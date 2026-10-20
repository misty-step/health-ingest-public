import assert from 'node:assert/strict';

const expiry = {
  id: 'health-ingest-abandoned-staging', enabled: true,
  conditions: { prefix: 'staging/' },
  deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } },
};

export async function ensureStageExpiry(api, bucket) {
  const path = `/r2/buckets/${bucket}/lifecycle`;
  const before = (await api(path)).rules || [];
  // Never shorten retention of accepted records or overwrite an unknown rule.
  for (const rule of before) {
    assert.ok(!rule.enabled || !rule.deleteObjectsTransition ||
      rule.conditions?.prefix === 'staging/', 'Unexpected accepted-data expiry; inspect before deployment');
  }
  const rules = [...before.filter(rule => rule.id !== expiry.id), expiry];
  await api(path, 'PUT', { rules });
  const after = (await api(path)).rules;
  assert.deepEqual(after, rules);
  return { staging_expiry_seconds: expiry.deleteObjectsTransition.condition.maxAge,
    accepted_data_expiry: false, provider_readback: true };
}
