import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { jsonVerifier } from 'stream-json/core/utils/verifier.js';
import { none } from 'stream-chain/core';
import { observe, reportFailure } from './telemetry.mjs';

// Strictly under the owner's 100 MB edge contract; no multipart client protocol.
const MAX_BODY = 100_000_000;
const MAX_JSON_DEPTH = 128;
const CURSOR = 'state/hevy.json';
const HEVY_STALE_MS = 2 * 60 * 60 * 1000;
const HEVY = 'https://api.hevyapp.com';
const jwks = new Map();

class Refusal extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (body, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store' },
});

async function identity(request, env) {
  if (!env.ACCESS_ISSUER || !env.ACCESS_AUD) throw new Refusal(503, 'access not configured');
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion) throw new Refusal(403, 'forbidden');
  try {
    if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER)) throw Error();
    if (!jwks.has(env.ACCESS_ISSUER)) jwks.set(env.ACCESS_ISSUER, createRemoteJWKSet(
      new URL(`${env.ACCESS_ISSUER}/cdn-cgi/access/certs`), { timeoutDuration: 5000 },
    ));
    const { payload } = await jwtVerify(assertion, jwks.get(env.ACCESS_ISSUER), {
      algorithms: ['RS256'], issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUD,
      requiredClaims: ['exp', 'iat', 'sub'],
    });
    if (typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000) throw Error();
    const humans = JSON.parse(env.ACCESS_HUMAN_EMAILS || '[]');
    if (typeof payload.sub === 'string' && payload.sub && Array.isArray(humans) &&
        humans.includes(payload.email) && !payload.common_name) {
      return { kind: 'human', sources: ['*'] };
    }
    // Access service tokens have an empty sub. Only exact pinned machine IDs qualify.
    if (payload.sub === '' && typeof payload.common_name === 'string' && !payload.email) {
      const machine = JSON.parse(env.ACCESS_MACHINES).find(item => item.kind === 'machine' &&
        item.client_id && item.client_id === payload.common_name && Array.isArray(item.sources));
      if (machine && (['writer', 'poll-only'].includes(machine.role) ||
          (machine.role === 'preview-verifier' && env.PREVIEW === 'synthetic'))) return machine;
    }
  } catch { /* Never include assertions, identity claims or library errors in diagnostics. */ }
  throw new Refusal(403, 'forbidden');
}

function receipt(object) {
  return { status: 'ok', source: object.customMetadata.source, stored: object.key,
    bytes: object.size, sha256: object.customMetadata.sha256,
    received_at: object.customMetadata.received_at };
}

async function publish(bucket, source, sha256, body, metadata) {
  const key = `raw/${source}/${sha256}`;
  const existing = await bucket.head(key);
  if (existing) return receipt(existing);
  const object = await bucket.put(key, body, {
    onlyIf: { etagDoesNotMatch: '*' }, sha256,
    customMetadata: { source, sha256, received_at: new Date().toISOString() },
    httpMetadata: { contentType: metadata, cacheControl: 'private, no-store' },
  });
  const accepted = object || await bucket.head(key);
  if (!accepted || accepted.size <= 0 || accepted.customMetadata.sha256 !== sha256) throw Error('storage');
  return receipt(accepted);
}

