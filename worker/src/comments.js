// comments.js — 评论列表(嵌套树+排序)/发评论/删除/点赞
import { all, first, run, batch } from './db.js';
import { json, err, parseBody, requireAuth, currentUser, clientIpHash, setAuthCookie } from './utils.js';
import { checkRateLimit, isNewUser, rapidFire, auditText, reportComment } from './moderation.js';
import { create as createNotification, createOrUpdateLikeNotification } from './notifications.js';
import * as kvCache from './kvCache.js';

const MAX_CONTENT = 5000;
const MAX_ATTACH = 4;

function authorOf(row) {
  // 删除的评论仍显示原作者信息，只是内容显示 [已删除]
  return { id: row.user_id, nickname: row.nickname, avatarKey: row.avatar_key, isAdmin: !!row.user_is_admin };
}

function attachmentUrl(env, key) {
  const origin = env.API_ORIGIN || 'https://cmt.axxxx.cyou';
  return `${origin}/api/files/${key}`;
}

// GET /api/comments?rid=&sort=hot|time
export async function list(req, env) {
  const url = new URL(req.url);
  const rid = url.searchParams.get('rid');
  const sort = url.searchParams.get('sort') === 'time' ? 'time' : 'hot';
  const includePending = url.searchParams.get('include') === 'pending';
  if (!rid) return err(400, '缺少 rid 参数', req);

  const { user: me, newToken } = await currentUser(req, env);
  const canSeePending = me && me.is_admin && includePending;

  // 游客直接走缓存
  if (!me && !canSeePending) {
    const cacheKey = 'comments:' + rid + ':' + sort;
    const cached = await kvCache.get(env, cacheKey);
    if (cached) {
      return json(cached, { headers: { 'X-Cache': 'HIT' } }, req);
    }

    const rows = await all(
      env,
      `SELECT c.id, c.rid, c.parent_id, c.content, c.status, c.ip_hash, c.created_at,
              u.nickname, u.avatar_key, u.is_admin AS user_is_admin,
              (SELECT COUNT(*) FROM likes l WHERE l.comment_id = c.id) AS like_count,
              (SELECT COUNT(*) FROM comments ch WHERE ch.parent_id = c.id AND ch.status = 'approved') AS reply_count
         FROM comments c
         JOIN users u ON u.id = c.user_id
        WHERE c.rid = ? AND c.status = 'approved'
        ORDER BY c.created_at ASC`,
      [rid]
    );

    let attachMap = {};
    if (rows.length) {
      const ids = rows.map(r => r.id);
      const atts = await all(
        env,
        `SELECT id, comment_id, r2_key, filename, mime, size, kind FROM comment_attachments WHERE comment_id IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`,
        ids
      );
      attachMap = atts.reduce((m, a) => {
        (m[a.comment_id] = m[a.comment_id] || []).push({
          id: a.id, key: a.r2_key, url: attachmentUrl(env, a.r2_key),
          name: a.filename, mime: a.mime, size: a.size, kind: a.kind,
        });
        return m;
      }, {});
    }

    const nodes = rows.map(r => ({
      id: r.id,
      rid: r.rid,
      parentId: r.parent_id,
      content: r.content,
      status: r.status,
      createdAt: r.created_at,
      likeCount: r.like_count,
      replyCount: r.reply_count,
      likedByMe: false,
      author: authorOf(r),
      attachments: attachMap[r.id] || [],
      children: [],
    }));

    const byId = new Map(nodes.map(n => [n.id, n]));
    const top = [];
    for (const n of nodes) {
      if (n.parentId && byId.has(n.parentId)) {
        byId.get(n.parentId).children.push(n);
      } else {
        top.push(n);
      }
    }

    if (sort === 'time') {
      top.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } else {
      top.sort((a, b) => {
        const sa = a.likeCount + a.replyCount, sb = b.likeCount + b.replyCount;
        return sb - sa || b.createdAt.localeCompare(a.createdAt);
      });
    }

    const result = { tree: top, total: nodes.length, sort };
    await kvCache.set(env, cacheKey, result, 1800);
    return json(result, { headers: { 'X-Cache': 'MISS' } }, req);
  }

  // 普通用户：approved 公开评论 + 自己发送的 pending 评论（先发后审仅自己可见）
  // 管理员查看待审核：approved + 所有 pending
  const params = [rid];
  let pendingFilter = '';
  if (canSeePending) {
    pendingFilter = "OR c.status = 'pending'";
  } else if (me) {
    pendingFilter = 'OR (c.status = \'pending\' AND c.user_id = ?)';
    params.push(me.id);
  }

  const rows = await all(
    env,
    `SELECT c.id, c.rid, c.user_id, c.parent_id, c.content, c.status, c.ip_hash, c.created_at,
            u.nickname, u.avatar_key, u.is_admin AS user_is_admin,
            (SELECT COUNT(*) FROM likes l WHERE l.comment_id = c.id) AS like_count,
            (SELECT COUNT(*) FROM comments ch WHERE ch.parent_id = c.id AND ch.status = 'approved') AS reply_count
       FROM comments c
       JOIN users u ON u.id = c.user_id
      WHERE c.rid = ? AND (c.status = 'approved' ${pendingFilter})
      ORDER BY c.created_at ASC`,
    params
  );

  // 当前用户点赞集合
  let likedSet = new Set();
  if (me && rows.length) {
    const ids = rows.map(r => r.id);
    const likedRows = await all(
      env,
      `SELECT comment_id FROM likes WHERE user_id = ? AND comment_id IN (${ids.map(() => '?').join(',')})`,
      [me.id, ...ids]
    );
    likedSet = new Set(likedRows.map(r => r.comment_id));
  }

  // 附件
  let attachMap = {};
  if (rows.length) {
    const ids = rows.map(r => r.id);
    const atts = await all(
      env,
      `SELECT id, comment_id, r2_key, filename, mime, size, kind FROM comment_attachments WHERE comment_id IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`,
      ids
    );
    attachMap = atts.reduce((m, a) => {
      (m[a.comment_id] = m[a.comment_id] || []).push({
        id: a.id, key: a.r2_key, url: attachmentUrl(env, a.r2_key),
        name: a.filename, mime: a.mime, size: a.size, kind: a.kind,
      });
      return m;
    }, {});
  }

  // 组装节点
  const nodes = rows.map(r => ({
    id: r.id,
    rid: r.rid,
    parentId: r.parent_id,
    content: r.content,
    status: r.status,
    createdAt: r.created_at,
    likeCount: r.like_count,
    replyCount: r.reply_count,
    likedByMe: likedSet.has(r.id),
    author: authorOf(r),
    attachments: attachMap[r.id] || [],
    children: [],
  }));

  // 建树
  const byId = new Map(nodes.map(n => [n.id, n]));
  const top = [];
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      byId.get(n.parentId).children.push(n);
    } else {
      top.push(n);
    }
  }

  // 顶层排序：hot = (like+reply) DESC, created_at DESC；time = created_at DESC。回复固定时间升序（已按 ASC 查出）
  if (sort === 'time') {
    top.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } else {
    top.sort((a, b) => {
      const sa = a.likeCount + a.replyCount, sb = b.likeCount + b.replyCount;
      return sb - sa || b.createdAt.localeCompare(a.createdAt);
    });
  }

  const headers = {};
  if (newToken) headers['Set-Cookie'] = setAuthCookie(req, newToken);
  return json({ tree: top, total: nodes.length, sort }, { headers }, req);
}

