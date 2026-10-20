import { captureEvent, withSentry } from '@sentry/cloudflare';

const codes = new Set(['hevy_poll_failed', 'request_failed', 'unexpected_failure']);

export function reportFailure(code) {
  // No caught Error or Request ever enters the SDK.
  return captureEvent({ level: 'error', tags: { failure_code: code } });
}

export function observe(handler) {
  return withSentry(env => ({
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    release: env.RELEASE,
    environment: env.PREVIEW === 'synthetic' ? 'health-ingest-preview' : 'health-ingest-production',
    defaultIntegrations: false,
    cacheClient: false,
    dataCollection: {
      userInfo: false, cookies: false, httpHeaders: false, httpBodies: [],
      urlQueryParams: false, graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false }, databaseQueryData: false,
      queues: false, stackFrameVariables: false, frameContextLines: 0,
    },
    sendClientReports: false,
    maxBreadcrumbs: 0,
    tracesSampler: () => 0,
    tracePropagationTargets: [],
    enableLogs: false,
    transportOptions: { bufferSize: 2, fetchOptions: { signal: AbortSignal.timeout(1500) } },
    beforeSend(event) {
      const code = codes.has(event.tags?.failure_code) ? event.tags.failure_code : 'unexpected_failure';
      // Reconstruct, don't redact: SDK-added request/context/exception fields are
      // not part of this private service's telemetry contract, now or after upgrades.
      return {
        event_id: event.event_id, timestamp: event.timestamp, platform: 'javascript',
        level: 'error', message: `health-ingest ${code}`,
        // Relay's JavaScript legacy mode infers IP/geo even for an omitted or
        // null user IP. Use its native SDK setting, not an anonymized placeholder.
        sdk: { settings: { infer_ip: 'never' } },
        // Relay also geolocates the transport independently of IP inference.
        // An explicitly empty Geo interface prevents that enrichment.
        user: { geo: {} },
        release: env.RELEASE,
        environment: env.PREVIEW === 'synthetic' ? 'health-ingest-preview' : 'health-ingest-production',
        tags: { service: 'health-ingest', failure_code: code },
        fingerprint: ['health-ingest', code],
      };
    },
  }), handler);
}
