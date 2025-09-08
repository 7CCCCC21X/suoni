// pages/api/soneium.js
/**
 * 统一代理三个上游接口，解决浏览器端 CORS：
 * 1) base  : https://suoni.vercel.app/api/soneium?address=...
 * 2) tx    : https://portal.soneium.org/api/profile/tx-per-season?address=...&season=1
 * 3) bonus : https://portal.soneium.org/api/profile/bonus-dapp?address=...
 *
 * 前端调用：
 *   /api/soneium?type=base&address=0x...
 *   /api/soneium?type=tx&address=0x...&season=1
 *   /api/soneium?type=bonus&address=0x...
 *
 * 注意：
 * - 做了白名单与参数校验，避免任意转发（SSRF）。
 * - 返回上游原始 Content-Type，并设置 Access-Control-Allow-Origin: *。
 * - 如你把本路由部署在 suoni.vercel.app 同域，为避免“自我代理死循环”，代码做了自我转发阻断。
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Vary': 'Origin',
};

// 允许的上游（可按需改成环境变量）
const UPSTREAMS = {
  base : 'https://suoni.vercel.app/api/soneium',
  tx   : 'https://portal.soneium.org/api/profile/tx-per-season',
  bonus: 'https://portal.soneium.org/api/profile/bonus-dapp',
};

// EVM 地址粗校验
const isAddress = (s) => typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s);

// 自我代理保护：避免把请求再转回自己造成递归
function isSelfProxy(target, req) {
  try {
    const thost = new URL(target).host;
    const reqHost = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
    return thost && reqHost && thost.toLowerCase() === reqHost.toLowerCase();
  } catch { return false; }
}

export default async function handler(req, res) {
  // 处理 CORS 预检
  if (req.method === 'OPTIONS') {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const url = new URL(req.url, 'http://localhost'); // 仅用于解析 query
  // 兼容旧调用：不传 type 时默认走 base
  const typeRaw = url.searchParams.get('type') || url.searchParams.get('up') || 'base';
  const type = String(typeRaw).toLowerCase();

  // 基础参数
  const address = url.searchParams.get('address') || '';
  const seasonRaw = url.searchParams.get('season');
  const season = seasonRaw != null && seasonRaw !== '' ? parseInt(seasonRaw, 10) : 1;

  // 参数校验
  if (!['base', 'tx', 'bonus'].includes(type)) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: 'Invalid type', allow: ['base', 'tx', 'bonus'] });
  }
  if (!isAddress(address)) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: 'Invalid address' });
  }
  if (type === 'tx' && (!Number.isFinite(season) || season < 0)) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: 'Invalid season' });
  }

  // 组装上游 URL（严格白名单）
  let target = '';
  if (type === 'base') {
    const qs = new URLSearchParams({ address });
    target = `${UPSTREAMS.base}?${qs.toString()}`;
  } else if (type === 'tx') {
    const qs = new URLSearchParams({ address, season: String(season) });
    target = `${UPSTREAMS.tx}?${qs.toString()}`;
  } else if (type === 'bonus') {
    const qs = new URLSearchParams({ address });
    target = `${UPSTREAMS.bonus}?${qs.toString()}`;
  }

  // 防止自我代理递归
  if (isSelfProxy(target, req)) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: 'Refusing to proxy to self', target });
  }

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'Soneium-Proxy/1.0' },
      redirect: 'follow',
    });

    const bodyText = await upstream.text();
    // 透传 Content-Type，附加 CORS 与简单缓存
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300'); // CDN 60s，可按需调整
    res.setHeader('X-Proxy-Target', target);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

    return res.status(upstream.status).send(bodyText);
  } catch (e) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(502).json({ error: 'Bad gateway', detail: String(e) });
  }
}