// POST /api/comments { rid, content, parentId?, attachments? }
export async function create(req, env) {
  const { user, muted } = await currentUser(req, env);
  if (!user) return err(401, '未登录', req);
  if (muted) return err(403, '您已被禁言，禁言结束时间：' + new Date(muted).toLocaleString(), req);
  const body = await parseBody(req);
  const rid = String(body.rid || '').trim();
  const content = String(body.content || '').trim();
  const parentId = body.parentId ? Number(body.parentId) : null;
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, MAX_ATTACH) : [];

  if (!rid) return err(400, '缺少 rid', req);
  if (!content || content.length > MAX_CONTENT) return err(400, `内容需 1-${MAX_CONTENT} 字符`, req);

  await checkRateLimit(env, user.id);
  const ipHash = await clientIpHash(req);

  // 自动审核：文字内容
  const audit = auditText(content);
  if (audit.action === 'reject') {
    return err(400, audit.reason || '内容违规', req);
  }

  // 判定最终状态（管理员直接通过，跳过审核）
  let status;
  if (user.is_admin) {
    status = 'approved';
  } else if (audit.action === 'pending') {
    status = 'pending';
  } else if (await rapidFire(env, user.id, ipHash)) {
    status = 'pending';
  } else if (await isNewUser(env, user)) {
    status = 'pending';
  } else {
    status = 'approved';
  }

  const ins = await run(
    env,
    'INSERT INTO comments (rid, user_id, parent_id, content, status, ip_hash) VALUES (?, ?, ?, ?, ?, ?)',
    [rid, user.id, parentId, content, status, ipHash]
  );
  const commentId = ins.meta.last_row_id;

  // 附件批量插入（校验 key 形如 comment/<userId>/...）
  if (attachments.length) {
    const stmts = attachments
      .filter(a => a && typeof a.key === 'string' && a.key.startsWith(`comment/${user.id}/`))
      .map(a => ({
        sql: 'INSERT INTO comment_attachments (comment_id, r2_key, filename, mime, size, kind) VALUES (?, ?, ?, ?, ?, ?)',
        params: [commentId, a.key, String(a.name || '').slice(0, 200), String(a.mime || 'application/octet-stream'), Number(a.size) || 0, String(a.kind || 'text')],
      }));
    if (stmts.length) await batch(env, stmts);
  }

  // 回复站内通知
  if (parentId) {
    const parent = await first(env, 'SELECT c.*, u.email, u.is_verified FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?', [parentId]);
    if (parent && parent.user_id !== user.id) {
      try {
        await createNotification(env, {
          userId: parent.user_id,
          type: 'reply',
          message: `${user.nickname} 回复了你的评论：${content.slice(0, 80)}${content.length > 80 ? '…' : ''}`,
          data: { rid, commentId, parentId },
        });
      } catch (e) { console.log('[createNotification reply]', e.message); }
    }
  }

  await invalidateCommentCache(env, rid);

  return json({
    id: commentId, rid, parentId, content, status,
    createdAt: new Date().toISOString(),
    likeCount: 0, replyCount: 0, likedByMe: false,
    author: { id: user.id, nickname: user.nickname, avatarKey: user.avatar_key, isAdmin: !!user.is_admin },
    attachments: attachments.filter(a => a && typeof a.key === 'string' && a.key.startsWith(`comment/${user.id}/`)).map(a => ({
      key: a.key, url: attachmentUrl(env, a.key), name: a.name, mime: a.mime, size: a.size, kind: a.kind,
    })),
    children: [],
    pending: status === 'pending',
  }, {}, req);
}

