#!/usr/bin/env node
// Run the built Worker (cloudflare/build/worker.js) in local workerd behind an
// emulated Cloudflare Access edge, so shell clients drive it the way production
// clients do. Fictional identities, generated signing keys, loopback only.
//
//   node local-edge.mjs --state DIR --edge-port N --origin-port N --control-port N --hevy-url URL
//
// Edge (127.0.0.1:<edge-port>), the client-facing host:
//   - CF-Access-Client-Id/-Secret matching a synthetic service token -> signed
//     machine assertion (sub "", common_name = client id) forwarded to the Worker.
//   - CF_Authorization cookie from /cdn-cgi/access/login -> signed human assertion.
//   - Anything else, an unknown token or an expired session -> 302 to the login page,
//     as real Access does. Client-supplied Cf-Access-Jwt-Assertion is stripped.
//   GET  /cdn-cgi/access/login?email=E&redirect_url=/path  sets the session cookie.
//   GET  /cdn-cgi/access/logout                           clears it.
// Origin (127.0.0.1:<origin-port>): the Worker itself, no edge. Only for the
//   "bypass Access with a forged assertion" journey.
// Control (127.0.0.1:<control-port>), verification-only:
//   GET  /r2?prefix=P  lists keys, bytes and SHA256 of stored objects (second view of storage).
//   POST /sign {email|client_id, issuer?, audience?, ttl?, iat_offset?} returns an assertion
//        signed with this run's key, so the Worker's own issuer/audience/time checks can be
//        driven directly at the origin port.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const require = createRequire(path.join(repo, 'cloudflare', 'package.json'));
const { Miniflare } = require('miniflare');
const { exportJWK, generateKeyPair, importJWK, SignJWT } = await import(pathToFileURL(require.resolve('jose')));

const { values: args } = parseArgs({ options: {
  state: { type: 'string' }, 'edge-port': { type: 'string' }, 'origin-port': { type: 'string' },
  'control-port': { type: 'string' }, 'hevy-url': { type: 'string' },
} });
for (const name of ['state', 'edge-port', 'origin-port', 'control-port', 'hevy-url']) {
  if (!args[name]) { console.error(`--${name} is required`); process.exit(2); }
}
const hevy = new URL(args['hevy-url']);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(hevy.hostname)) {
  console.error('--hevy-url must be loopback; the real Hevy API is never contacted'); process.exit(2);
}

const ISSUER = 'https://synthetic-verify.cloudflareaccess.com';
const AUD = 'synthetic-verify-audience';
const OWNER = 'fictional-owner@example.invalid';
// Service tokens the emulated edge accepts. `unpinned` passes the edge but is
// not pinned in ACCESS_MACHINES, so the Worker itself must refuse it.
const TOKENS = {
  'synthetic-writer.access': { secret: 'synthetic-writer-secret', role: 'writer', sources: ['artoo', 'synthetic'] },
  'synthetic-poller.access': { secret: 'synthetic-poller-secret', role: 'poll-only', sources: [] },
  'synthetic-unpinned.access': { secret: 'synthetic-unpinned-secret', role: null, sources: [] },
};

await mkdir(path.join(args.state, 'r2'), { recursive: true });
// Keep one signing key per state directory so sessions survive an edge restart.
const keyFile = path.join(args.state, 'signing-key.json');
let privateKey, jwk;
try {
  const saved = JSON.parse(await readFile(keyFile, 'utf8'));
  privateKey = await importJWK(saved.private, 'RS256');
  jwk = saved.public;
} catch {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  jwk = { ...await exportJWK(pair.publicKey), kid: 'synthetic-verify', alg: 'RS256', use: 'sig' };
  await writeFile(keyFile, JSON.stringify({ private: await exportJWK(pair.privateKey), public: jwk }), { mode: 0o600 });
}
const sign = (claims, ttl, { issuer = ISSUER, audience = AUD, iatOffset = 0 } = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-verify' })
    .setIssuer(issuer).setAudience(audience).setIssuedAt(now + iatOffset).setExpirationTime(now + ttl)
    .sign(privateKey);
};

