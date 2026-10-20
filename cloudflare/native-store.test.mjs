import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { auditNative, importNative, restoreNative } from './native-store.mjs';

const sha = body => createHash('sha256').update(body).digest('hex');
const root = await mkdtemp(path.join(tmpdir(), 'health-native-synthetic-'));
const source = path.join(root, 'source');
const cursor = { since: '2026-01-01T00:00:00Z' };
const archive = Buffer.from('fictional old archive; never extracted');
const fidelity = ' \n{"big":9007199254740993,"flt":1.0,"huge":1e400,"neg0":-0,"dup":1,"dup":2,"escaped":"\\u96ea"}\t ';
let fidelityReceipt;
const archivePath = `raw/artoo/2026-01-01/${sha(archive)}/snapshot.tar.gz`;
const fixture = { received_at: '2026-01-01T00:00:00Z', remote: 'fictional', payload: { kind: 'events', events: [] } };
async function file(name, bytes) {
  const destination = path.join(source, name);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}
async function absent(name) { await assert.rejects(access(name), { code: 'ENOENT' }); }
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'migration-synthetic', alg: 'RS256' };
const ISSUER = 'https://migration-synthetic.cloudflareaccess.com';
const token = role => new SignJWT({ sub: '', common_name: role }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
  .setIssuer(ISSUER).setAudience('migration-synthetic').setIssuedAt().setExpirationTime('5m').sign(privateKey);
let mf;
function options() {
  return { resourcePersistencePath: path.join(root, 'r2'), telemetry: { enabled: false }, cf: false,
    workers: [{ config: {
      name: 'migration-synthetic', compatibilityDate: '2026-10-15', compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: script } } },
      env: {
        DATA: { type: 'r2', name: 'migration-synthetic' },
        SCRATCH: { type: 'r2', name: 'migration-interrupted-synthetic' },
        ...Object.fromEntries(Object.entries({ RELEASE: 'migration-synthetic', ACCESS_ISSUER: ISSUER,
          ACCESS_AUD: 'migration-synthetic', ACCESS_HUMAN_EMAILS: '[]', HEVY_API_KEY: 'fictional-key',
          ACCESS_MACHINES: JSON.stringify([
            { kind: 'machine', role: 'writer', client_id: 'writer', sources: ['artoo', 'synthetic'] },
            { kind: 'machine', role: 'poll-only', client_id: 'poller', sources: [] },
          ]),
        }).map(([name, value]) => [name, { type: 'json', value }])),
      },
    }, dev: { outboundService: { type: 'fetcher', handler: async request => {
      if (request.url === `${ISSUER}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
      assert.equal(new URL(request.url).origin, 'https://api.hevyapp.com');
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('api-key'), 'fictional-key');
      assert.equal(new URL(request.url).pathname, '/v1/workouts/events'); // Seeded, not a new backfill.
      return Response.json({ page: 1, page_count: 1, events: [{ type: 'deleted', id: 'fictional-deleted' }] });
    } } } }],
  };
}
const script = await readFile(new URL('./build/worker.js', import.meta.url), 'utf8');
const wrap = (bucket, overrides = {}) => new Proxy(bucket, { get(target, name) {
  return overrides[name] || (typeof target[name] === 'function' ? target[name].bind(target) : target[name]);
} });
const paged = bucket => wrap(bucket, { list: options => bucket.list({ ...options, limit: 2 }) });
async function clear(bucket) {
  for (;;) {
    const page = await bucket.list();
    if (!page.objects.length) break;
    await bucket.delete(page.objects.map(object => object.key));
  }
}
async function request(pathname, body, role = 'writer', type = 'application/json') {
  return (await mf.getWorker()).fetch(`https://migration.invalid${pathname}`, {
    method: 'POST', body, headers: { 'Cf-Access-Jwt-Assertion': await token(role),
      'Content-Length': String(Buffer.byteLength(body)), 'Content-Type': type },
  });
}
async function nativeJourney(directory) {
  const child = spawn(process.env.PYTHON || 'python3', ['-u', '-c',
    'import sys;from pathlib import Path;sys.path.insert(0,"..");import server;server.ROOT=Path(sys.argv[1]).parent;server.DATA_RAW=Path(sys.argv[1])/"raw";server.TOKEN="synthetic-token";s=server.ThreadingHTTPServer(("127.0.0.1",0),server.Handler);print(s.server_address[1],flush=True);s.serve_forever()', directory],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  try {
    const port = await new Promise((resolve, reject) => {
      child.stdout.once('data', bytes => resolve(Number(bytes.toString().split('\n')[0])));
      child.once('error', reject);
      child.once('exit', () => reject(Error('isolated native server failed')));
    });
    // Match the receiver's explicit-length, one-request-per-connection contract
    // and consume complete replies, including early auth refusal.
    const call = (pathname, body, authorized = false) => new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path: pathname,
        method: body === undefined ? 'GET' : 'POST', agent: false, headers: {
          Connection: 'close', ...(body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }),
          ...(authorized ? { Authorization: 'Bearer synthetic-token' } : {}),
        },
      }, response => {
        let text = ''; response.on('data', bytes => { text += bytes; });
        response.on('end', () => resolve({ status: response.statusCode, text }));
        response.on('error', reject);
      });
      request.on('error', reject); request.end(body);
    });
    assert.deepEqual(await call('/healthz'), { status: 200, text: 'ok\n' });
    assert.equal((await call('/ingest/recovered', '{}')).status, 403);
    assert.equal((await call('/ingest/recovered', '{', true)).status, 400);
    const accepted = await call('/ingest/recovered', '{"fictional":true}', true);
    assert.equal(accepted.status, 200);
    assert.equal(JSON.parse(accepted.text).status, 'ok');
    assert.equal(stderr, '');
  } finally { child.kill('SIGTERM'); await once(child, 'exit'); }
}

