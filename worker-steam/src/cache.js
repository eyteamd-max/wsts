// cache.js — 多级缓存工具
// L1: 内存缓存（同 Worker 实例内，TTL 短）
// L2: Cloudflare KV（跨实例持久化，TTL 中）
// L3: Cloudflare Cache API（边缘 CDN 缓存，TTL 长）

// L1 内存缓存
const l1 = new Map();
const L1_MAX = 200;

function l1Get(key) {
  const entry = l1.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expireAt) {
    l1.delete(key);
    return null;
  }
  return entry.value;
}

function l1Set(key, value, ttlSec) {
  if (l1.size >= L1_MAX) {
    const firstKey = l1.keys().next().value;
    l1.delete(firstKey);
  }
  l1.set(key, { value, expireAt: Date.now() + ttlSec * 1000 });
}

function l1Del(key) {
  l1.delete(key);
}

// L2 KV 缓存
async function l2Get(env, key) {
  try {
    const raw = await env.STEAM_META.get(key);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function l2Set(env, key, value, ttlSec) {
  try {
    await env.STEAM_META.put(key, JSON.stringify(value), {
      expirationTtl: ttlSec,
    });
  } catch {}
}

async function l2Del(env, key) {
  try {
    await env.STEAM_META.delete(key);
  } catch {}
}

// L3 Cache API（用于缓存下载文件流）
async function l3GetMatch(cache, request) {
  try {
    return await cache.match(request);
  } catch {
    return null;
  }
}

async function l3Put(cache, request, response, options = {}) {
  try {
    const resp = new Response(response.body, response);
    resp.headers.set('Cache-Control', `public, max-age=${options.ttl || 86400}`);
    await cache.put(request, resp.clone());
    return resp;
  } catch {
    return response;
  }
}

/**
 * 获取元数据缓存（L1 -> L2）
 */
export async function getMeta(env, key) {
  if (l1Get(key)) return l1Get(key);
  const l2 = await l2Get(env, key);
  if (l2 !== null) {
    const ttl = parseInt(env.META_CACHE_TTL || '3600', 10);
    l1Set(key, l2, Math.min(ttl, 60)); // L1 只缓存 60 秒
    return l2;
  }
  return null;
}

export async function setMeta(env, key, value) {
  const ttl = parseInt(env.META_CACHE_TTL || '3600', 10);
  l1Set(key, value, Math.min(ttl, 60));
  await l2Set(env, key, value, ttl);
}

export async function delMeta(env, key) {
  l1Del(key);
  await l2Del(env, key);
}

/**
 * file_url 缓存（Steam 的 file_url 有时效性，缓存时间短）
 */
export async function getFileUrl(env, publishedfileid) {
  const key = `fileurl:${publishedfileid}`;
  try {
    const raw = await env.STEAM_FILE_URL.get(key);
    return raw;
  } catch {
    return null;
  }
}

export async function setFileUrl(env, publishedfileid, url) {
  const key = `fileurl:${publishedfileid}`;
  const ttl = parseInt(env.FILEURL_CACHE_TTL || '180', 10);
  try {
    await env.STEAM_FILE_URL.put(key, url, { expirationTtl: ttl });
  } catch {}
}

/**
 * R2 文件缓存：检查文件是否已缓存
 */
export async function getFileFromR2(env, key) {
  try {
    const obj = await env.STEAM_FILES.get(key);
    return obj;
  } catch {
    return null;
  }
}

/**
 * R2 文件缓存：写入
 */
export async function putFileToR2(env, key, body, metadata = {}) {
  try {
    await env.STEAM_FILES.put(key, body, {
      customMetadata: metadata,
    });
  } catch {}
}

export { l3GetMatch, l3Put };