const script = await readFile(path.join(repo, 'cloudflare', 'build', 'worker.js'), 'utf8');
const vars = {
  RELEASE: process.env.VERIFY_RELEASE || 'verify-local', ACCESS_ISSUER: ISSUER, ACCESS_AUD: AUD,
  ACCESS_HUMAN_EMAILS: JSON.stringify([OWNER]),
  ACCESS_MACHINES: JSON.stringify(Object.entries(TOKENS).filter(([, t]) => t.role)
    .map(([client_id, t]) => ({ kind: 'machine', role: t.role, client_id, sources: t.sources }))),
  HEVY_API_KEY: '00000000-0000-4000-8000-000000000000',
};
const mf = new Miniflare({
  host: '127.0.0.1', port: Number(args['origin-port']),
  resourcePersistencePath: path.join(args.state, 'r2'), telemetry: { enabled: false }, cf: false,
  workers: [{ config: {
    name: 'health-ingest-verify', compatibilityDate: '2026-10-15', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: script } } },
    env: { ...Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { type: 'json', value: v }])),
      DATA: { type: 'r2', name: 'synthetic-records' } },
  }, dev: { outboundService: { type: 'fetcher', handler: async request => {
    const url = new URL(request.url);
    if (url.href === `${ISSUER}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    if (url.origin === 'https://api.hevyapp.com') {
      const target = new URL(url.pathname + url.search, hevy);
      return fetch(target, { method: request.method, headers: request.headers, redirect: 'manual' });
    }
    return new Response('verification edge: outbound host not allowed', { status: 502 });
  } } } }],
});
const origin = await mf.ready;

function cookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim().split('=')).filter(([k]) => k));
}
function redirectToLogin(res, url) {
  const login = `/cdn-cgi/access/login?redirect_url=${encodeURIComponent(url.pathname)}`;
  res.writeHead(302, { Location: login, 'Content-Length': 0 }).end();
}
async function assertionFor(req) {
  const id = req.headers['cf-access-client-id'];
  if (id !== undefined) {
    const token = TOKENS[id];
    if (!token || req.headers['cf-access-client-secret'] !== token.secret) return null;
    return sign({ sub: '', common_name: id }, 300);
  }
  const session = cookies(req.headers.cookie).CF_Authorization;
  if (!session) return null;
  try {
    const claims = JSON.parse(Buffer.from(session.split('.')[1], 'base64url'));
    if (claims.exp <= Date.now() / 1000) return null; // Access re-prompts on expiry.
  } catch { return null; }
  return session;
}

const edge = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://edge.invalid');
  try {
    if (url.pathname === '/cdn-cgi/access/login') {
      const email = url.searchParams.get('email');
      if (!email) {
        const body = `<!doctype html><title>Sign in · local Access emulation</title><h1>Sign in</h1>
<p>Local emulation of Cloudflare Access. Choose the identity: GET this page with <code>?email=</code>.</p>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }).end(body);
        return;
      }
      const ttl = Number(url.searchParams.get('ttl') || 3600);
      const jwt = await sign({ sub: `synthetic-${createHash('sha256').update(email).digest('hex').slice(0, 12)}`, email }, ttl);
      res.writeHead(302, { Location: url.searchParams.get('redirect_url') || '/healthz',
        'Set-Cookie': `CF_Authorization=${jwt}; Path=/; HttpOnly; SameSite=Lax`, 'Content-Length': 0 }).end();
      return;
    }
    if (url.pathname === '/cdn-cgi/access/logout') {
      res.writeHead(200, { 'Set-Cookie': 'CF_Authorization=; Path=/; Max-Age=0', 'Content-Length': 0 }).end();
      return;
    }
    const assertion = await assertionFor(req);
    if (!assertion) { req.resume(); redirectToLogin(res, url); return; }
    const headers = { ...req.headers };
    for (const name of ['host', 'cf-access-client-id', 'cf-access-client-secret', 'cf-access-jwt-assertion', 'cookie',
      'connection', 'transfer-encoding']) delete headers[name];
    headers['cf-access-jwt-assertion'] = assertion;
    // A chunked request arrives with no Content-Length and is forwarded the same way,
    // so the Worker's own 411 answers it; an explicit Content-Length: 0 stays as sent.
    const hasBody = !['GET', 'HEAD'].includes(req.method) && headers['content-length'] !== '0';
    const response = await fetch(new URL(url.pathname + url.search, origin), {
      method: req.method, headers, body: hasBody ? req : undefined, duplex: hasBody ? 'half' : undefined, redirect: 'manual',
    });
    const out = Object.fromEntries([...response.headers].filter(([k]) => k !== 'content-encoding' && k !== 'transfer-encoding'));
    const bytes = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, { ...out, 'content-length': bytes.length }).end(bytes);
  } catch (error) {
    res.writeHead(502, { 'Content-Type': 'text/plain' }).end('verification edge error\n');
    console.error('edge error:', error.message);
  }
});

const control = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://control.invalid');
  if (req.method === 'POST' && url.pathname === '/sign') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let claims;
    try { claims = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { claims = null; }
    if (!claims || typeof claims !== 'object' || (!claims.email === !claims.client_id)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('give JSON with exactly one of email or client_id\n');
      return;
    }
    const subject = claims.email ? { sub: 'synthetic-signed', email: claims.email } : { sub: '', common_name: claims.client_id };
    const jwt = await sign(subject, claims.ttl ?? 300,
      { issuer: claims.issuer, audience: claims.audience, iatOffset: claims.iat_offset ?? 0 });
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(jwt);
    return;
  }
  if (req.method !== 'GET' || url.pathname !== '/r2') { res.writeHead(404).end(); return; }
  const bucket = await mf.getR2Bucket('DATA');
  const listing = await bucket.list({ prefix: url.searchParams.get('prefix') || '' });
  const objects = [];
  for (const object of listing.objects) {
    const stored = await bucket.get(object.key);
    const hash = createHash('sha256').update(Buffer.from(await stored.arrayBuffer())).digest('hex');
    objects.push({ key: object.key, bytes: object.size, sha256: hash });
  }
  const body = JSON.stringify({ objects, truncated: listing.truncated });
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
});

await new Promise(resolve => edge.listen(Number(args['edge-port']), '127.0.0.1', resolve));
await new Promise(resolve => control.listen(Number(args['control-port']), '127.0.0.1', resolve));
console.log(`local-edge ready edge=http://127.0.0.1:${args['edge-port']} origin=${origin.href} control=http://127.0.0.1:${args['control-port']}`);
const stop = async () => { edge.close(); control.close(); await mf.dispose(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