test('native import and reverse recovery through real R2, Worker HTTP and native HTTP', async t => {
  try {
    await file('raw/hevy/2026-01-01.json', JSON.stringify([fixture, fixture], null, 2));
    await file('raw/synthetic/2026-01-01.json', JSON.stringify([{ ...fixture, payload: { fictional: '雪' } }]));
    await file('raw/synthetic/2026-01-02.json', '{historical-corrupt-bytes');
    await file('raw/.gitkeep', '');
    await file(archivePath, archive);
    await file(archivePath.replace('snapshot.tar.gz', 'receipt.json'), JSON.stringify({ fictional: 'old receipt' }));
    await file('state/hevy.json', JSON.stringify(cursor));
    mf = new Miniflare(options()); await mf.ready;
    let data = paged(await mf.getR2Bucket('DATA'));
    let scratch = paged(await mf.getR2Bucket('SCRATCH'));
    const baseline = await auditNative(source);
    await t.test('canonical multiplicity, opaque/corrupt history and byte-exact restore survive paged R2', async () => {
      assert.equal(baseline.json_records, 3);
      assert.deepEqual(await importNative(source, data), baseline);
      const restored = path.join(root, 'baseline-restored');
      assert.deepEqual(await restoreNative(data, restored), { ...baseline, cloudflare_records: 0 });
      assert.deepEqual(await auditNative(restored), baseline);
      assert.deepEqual(await readFile(path.join(restored, archivePath)), archive);
      assert.deepEqual(await readFile(path.join(restored, 'raw/.gitkeep')), Buffer.alloc(0));
      await assert.rejects(restoreNative(data, restored), /operation refused/);
      const empty = path.join(root, 'occupied-empty'); await mkdir(empty);
      await assert.rejects(restoreNative(data, empty), /operation refused/);
      assert.deepEqual(await readdir(empty), []);
    });
    await t.test('only empty gitkeep leaves are permitted; hidden data and placeholder directories refuse', async () => {
      for (const name of ['raw/.gitkeep', 'raw/.hidden', 'raw/.upload-incomplete']) {
        await file(name, 'fictional');
        await assert.rejects(importNative(source, scratch), /operation refused/);
        await rm(path.join(source, name));
      }
      await mkdir(path.join(source, 'raw/.gitkeep'));
      await assert.rejects(importNative(source, scratch), /operation refused/);
      await rm(path.join(source, 'raw/.gitkeep'), { recursive: true });
      await mkdir(path.join(source, 'raw/.hidden'));
      await file('raw/.hidden/.gitkeep', '');
      await assert.rejects(importNative(source, scratch), /operation refused/);
      await rm(path.join(source, 'raw/.hidden'), { recursive: true });
      await file('raw/.gitkeep', '');
      assert.equal(await scratch.get('migration/native.json'), null);
      assert.equal(await scratch.get('state/hevy.json'), null);
    });
    await t.test('symlinks, unfinished uploads and missing cursor refuse before any commit', async () => {
      await symlink(path.join(source, 'state/hevy.json'), path.join(source, 'raw/link'));
      await assert.rejects(importNative(source, scratch), /operation refused/);
      await rm(path.join(source, 'raw/link'));
      await file('raw/artoo/.upload-incomplete', 'fictional');
      await assert.rejects(importNative(source, scratch), /operation refused/);
      await rm(path.join(source, 'raw/artoo/.upload-incomplete'));
      await rm(path.join(source, 'state/hevy.json'));
      await assert.rejects(importNative(source, scratch), /operation refused/);
      assert.equal(await scratch.get('migration/native.json'), null);
      await file('state/hevy.json', JSON.stringify(cursor));
    });
    await t.test('historical JSON beyond canonical stack depth remains byte-exact opaque history', async () => {
      const body = '['.repeat(20_000) + '0' + ']'.repeat(20_000);
      await file('raw/synthetic/deep.json', body);
      try {
        const deep = await auditNative(source);
        assert.equal(deep.files, baseline.files + 1);
        assert.equal(deep.opaque_files, baseline.opaque_files + 1);
        assert.equal(deep.json_records, baseline.json_records);
        assert.deepEqual(await importNative(source, scratch), deep);
        const restored = path.join(root, 'deep-history-restored');
        assert.deepEqual(await restoreNative(scratch, restored), { ...deep, cloudflare_records: 0 });
        assert.equal(sha(await readFile(path.join(restored, 'raw/synthetic/deep.json'))), sha(body));
      } finally {
        await rm(path.join(source, 'raw/synthetic/deep.json'));
        await clear(scratch);
      }
    });
    await t.test('failed object copy and last commit never claim success; retries recover without deletion', async () => {
      let puts = 0;
      await assert.rejects(importNative(source, wrap(scratch, { put: (...args) => {
        if (++puts === 2) throw Error('fictional injected storage failure');
        return scratch.put(...args);
      } })), /operation refused/);
      assert.equal(await scratch.get('migration/native.json'), null);
      assert.equal(await scratch.get('state/hevy.json'), null);
      await assert.rejects(importNative(source, wrap(scratch, { put: (key, ...args) => {
        if (key === 'migration/native.json') throw Error('fictional commit failure');
        return scratch.put(key, ...args);
      } })), /operation refused/);
      assert.equal(await scratch.get('migration/native.json'), null);
      assert.ok(await scratch.get('state/hevy.json'));
      assert.deepEqual(await importNative(source, scratch), baseline);
    });
    await t.test('an interrupted final-delta commit cannot masquerade as a completed reverse restore', async () => {
      await file('raw/hevy/2026-01-01.json', JSON.stringify([fixture, fixture, fixture]));
      await assert.rejects(importNative(source, wrap(scratch, { put: (key, ...args) => {
        if (key === 'migration/native.json') throw Error('fictional final delta commit failure');
        return scratch.put(key, ...args);
      } })), /operation refused/);
      const destination = path.join(root, 'uncommitted-final-delta');
      await assert.rejects(restoreNative(scratch, destination), /operation refused/);
      await absent(destination);
      const delta = await auditNative(source);
      assert.deepEqual(await importNative(source, scratch), delta);
      assert.deepEqual(await restoreNative(scratch, destination), { ...delta, cloudflare_records: 0 });
      await file('raw/hevy/2026-01-01.json', JSON.stringify([fixture, fixture], null, 2));
    });
    await t.test('a changing source cannot publish a final delta; stable final delta is resumable', async () => {
      const before = await (await data.get('migration/native.json')).text();
      const nativePath = 'raw/hevy/2026-01-01.json';
      await file(nativePath, JSON.stringify([fixture, fixture, fixture]));
      let changed = false;
      const moving = wrap(data, { put: async (key, ...args) => {
        const result = await data.put(key, ...args);
        if (!changed && key.startsWith('legacy/')) {
          changed = true; await file(nativePath, JSON.stringify([fixture, fixture, fixture, fixture]));
        }
        return result;
      } });
      await assert.rejects(importNative(source, moving), /operation refused/);
      assert.equal(await (await data.get('migration/native.json')).text(), before);
      const delta = await auditNative(source);
      assert.equal(delta.json_records, 5);
      assert.deepEqual(await importNative(source, data), delta);
      assert.deepEqual(await importNative(source, data), delta);
    });
    await t.test('final delta refuses deleted, truncated or rewritten history and cursor regression', async () => {
      const original = await readFile(path.join(source, 'raw/hevy/2026-01-01.json'));
      const before = await (await data.get('migration/native.json')).text();
      for (const rejected of [JSON.stringify([fixture]), JSON.stringify([fixture, { payload: 'rewritten' }, fixture, fixture])]) {
        await file('raw/hevy/2026-01-01.json', rejected);
        await assert.rejects(importNative(source, data), /operation refused/);
        assert.equal(await (await data.get('migration/native.json')).text(), before);
      }
      await rm(path.join(source, 'raw/hevy/2026-01-01.json'));
      await assert.rejects(importNative(source, data), /operation refused/);
      await file('raw/hevy/2026-01-01.json', original);
      await file('state/hevy.json', JSON.stringify({ since: '2025-01-01T00:00:00Z' }));
      await assert.rejects(importNative(source, data), /operation refused/);
      await file('state/hevy.json', JSON.stringify(cursor));
      assert.equal(await (await data.get('migration/native.json')).text(), before);
    });
    await t.test('real Worker accepts post-import JSON, opaque archive and seeded Hevy events', async () => {
      for (const [route, body, role, type] of [
        ['/ingest/synthetic', fidelity, 'writer', 'application/json'],
        ['/artoo/snapshot', 'fictional new archive; never extracted', 'writer', 'application/gzip'],
        ['/internal/hevy-poll', '', 'poller', 'application/json'],
      ]) {
        const response = await request(route, body, role, type);
        assert.equal(response.status, 200);
        const receipt = await response.json();
        if (route !== '/internal/hevy-poll') assert.equal(receipt.sha256, sha(body));
        if (route === '/ingest/synthetic') fidelityReceipt = receipt;
      }
      const manifest = await (await data.get('migration/native.json')).text();
      const state = await (await data.get('state/hevy.json')).text();
      await assert.rejects(importNative(source, data), /operation refused/);
      assert.equal(await (await data.get('migration/native.json')).text(), manifest);
      assert.equal(await (await data.get('state/hevy.json')).text(), state);
    });
    await t.test('fresh runtime reverse-restores every accepted write and latest cursor; original native serves again', async () => {
      await mf.dispose(); mf = new Miniflare(options()); await mf.ready;
      data = paged(await mf.getR2Bucket('DATA'));
      scratch = paged(await mf.getR2Bucket('SCRATCH'));
      const restored = path.join(root, 'after-cutover-restored');
      const result = await restoreNative(data, restored);
      assert.equal(result.cloudflare_records, 3);
      assert.equal(result.json_records, 7);
      assert.deepEqual(JSON.parse(await readFile(path.join(restored, 'state/hevy.json'))), await (await data.get('state/hevy.json')).json());
      assert.deepEqual(await readFile(path.join(restored, archivePath)), archive);
      const newArchive = (await data.list({ prefix: 'raw/artoo/' })).objects[0];
      const received = (await data.get(newArchive.key)).customMetadata.received_at.slice(0, 10);
      assert.equal(sha(await readFile(path.join(restored, 'raw/artoo', received, newArchive.key.split('/')[2], 'snapshot.tar.gz'))), newArchive.key.split('/')[2]);
      const recoveredJSON = path.join(restored, 'raw/synthetic', `${fidelityReceipt.received_at.slice(0, 10)}.cf-${fidelityReceipt.sha256}.json`);
      const envelope = await readFile(recoveredJSON);
      const marker = Buffer.from(',"payload":');
      const start = envelope.indexOf(marker);
      assert.ok(start > 0);
      assert.equal(envelope.subarray(-2).toString(), '}]');
      const originalBytes = envelope.subarray(start + marker.length, -2);
      assert.deepEqual(originalBytes, Buffer.from(fidelity));
      assert.equal(sha(originalBytes), fidelityReceipt.sha256);
      const python = spawnSync(process.env.PYTHON || 'python3', ['-c',
        'import json,sys;original=json.loads(sys.argv[1]);restored=json.load(open(sys.argv[2],encoding="utf-8"))[0]["payload"];assert original==restored;assert {k:repr(v) for k,v in original.items()}=={k:repr(v) for k,v in restored.items()};print("native JSON values preserved")',
        fidelity, recoveredJSON], { encoding: 'utf8' });
      assert.equal(python.status, 0, python.stderr);
      assert.equal(python.stdout, 'native JSON values preserved\n');
      await nativeJourney(restored);
      assert.equal((await auditNative(restored)).json_records, result.json_records + 1);
    });
    await t.test('missing, corrupt or traversal-tainted objects publish no restore and leave no staging files', async () => {
      await clear(scratch); await importNative(source, scratch);
      const original = await (await scratch.get('migration/native.json')).text();
      const manifest = JSON.parse(original);
      const key = `legacy/${manifest.files[0].sha256}`;
      const good = await (await scratch.get(key)).arrayBuffer();
      await scratch.delete(key);
      const destination = path.join(root, 'refused-restore');
      await assert.rejects(restoreNative(scratch, destination), /operation refused/); await absent(destination);
      await scratch.put(key, 'fictional damaged object');
      await assert.rejects(restoreNative(scratch, destination), /operation refused/); await absent(destination);
      await scratch.put(key, good);
      for (const badPath of ['raw/synthetic/.gitkeep', 'raw/.gitkeep/child', 'raw/.hidden/.gitkeep']) {
        const tainted = JSON.parse(original);
        tainted.files.find(row => row.bytes > 0 && row.path.startsWith('raw/')).path = badPath;
        await scratch.put('migration/native.json', JSON.stringify(tainted));
        await assert.rejects(restoreNative(scratch, destination), /operation refused/); await absent(destination);
      }
      manifest.files[0].path = '../must-not-exist';
      await scratch.put('migration/native.json', JSON.stringify(manifest));
      await assert.rejects(restoreNative(scratch, destination), /operation refused/); await absent(destination);
      await absent(path.join(root, 'must-not-exist'));
      assert.ok(!(await readdir(root)).some(name => name.startsWith('.native-restore-')));
    });
    await t.test('a moving Cloudflare writer prevents publication of a stale reverse restore', async () => {
      await clear(scratch); await importNative(source, scratch);
      let changed = false;
      const moving = wrap(scratch, { get: async key => {
        if (!changed && key === 'state/hevy.json') {
          changed = true;
          const body = '{"fictional_concurrent_write":true}';
          await scratch.put(`raw/synthetic/${sha(body)}`, body, { customMetadata: {
            source: 'synthetic', sha256: sha(body), received_at: new Date().toISOString(),
          } });
        }
        return scratch.get(key);
      } });
      const destination = path.join(root, 'moving-restore');
      await assert.rejects(restoreNative(moving, destination), /operation refused/);
      await absent(destination);
      assert.ok(!(await readdir(root)).some(name => name.startsWith('.native-restore-')));
    });
    await t.test('bundled CLI errors reveal no path/content canary and produce no success receipt', async () => {
      const child = spawn(process.execPath, ['build/native-store-cli.mjs', 'audit', '--directory',
        path.join(root, 'PRIVATE-CONTENT-CANARY-NOT-A-REAL-RECORD')], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      const [code] = await once(child, 'exit');
      assert.equal(code, 1); assert.equal(stdout, '');
      assert.equal(stderr, 'Native store operation failed; no completed migration/restore claimed.\n');
    });
  } finally { await mf?.dispose(); await rm(root, { recursive: true, force: true }); }
});
