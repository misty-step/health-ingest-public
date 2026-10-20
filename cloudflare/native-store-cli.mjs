// Bundle once; run the verified artifact through the operator's credential path.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { auditNative, importNative, restoreNative } from './native-store.mjs';
import { R2Bucket } from './r2-bucket.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    directory: { type: 'string' }, account: { type: 'string' }, bucket: { type: 'string' },
  } });
  const [operation] = positionals;
  if (positionals.length !== 1 || !['audit', 'import', 'restore'].includes(operation) || !values.directory) throw Error();
  let result;
  if (operation === 'audit') result = await auditNative(values.directory);
  else {
    let token;
    for await (const line of createInterface({ input: process.stdin })) { token = line.trim(); break; }
    const bucket = await R2Bucket.fromToken({ account: values.account, bucket: values.bucket, token });
    result = operation === 'import' ? await importNative(values.directory, bucket) : await restoreNative(bucket, values.directory);
  }
  console.log(JSON.stringify({ operation, ...result }));
} catch {
  console.error('Native store operation failed; no completed migration/restore claimed.');
  process.exitCode = 1;
}
