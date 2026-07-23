// moderation.js — 自动审核 + 频率限制 + 用户举报
import { first, run } from './db.js';

// ========== 关键词库（三级策略） ==========

// BLOCK 级：明显违规，直接拒绝/拦截
const BLOCK_KEYWORDS = [
  '裸聊', '约炮', '一夜情', 'AV上门', '成人直播', '色情网站', '卖淫',
  '赌博网站', '博彩网站', '六合彩', '私彩', '黑彩', '赌场', '赌球',
  '毒品', '冰毒', '海洛因', '大麻', '罂粟', '白粉',
  '杀人', '自杀教程', '教唆自杀', '恐怖袭击', '爆炸物制作',
  '儿童色情', '幼女', '萝莉控', '恋童', '强奸', '迷奸',
  '代开', '代办', '刷赞', '刷量', '代刷', '刷粉', '刷票',
  '日赚百元', '零投资', '稳赚不赔', '传销', '资金盘',
  '办证', '假证', '假币', '枪支', '弹药', '管制刀具',
];

// SUSPECT 级：可疑内容，标记为 pending 待人工确认
const SUSPECT_KEYWORDS = [
  '傻逼', '煞笔', '沙比', 'sb', 'cnm', '草泥马', '尼玛', 'nmsl',
  '贱人', '婊子', '妓女', '荡妇', '废物', '垃圾', '狗东西',
  '去死', '全家死', '死妈', '死全家', '畜生', '杂种', '脑瘫',
  '脑残', '弱智', '智障', '疯狗', '贱货', '臭婊子',
  '黄片', '毛片', '三级片', '色情', 'av', 'av片',
  '兼职日结', '加微信', '加QQ', '加q', 'vx', '微信', 'qq号',
  '赚钱二维码', '扫码', '二维码收款', '进群', '群号',
];

// 昵称专用拦截：更严格的模式
const NICK_BLOCK_PATTERNS = [
  /https?:\/\/[^\s]+/i,            // URL
  /www\.[^\s]+/i,                   // www 链接
  /[\w\-]+\.(com|cn|net|org|cc|xyz|top|club|vip)/i, // 域名
  /\b\d{6,}\b/,                      // 6位以上数字（群号/QQ号）
  /[qQ][qQ][:：]?\s*\d{5,}/,        // QQ:123456
  /群[:：]?\s*\d{5,}/,              // 群:123456
  /[vV][xX][:：]?\s*[a-zA-Z0-9_]+/, // VX:xxx
  /微信[:：]?\s*[a-zA-Z0-9_]+/,      // 微信:xxx
];

// 图片文件名敏感词
const FILE_NAME_SENSITIVE = [
  '色情', 'porn', 'nude', 'naked', 'sex', 'xxx', 'av', '血腥', 'gore',
  '暴恐', '恐怖', 'terror', '二维码', 'qrcode', 'qr_code', '扫码',
];

const URL_RE = /https?:\/\/[^\s]+/gi;
const QQ_GROUP_RE = /\b\d{6,}\b/;

function hasChinese(str) {
  return /[\u4e00-\u9fa5]/.test(str);
}

// ========== 文字审核（评论内容） ==========

/**
 * 审核文字内容（已关闭敏感词检测）
 * @returns {{action:'approve'|'pending'|'reject', reason:string|null}}
 */
export function auditText(content) {
  return { action: 'approve', reason: null };
}

// ========== 昵称审核 ==========

/**
 * 审核用户昵称（已关闭敏感词检测）
 * @returns {{ok:boolean, reason:string|null}}
 */
export function auditNickname(nickname) {
  return { ok: true, reason: null };
}

// ========== 图片/文件名审核 ==========

/**
 * 审核文件名（已关闭敏感词检测）
 * @returns {{ok:boolean, reason:string|null}}
 */
export function auditFilename(filename) {
  return { ok: true, reason: null };
}

// ========== 频率限制 ==========

async function rateLimitCheck(env, bucket, maxCount, windowSec) {
  const row = await first(
    env,
    `SELECT COUNT(*) AS c FROM rate_events WHERE bucket = ? AND created_at > datetime('now','-${windowSec} seconds')`,
    [bucket]
  );
  if (row && row.c >= maxCount) {
    const e = new Error('操作过于频繁，请稍后再试');
    e.code = 429;
    throw e;
  }
  await run(env, 'INSERT INTO rate_events (bucket) VALUES (?)', [bucket]);
}

// 5 秒冷却：同一用户发评论间隔
export async function checkRateLimit(env, userId) {
  const bucket = 'comment:' + userId;
  const row = await first(
    env,
    "SELECT created_at FROM rate_events WHERE bucket = ? AND created_at > datetime('now','-5 seconds') ORDER BY created_at DESC LIMIT 1",
    [bucket]
  );
  if (row) {
    const e = new Error('操作过于频繁，请 5 秒后再试'); e.code = 429; throw e;
  }
  await run(env, 'INSERT INTO rate_events (bucket) VALUES (?)', [bucket]);
}

// 注册限流：同 IP 10 分钟内最多 5 次
export async function checkRegisterRateLimit(env, ipHash) {
  await rateLimitCheck(env, 'register:ip:' + ipHash, 5, 600);
}

// 登录限流：同 IP 1 分钟内最多 5 次
export async function checkLoginRateLimit(env, ipHash) {
  await rateLimitCheck(env, 'login:ip:' + ipHash, 5, 60);
}

// 新用户判定：注册 < 24h 或 已通过评论数 < 3
export async function isNewUser(env, user) {
  const ageRow = await first(
    env,
    "SELECT (julianday('now') - julianday(created_at)) * 24 AS hours FROM users WHERE id = ?",
    [user.id]
  );
  if (!ageRow || ageRow.hours == null) return true;
  if (ageRow.hours < 24) return true;
  const cntRow = await first(
    env,
    "SELECT COUNT(*) AS c FROM comments WHERE user_id = ? AND status = 'approved'",
    [user.id]
  );
  return !cntRow || cntRow.c < 3;
}

// 短时连发检测：同用户 60s 内 > 5 条 → 标记 spam
export async function rapidFire(env, userId, ipHash) {
  const byUser = await first(
    env,
    "SELECT COUNT(*) AS c FROM comments WHERE user_id = ? AND created_at > datetime('now','-60 seconds')",
    [userId]
  );
  if (byUser && byUser.c > 5) return true;
  if (ipHash) {
    const byIp = await first(
      env,
      "SELECT COUNT(*) AS c FROM comments WHERE ip_hash = ? AND created_at > datetime('now','-60 seconds')",
      [ipHash]
    );
    if (byIp && byIp.c > 5) return true;
  }
  return false;
}

// ========== 用户举报 ==========

/**
 * 举报评论
 * @returns {{ok:boolean, alreadyReported:boolean}}
 */
export async function reportComment(env, commentId, userId, reason) {
  try {
    await run(
      env,
      'INSERT INTO reports (comment_id, user_id, reason) VALUES (?, ?, ?)',
      [commentId, userId, reason || null]
    );
    // 更新评论的 report_count
    await run(
      env,
      'UPDATE comments SET report_count = (SELECT COUNT(*) FROM reports WHERE comment_id = ?), status = ? WHERE id = ?',
      [commentId, 'reported', commentId]
    );
    return { ok: true, alreadyReported: false };
  } catch (e) {
    // UNIQUE 约束冲突 = 已经举报过
    if (e && e.message && e.message.includes('UNIQUE constraint failed')) {
      return { ok: true, alreadyReported: true };
    }
    throw e;
  }
}
