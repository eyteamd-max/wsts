// utils.js — 通用工具函数

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export function json(data, status = 200, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
    ...extraHeaders,
  };
  return new Response(JSON.stringify(data), { status, headers });
}

export function jsonError(status, message, extraHeaders = {}) {
  return json({ error: message }, status, extraHeaders);
}

export function handleCORS(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return null;
}

/**
 * 从 URL 解析路径参数
 * 支持 /api/parse/:id 这种格式
 */
export function parseRoute(url, pattern) {
  const u = new URL(url);
  const path = u.pathname;
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);

  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * 格式化字节数为人类可读
 */
export function formatSize(bytes) {
  if (!bytes || bytes === 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(2)} ${units[i]}`;
}

/**
 * 格式化 Unix 时间戳为可读日期
 */
export function formatDate(timestamp) {
  if (!timestamp) return '未知';
  const d = new Date(timestamp * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

export { CORS_HEADERS };