// Only count containers here; jsonVerifier remains the syntax authority. Skipping
// ordinary text keeps large string uploads cheap, including across chunk escapes.
function depthLimiter() {
  let depth = 0, quoted = false, escaped = false;
  const syntax = /["\\\[\]{}]/g;
  return text => {
    syntax.lastIndex = escaped ? 1 : 0;
    escaped = escaped && text.length === 0;
    let match;
    while ((match = syntax.exec(text))) {
      const char = match[0];
      if (quoted && char === '\\') {
        syntax.lastIndex = match.index + 2;
        escaped = match.index + 1 === text.length;
      } else if (char === '"') quoted = !quoted;
      else if (!quoted && (char === '[' || char === '{')) {
        if (++depth > MAX_JSON_DEPTH) throw new Refusal(400, `JSON nesting exceeds ${MAX_JSON_DEPTH} containers`);
      } else if (!quoted && (char === ']' || char === '}')) depth--;
    }
  };
}

async function ingest(request, env, source) {
  const value = request.headers.get('Content-Length');
  if (!value || !/^\d+$/.test(value)) throw new Refusal(411, 'Content-Length required');
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length >= MAX_BODY) throw new Refusal(413, 'batch must be under 100 MB');
  if (length <= 0 || !request.body) throw new Refusal(400, 'empty body');
  const archive = source === 'artoo';
  const type = request.headers.get('Content-Type')?.split(';')[0].trim();
  if (archive && type !== 'application/gzip') throw new Refusal(415, 'application/gzip required');
  const stage = `staging/${crypto.randomUUID()}`;
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const validate = archive ? null : jsonVerifier();
  const limitDepth = depthLimiter();
  let count = 0;
  // Fixed length keeps R2 writes streaming; neither archives nor JSON are buffered.
  const fixed = new FixedLengthStream(length);
  const abort = new AbortController();
  const pipe = request.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      count += chunk.byteLength;
      if (count > length) throw new Refusal(400, 'body length mismatch');
      hash.update(chunk);
      if (validate) {
        let text;
        try { text = decoder.decode(chunk, { stream: true }); }
        catch { throw new Refusal(400, 'invalid JSON'); }
        limitDepth(text);
        try { validate(text); }
        catch { throw new Refusal(400, 'invalid JSON'); }
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (count !== length) throw new Refusal(400, 'body length mismatch');
      if (validate) {
        let text;
        try { text = decoder.decode(); }
        catch { throw new Refusal(400, 'invalid JSON'); }
        limitDepth(text);
        try { validate(text); validate(none); }
        catch { throw new Refusal(400, 'invalid JSON'); }
      }
    },
  })).pipeTo(fixed.writable, { signal: abort.signal });
  // Await both sides before cleanup: R2 may finish after the validator rejects
  // its final chunk. Deleting a stage before that put settles leaves an orphan.
  try {
    const upload = env.DATA.put(stage, fixed.readable).catch(error => {
      abort.abort();
      throw error;
    });
    const results = await Promise.allSettled([pipe, upload]);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    const staged = await env.DATA.get(stage);
    if (!staged || staged.size !== length) throw Error('storage');
    return await publish(env.DATA, source, hash.digest('hex'), staged.body,
      archive ? 'application/gzip' : 'application/json');
  } finally {
    await env.DATA.delete(stage);
  }
}

// Deterministic bytes make a repeated Hevy event independent of page/cursor ordering.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]),
  );
  return value;
}

async function page(env, path, params) {
  const url = new URL(path, HEVY);
  url.search = new URLSearchParams(params).toString();
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      const get = env.PREVIEW === 'synthetic' ? env.HEVY_STUB.fetch.bind(env.HEVY_STUB) : fetch;
      response = await get(url, { method: 'GET', redirect: 'manual',
        headers: { 'api-key': env.HEVY_API_KEY, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000) });
    } catch { if (attempt === 2) throw Error('hevy network'); else continue; }
    if (response.ok) return response.json();
    await response.body?.cancel();
    // Rate limits wait until the next hourly HTTP invocation, not a tight retry.
    if (response.status === 429 || response.status < 500 || attempt === 2) throw Error('hevy status');
  }
}

