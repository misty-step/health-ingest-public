import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const ISSUER = 'https://synthetic.cloudflareaccess.com';
const AUD = 'synthetic-health-preview';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
const token = (claims = {}, options = {}) => new SignJWT({ sub: '', common_name: 'synthetic-artoo', ...claims })
  .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
  .setIssuer(options.issuer || ISSUER).setAudience(options.audience || AUD)
  .setIssuedAt(options.iat || Math.floor(Date.now() / 1000))
  .setExpirationTime(options.exp || '5m').sign(privateKey);

// These are fictional API fixtures, not captured/exported owner data.
const events = Array.from({ length: 11 }, (_, id) => ({ id: `fictional-${id}`, type: 'updated', workout: { id: `fictional-${id}` } }));
const calls = [];
let mode = 'backfill';
let failures = 0;
let overlapping = 0;
let releaseOverlap;
let overlap;
let mf;
const persistence = await mkdtemp(path.join(tmpdir(), 'health-ingest-synthetic-'));
const script = await readFile(new URL('./build/worker.js', import.meta.url), 'utf8');
const bindings = {
  RELEASE: 'candidate-A', ACCESS_ISSUER: ISSUER, ACCESS_AUD: AUD,
  ACCESS_HUMAN_EMAILS: '["fictional-owner@example.invalid"]',
  ACCESS_MACHINES: JSON.stringify([
    { kind: 'machine', role: 'writer', client_id: 'synthetic-artoo', sources: ['artoo', 'synthetic'] },
    { kind: 'machine', role: 'poll-only', client_id: 'synthetic-poller', sources: [] },
    { kind: 'machine', role: 'unknown-role', client_id: 'synthetic-unknown-role', sources: ['*'] },
  ]),
  HEVY_API_KEY: 'synthetic-upstream-key',
};
function options(release = 'candidate-A') {
  return {
    resourcePersistencePath: persistence, telemetry: { enabled: false }, cf: false,
    workers: [{ config: {
      name: 'health-ingest-test', compatibilityDate: '2026-10-15', compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: script } } },
      env: { ...Object.fromEntries(Object.entries({ ...bindings, RELEASE: release }).map(
        ([name, value]) => [name, { type: 'json', value }],
      )), DATA: { type: 'r2', name: 'synthetic-records' } },
    }, dev: { outboundService: { type: 'fetcher', handler: async request => {
      const url = new URL(request.url);
      if (url.href === `${ISSUER}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
      assert.equal(url.origin, 'https://api.hevyapp.com');
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('api-key'), 'synthetic-upstream-key');
      assert.ok(['/v1/workouts', '/v1/workouts/events'].includes(url.pathname));
      calls.push({ path: url.pathname, page: Number(url.searchParams.get('page')), since: url.searchParams.get('since') });
      assert.equal(url.searchParams.get('pageSize'), '10');
      if (mode === 'transient' && failures++ < 2) return new Response('synthetic outage', { status: 503 });
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://invalid.example/secret' } });
      if (mode === 'malformed') return Response.json({ page_count: 1 });
      const page = Number(url.searchParams.get('page'));
      if (mode === 'overlap' && page === 1) {
        if (++overlapping === 2) releaseOverlap();
        await overlap;
      }
      if (mode === 'partial' && page === 2) return new Response('synthetic outage', { status: 503 });
      const key = url.pathname.endsWith('/events') ? 'events' : 'workouts';
      if (mode === 'empty-zero' || mode === 'empty-one') {
        return Response.json({ page: 1, page_count: mode === 'empty-zero' ? 0 : 1, [key]: [] });
      }
      if (mode === 'invalid-zero') return Response.json({ page: 1, page_count: 0, [key]: [{ id: 'fictional-invalid' }] });
      if (mode === 'rate-limit') return new Response(null, { status: 429 });
      return Response.json({ page_count: 2, [key]: events.slice((page - 1) * 10, page * 10) });
    } } } }],
  };
}
async function request(pathname, body, jwt, headers = {}) {
  const worker = await mf.getWorker();
  return worker.fetch(`https://health.synthetic.invalid${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}),
      ...(body !== undefined ? { 'Content-Length': String(Buffer.byteLength(body)), 'Content-Type': 'application/json' } : {}), ...headers },
    body,
  });
}
const bucket = () => mf.getR2Bucket('DATA');
const records = async prefix => (await (await bucket()).list({ prefix })).objects;
const cursor = async () => { const value = await (await bucket()).get('state/hevy.json'); return value ? value.json() : null; };
const poll = async (jwt, status = 200) => {
  const response = await request('/internal/hevy-poll', '', jwt);
  assert.equal(response.status, status);
  if (status === 200) assert.deepEqual(await response.json(), { ok: true });
  else assert.equal(await response.text(), '');
};
const assertStatus = async (response, expected) => assert.equal(response.status, expected, await response.text());
async function bodyHash(body) {
  const hash = createHash('sha256');
  for await (const chunk of body) hash.update(chunk);
  return hash.digest('hex');
}
async function headersOnly(pathname, jwt, length) {
  const origin = await mf.ready;
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(pathname, origin), { method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': jwt, ...(length ? { 'Content-Length': length } : {}) },
    }, response => {
      response.resume();
      response.on('end', () => { resolve(response.statusCode); req.destroy(); });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('synthetic header-only request timed out')));
    req.flushHeaders();
  });
}

