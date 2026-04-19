export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const result = {
    status: 'API is working',
    time: new Date().toISOString(),
    vercel: !!process.env.VERCEL,
    region: process.env.VERCEL_REGION || 'unknown',
  };

  try {
    const t0 = Date.now();
    const resp = await fetch('https://alzeena-checker.lovable.app/api/check?phone=01603746079', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const t1 = Date.now();
    result.upstream_reachable = true;
    result.upstream_status = resp.status;
    result.upstream_time_ms = t1 - t0;

    if (resp.ok) {
      const body = await resp.json();
      result.upstream_sample_keys = Object.keys(body);
      result.upstream_success = body.success;
    }
  } catch (e) {
    result.upstream_reachable = false;
    result.upstream_error = e.message;
  }

  res.status(200).json(result);
}
