// pages/api/soneium.js
/**
 * 统一代理 3 个上游接口；并做两点定制：
 * A) tx：不带 season 时默认使用第 7 季
 * B) calc（默认路由）：优先返回第 7 季；若上游无 S7 数据则返回数字 0
 *
 * 上游：
 *  - calc  : https://portal.soneium.org/api/profile/calculator?address=...
 *  - tx    : https://portal.soneium.org/api/profile/tx-per-season?address=...&season=...
 *  - bonus : https://portal.soneium.org/api/profile/bonus-dapp?address=...
 *
 * 前端调用（全部走本路由）：
 *   /api/soneium?address=0x...                         // == type=calc，返回 S7；若无 S7 则返回 0（数字）
 *   /api/soneium?type=calc&address=0x...&season=7      // 强制返回 S7 对象
 *   /api/soneium?type=calc&address=0x...&raw=1         // 透传上游原始返回（不做筛选/改写）
 *   /api/soneium?type=tx&address=0x...                 // 默认 season=7
 *   /api/soneium?type=tx&address=0x...&season=7        // 指定 S7
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

// 默认季（可被环境变量覆盖）
// ★ 已切换到 S7
const DEFAULT_SEASON = Number(process.env.DEFAULT_SEASON || 7);                     // calc 用于选择“目标季”
const DEFAULT_TX_SEASON = Number(process.env.DEFAULT_TX_SEASON || DEFAULT_SEASON); // tx 默认季

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

// —— 尝试在各种常见结构中选出指定赛季 —— //
// 上游 calculator 可能返回：
//  1) 纯数组：[{season:7,...},{season:6,...}, ...]
//  2) 对象 + 数组：{ seasons:[{season:7,...}, ...] } 或 { data:[{season:7,...}, ...] }
//  3) 单对象：{ season:7, ... }（若命中所需季，可直接返回）
function pickSeasonPayload(data, seasonToPick) {
  if (!data) return undefined;

  // 情况 3：单对象且 season 匹配
  if (typeof data === 'object' && !Array.isArray(data) && Number(data.season) === Number(seasonToPick)) {
    return data;
  }

  // 情况 1：纯数组
  if (Array.isArray(data)) {
    return data.find(d => Number(d?.season) === Number(seasonToPick));
  }

  // 情况 2：对象包装的数组
  if (typeof data === 'object' && data) {
    const arrLike = Array.isArray(data.seasons) ? data.seasons
                  : Array.isArray(data.data)    ? data.data
                  : Array.isArray(data.items)   ? data.items
                  : undefined;
    if (arrLike) {
      return arrLike.find(d => Number(d?.season) === Number(seasonToPick));
    }
  }

  // 未找到
  return undefined;
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

  // season：calc/tx 都接受；calc 用于从上游返回中选定对应赛季
  const seasonRaw = url.searchParams.get('season');
  const hasSeasonParam = seasonRaw !== null && seasonRaw !== '';
  const season = hasSeasonParam ? parseInt(seasonRaw, 10) : undefined;

  // 是否要求透传 calc 的原始返回
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
    // calc：始终请求上游的完整数据（不携带 season），在本地筛选到 S7 或返回 0
    const qs = new URLSearchParams({ address });
    target = `${UPSTREAMS.calc}?${qs.toString()}`;
  } else if (type === 'tx') {
    // tx：默认 season=7（可通过 ?season= 覆盖）
    const seasonForTx = hasSeasonParam ? String(season) : String(DEFAULT_TX_SEASON);
    const qs = new URLSearchParams({ address, season: seasonForTx });
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
      headers: { accept: 'application/json', 'user-agent': 'Soneium-Proxy/1.5' },
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
      'X-Season-Default': String(DEFAULT_SEASON),
      ...CORS_HEADERS,
    };

    // --- calc 定制：优先返回 S7；若无 S7 则返回数字 0（除非显式 raw=1 要求透传） ---
    if (type === 'calc' && upstream.ok && !wantRaw) {
      try {
        const data = JSON.parse(bodyText); // 上游常为数组，亦可能为对象
        const seasonToPick = hasSeasonParam ? Number(season) : DEFAULT_SEASON;
        const selected = pickSeasonPayload(data, seasonToPick);

        responseHeaders['Content-Type'] = 'application/json; charset=utf-8';
        responseHeaders['X-Calc-Season-Requested'] = String(seasonToPick);

        if (selected) {
          // 命中该季：返回对象
          bodyText = JSON.stringify(selected);
          responseHeaders['X-Calc-Match'] = 'hit';
        } else {
          // 上游无该季：返回数字 0
          bodyText = '0';
          responseHeaders['X-Calc-Match'] = 'miss';
        }
      } catch {
        // JSON 解析失败则原样透传
      }
    }

    Object.entries(responseHeaders).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(status).send(bodyText);
  } catch (e) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(502).json({ error: 'Bad gateway', detail: String(e) });
  }
}
