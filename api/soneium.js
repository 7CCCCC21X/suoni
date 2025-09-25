// pages/api/soneium.js
/**
 * 统一代理 3 个上游接口，并在 calc 模式下支持“只返回指定季/最新季”的聚合展示：
 * 1) calc  : https://portal.soneium.org/api/profile/calculator?address=...
 *            - 默认：仅返回“最新季”的单个对象（不是数组）
 *            - 可选：?season=2 仅返回指定季
 *            - 可选：?raw=1   原样透传上游数组（兼容旧前端）
 * 2) tx    : https://portal.soneium.org/api/profile/tx-per-season?address=...&season=1
 * 3) bonus : https://portal.soneium.org/api/profile/bonus-dapp?address=...
 *
 * 前端调用（全部走本路由）：
 *   /api/soneium?address=0x...                         // 默认 == type=calc，返回“最新季”对象（当前为 S2）
 *   /api/soneium?type=calc&address=0x...&season=2      // 只要第 2 季对象
 *   /api/soneium?type=calc&address=0x...&raw=1         // 原样数组（不做聚合）
 *   /api/soneium?type=tx&address=0x...&season=2        // 上游透传（S2）
 *   /api/soneium?type=bonus&address=0x...
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Vary': 'Origin',
};

// 允许的上游（可用环境变量覆盖）
const UPSTREAMS = {
  calc : process.env.CALC_UPSTREAM  || 'https://portal.soneium.org/api/profile/calculator',
  tx   : process.env.TX_UPSTREAM    || 'https://portal.soneium.org/api/profile/tx-per-season',
  bonus: process.env.BONUS_UPSTREAM || 'https://portal.soneium.org/api/profile/bonus-dapp',
};

// EVM 地址粗校验
const isAddress = (s) => typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/i.test(s);

// 自我代理保护：避免把请求再转回自己造成递归
function isSelfProxy(target, req) {
  try {
    const thost = new URL(target).host;
    const reqHost = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
    return thost && reqHost && thost.toLowerCase() === reqHost.toLowerCase();
  } catch { return false; }
}

// 从数组里挑“最新季”（season 最大）的一条
function pickLatestSeasonItem(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.reduce((best, cur) => {
    const b = Number(best?.season ?? -Infinity);
    const c = Number(cur?.season ?? -Infinity);
    return c > b ? cur : best;
  }, null);
}

export default async function handler(req, res) {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const url = new URL(req.url, 'http://localhost'); // 仅解析 query
  // 默认走 calculator；兼容 base/calculator 别名
  const typeRaw = url.searchParams.get('type') || url.searchParams.get('up') || 'calc';
  const t = String(typeRaw).toLowerCase();
  const type = (t === 'calculator' || t === 'base') ? 'calc' : t;

  const address = url.searchParams.get('address') || '';

  // season 现在同时支持 calc / tx（calc 用于筛选返回的数组）
  const seasonParam = url.searchParams.get('season');
  const hasSeasonParam = seasonParam !== null && seasonParam !== '';
  const season = hasSeasonParam ? parseInt(seasonParam, 10) : undefined;

  // 是否要求透传 calc 的原始数组
  const rawParam = (url.searchParams.get('raw') || '').toLowerCase();
  const wantRaw = rawParam === '1' || rawParam === 'true';

  // 参数校验
  if (!['calc', 'tx', 'bonus'].includes(type)) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: 'Invalid type', allow: ['calc', 'tx', 'bonus'] });
  }
  if (!isAddress(address)) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: 'Invalid address' });
  }
  if ((type === 'tx' || type === 'calc') && hasSeasonParam && (!Number.isFinite(season) || season < 0)) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: 'Invalid season' });
  }

  // 组装上游 URL（严格白名单）
  let target = '';
  if (type === 'calc') {
    const qs = new URLSearchParams({ address });
    target = `${UPSTREAMS.calc}?${qs.toString()}`;
  } else if (type === 'tx') {
    const seasonForTx = season ?? 1; // tx 不传 season 时，仍默认查询 S1（与原版一致）
    const qs = new URLSearchParams({ address, season: String(seasonForTx) });
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
      headers: { accept: 'application/json', 'user-agent': 'Soneium-Proxy/1.1' },
      redirect: 'follow',
    });

    let bodyText = await upstream.text();
    const status = upstream.status;

    // 默认透传 Content-Type；calc 被加工时强制设为 JSON
    const upstreamCT = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const responseHeaders = {
      'Content-Type': upstreamCT,
      'Cache-Control': 's-maxage=60, stale-while-revalidate=300', // CDN 60s，可按需调整
      'X-Proxy-Target': target,
      ...CORS_HEADERS,
    };

    // --- calc 聚合（只返回“最新季”或指定季） ---
    if (type === 'calc' && upstream.ok && !wantRaw) {
      try {
        const data = JSON.parse(bodyText); // 上游返回数组
        let selected = null;

        if (Array.isArray(data)) {
          if (hasSeasonParam) {
            selected = data.find(d => Number(d?.season) === Number(season));
            // 若没找到指定季，则兜底返回“最新季”
            if (!selected) selected = pickLatestSeasonItem(data);
          } else {
            // 未指定季：默认返回“最新季”
            selected = pickLatestSeasonItem(data);
          }
        }

        if (selected) {
          bodyText = JSON.stringify(selected);
          responseHeaders['Content-Type'] = 'application/json; charset=utf-8';
          responseHeaders['X-Calc-Mode'] = hasSeasonParam ? 'season' : 'latest';
          responseHeaders['X-Calc-Season'] = String(selected.season ?? '');
        }
      } catch {
        // JSON 解析失败就原样透传
      }
    }

    Object.entries(responseHeaders).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(status).send(bodyText);
  } catch (e) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(502).json({ error: 'Bad gateway', detail: String(e) });
  }
}
