// No external route, credentials or real health data. Preview service binding only.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const setting = /^\/preview\/mode\/(backfill|partial|events|malformed|transient|empty-zero|empty-one|invalid-zero)$/.exec(url.pathname);
    if (url.origin === 'https://control.invalid' && request.method === 'POST' && setting) {
      await env.DATA.put('stub/mode', setting[1]);
      await env.DATA.put('stub/attempt', '0');
      return Response.json({ ok: true });
    }
    if (url.origin !== 'https://api.hevyapp.com' || request.method !== 'GET' ||
        !['/v1/workouts', '/v1/workouts/events'].includes(url.pathname) ||
        request.headers.get('api-key') !== 'synthetic-upstream-key') return new Response(null, { status: 403 });
    const mode = await (await env.DATA.get('stub/mode'))?.text() || 'backfill';
    const page = Number(url.searchParams.get('page'));
    const attempt = Number(await (await env.DATA.get('stub/attempt'))?.text() || '0');
    if (mode === 'transient' && attempt < 2) {
      await env.DATA.put('stub/attempt', String(attempt + 1));
      return new Response(null, { status: 503 });
    }
    if (mode === 'partial' && page === 2) return new Response(null, { status: 503 });
    if (mode === 'malformed') return Response.json({ page_count: 1 });
    const key = url.pathname.endsWith('/events') ? 'events' : 'workouts';
    if (mode === 'empty-zero' || mode === 'empty-one') {
      return Response.json({ page: 1, page_count: mode === 'empty-zero' ? 0 : 1, [key]: [] });
    }
    if (mode === 'invalid-zero') return Response.json({ page: 1, page_count: 0, [key]: [{ id: 'fictional-invalid' }] });
    const items = Array.from({ length: 11 }, (_, id) => key === 'workouts' ?
      { id: `fictional-${id}` } : { type: 'updated', workout: { id: `fictional-${id}` } });
    return Response.json({ page, page_count: 2, [key]: items.slice((page - 1) * 10, page * 10) });
  },
};