async function largeJSON(jwt) {
  const total = 99_999_999;
  const digest = createHash('sha256');
  const origin = await mf.ready;
  let req;
  const response = new Promise((resolve, reject) => {
    req = httpRequest(new URL('/ingest/synthetic', origin), { method: 'POST', headers: {
      'Cf-Access-Jwt-Assertion': jwt, 'Content-Length': total, 'Content-Type': 'application/json',
    } }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode, receipt: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject);
  });
  const write = async chunk => {
    digest.update(chunk);
    if (!req.write(chunk)) await once(req, 'drain');
  };
  await write(Buffer.from('"'));
  for (let remaining = total - 2; remaining > 0;) {
    const chunk = Buffer.alloc(Math.min(65_536, remaining), 120);
    await write(chunk);
    remaining -= chunk.length;
  }
  await write(Buffer.from('"'));
  req.end();
  const value = await response;
  assert.equal(value.status, 200);
  assert.equal(value.receipt.bytes, total);
  assert.equal(value.receipt.sha256, digest.digest('hex'));
  assert.equal((await (await bucket()).head(value.receipt.stored)).size, total);
  assert.equal((await records('staging/')).length, 0);
}

async function chunkedJSON(chunks, jwt) {
  const origin = await mf.ready;
  let req;
  const response = new Promise((resolve, reject) => {
    req = httpRequest(new URL('/ingest/synthetic', origin), { method: 'POST', headers: {
      'Cf-Access-Jwt-Assertion': jwt, 'Content-Length': chunks.reduce((sum, chunk) => sum + chunk.length, 0),
      'Content-Type': 'application/json',
    } }, incoming => {
      let text = '';
      incoming.on('data', chunk => { text += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
  });
  for (const chunk of chunks) { req.write(chunk); await new Promise(resolve => setTimeout(resolve, 2)); }
  req.end();
  return response;
}

test('real workerd: private ingest, streaming persistence, authenticated polling and code recovery', async t => {
  try {
    mf = new Miniflare(options());
    await mf.ready;
    const machine = await token();
    const poller = await token({ common_name: 'synthetic-poller' });
    const human = await token({ sub: 'synthetic-human', common_name: undefined, email: 'fictional-owner@example.invalid' });
    await t.test('origin validates signed audience, issuer, time and exact tagged identities', async () => {
      for (const denied of [undefined, 'bad-token', await token({}, { audience: 'wrong' }),
        await token({}, { issuer: 'https://wrong.cloudflareaccess.com' }), await token({}, { exp: 1 }),
        await token({}, { iat: Math.floor(Date.now() / 1000) + 300 }),
        await token({ common_name: 'unknown' }), await token({ common_name: undefined }),
        await token({ common_name: 'synthetic-unknown-role' }),
        await token({ sub: 'unknown-human', common_name: undefined, email: 'other@example.invalid' }),
        await token({ sub: '', common_name: undefined, email: 'fictional-owner@example.invalid' }),
        await token({ sub: 'human', common_name: 'synthetic-artoo' })]) {
        await assertStatus(await request('/healthz', undefined, denied), 403);
      }
      for (const allowed of [machine, human]) {
        const response = await request('/healthz', undefined, allowed);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { ok: false, revision: 'candidate-A', reason: 'hevy_never_polled' });
      }
      await assertStatus(await request('/ingest/hevy', '{}', machine), 403);
      for (const pathname of ['/hae', '/ingest/healthautoexport']) await assertStatus(await request(pathname, '{}', human), 404);
    });
    await t.test('poll-only identity cannot read or write; writers, humans and unsigned callers cannot poll', async () => {
      for (const denied of [undefined, 'bad-token', machine, human]) await poll(denied, 403);
      for (const pathname of ['/healthz', '/preview/state', '/ingest/synthetic', '/artoo/snapshot']) {
        await assertStatus(await request(pathname, '{}', poller), 403);
      }
      const get = await request('/internal/hevy-poll', undefined, poller);
      assert.equal(get.status, 405); assert.equal(await get.text(), '');
      await assertStatus(await request('/preview/poll', '', machine), 404);
      assert.equal(calls.length, 0);
    });
    await t.test('accepted JSON is immutable, byte-exact and idempotent under concurrent replay', async () => {
      const payload = '{"fictional_metric":[1,2,3]}';
      const replies = await Promise.all(Array.from({ length: 4 }, () => request('/ingest/synthetic', payload, machine)));
      const receipts = await Promise.all(replies.map(async response => { assert.equal(response.status, 200); return response.json(); }));
      for (const receipt of receipts) { assert.deepEqual(receipt, receipts[0]); assert.equal(receipt.sha256, sha(payload)); }
      const persisted = await (await bucket()).get(receipts[0].stored);
      assert.equal(await persisted.text(), payload);
      assert.equal((await records('raw/synthetic/')).length, 1);
      assert.equal((await records('staging/')).length, 0);
    });
    await t.test('malformed JSON/UTF8, absent length, wrong method/type and edge bound refuse without records', async () => {
      const before = (await records('raw/')).length;
      for (const payload of ['', '{', '[]x', '{"a":}', '01', '{"a":NaN}', '[1,]', '{}{}', '\ufeff{}']) {
        await assertStatus(await request('/ingest/synthetic', payload, machine), 400);
      }
      await assertStatus(await request('/ingest/synthetic', Buffer.from([0xff]), machine), 400);
      assert.equal(await headersOnly('/ingest/synthetic', machine), 411);
      assert.equal(await headersOnly('/ingest/synthetic', machine, '100000000'), 413);
      await assertStatus(await request('/artoo/snapshot', 'fictional', machine), 415);
      await assertStatus(await request('/artoo/snapshot', undefined, machine), 405);
      assert.equal((await records('raw/')).length, before);
      assert.equal((await records('staging/')).length, 0);
    });
    await t.test('opaque archive receipt verifies bytes and replay; no raw GET', async () => {
      const bytes = Buffer.from('synthetic opaque archive, deliberately not extracted');
      const response = await request('/artoo/snapshot', bytes, machine, { 'Content-Type': 'application/gzip' });
      assert.equal(response.status, 200);
      const receipt = await response.json();
      assert.equal(receipt.sha256, sha(bytes)); assert.equal(receipt.bytes, bytes.length);
      assert.deepEqual(await (await request('/artoo/snapshot', bytes, machine, { 'Content-Type': 'application/gzip' })).json(), receipt);
      assert.deepEqual(Buffer.from(await (await (await bucket()).get(receipt.stored)).arrayBuffer()), bytes);
      await assertStatus(await request(`/${receipt.stored}`, undefined, machine), 404);
    });
    await t.test('JSON depth 128 accepts split escapes/UTF8; deeper arrays/objects refuse clearly and cleanly', async () => {
      const before = (await records('raw/')).length;
      const quoted = Buffer.from(JSON.stringify('雪"[{}]\\' + '[]'.repeat(200)));
      const chunks = [Buffer.from('['.repeat(128)), ...Array.from(quoted.subarray(0, 16), byte => Buffer.from([byte])),
        quoted.subarray(16), Buffer.from(']'.repeat(128))];
      const accepted = await chunkedJSON(chunks, machine);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.sha256, sha(Buffer.concat(chunks)));
      assert.deepEqual(Buffer.from(await (await (await bucket()).get(accepted.body.stored)).arrayBuffer()), Buffer.concat(chunks));
      const object = '{"a":'.repeat(128) + '0' + '}'.repeat(128);
      await assertStatus(await request('/ingest/synthetic', object, machine), 200);
      for (const body of ['['.repeat(129) + '0' + ']'.repeat(129),
        '{"a":'.repeat(129) + '0' + '}'.repeat(129), '['.repeat(20_000) + ']'.repeat(20_000)]) {
        const response = await request('/ingest/synthetic', body, machine);
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: 'JSON nesting exceeds 128 containers' });
      }
      assert.equal((await records('raw/')).length, before + 2);
      assert.equal((await records('staging/')).length, 0);
      await assertStatus(await request('/ingest/synthetic', '{"depth_recovery":true}', machine), 200);
    });
    await t.test('99,999,999-byte JSON string validates and persists without whole-body buffering', async () => {
      await largeJSON(machine);
    });
    await t.test('authenticated backfill returns 200 only with 11 durable items and a committed cursor', async () => {
      await poll(poller);
      assert.equal((await records('raw/hevy/')).length, 11);
      assert.ok((await cursor()).since);
      assert.deepEqual(calls.map(call => call.page), [1, 2]);
      assert.deepEqual(await (await request('/healthz', undefined, machine)).json(), { ok: true, revision: 'candidate-A' });
    });
    await t.test('partial poll failure returns empty 503, preserves writes/cursor; retry dedupes', async () => {
      const previous = await cursor();
      mode = 'partial';
      await poll(poller, 503);
      assert.deepEqual(await cursor(), previous);
      assert.equal((await records('raw/hevy/')).length, 21);
      mode = 'events';
      await poll(poller);
      assert.equal((await records('raw/hevy/')).length, 22);
      assert.notDeepEqual(await cursor(), previous);
    });
    await t.test('malformed upstream 200 and redirects fail closed without moving the cursor', async () => {
      const previous = await cursor();
      for (mode of ['malformed', 'redirect', 'invalid-zero']) {
        await poll(poller, 503);
        assert.deepEqual(await cursor(), previous);
      }
    });
    await t.test('both empty feed shapes advance the cursor without records, including empty backfill', async () => {
      const before = (await records('raw/')).length;
      for (mode of ['empty-zero', 'empty-one']) {
        const previous = await cursor();
        await poll(poller);
        assert.ok(Date.parse((await cursor()).since) > Date.parse(previous.since));
        assert.equal((await records('raw/')).length, before);
        await (await bucket()).delete('state/hevy.json');
        await poll(poller);
        assert.ok((await cursor()).since);
        assert.equal((await records('raw/')).length, before);
      }
    });
    await t.test('transient GET retries recover; rate limits wait for the next hourly call', async () => {
      mode = 'transient'; failures = 0;
      const before = calls.length;
      await poll(poller);
      assert.equal(calls.length - before, 4);
      const previous = await cursor();
      const requests = calls.length;
      mode = 'rate-limit';
      await poll(poller, 503);
      assert.equal(calls.length, requests + 1);
      assert.deepEqual(await cursor(), previous);
      assert.equal((await records('raw/hevy/')).length, 22);
    });
    await t.test('stale/invalid/future checkpoints fail health, failed poll stays stale, recovery restores 200', async () => {
      for (const invalid of ['{', 'null', '{}']) {
        await (await bucket()).put('state/hevy.json', invalid);
        const response = await request('/healthz', undefined, machine);
        assert.equal(response.status, 503);
        assert.equal((await response.json()).reason, 'hevy_stale');
      }
      for (const since of [new Date(Date.now() - 7_200_001).toISOString(), 'invalid', new Date(Date.now() + 60_000).toISOString()]) {
        await (await bucket()).put('state/hevy.json', JSON.stringify({ since }));
        const response = await request('/healthz', undefined, machine);
        assert.equal(response.status, 503);
        assert.equal((await response.json()).reason, 'hevy_stale');
      }
      const stale = { since: new Date(Date.now() - 7_200_001).toISOString() };
      await (await bucket()).put('state/hevy.json', JSON.stringify(stale));
      mode = 'malformed'; await poll(poller, 503);
      assert.deepEqual(await cursor(), stale);
      assert.equal((await request('/healthz', undefined, machine)).status, 503);
      mode = 'empty-zero'; await poll(poller);
      await assertStatus(await request('/healthz', undefined, machine), 200);
    });
    await t.test('overlapping HTTP polls report a lost cursor commit as empty 503, never false 200', async () => {
      mode = 'overlap'; overlapping = 0;
      overlap = new Promise(resolve => { releaseOverlap = resolve; });
      const before = await cursor();
      const replies = await Promise.all(Array.from({ length: 2 }, () => request('/internal/hevy-poll', '', poller)));
      assert.deepEqual(replies.map(response => response.status).sort(), [200, 503]);
      for (const reply of replies) {
        if (reply.status === 503) assert.equal(await reply.text(), '');
        else assert.deepEqual(await reply.json(), { ok: true });
      }
      assert.ok(Date.parse((await cursor()).since) > Date.parse(before.since));
      assert.equal((await records('raw/hevy/')).length, 22);
    });
    await t.test('code rollback and full runtime restart retain all accepted object bytes and cursor', async () => {
      const data = await bucket();
      const keys = (await records('')).map(object => object.key);
      const hashes = await Promise.all(keys.map(async key => bodyHash((await data.get(key)).body)));
      const previous = await cursor();
      await mf.dispose();
      mf = new Miniflare(options('previous-code-compatible'));
      await mf.ready;
      assert.equal((await (await request('/healthz', undefined, machine)).json()).revision, 'previous-code-compatible');
      for (const [index, key] of keys.entries()) assert.equal(await bodyHash((await (await bucket()).get(key)).body), hashes[index]);
      assert.deepEqual(await cursor(), previous);
      await assertStatus(await request('/ingest/synthetic', '{"accepted_after_recovery":true}', machine), 200);
    });
    await t.test('preview-verifier is rejected in a non-preview runtime', async () => {
      bindings.ACCESS_MACHINES = JSON.stringify([{ kind: 'machine', role: 'preview-verifier', client_id: 'synthetic-artoo', sources: ['artoo', 'synthetic'] }]);
      await mf.dispose();
      mf = new Miniflare(options());
      await mf.ready;
      await assertStatus(await request('/healthz', undefined, machine), 403);
      await assertStatus(await request('/ingest/synthetic', '{}', machine), 403);
      await assertStatus(await request('/preview/state', undefined, human), 404);
      await poll(machine, 403);
      await poll(human, 403);
    });
  } finally {
    await mf?.dispose();
    await rm(persistence, { recursive: true, force: true });
  }
});
