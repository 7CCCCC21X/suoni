// 文件路径：/api/soneium.js
export default async function handler(req, res) {
  // 允许跨域（也支持 OPTIONS 预检）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const { address } = req.query || {};
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Missing or invalid address' });
  }

  const target = `https://portal.soneium.org/api/profile/calculator?address=${encodeURIComponent(address)}`;

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers: { 'accept': 'application/json' },
    });

    const text = await upstream.text();

    // 直接透传状态码与内容
    res.status(upstream.status);
    // 保持 JSON 响应类型（若上游不是 JSON，这里也只是透传文本）
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // 建议不缓存，确保拿到最新分数
    res.setHeader('Cache-Control', 'no-store');

    return res.send(text);
  } catch (err) {
    return res.status(502).json({ error: 'Bad gateway', detail: String(err) });
  }
}
