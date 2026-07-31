// download.js — 下载代理模块
// 策略：R2 缓存 -> Cache API -> 实时代理
// 实现"秒下"体验

import { getFileUrl, setFileUrl, getFileFromR2, putFileToR2, l3GetMatch, l3Put } from './cache.js';
import { fetchFileDetails } from './steam.js';

/**
 * 代理下载创意工坊文件
 * 1. 先查 R2 缓存（命中则秒返）
 * 2. 再查 Cache API（CDN 边缘缓存）
 * 3. 实时获取 file_url 并代理下载，同时缓存到 R2 和 Cache API
 */
export async function proxyDownload(request, env, params) {
  const publishedfileid = String(params.id || '').trim();
  if (!publishedfileid) {
    return jsonError(400, '缺少模组 ID');
  }

  const cacheKey = `file:${publishedfileid}`;
  const cache = caches.default;

  // 1. 先查 Cache API（边缘缓存，最快）
  const cachedResp = await l3GetMatch(cache, request);
  if (cachedResp) {
    const resp = new Response(cachedResp.body, cachedResp);
    resp.headers.set('X-Cache', 'HIT-EDGE');
    return resp;
  }

  // 2. 查 R2 缓存
  const r2Obj = await getFileFromR2(env, cacheKey);
  if (r2Obj) {
    const headers = new Headers();
    headers.set('Content-Type', r2Obj.httpMetadata?.contentType || 'application/octet-stream');
    headers.set('Content-Length', String(r2Obj.size));
    headers.set('Content-Disposition', `attachment; filename="${publishedfileid}.zip"`);
    headers.set('X-Cache', 'HIT-R2');
    headers.set('Cache-Control', `public, max-age=${env.FILE_CACHE_TTL || 604800}`);

    const resp = new Response(r2Obj.body, { headers });

    // 异步写入 Cache API
    const cacheReq = new Request(request.url, { method: 'GET' });
    ctxWaitUntil(env, l3Put(cache, cacheReq, resp.clone(), { ttl: parseInt(env.FILE_CACHE_TTL || '604800', 10) }));

    return resp;
  }

  // 3. 获取 file_url（先查 KV 缓存，避免频繁调用 Steam API）
  let fileUrl = await getFileUrl(env, publishedfileid);
  if (!fileUrl) {
    const details = await fetchFileDetails([publishedfileid]);
    if (!details.length || details[0].result !== 1) {
      return jsonError(404, '模组不存在或已被删除');
    }
    fileUrl = details[0].fileUrl;
    if (!fileUrl) {
      return jsonError(404, '该模组没有可下载的文件');
    }
    // 缓存 file_url
    await setFileUrl(env, publishedfileid, fileUrl);
    // 顺便缓存元数据
  }

  // 4. 实时代理下载
  const upstreamResp = await fetch(fileUrl, {
    method: 'GET',
    redirect: 'follow',
  });

  if (!upstreamResp.ok) {
    // file_url 可能已过期，清除缓存重试
    if (upstreamResp.status === 403 || upstreamResp.status === 410) {
      await setFileUrl(env, publishedfileid, '');
    }
    return jsonError(upstreamResp.status, `Steam CDN 返回错误: ${upstreamResp.status}`);
  }

  // 5. 构造响应
  const contentType = upstreamResp.headers.get('Content-Type') || 'application/octet-stream';
  const contentLength = upstreamResp.headers.get('Content-Length') || '';

  const respHeaders = new Headers();
  respHeaders.set('Content-Type', contentType);
  if (contentLength) respHeaders.set('Content-Length', contentLength);
  respHeaders.set('Content-Disposition', `attachment; filename="${publishedfileid}.zip"`);
  respHeaders.set('Cache-Control', `public, max-age=${env.FILE_CACHE_TTL || 604800}`);
  respHeaders.set('X-Cache', 'MISS');

  const resp = new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers: respHeaders,
  });

  // 6. 异步缓存到 Cache API 和 R2
  // R2 只缓存小于 50MB 的文件（避免大文件占用过多存储）
  const sizeThreshold = 50 * 1024 * 1024;
  const sizeNum = parseInt(contentLength, 10) || 0;

  if (sizeNum > 0 && sizeNum < sizeThreshold) {
    // 克隆响应用于缓存
    const cloneForR2 = resp.clone();
    const cloneForCache = resp.clone();

    ctxWaitUntil(env, Promise.all([
      putFileToR2(env, cacheKey, cloneForR2.body, {
        publishedfileid,
        size: contentLength,
        cachedAt: new Date().toISOString(),
      }),
      l3Put(cache, new Request(request.url, { method: 'GET' }), cloneForCache, {
        ttl: parseInt(env.FILE_CACHE_TTL || '604800', 10),
      }),
    ]));
  } else if (sizeNum === 0) {
    // 未知大小，只缓存到 Cache API
    const cloneForCache = resp.clone();
    ctxWaitUntil(env, l3Put(cache, new Request(request.url, { method: 'GET' }), cloneForCache, {
      ttl: parseInt(env.FILE_CACHE_TTL || '604800', 10),
    }));
  }

  return resp;
}

function ctxWaitUntil(env, promise) {
  // Cloudflare Workers 的 ctx.waitUntil 通过 env.__ctx 注入（见 index.js）
  if (env.__ctx && typeof env.__ctx.waitUntil === 'function') {
    env.__ctx.waitUntil(promise);
  }
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
