// Operator-side migration codec. No credentials, provider endpoints or live paths.
// Call only with quiesced writers and an isolated/otherwise non-serving bucket.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MANIFEST = 'migration/native.json';
const CURSOR = 'state/hevy.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const encode = value => JSON.stringify(canonical(value));
const check = value => { if (!value) throw Error('migration refused'); };
const safe = key => typeof key === 'string' && key.length > 0 &&
  !key.includes('\\') && !key.includes('\0') && !path.posix.isAbsolute(key) &&
  key.split('/').every((part, index, parts) => part && part !== '.' && part !== '..' &&
    (!part.startsWith('.') || (part === '.gitkeep' && index === parts.length - 1)));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

async function fileHash(file) {
  return bodyHash(createReadStream(file));
}
async function bodyHash(body) {
  const hash = createHash('sha256');
  for await (const chunk of body) hash.update(chunk);
  return hash.digest('hex');
}
async function entries(root, prefix = '') {
  check((await lstat(root)).isDirectory());
  const result = [];
  for (const name of (await readdir(root)).sort()) {
    const key = prefix + name;
    check(safe(key)); // Includes unfinished native .upload-* / temporary files.
    const file = path.join(root, name);
    const stat = await lstat(file);
    check(!stat.isSymbolicLink());
    check(name !== '.gitkeep' || (stat.isFile() && stat.size === 0));
    if (stat.isDirectory()) result.push(...await entries(file, key + '/'));
    else { check(stat.isFile()); result.push({ path: key, bytes: stat.size, sha256: await fileHash(file) }); }
  }
  return result;
}
async function summary(root, files) {
  let records = 0, opaque = 0;
  const logical = [];
  for (const row of files) {
    let value, logicalHash = row.sha256, valid = false;
    if (row.path.endsWith('.json') && !row.path.startsWith('raw/artoo/')) {
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path.join(root, row.path))));
        logicalHash = digest(encode(value));
        valid = true;
      } catch { /* Corrupt or too-deep historical bytes remain opaque, never discarded or repaired. */ }
    }
    if (valid && row.path.startsWith('raw/') && Array.isArray(value) &&
        value.every(record => record && typeof record === 'object' && 'payload' in record)) records += value.length;
    if (!valid) opaque++;
    logical.push([row.path, valid ? 'json' : 'opaque', logicalHash]);
  }
  return { files: files.length, bytes: files.reduce((sum, row) => sum + row.bytes, 0),
    json_records: records, opaque_files: opaque,
    canonical_sha256: digest(encode(logical)), bytes_sha256: digest(encode(files)) };
}
async function audit(root) {
  const files = await entries(root);
  check(files.every(row => row.path.startsWith('raw/') || row.path === CURSOR));
  const cursor = files.find(row => row.path === CURSOR);
  check(cursor); // Do not accidentally backfill after migrating a poller's history.
  const state = JSON.parse(await readFile(path.join(root, CURSOR), 'utf8'));
  check(typeof state.since === 'string' && Number.isFinite(Date.parse(state.since)) && Date.parse(state.since) <= Date.now());
  const result = { version: 1, files, summary: await summary(root, files) };
  // Canonical JSON parsing must not attest bytes from a different read epoch.
  check(encode(await entries(root)) === encode(files));
  return result;
}
async function all(bucket, prefix = '') {
  const objects = [];
  let cursor;
  const cursors = new Set();
  do {
    const page = await bucket.list({ prefix, cursor, include: ['customMetadata'] });
    check(Array.isArray(page.objects));
    objects.push(...page.objects);
    if (!page.truncated) return objects.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    check(page.cursor && !cursors.has(page.cursor));
    cursors.add(page.cursor); cursor = page.cursor;
  } while (true);
}
async function bytes(bucket, key) {
  const object = await bucket.get(key); check(object);
  return new Uint8Array(await object.arrayBuffer());
}
async function verifiedCopy(bucket, key, file, expected) {
  const object = await bucket.get(key); check(object && object.size === expected.bytes);
  const hash = createHash('sha256');
  async function* verified() {
    for await (const chunk of object.body) { hash.update(chunk); yield chunk; }
  }
  await pipeline(Readable.from(verified()), createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  check(hash.digest('hex') === expected.sha256);
}
// Public operations deliberately discard filesystem/library errors: no record,
// path, metadata, identity or upstream exception can escape into operator logs.
async function privateOperation(action) {
  try { return await action(); } catch { throw Error('native store operation refused; no completed migration/restore claimed'); }
}
export const auditNative = root => privateOperation(async () => (await audit(root)).summary);

export const importNative = (root, bucket) => privateOperation(async () => {
  const manifest = await audit(root);
  check((await all(bucket, 'raw/')).length === 0); // Never import over accepted CF writes.
  const previous = await bucket.get(MANIFEST);
  const state = await bucket.get(CURSOR);
  const stateBytes = state ? new Uint8Array(await state.arrayBuffer()) : null;
  const sourceCursor = await readFile(path.join(root, CURSOR));
  const seed = digest(encode(manifest));
  const resumedSeed = state && state.customMetadata?.native_seed === seed &&
    digest(stateBytes) === digest(sourceCursor);
  if (previous) {
    const old = JSON.parse(await previous.text());
    check(old.version === 1 && Array.isArray(old.files));
    const oldCursor = old.files.find(row => row.path === CURSOR);
    check(oldCursor && state && (resumedSeed || digest(stateBytes) === oldCursor.sha256));
    for (const before of old.files) {
      check(safe(before.path) && sha(before.sha256));
      const after = manifest.files.find(row => row.path === before.path);
      check(after); // A final delta never removes an accepted native file.
      if (before.sha256 === after.sha256) continue;
      const priorBytes = await bytes(bucket, `legacy/${before.sha256}`);
      check(digest(priorBytes) === before.sha256);
      const prior = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(priorBytes));
      const next = JSON.parse(await readFile(path.join(root, after.path), 'utf8'));
      if (before.path === CURSOR) check(Date.parse(next.since) >= Date.parse(prior.since));
      else {
        check(before.path.startsWith('raw/') && !before.path.startsWith('raw/artoo/') &&
          Array.isArray(prior) && Array.isArray(next) && next.length >= prior.length);
        check(prior.every((record, index) => encode(record) === encode(next[index])));
      }
    }
  } else check(!state || resumedSeed);
  for (const row of manifest.files) {
    const key = `legacy/${row.sha256}`;
    const existing = await bucket.get(key);
    if (existing) check(existing.size === row.bytes && await bodyHash(existing.body) === row.sha256);
    else {
      const put = await bucket.put(key, await openAsBlob(path.join(root, row.path)), {
        onlyIf: { etagDoesNotMatch: '*' }, sha256: row.sha256,
        httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, no-store' },
      });
      check(put);
      const written = await bucket.get(key);
      check(written && written.size === row.bytes && await bodyHash(written.body) === row.sha256);
    }
  }
  check(encode(await audit(root)) === encode(manifest));
  // Writers must remain stopped throughout. The manifest is the LAST commit
  // marker. A failed seed/commit leaves a recognized resumable seed, not a pass.
  check((await all(bucket, 'raw/')).length === 0);
  const seeded = await bucket.put(CURSOR, sourceCursor, {
    onlyIf: state ? { etagMatches: state.etag } : { etagDoesNotMatch: '*' },
    customMetadata: { native_seed: seed },
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
  check(seeded);
  check(digest(await bytes(bucket, CURSOR)) === digest(sourceCursor));
  const committed = await bucket.put(MANIFEST, encode(manifest), {
    onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
  check(committed);
  check(digest(await bytes(bucket, MANIFEST)) === seed);
  check(digest(await bytes(bucket, CURSOR)) === digest(sourceCursor));
  return manifest.summary;
});

export const restoreNative = (bucket, destination) => privateOperation(async () => {
  // An unused destination is required; never merge a snapshot into accepted state.
  try { await lstat(destination); throw Error('occupied'); }
  catch (error) { check(error.code === 'ENOENT'); }
  const stage = await mkdtemp(path.join(path.dirname(destination), '.native-restore-'));
  try {
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bytes(bucket, MANIFEST)));
    check(manifest.version === 1 && Array.isArray(manifest.files));
    const paths = new Set();
    for (const row of manifest.files) {
      check(safe(row.path) && (row.path.startsWith('raw/') || row.path === CURSOR) && !paths.has(row.path));
      check(sha(row.sha256) && Number.isSafeInteger(row.bytes) && row.bytes >= 0);
      check(path.posix.basename(row.path) !== '.gitkeep' || row.bytes === 0);
      paths.add(row.path);
      const file = path.join(stage, row.path);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await verifiedCopy(bucket, `legacy/${row.sha256}`, file, row);
    }
    check(encode((await audit(stage)).summary) === encode(manifest.summary));
    const accepted = await all(bucket, 'raw/');
    for (const object of accepted) {
      const match = /^raw\/([a-zA-Z0-9-]+)\/([a-f0-9]{64})$/.exec(object.key);
      check(match);
      const [, source, hash] = match;
      const stored = await bucket.get(object.key); check(stored);
      const metadata = stored.customMetadata;
      check(metadata?.source === source && metadata.sha256 === hash &&
        typeof metadata.received_at === 'string' && Number.isFinite(Date.parse(metadata.received_at)));
      const day = new Date(metadata.received_at).toISOString().slice(0, 10);
      if (source === 'artoo') {
        await stored.body.cancel();
        const directory = path.join(stage, 'raw/artoo', day, hash);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, 'snapshot.tar.gz');
        try { await lstat(file); check(await fileHash(file) === hash); }
        catch (error) {
          check(error.code === 'ENOENT');
          await verifiedCopy(bucket, object.key, file, { bytes: stored.size, sha256: hash });
          await writeFile(path.join(directory, 'receipt.json'), JSON.stringify({ status: 'ok', source,
            received_at: metadata.received_at, remote: 'cloudflare', bytes: stored.size, sha256: hash,
            stored: `data/raw/artoo/${day}/${hash}/snapshot.tar.gz` }), { flag: 'wx', mode: 0o600 });
        }
      } else {
        const body = new Uint8Array(await stored.arrayBuffer()); check(digest(body) === hash);
        const payload = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
        JSON.parse(payload); // Validate only: re-encoding would change accepted numbers/keys/bytes.
        const directory = path.join(stage, 'raw', source);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const envelope = JSON.stringify({ received_at: metadata.received_at, remote: 'cloudflare' });
        await writeFile(path.join(directory, `${day}.cf-${hash}.json`),
          `[${envelope.slice(0, -1)},"payload":${payload}}]`, { flag: 'wx', mode: 0o600 });
      }
    }
    // Latest CF cursor, not the imported historical cursor, controls recovery.
    const checkpoint = await bucket.get(CURSOR); check(checkpoint);
    const seed = checkpoint.customMetadata?.native_seed;
    check(!seed || seed === digest(encode(manifest))); // Refuse a half-committed final delta.
    const latest = new Uint8Array(await checkpoint.arrayBuffer());
    const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(latest));
    check(typeof state.since === 'string' && Number.isFinite(Date.parse(state.since)) && Date.parse(state.since) <= Date.now());
    await writeFile(path.join(stage, CURSOR), latest, { mode: 0o600 });
    // Detect moving CF writers before publishing; callers must still quiesce
    // both writers to prevent a write after this last observation.
    check(encode(await all(bucket, 'raw/')) === encode(accepted));
    const finalCheckpoint = await bucket.get(CURSOR); check(finalCheckpoint);
    check(finalCheckpoint.customMetadata?.native_seed === seed &&
      digest(new Uint8Array(await finalCheckpoint.arrayBuffer())) === digest(latest));
    check(digest(await bytes(bucket, MANIFEST)) === digest(encode(manifest)));
    const result = await audit(stage);
    await rename(stage, destination);
    return { ...result.summary, cloudflare_records: accepted.length };
  } finally { await rm(stage, { recursive: true, force: true }); }
});
