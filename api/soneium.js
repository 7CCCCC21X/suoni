// pages/api/portal/[...path].js
export default async function handler(req, res) {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 仅允许这两个后端路径，避免 SSRF
  const segRaw = req.query.path;                               // e.g. ['profile','tx-per-season']
  const segs   = Array.isArray(segRaw) ? segRaw : [segRaw].filter(Boolean);
  const joined = segs.join('/').toLowerCase();

  const ALLOWED = new Set(['profile/tx-per-season', 'profile/bonus-dapp']);
  if (!ALLOWED.has(joined)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(400).json({ error: 'Disallowed path' });
  }

  // 拼接上游 URL（带原查询串）
  const urlObj = new URL(req.url, 'http://localhost');         // 仅用于拿 search
  const qs = urlObj.search || '';                              // like ?address=...&season=1
  const target = `https://portal.soneium.org/api/${joined}${qs}`;

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers: { 'accept': 'application/json', 'user-agent': 'Soneium-Proxy/1.0' },
      redirect: 'follow',
    });

    const body = await upstream.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.status(upstream.status).send(body);
  } catch (e) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(502).json({ error: 'Bad gateway', detail: String(e) });
  }
}
