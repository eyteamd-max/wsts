// steam.js — Steam 创意工坊轮询
// 使用 ISteamRemoteStorage/GetPublishedFileDetails 公开端点（无需 API Key）
// 文档：https://steamwebapi.azurewebsites.net/ 或 steam官方
import { all, run, first } from './db.js';
import { nowIso } from './utils.js';

// 从 URL 中提取 workshop item id
// 例如 https://steamcommunity.com/sharedfiles/filedetails/?id=3756024281 → 3756024281
export function extractWorkshopId(url) {
  if (!url) return null;
  const m = String(url).match(/[?&]id=(\d+)/);
  return m ? m[1] : null;
}

// 批量查询 Steam 创意工坊项目（每次最多 1000 个）
async function fetchWorkshopDetails(env, publishedFileIds) {
  if (!publishedFileIds.length) return [];
  const endpoint = env.STEAM_WORKSHOP_BULK_ENDPOINT || 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
  const body = new URLSearchParams();
  body.append('itemcount', String(publishedFileIds.length));
  publishedFileIds.forEach((id, i) => body.append(`publishedfileids[${i}]`, id));

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`Steam API 请求失败: ${resp.status}`);
  }
  const data = await resp.json();
  return (data.response && data.response.publishedfiledetails) || [];
}

// 主轮询入口（由 Cron Trigger 调用，或手动 POST /api/steam/poll）
export async function pollAll(env) {
  const sources = await all(env, `SELECT id, rid, source_id, source_url, last_seen_updated_at FROM mod_sources WHERE source_type = 'steam'`);
  if (!sources.length) {
    return { ok: true, polled: 0, newUpdates: 0, message: '没有 Steam 来源' };
  }

  const ids = sources.map(s => s.source_id).filter(Boolean);
  const details = await fetchWorkshopDetails(env, ids);
  const detailMap = {};
  details.forEach(d => { detailMap[d.publishedfileid] = d; });

  let newUpdates = 0;
  const now = nowIso();

  for (const src of sources) {
    const detail = detailMap[src.source_id];
    if (!detail) {
      // Steam 上找不到（可能下架了），仅更新 last_checked_at
      await run(env, `UPDATE mod_sources SET last_checked_at = ? WHERE id = ?`, [now, src.id]);
      continue;
    }

    const serverUpdated = detail.time_updated || 0;
    const lastSeen = src.last_seen_updated_at || 0;

    await run(env, `UPDATE mod_sources SET last_checked_at = ?, last_seen_updated_at = ? WHERE id = ?`,
      [now, serverUpdated, src.id]);

    if (serverUpdated > lastSeen) {
      // 检测到更新，写入 pending_updates
      const stagingRow = await first(env, `SELECT data_json FROM mods_staging WHERE rid = ?`, [src.rid]);
      let oldVersion = null;
      if (stagingRow) {
        try {
          const oldMod = JSON.parse(stagingRow.data_json);
          oldVersion = oldMod.badge || null;
        } catch {}
      }

      const payload = {
        title: detail.title,
        description: detail.description ? String(detail.description).slice(0, 2000) : null,
        workshop_url: src.source_url,
        time_updated: serverUpdated,
        time_created: detail.time_created,
        file_size: detail.file_size,
        subscriptions: detail.subscriptions,
        lifetime_subscriptions: detail.lifetime_subscriptions,
        favorited: detail.favorited,
        lifetime_favorited: detail.lifetime_favorited,
        views: detail.views,
        tags: (detail.tags || []).map(t => t.tag),
      };

      // 仅在确实有变化时入库（避免首次初始化时全部误报）
      if (lastSeen > 0) {
        await run(env,
          `INSERT INTO pending_updates (rid, source_type, detected_at, old_version, new_version, payload_json, status)
           VALUES (?, 'steam', ?, ?, ?, ?, 'pending')`,
          [src.rid, now, oldVersion, detail.title ? `workshop-${serverUpdated}` : null, JSON.stringify(payload)]
        );
        newUpdates++;
      }
    }
  }

  return { ok: true, polled: sources.length, newUpdates, message: `轮询完成，${newUpdates} 个新更新待审核` };
}

// 手动触发：POST /api/steam/poll（需 admin）
export async function triggerPoll(req, env) {
  const result = await pollAll(env);
  return Response.json(result);
}
