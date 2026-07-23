// notifications.js — 用户通知中心
import { all, first, run } from './db.js';
import { json, err, requireAuth } from './utils.js';
import * as kvCache from './kvCache.js';

const L1_MAX = 500;
const L1_TTL_MS = 10 * 1000;
const L2_TTL_SEC = 30;

const l1 = new Map();

function l1Key(userId, type) {
  return `${userId}:${type || 'all'}`;
}

function l1Get(userId, type) {
  const k = l1Key(userId, type);
  const entry = l1.get(k);
  if (!entry) return null;
  if (Date.now() > entry.expireAt) {
    l1.delete(k);
    return null;
  }
  return entry.value;
}

function l1Set(userId, type, value) {
  const k = l1Key(userId, type);
  if (l1.size >= L1_MAX) {
    const firstKey = l1.keys().next().value;
    l1.delete(firstKey);
  }
  l1.set(k, { value, expireAt: Date.now() + L1_TTL_MS });
}

function l1DelByPrefix(userId) {
  const prefix = `${userId}:`;
  for (const k of l1.keys()) {
    if (k.startsWith(prefix)) l1.delete(k);
  }
}

async function invalidateNotifCache(env, userId) {
  l1DelByPrefix(userId);
  const types = ['all', 'reply', 'like', 'system'];
  const dels = types.map(t => kvCache.del(env, 'notif:' + userId + ':' + t));
  Promise.all(dels).catch(() => {});
}

export async function create(env, { userId, type, message, data }) {
  if (!userId || !type || !message) {
    console.log('[notifications.create] 参数缺失:', { userId, type, message });
    return;
  }
  const payload = data ? JSON.stringify(data) : null;
  await run(
    env,
    'INSERT INTO notifications (user_id, type, message, data) VALUES (?, ?, ?, ?)',
    [userId, type, message, payload]
  );
  await invalidateNotifCache(env, userId);
}

// 点赞通知合并去重：同一评论的多次点赞合并为一条通知
export async function createOrUpdateLikeNotification(env, { userId, commentId, rid, parentId, likerId, likerNickname }) {
  if (!userId || !commentId || !likerId) {
    console.log('[createOrUpdateLikeNotification] 参数缺失:', { userId, commentId, likerId });
    return;
  }
  // 查询是否已有同一评论的 like 通知
  const existing = await first(
    env,
    "SELECT * FROM notifications WHERE user_id = ? AND type = 'like' AND related_id = ? ORDER BY created_at DESC LIMIT 1",
    [userId, commentId]
  );
  if (existing) {
    // 解析已有 likers 数组
    let data = {};
    try { data = existing.data ? JSON.parse(existing.data) : {}; } catch (e) {}
    let likers = Array.isArray(data.likers) ? data.likers : [];
    // 去重：同一用户已点赞过，不重复发通知
    if (likers.some(l => l.id === likerId)) return;
    // 添加新点赞者
    likers.push({ id: likerId, nickname: likerNickname });
    // 生成合并消息
    let message;
    if (likers.length === 1) {
      message = `${likerNickname} 赞了你的评论`;
    } else if (likers.length === 2) {
      message = `${likers[0].nickname}、${likers[1].nickname} 赞了你的评论`;
    } else {
      message = `${likers[0].nickname}、${likers[1].nickname} 等总计 ${likers.length} 人赞了你的评论`;
    }
    const newData = JSON.stringify({ commentId, rid, parentId: parentId || null, likers });
    await run(
      env,
      'UPDATE notifications SET message = ?, data = ?, is_read = 0, created_at = datetime(\'now\') WHERE id = ?',
      [message, newData, existing.id]
    );
  } else {
    // 创建新通知
    const likers = [{ id: likerId, nickname: likerNickname }];
    const message = `${likerNickname} 赞了你的评论`;
    const data = JSON.stringify({ commentId, rid, parentId: parentId || null, likers });
    await run(
      env,
      'INSERT INTO notifications (user_id, type, message, data, related_id) VALUES (?, ?, ?, ?, ?)',
      [userId, 'like', message, data, commentId]
    );
  }
  await invalidateNotifCache(env, userId);
}

function publicNotification(row) {
  let data = null;
  try { data = row.data ? JSON.parse(row.data) : null; } catch (e) {}
  return {
    id: row.id,
    type: row.type,
    message: row.message,
    read: !!row.is_read,
    createdAt: row.created_at,
    data,
  };
}

// GET /api/notifications?type=reply|like|system
export async function list(req, env) {
  const user = await requireAuth(req, env);
  const url = new URL(req.url);
  const type = url.searchParams.get('type');
  const typeKey = type || 'all';

  const l1 = l1Get(user.id, type);
  if (l1) {
    return json({ notifications: l1 }, { headers: { 'X-Cache': 'HIT-L1' } }, req);
  }

  const l2 = await kvCache.get(env, 'notif:' + user.id + ':' + typeKey);
  if (l2) {
    l1Set(user.id, type, l2);
    return json({ notifications: l2 }, { headers: { 'X-Cache': 'HIT-L2' } }, req);
  }

  let sql = 'SELECT id, type, message, data, is_read, created_at FROM notifications WHERE user_id = ?';
  let params = [user.id];

  if (type === 'reply') {
    sql += " AND type = 'reply'";
  } else if (type === 'like') {
    sql += " AND type = 'like'";
  } else if (type === 'system') {
    sql += " AND type IN ('mute', 'unmute', 'reject', 'system')";
  }

  sql += ' ORDER BY created_at DESC LIMIT 100';
  const rows = await all(env, sql, params);
  const result = rows.map(publicNotification);

  l1Set(user.id, type, result);
  kvCache.set(env, 'notif:' + user.id + ':' + typeKey, result, L2_TTL_SEC).catch(() => {});

  return json({ notifications: result }, { headers: { 'X-Cache': 'MISS' } }, req);
}

// POST /api/notifications/:id/read
export async function markRead(req, env, params) {
  const user = await requireAuth(req, env);
  const id = Number(params.id);
  if (!id) return err(400, '无效的通知 id', req);
  await run(env, 'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [id, user.id]);
  await invalidateNotifCache(env, user.id);
  return json({ ok: true }, {}, req);
}

// POST /api/notifications/read-all
export async function markAllRead(req, env) {
  const user = await requireAuth(req, env);
  await run(env, 'UPDATE notifications SET is_read = 1 WHERE user_id = ?', [user.id]);
  await invalidateNotifCache(env, user.id);
  return json({ ok: true }, {}, req);
}
