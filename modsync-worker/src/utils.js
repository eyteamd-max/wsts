// utils.js — 通用工具：响应、错误、CORS、cookie、admin 校验

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://test.axxxx.cyou, https://axxxx.cyou, https://www.axxxx.cyou',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Credentials': 'true',
  Vary: 'Origin',
};

function pickOrigin(req) {
  const o = req.headers.get('Origin') || '';
  const allowed = ['https://test.axxxx.cyou', 'https://axxxx.cyou', 'https://www.axxxx.cyou', 'https://sync.axxxx.cyou'];
  return allowed.includes(o) ? o : allowed[0];
}

export function json(data, opts = {}, req) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': opts.cache || 'no-store',
    'Access-Control-Allow-Origin': req ? pickOrigin(req) : CORS_HEADERS['Access-Control-Allow-Origin'],
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
  if (opts.headers) Object.assign(headers, opts.headers);
  return new Response(JSON.stringify(data), { status: opts.status || 200, headers });
}

export function err(status, message, req) {
  return json({ ok: false, error: message }, { status }, req);
}

export function handleOptions(req) {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': pickOrigin(req),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }});
}

export async function parseBody(req) {
  try {
    const text = await req.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function getCookie(req, name) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : null;
}

// 简易 admin 校验：
//   1. 优先校验 X-Admin-Token header（与 env.ADMIN_TOKEN secret 比对）
//   2. 否则校验 cmt.axxxx.cyou 的 admin JWT cookie（复用现有评论系统的同站 Cookie）
//   3. 兜底：本地开发允许 admin_local cookie
export async function requireAdmin(req, env) {
  const token = req.headers.get('X-Admin-Token');
  if (env.ADMIN_TOKEN && token && timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return { id: 0, nickname: 'admin-token', source: 'token' };
  }
  const jwt = getCookie(req, 'cmt_auth') || getCookie(req, 'admin_local');
  if (jwt) {
    try {
      const parts = jwt.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (payload && payload.admin === true && payload.exp && payload.exp > Math.floor(Date.now() / 1000)) {
          return { id: payload.sub || 0, nickname: payload.nickname || 'admin', source: 'jwt' };
        }
      }
    } catch {}
  }
  throw new HttpError(401, '需要管理员权限');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function clientIpHash(req) {
  const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const data = new TextEncoder().encode(ip + ':sts2-modsync-salt');
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export function nowIso() {
  return new Date().toISOString();
}
