import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ensureStageExpiry } from './staging-expiry.mjs';

const issuer = 'https://synthetic.cloudflareaccess.com';
const canary = 'PRIVATE_HEALTH_CANARY_NEVER_TELEMETRY';
const upstreamKey = 'PRIVATE_HEVY_CREDENTIAL_CANARY';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'telemetry-test', alg: 'RS256', use: 'sig' };
const sign = role => new SignJWT({ sub: '', common_name: role })
  .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setAudience('fictional-audience')
  .setIssuedAt().setExpirationTime('5m').sign(privateKey);
const script = await readFile(new URL('./build/worker.js', import.meta.url), 'utf8');

test('actual Worker SDK transport is allowlisted, isolated and does not stall on an unavailable sink', async () => {
  const persistence = await mkdtemp(path.join(tmpdir(), 'health-ingest-telemetry-'));
  const envelopes = [];
  let mode = 'fail', sink = 'ok', notify;
  const mf = new Miniflare({ resourcePersistencePath: persistence, telemetry: { enabled: false }, cf: false,
    workers: [{ config: {
      name: 'health-ingest-telemetry-test', compatibilityDate: '2026-10-15', compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: script } } },
      env: { ...Object.fromEntries(Object.entries({
        RELEASE: 'synthetic-candidate', ACCESS_ISSUER: issuer, ACCESS_AUD: 'fictional-audience',
        ACCESS_MACHINES: JSON.stringify([
          { kind: 'machine', role: 'writer', client_id: 'writer', sources: ['synthetic'] },
          { kind: 'machine', role: 'poll-only', client_id: 'poller', sources: [] },
        ]), HEVY_API_KEY: upstreamKey, SENTRY_DSN: 'https://fictional@sentry.synthetic.invalid/1',
      }).map(([name, value]) => [name, { type: 'json', value }])), DATA: { type: 'r2', name: 'fictional-telemetry' } },
    }, dev: { outboundService: { type: 'fetcher', handler: async request => {
      const url = new URL(request.url);
      if (url.href === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
      if (url.origin === 'https://api.hevyapp.com') {
        assert.equal(request.headers.get('api-key'), upstreamKey);
        if (mode === 'fail') return new Response(canary, { status: 500 });
        if (mode === 'invalid') return new Response(canary, { headers: { 'Content-Type': 'application/json' } });
        return Response.json({ page: 1, page_count: 0, workouts: [], events: [] });
      }
      assert.equal(url.origin, 'https://sentry.synthetic.invalid');
      const raw = await request.text();
      envelopes.push(raw); notify?.();
      if (sink === 'slow') await new Promise(resolve => setTimeout(resolve, 1200));
      if (sink === 'offline') throw Error(canary);
      return Response.json({}, { status: sink === 'ok' ? 200 : 503 });
    } } } }],
  });
  const worker = await mf.getWorker();
  const writer = await sign('writer'), poller = await sign('poller');
  const request = (route, jwt, body) => worker.fetch(`https://health.invalid${route}?private=${canary}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Cf-Access-Jwt-Assertion': jwt || '', Cookie: canary, 'X-Private-Canary': canary,
      'sentry-trace': '12345678901234567890123456789012-1234567890123456-1',
      baggage: `private=${canary},sentry-sampled=true,sentry-public_key=fictional`,
      ...(body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(body)), 'Content-Type': 'application/json' }) }, body,
  });
  async function failedPoll() {
    let timeout;
    const delivered = new Promise((resolve, reject) => {
      notify = resolve; timeout = setTimeout(() => reject(Error('No SDK envelope received')), 5000);
    });
    const started = Date.now();
    const response = await request('/internal/hevy-poll', poller, '');
    const elapsed = Date.now() - started;
    assert.equal(response.status, 503); assert.equal(await response.text(), '');
    const id = response.headers.get('X-Health-Ingest-Event');
    assert.match(id, /^[a-f0-9]{32}$/);
    try { await delivered; } finally { clearTimeout(timeout); notify = null; }
    const lines = envelopes.at(-1).trim().split('\n');
    assert.equal(lines.length, 3, 'Only one event per envelope, no attachments/metrics/trace items');
    assert.equal(JSON.parse(lines[1]).type, 'event');
    const event = JSON.parse(lines[2]);
    assert.equal(event.event_id, id);
    assert.deepEqual(Object.keys(event).sort(), ['environment', 'event_id', 'fingerprint', 'level', 'message', 'platform', 'release', 'sdk', 'tags', 'timestamp', 'user'].sort());
    assert.deepEqual(event.sdk.settings, { infer_ip: 'never' });
    assert.deepEqual(event.user, { geo: {} });
    assert.equal(event.sdk.version, '11.8.0');
    assert.ok(event.sdk.name.startsWith('sentry.javascript.'));
    assert.equal(event.release, 'synthetic-candidate');
    assert.equal(event.environment, 'health-ingest-production');
    assert.deepEqual(event.tags, { service: 'health-ingest', failure_code: 'hevy_poll_failed' });
    assert.deepEqual(event.fingerprint, ['health-ingest', 'hevy_poll_failed']);
    for (const value of [canary, upstreamKey, writer, poller, 'health.invalid', 'api.hevyapp.com', 'raw/', 'state/']) {
      assert.ok(!envelopes.at(-1).includes(value), `Private input escaped into envelope: ${value.slice(0, 12)}`);
    }
    return elapsed;
  }
  try {
    assert.equal((await request('/ingest/synthetic', null, canary)).status, 403);
    assert.equal((await request('/ingest/synthetic', writer, '{')).status, 400);
    const accepted = await request('/ingest/synthetic', writer, JSON.stringify({ private: canary }));
    assert.equal(accepted.status, 200);
    const receipt = await accepted.json();
    assert.equal(envelopes.length, 0, 'Refusals and successful writes are not incidents');
    await failedPoll();
    mode = 'invalid'; await failedPoll();
    sink = 'offline'; await failedPoll();
    sink = 'slow'; assert.ok(await failedPoll() < 1000, 'Telemetry must not hold the poll response');
    mode = 'empty';
    assert.equal((await request('/internal/hevy-poll', poller, '')).status, 200);
    assert.equal((await request('/healthz', writer)).status, 200);
    const replay = await request('/ingest/synthetic', writer, JSON.stringify({ private: canary }));
    assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), receipt);
    assert.equal(envelopes.length, 4, 'Recovery does not emit a second error or leak accepted content');
  } finally { await mf.dispose(); await rm(persistence, { recursive: true, force: true }); }
});

test('lifecycle refuses accepted-data expiry before mutation and preserves unrelated rules', async () => {
  let rules = [{ id: 'native-abort-only', enabled: true, conditions: { prefix: '' },
    abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 604800 } } }];
  let writes = 0;
  const api = async (route, method, body) => {
    assert.equal(route, '/r2/buckets/fictional/lifecycle');
    if (method === 'PUT') { writes++; rules = structuredClone(body.rules); }
    return { rules: structuredClone(rules) };
  };
  assert.equal((await ensureStageExpiry(api, 'fictional')).accepted_data_expiry, false);
  const first = structuredClone(rules);
  await ensureStageExpiry(api, 'fictional'); assert.deepEqual(rules, first);
  assert.equal(rules.length, 2); assert.equal(writes, 2);
  for (const prefix of ['', 'raw/', 'legacy/', 'state/']) {
    rules = [{ id: 'unknown-expiry', enabled: true, conditions: { prefix }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 1 } } }];
    await assert.rejects(ensureStageExpiry(api, 'fictional'), /Unexpected accepted-data expiry/);
    assert.equal(writes, 2);
  }
});
