// index.js — sts2-steam Worker 入口
// Steam 创意工坊解析与下载代理

import { fetchFileDetails, fetchCollectionDetails, searchWorkshop } from './steam.js';
import { getMeta, setMeta, delMeta, getFileUrl, setFileUrl } from './cache.js';
import { proxyDownload } from './download.js';
import { json, jsonError, handleCORS, parseRoute, formatSize, formatDate, CORS_HEADERS } from './utils.js';

export default {
  async fetch(request, env, ctx) {
    // 注入 ctx 到 env，供下游模块使用 waitUntil
    env.__ctx = ctx;

    // CORS 预检
    const corsResp = handleCORS(request);
    if (corsResp) return corsResp;

    const url = new URL(request.url);
    const path = url.pathname;

    // 健康检查
    if (path === '/' || path === '/health') {
      return json({
        ok: true,
        service: 'sts2-steam',
        time: new Date().toISOString(),
      });
    }

    // ---------- 路由匹配 ----------
    try {
      // GET /api/parse/:id — 解析单个模组
      let params = parseRoute(url, '/api/parse/:id');
      if (params && request.method === 'GET') {
        return await handleParseOne(request, env, params);
      }

      // GET /api/parse?ids=id1,id2,id3 — 批量解析
      if (path === '/api/parse' && request.method === 'GET') {
        return await handleParseBatch(request, env);
      }

      // GET /api/collection/:id — 解析集合，返回集合内所有模组详情
      params = parseRoute(url, '/api/collection/:id');
      if (params && request.method === 'GET') {
        return await handleCollection(request, env, params);
      }

      // GET /api/download/:id — 代理下载模组文件
      params = parseRoute(url, '/api/download/:id');
      if (params && request.method === 'GET') {
        return await proxyDownload(request, env, params);
      }

      // GET /api/fileurl/:id — 获取模组下载直链（重定向到 Steam CDN）
      params = parseRoute(url, '/api/fileurl/:id');
      if (params && request.method === 'GET') {
        return await handleFileUrl(request, env, params);
      }

      // GET /api/search?q=keyword — 搜索创意工坊
      if (path === '/api/search' && request.method === 'GET') {
        return await handleSearch(request, env);
      }

      // GET /api/invalidate/:id — 清除缓存（管理用）
      params = parseRoute(url, '/api/invalidate/:id');
      if (params && request.method === 'GET') {
        return await handleInvalidate(request, env, params);
      }

      return jsonError(404, '接口不存在');
    } catch (err) {
      console.error('Worker 错误:', err);
      return jsonError(500, `服务器错误: ${err.message || err}`);
    }
  },
};

// ---------- 解析单个模组 ----------
async function handleParseOne(request, env, params) {
  const id = String(params.id || '').trim();
  if (!id) return jsonError(400, '缺少模组 ID');

  // 查缓存
  const cacheKey = `meta:${id}`;
  const cached = await getMeta(env, cacheKey);
  if (cached) {
    return json(cached, 200, { 'X-Cache': 'HIT' });
  }

  // 调 Steam API
  const details = await fetchFileDetails([id]);
  if (!details.length) {
    return jsonError(404, '未找到该模组');
  }

  const item = details[0];
  if (item.result !== 1) {
    return jsonError(404, '模组不存在或已被删除');
  }

  // 增强字段
  const enhanced = enhanceItem(item);

  // 缓存
  await setMeta(env, cacheKey, enhanced);

  return json(enhanced, 200, { 'X-Cache': 'MISS' });
}

// ---------- 批量解析 ----------
async function handleParseBatch(request, env) {
  const url = new URL(request.url);
  const idsParam = url.searchParams.get('ids') || '';
  const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);

  if (!ids.length) {
    return jsonError(400, '缺少 ids 参数');
  }

  if (ids.length > 50) {
    return jsonError(400, '单次最多解析 50 个模组');
  }

  // 先查缓存
  const results = [];
  const missIds = [];
  for (const id of ids) {
    const cached = await getMeta(env, `meta:${id}`);
    if (cached) {
      results.push(cached);
    } else {
      missIds.push(id);
    }
  }

  // 批量调用 Steam API
  if (missIds.length > 0) {
    const details = await fetchFileDetails(missIds);
    const cacheWrites = [];
    for (const item of details) {
      if (item.result === 1) {
        const enhanced = enhanceItem(item);
        results.push(enhanced);
        cacheWrites.push(setMeta(env, `meta:${item.publishedfileid}`, enhanced));
      }
    }
    // 异步写入缓存
    if (env.__ctx) env.__ctx.waitUntil(Promise.all(cacheWrites));
  }

  // 按 ids 顺序排序
  const ordered = ids.map(id => results.find(r => String(r.publishedfileid) === String(id))).filter(Boolean);

  return json({ items: ordered, total: ordered.length });
}