async function poll(env) {
  if (!env.HEVY_API_KEY) throw Error('hevy not configured');
  const previous = await env.DATA.get(CURSOR);
  const state = previous ? await previous.json() : null;
  if (state && (!state.since || !Number.isFinite(Date.parse(state.since)))) throw Error('cursor');
  const started = new Date().toISOString();
  if (state && Date.parse(state.since) > Date.parse(started)) throw Error('cursor');
  const backfill = !state;
  const key = backfill ? 'workouts' : 'events';
  const path = backfill ? '/v1/workouts' : '/v1/workouts/events';
  let expectedPages;
  for (let number = 1; ; number++) {
    const body = await page(env, path, { page: number, pageSize: 10,
      ...(backfill ? {} : { since: state.since }) });
    const empty = number === 1 && body?.page_count === 0 && Array.isArray(body[key]) && body[key].length === 0;
    if (!Number.isInteger(body?.page_count) || (!empty && body.page_count < number) ||
        body.page_count > 1000 || !Array.isArray(body[key]) || body[key].length > 10 ||
        (body.page !== undefined && body.page !== number) ||
        (body[key].length === 0 && number < body.page_count) ||
        (expectedPages !== undefined && body.page_count !== expectedPages)) throw Error('hevy schema');
    expectedPages = body.page_count;
    for (const item of body[key]) {
      // Preserve raw item fields. Validate only the common envelope, never normalize records.
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('hevy item');
      const id = backfill ? item.id : item.type === 'updated' ? item.workout?.id :
        item.type === 'deleted' ? item.id : null;
      if (typeof id !== 'string' || !id) throw Error('hevy item identity');
      const bytes = JSON.stringify(canonical({ kind: backfill ? 'backfill' : 'events', [key]: [item] }));
      await publish(env.DATA, 'hevy', createHash('sha256').update(bytes).digest('hex'), bytes, 'application/json');
    }
    if (empty || number === expectedPages) break;
  }
  // Conditional commit: overlapping triggers may write immutable items, but cannot
  // replace another run's checkpoint. Failed/partial runs leave the cursor intact.
  const committed = await env.DATA.put(CURSOR, JSON.stringify({ since: started }), {
    onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
  if (!committed) throw Error('concurrent poll; retry next trigger');
}

export default observe({
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      const who = await identity(request, env);
      if (path === '/internal/hevy-poll') {
        if (who.role !== 'poll-only' && who.role !== 'preview-verifier') throw new Refusal(403, 'forbidden');
        if (request.method !== 'POST') throw new Refusal(405, 'method not allowed');
        await poll(env);
        return json({ ok: true });
      }
      if (who.role === 'poll-only') throw new Refusal(403, 'forbidden');
      if (path === '/healthz') {
        if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
        const cursor = await env.DATA.get(CURSOR);
        if (!cursor) return json({ ok: false, revision: env.RELEASE, reason: 'hevy_never_polled' }, 503);
        let since = NaN;
        try { since = Date.parse((await cursor.json())?.since); } catch { /* Invalid checkpoint is stale, never healthy. */ }
        const age = Date.now() - since;
        if (!Number.isFinite(age) || age < 0 || age > HEVY_STALE_MS) {
          return json({ ok: false, revision: env.RELEASE, reason: 'hevy_stale' }, 503);
        }
        return json({ ok: true, revision: env.RELEASE });
      }
      if (env.PREVIEW === 'synthetic' && who.role === 'preview-verifier' && path.startsWith('/preview/')) {
        if (path === '/preview/state' && request.method === 'GET') {
          const objects = await env.DATA.list();
          if (objects.truncated) throw Error('preview exceeded bounded fixture size');
          const records = [];
          for (const object of objects.objects) {
            const stored = await env.DATA.get(object.key);
            const hash = createHash('sha256');
            for await (const chunk of stored.body) hash.update(chunk);
            records.push({ key: object.key, bytes: stored.size, sha256: hash.digest('hex') });
          }
          const cursor = await env.DATA.get(CURSOR);
          return json({ records, cursor: cursor ? await cursor.json() : null });
        }
        if (/^\/preview\/mode\/(backfill|partial|events|malformed|transient|empty-zero|empty-one|invalid-zero)$/.test(path) && request.method === 'POST') {
          return env.HEVY_STUB.fetch(`https://control.invalid${path}`, { method: 'POST' });
        }
      }
      // HAE has a separate receiver; no competing endpoint is deployed.
      if (path === '/hae' || path === '/ingest/healthautoexport') return json({ error: 'not found' }, 404);
      const source = path === '/artoo/snapshot' ? 'artoo' : /^\/ingest\/([a-zA-Z0-9-]+)$/.exec(path)?.[1];
      if (!source) return json({ error: 'not found' }, 404);
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      if (!who.sources.includes('*') && !who.sources.includes(source)) throw new Refusal(403, 'forbidden');
      return json(await ingest(request, env, source));
    } catch (error) {
      if (path === '/internal/hevy-poll') {
        const event = error instanceof Refusal ? null : reportFailure('hevy_poll_failed');
        return new Response(null, { status: error instanceof Refusal ? error.status : 503,
          headers: { 'Cache-Control': 'no-store', ...(event ? { 'X-Health-Ingest-Event': event } : {}) } });
      }
      if (error instanceof Refusal) return json({ error: error.message }, error.status);
      reportFailure('request_failed');
      return json({ error: 'temporarily unavailable' }, 503);
    }
  },
});
