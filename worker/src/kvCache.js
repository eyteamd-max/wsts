// kvCache.js — KV + 内存 L1 缓存工具
const PREFIX = 'cache:';
const L1_MAX = 500;
const L1_TTL_MS = 10 * 1000;

const l1 = new Map();

function fullKey(key) {
  return PREFIX + key;
}

function l1Get(key) {
  const entry = l1.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expireAt) {
    l1.delete(key);
    return null;
  }
  return entry.value;
}

function l1Set(key, value) {
  if (l1.size >= L1_MAX) {
    const firstKey = l1.keys().next().value;
    l1.delete(firstKey);
  }
  l1.set(key, { value, expireAt: Date.now() + L1_TTL_MS });
}

function l1Del(key) {
  l1.delete(key);
}

export async function get(env, key) {
  const k = fullKey(key);
  const cached = l1Get(k);
  if (cached !== null) return cached;

  try {
    const raw = await env.CACHE_STORE.get(k);
    if (raw == null) return null;
    const value = JSON.parse(raw);
    l1Set(k, value);
    return value;
  } catch {
    return null;
  }
}

export async function set(env, key, value, ttlSec) {
  const k = fullKey(key);
  l1Set(k, value);

  try {
    await env.CACHE_STORE.put(k, JSON.stringify(value), {
      expirationTtl: ttlSec,
    });
    return true;
  } catch {
    return null;
  }
}

export async function del(env, key) {
  const k = fullKey(key);
  l1Del(k);

  try {
    await env.CACHE_STORE.delete(k);
    return true;
  } catch {
    return null;
  }
}