// DELETE /api/comments/:id
export async function del(req, env, params) {
  const user = await requireAuth(req, env);
  const id = Number(params.id);
  if (!id) return err(400, '无效的评论 id', req);

  const c = await first(env, 'SELECT * FROM comments WHERE id = ?', [id]);
  if (!c) return err(404, '评论不存在', req);
  if (c.user_id !== user.id && !user.is_admin) return err(403, '无权删除该评论', req);

  const allIds = await getAllCommentIds(env, id);
  const ph = allIds.map(() => '?').join(',');

  // 管理员删除时先记录日志（此时 comment 还存在，外键不报错）
  const stmts = [];
  if (user.is_admin && c.user_id !== user.id) {
    stmts.push({
      sql: 'INSERT INTO moderation_log (comment_id, moderator_id, action, reason) VALUES (?, ?, ?, ?)',
      params: [id, user.id, 'delete', '管理员删除'],
    });
  }

  // 按外键依赖顺序删除：先删子表，最后删 comments
  stmts.push({ sql: `DELETE FROM moderation_log WHERE comment_id IN (${ph})`, params: allIds });
  stmts.push({ sql: `DELETE FROM comment_attachments WHERE comment_id IN (${ph})`, params: allIds });
  stmts.push({ sql: `DELETE FROM likes WHERE comment_id IN (${ph})`, params: allIds });
  stmts.push({ sql: `DELETE FROM reports WHERE comment_id IN (${ph})`, params: allIds });
  stmts.push({ sql: `DELETE FROM comments WHERE id IN (${ph})`, params: allIds });

  await batch(env, stmts);
  await invalidateCommentCache(env, c.rid);
  return json({ ok: true }, {}, req);
}

async function getAllCommentIds(env, rootId) {
  const ids = [rootId];
  let pending = [rootId];
  while (pending.length) {
    const pid = pending.shift();
    const rows = await all(env, 'SELECT id FROM comments WHERE parent_id = ?', [pid]);
    for (const r of rows) {
      ids.push(r.id);
      pending.push(r.id);
    }
  }
  return ids;
}

// POST /api/comments/:id/like (toggle)
export async function like(req, env, params) {
  const user = await requireAuth(req, env);
  const id = Number(params.id);
  if (!id) return err(400, '无效的评论 id', req);

  const c = await first(env, 'SELECT c.*, u.nickname AS author_nickname FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?', [id]);
  if (!c) return err(404, '评论不存在', req);

  const existing = await first(env, 'SELECT id FROM likes WHERE comment_id = ? AND user_id = ?', [id, user.id]);
  if (existing) {
    await run(env, 'DELETE FROM likes WHERE id = ?', [existing.id]);
    const cnt = await first(env, 'SELECT COUNT(*) AS c FROM likes WHERE comment_id = ?', [id]);
    await invalidateCommentCache(env, c.rid);
    return json({ liked: false, count: cnt.c }, {}, req);
  } else {
    await run(env, 'INSERT INTO likes (comment_id, user_id) VALUES (?, ?)', [id, user.id]);
    const cnt = await first(env, 'SELECT COUNT(*) AS c FROM likes WHERE comment_id = ?', [id]);
    if (c.user_id !== user.id) {
      try {
        await createOrUpdateLikeNotification(env, {
          userId: c.user_id,
          commentId: id,
          rid: c.rid,
          parentId: c.parent_id,
          likerId: user.id,
          likerNickname: user.nickname,
        });
      } catch (e) { console.log('[createOrUpdateLikeNotification]', e.message); }
    }
    await invalidateCommentCache(env, c.rid);
    return json({ liked: true, count: cnt.c }, {}, req);
  }
}

export async function invalidateCommentCache(env, rid) {
  await kvCache.del(env, 'comments:' + rid + ':hot');
  await kvCache.del(env, 'comments:' + rid + ':time');
}
