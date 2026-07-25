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

// L2 KV 写入临时禁用，使用内存 L1 缓存仅
// 待 CACHE_STORE 命名空间部署后恢复
const L2_ENABLED = false;

function l2Get(env, key) {
  if (!L2_ENABLED) return null;
  try {
    const raw = env.CACHE_STORE ? env.CACHE_STORE.get(key) : null;
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function l2Set(env, key, value, ttlSec) {
  if (!L2_ENABLED) return null;
  try {
    if (env.CACHE_STORE) {
      return env.CACHE_STORE.put(key, JSON.stringify(value), {
        expirationTtl: ttlSec,
      });
    }
  } catch {}
  return null;
}

function l2Del(env, key) {
  if (!L2_ENABLED) return null;
  try {
    if (env.CACHE_STORE) {
      return env.CACHE_STORE.delete(key);
    }
  } catch {}
  return null;
}

export async function get(env, key) {
  const k = fullKey(key);
  const cached = l1Get(k);
  if (cached !== null) return cached;

  const l2 = await l2Get(env, k);
  if (l2 !== null) {
    l1Set(k, l2);
    return l2;
  }
  return null;
}

export async function set(env, key, value, ttlSec) {
  const k = fullKey(key);
  l1Set(k, value);
  await l2Set(env, k, value, ttlSec);
  return true;
}

export async function del(env, key) {
  const k = fullKey(key);
  l1Del(k);
  await l2Del(env, k);
  return true;
}
