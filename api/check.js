export const config = {
  api: {
    bodyParser: false,
    responseLimit: '10mb',
  },
};

const UPSTREAM = 'https://alzeena-checker.lovable.app/api/check';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    cors(res);
    return res.status(405).json({ success: false, error: 'Only GET allowed' });
  }

  const phone = req.query.phone;
  if (!phone) {
    cors(res);
    return res.status(400).json({
      success: false,
      error: 'Phone number required. Usage: /api/check?phone=016XXXXXXXX',
    });
  }

  try {
    const url = UPSTREAM + '?phone=' + encodeURIComponent(phone);

    const upstream = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
      redirect: 'follow',
    });

    if (!upstream.ok) {
      cors(res);
      return res.status(502).json({
        success: false,
        error: 'Upstream returned HTTP ' + upstream.status,
        upstream_url: url,
      });
    }

    const data = await upstream.json();

    cors(res);
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json(data);

  } catch (err) {
    console.error('Proxy Error:', err.message);
    cors(res);
    return res.status(500).json({
      success: false,
      error: 'Proxy failed: ' + err.message,
    });
  }
}