// ---------- 解析集合 ----------
async function handleCollection(request, env, params) {
  const collectionId = String(params.id || '').trim();
  if (!collectionId) return jsonError(400, '缺少集合 ID');

  // 查缓存
  const cacheKey = `collection:${collectionId}`;
  const cached = await getMeta(env, cacheKey);
  if (cached) {
    return json(cached, 200, { 'X-Cache': 'HIT' });
  }

  // 获取集合内的模组 ID
  const childIds = await fetchCollectionDetails(collectionId);
  if (!childIds.length) {
    return jsonError(404, '集合为空或不存在');
  }

  // 批量获取详情（分批，每批最多 50 个）
  const allItems = [];
  const batchSize = 50;
  for (let i = 0; i < childIds.length; i += batchSize) {
    const batch = childIds.slice(i, i + batchSize);
    const details = await fetchFileDetails(batch);
    for (const item of details) {
      if (item.result === 1) {
        allItems.push(enhanceItem(item));
      }
    }
  }

  const result = {
    collectionId,
    total: allItems.length,
    items: allItems,
  };

  // 缓存
  await setMeta(env, cacheKey, result);

  return json(result, 200, { 'X-Cache': 'MISS' });
}

// ---------- 获取下载直链（重定向） ----------
async function handleFileUrl(request, env, params) {
  const id = String(params.id || '').trim();
  if (!id) return jsonError(400, '缺少模组 ID');

  // 查 KV 缓存
  let fileUrl = await getFileUrl(env, id);
  if (!fileUrl) {
    const details = await fetchFileDetails([id]);
    if (!details.length || details[0].result !== 1) {
      return jsonError(404, '模组不存在');
    }
    fileUrl = details[0].fileUrl;
    if (!fileUrl) {
      return jsonError(404, '该模组没有可下载的文件');
    }
    await setFileUrl(env, id, fileUrl);
  }

  // 返回直链信息（前端可自行下载，或用 /api/download/:id 走代理）
  return json({ publishedfileid: id, fileUrl });
}

// ---------- 搜索 ----------
async function handleSearch(request, env) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const numPerPage = parseInt(url.searchParams.get('num') || '30', 10);

  if (!q) {
    return jsonError(400, '缺少搜索关键词 q');
  }

  const apiKey = env.STEAM_API_KEY;
  if (!apiKey) {
    return jsonError(501, '搜索功能未启用：需要配置 STEAM_API_KEY');
  }

  const result = await searchWorkshop(q, {
    apiKey,
    appid: env.STEAM_APPID,
    page,
    numPerPage,
  });

  return json(result);
}

// ---------- 清除缓存 ----------
async function handleInvalidate(request, env, params) {
  const id = String(params.id || '').trim();
  if (!id) return jsonError(400, '缺少模组 ID');

  await delMeta(env, `meta:${id}`);
  await setFileUrl(env, id, '');

  return json({ ok: true, message: `已清除 ${id} 的缓存` });
}

// ---------- 增强模组信息 ----------
function enhanceItem(item) {
  return {
    ...item,
    fileSizeFormatted: formatSize(item.fileSize),
    timeCreatedFormatted: formatDate(item.timeCreated),
    timeUpdatedFormatted: formatDate(item.timeUpdated),
    // Steam 创意工坊页面链接
    workshopUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.publishedfileid}`,
    // 下载链接（走我们的代理）
    downloadUrl: `/api/download/${item.publishedfileid}`,
    // 从 tags 提取游戏版本兼容性（启发式）
    supportedVersions: extractVersions(item),
  };
}

/**
 * 从模组的 tags 和 description 中启发式提取支持的游戏版本
 * STS2 的版本号通常类似 0.107.1 / 0.109.x
 */
function extractVersions(item) {
  const versions = new Set();
  const text = `${item.title} ${item.description} ${(item.tags || []).map(t => t.tag).join(' ')}`;

  // 匹配 0.xxx.x 格式的版本号
  const matches = text.match(/0\.\d{2,3}\.[\dxX]+/g) || [];
  matches.forEach(v => versions.add(v));

  // 匹配 0.10x.x 格式
  const matches2 = text.match(/0\.10[0-9]\.[0-9xX]+/g) || [];
  matches2.forEach(v => versions.add(v));

  return Array.from(versions).sort();
}
