// steam.js — Steam Web API 调用封装
// 核心：GetPublishedFileDetails / GetCollectionDetails（均无需 API Key）

const STEAM_API = 'https://api.steampowered.com/ISteamRemoteStorage';

/**
 * 批量获取创意工坊物品详情
 * POST /ISteamRemoteStorage/GetPublishedFileDetails/v1/
 * 无需 API Key
 */
export async function fetchFileDetails(publishedfileids) {
  const ids = Array.isArray(publishedfileids) ? publishedfileids : [publishedfileids];
  if (ids.length === 0) return [];

  const params = new URLSearchParams();
  params.append('itemcount', String(ids.length));
  ids.forEach((id, i) => {
    params.append(`publishedfileids[${i}]`, String(id));
  });

  const resp = await fetch(`${STEAM_API}/GetPublishedFileDetails/v1/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!resp.ok) {
    throw new Error(`Steam API GetPublishedFileDetails 失败: ${resp.status}`);
  }

  const data = await resp.json();
  const files = data?.response?.publishedfiledetails || [];
  return files.map(normalizeFileDetails);
}

/**
 * 获取集合（Collection）详情，返回集合内所有模组 ID
 * POST /ISteamRemoteStorage/GetCollectionDetails/v1/
 * 无需 API Key
 */
export async function fetchCollectionDetails(collectionId) {
  const params = new URLSearchParams();
  params.append('collectioncount', '1');
  params.append('publishedfileids[0]', String(collectionId));

  const resp = await fetch(`${STEAM_API}/GetCollectionDetails/v1/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!resp.ok) {
    throw new Error(`Steam API GetCollectionDetails 失败: ${resp.status}`);
  }

  const data = await resp.json();
  const collection = data?.response?.collections?.[0];
  if (!collection) return [];

  return (collection.children || []).map(c => c.publishedfileid).filter(Boolean);
}

/**
 * 搜索创意工坊物品
 * GET /IPublishedFileService/QueryFiles/v1/
 * 需要 API Key
 */
export async function searchWorkshop(query, opts = {}) {
  const apiKey = opts.apiKey;
  if (!apiKey) {
    throw new Error('搜索功能需要 Steam Web API Key');
  }

  const appid = opts.appid || '2868840';
  const page = opts.page || 1;
  const numPerPage = opts.numPerPage || 30;
  const returnType = opts.returnType || 'json';
  const cursor = (page - 1) * numPerPage;

  const params = new URLSearchParams({
    key: apiKey,
    appid,
    query,
    return_type: returnType,
    cursor: String(cursor),
    numperpage: String(numPerPage),
    return_vote_data: 'false',
    return_tags: 'true',
    return_kv_tags: 'true',
    return_previews: 'true',
    return_children: 'false',
    return_short_description: 'true',
    return_for_sale_data: 'false',
  });

  if (opts.days && opts.days > 0) {
    params.append('days', String(opts.days));
  }

  const resp = await fetch(
    `https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/?${params.toString()}`
  );

  if (!resp.ok) {
    throw new Error(`Steam API QueryFiles 失败: ${resp.status}`);
  }

  const data = await resp.json();
  const files = data?.response?.publishedfiledetails || [];
  return {
    total: data?.response?.total || files.length,
    items: files.map(normalizeFileDetails),
  };
}

/**
 * 标准化 Steam 返回的数据结构，提取我们需要的字段
 */
function normalizeFileDetails(raw) {
  const tags = (raw.tags || []).map(t => ({
    tag: t.tag,
    // Steam 返回的颜色是 "color" 字段
    color: t.color || null,
  }));

  // 提取预览图（Steam 允许上传多张预览图）
  const previews = (raw.previews || []).map(p => ({
    url: p.url,
    size: p.size,
    name: p.name,
  }));

  // 封面图优先用 preview_url，其次用第一张预览图
  const coverImage = raw.preview_url || (previews[0] && previews[0].url) || null;

  return {
    publishedfileid: raw.publishedfileid,
    result: raw.result, // 1 = 成功, 9 = 已删除/不存在
    creator: raw.creator,
    creator_app_id: raw.creator_app_id,
    consumer_app_id: raw.consumer_app_id,
    title: raw.title || '',
    description: raw.description || '',
    shortDescription: raw.short_description || '',
    tags,
    previews,
    coverImage,
    fileName: raw.filename || '',
    fileSize: raw.file_size || 0,
    fileUrl: raw.file_url || null,
    hcontentFile: raw.hcontent_file || '',
    timeCreated: raw.time_created || 0, // Unix 时间戳
    timeUpdated: raw.time_updated || 0, // Unix 时间戳
    visibility: raw.visibility, // 0=public, 1=friends, 2=private
    banned: raw.banned || false,
    banReason: raw.ban_reason || '',
    subscriptions: raw.subscriptions || 0,
    lifetimeSubscriptions: raw.lifetime_subscriptions || 0,
    lifetimeFavorited: raw.lifetime_favorited || 0,
    views: raw.views || 0,
    favorited: raw.favorited || 0,
  };
}
