// Existing scoped Cloudflare API token, operator/CI memory only. S3 credentials
// are the documented token ID + SHA256(token), not a newly minted credential.
import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';

export class R2Bucket {
  static async fromToken({ account, bucket, token }) {
    if (!/^[a-f0-9]{32}$/.test(account) || !token) throw Error('invalid R2 binding');
    for (const prefix of ['user', `accounts/${account}`]) {
      let response;
      try { response = await fetch(`https://api.cloudflare.com/client/v4/${prefix}/tokens/verify`, {
        headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(60_000),
      }); } catch { throw Error('token identity unavailable'); }
      const payload = await response.json();
      if (response.ok && payload.success && payload.result?.status === 'active') {
        return new R2Bucket({ account, bucket, token, tokenId: payload.result.id });
      }
    }
    throw Error('token identity unavailable');
  }
  constructor({ account, bucket, tokenId, token }) {
    if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-f0-9]{32}$/.test(tokenId) ||
        !/^[a-z0-9-]{3,63}$/.test(bucket) || !token) throw Error('invalid R2 binding');
    this.account = account; this.bucket = bucket; this.token = token;
    this.client = new AwsClient({ accessKeyId: tokenId,
      secretAccessKey: createHash('sha256').update(token).digest('hex'),
      service: 's3', region: 'auto', retries: 0 });
  }
  async get(key) {
    const response = await this.request(key, 'GET');
    if (response.status === 404) return null;
    if (response.status !== 200) { await response.body?.cancel(); throw Error('R2 get failed'); }
    const etag = response.headers.get('etag');
    if (!/^"[^"]+"$/.test(etag || '')) { await response.body?.cancel(); throw Error('R2 strong ETag unavailable'); }
    return { size: Number(response.headers.get('content-length')),
      etag: etag.slice(1, -1), body: response.body,
      customMetadata: Object.fromEntries([...response.headers].filter(([name]) => name.startsWith('x-amz-meta-'))
        .map(([name, value]) => [name.slice(11), value])),
      arrayBuffer: () => response.arrayBuffer(), text: () => response.text(), json: () => response.json() };
  }
  async put(key, body, options = {}) {
    const headers = { 'Content-Type': options.httpMetadata?.contentType || 'application/octet-stream',
      'Cache-Control': options.httpMetadata?.cacheControl || 'private, no-store',
      ...Object.fromEntries(Object.entries(options.customMetadata || {}).map(([name, value]) => [`x-amz-meta-${name}`, value])),
    };
    if (options.onlyIf?.etagMatches) headers['If-Match'] = `"${options.onlyIf.etagMatches}"`;
    if (options.onlyIf?.etagDoesNotMatch) headers['If-None-Match'] = options.onlyIf.etagDoesNotMatch === '*' ? '*' : `"${options.onlyIf.etagDoesNotMatch}"`;
    if (options.sha256) headers['x-amz-checksum-sha256'] = Buffer.from(options.sha256, 'hex').toString('base64');
    const response = await this.request(key, 'PUT', body, headers);
    await response.body?.cancel();
    if (response.status === 412) return null;
    if (response.status !== 200) throw Error('R2 put failed');
    return { key, etag: response.headers.get('etag')?.replaceAll('"', '') };
  }
  async request(key, method, body, headers = {}) {
    const escaped = key.split('/').map(encodeURIComponent).join('/');
    try {
      return await this.client.fetch(`https://${this.account}.r2.cloudflarestorage.com/${this.bucket}/${escaped}`, {
        method, body, headers: { 'Accept-Encoding': 'identity', ...headers },
        redirect: 'error', signal: AbortSignal.timeout(300_000),
      });
    } catch { throw Error('R2 transport failed'); }
  }
  async list({ prefix = '', cursor } = {}) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${this.account}/r2/buckets/${this.bucket}/objects`);
    url.search = new URLSearchParams({ prefix, per_page: '1000', ...(cursor ? { cursor } : {}) }).toString();
    let response;
    try { response = await fetch(url, { redirect: 'error', headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(60_000) }); }
    catch { throw Error('R2 listing failed'); }
    if (!response.ok) { await response.body?.cancel(); throw Error('R2 listing failed'); }
    const payload = await response.json();
    if (!payload.success || !Array.isArray(payload.result)) throw Error('R2 listing failed');
    return { objects: payload.result.map(row => ({ key: row.key, size: row.size, etag: row.etag,
      customMetadata: row.custom_metadata || {} })), truncated: payload.result_info?.is_truncated === true,
      cursor: payload.result_info?.cursor };
  }
}
