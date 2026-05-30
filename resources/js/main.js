(function () {
  function raceImage(urls, timeout) {
    timeout = timeout || 3500;
    if (!urls || urls.length === 0) return Promise.reject('no urls');

    var timeoutPromise = new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error('image load timeout'));
      }, timeout);
    });

    var loadPromises = urls.map(function (url) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        var stallTimer = setTimeout(function () {
          reject(new Error('image load stalled'));
        }, timeout + 2000);

        img.onload = img.onerror = function (e) {
          clearTimeout(stallTimer);
          if (e.type === 'load') resolve(url);
          else reject(new Error('image load failed'));
        };

        img.src = url;
      });
    });

    return Promise.race([
      Promise.any([timeoutPromise].concat(loadPromises)),
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error('total timeout'));
        }, timeout + 3000);
      })
    ]);
  }

  function toCandidates(item) {
    if (Array.isArray(item)) return item.length ? item : [item];
    return [item];
  }

  function sortModsByTimeId(dataArray) {
    return dataArray.slice().sort(function (a, b) {
      return (b.id || '').localeCompare(a.id || '');
    });
  }

  function extractBvid(input) {
    if (!input || typeof input !== 'string') return null;
    var trimmed = input.trim();
    var bvMatch = trimmed.match(/^(BV[a-zA-Z0-9]+)$/);
    if (bvMatch) return bvMatch[1];
    var urlMatch = trimmed.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/);
    if (urlMatch) return urlMatch[1];
    return null;
  }

  function isMir6ApiUrl(url) {
    return url && typeof url === 'string' && url.indexOf('api.mir6.com') !== -1;
  }

  var BILI_RESOLVE_API = 'https://api.mir6.com/api/bzjiexi?url=';
  var BILI_RESOLVE_TIMEOUT = 10000;
  var VIDEO_CONCURRENCY = 2;

  var videoQueue = [];
  var videoActiveCount = 0;

  function videoQueueEnqueue(taskFn) {
    return new Promise(function (resolve, reject) {
      videoQueue.push({ fn: taskFn, resolve: resolve, reject: reject });
      videoQueueProcess();
    });
  }

  function videoQueueProcess() {
    while (videoActiveCount < VIDEO_CONCURRENCY && videoQueue.length > 0) {
      var task = videoQueue.shift();
      videoActiveCount++;
      task.fn().then(function (result) {
        videoActiveCount--;
        task.resolve(result);
        videoQueueProcess();
      }).catch(function (err) {
        videoActiveCount--;
        task.reject(err);
        videoQueueProcess();
      });
    }
  }

  var bvidResolveCache = {};

  function resolveBvidToMp4(bvid) {
    if (bvidResolveCache[bvid] !== undefined) {
      return Promise.resolve(bvidResolveCache[bvid]);
    }

    return new Promise(function (resolve) {
      var apiUrl = BILI_RESOLVE_API + encodeURIComponent('https://www.bilibili.com/video/' + bvid + '/') + '&type=mp4';
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, BILI_RESOLVE_TIMEOUT);

      fetch(apiUrl, { signal: controller.signal })
        .then(function (resp) {
          clearTimeout(timeoutId);
          if (!resp.ok) throw new Error('API error');
          return resp.json();
        })
        .then(function (data) {
          var mp4Url = null;
          if (data) {
            if (data.video) mp4Url = data.video;
            else if (data.url) mp4Url = data.url;
            else if (data.data) {
              if (typeof data.data === 'string') mp4Url = data.data;
              else if (data.data.url) mp4Url = data.data.url;
              else if (data.data.video) mp4Url = data.data.video;
            }
          }
          if (mp4Url && typeof mp4Url === 'string' && mp4Url.indexOf('.mp4') !== -1) {
            bvidResolveCache[bvid] = mp4Url;
            resolve(mp4Url);
          } else {
            bvidResolveCache[bvid] = null;
            resolve(null);
          }
        })
        .catch(function () {
          clearTimeout(timeoutId);
          bvidResolveCache[bvid] = null;
          resolve(null);
        });
    });
  }

  function loadVideoElement(mp4Url, posterUrl) {
    return new Promise(function (resolve, reject) {
      var video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;

      var timer = setTimeout(function () {
        reject(new Error('video metadata timeout'));
      }, 15000);

      video.onloadedmetadata = function () {
        clearTimeout(timer);
        var cleanVideo = video.cloneNode(true);
        cleanVideo.muted = true;
        cleanVideo.playsInline = true;
        cleanVideo.preload = 'metadata';
        resolve(cleanVideo);
      };
      video.onerror = function () {
        clearTimeout(timer);
        reject(new Error('video load failed'));
      };

      if (posterUrl) video.poster = posterUrl;
      video.src = mp4Url;
    });
  }

  function createBiliIframe(bvid) {
    var wrapper = document.createElement('div');
    wrapper.className = 'preview-video-item preview-video-iframe-wrap';
    var iframe = document.createElement('iframe');
    iframe.src = 'https://player.bilibili.com/player.html?bvid=' + bvid + '&autoplay=0&danmaku=0&high_quality=1';
    iframe.allowFullscreen = true;
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.style.borderRadius = '12px';
    wrapper.appendChild(iframe);
    return wrapper;
  }

  function preloadImagesWithConcurrency(urls, concurrency) {
    return new Promise(function (resolve) {
      if (!urls || urls.length === 0) {
        resolve();
        return;
      }

      var index = 0;
      var running = 0;
      var total = urls.length;

      function next() {
        if (index >= total) {
          if (running === 0) resolve();
          return;
        }
        var url = urls[index++];
        running++;

        var img = new Image();
        var timer = setTimeout(function () {
          running--;
          next();
        }, 2500);

        img.onload = img.onerror = function () {
          clearTimeout(timer);
          running--;
          next();
        };

        img.src = url;
      }

      for (var i = 0; i < Math.min(concurrency, total); i++) {
        next();
      }
    });
  }
  var loadingOverlay = document.getElementById('loadingOverlay');
  var loadingGif = document.getElementById('loadingGif');
  var loadingText = document.getElementById('loadingText');
  var potionWrapper = document.getElementById('potionWrapper');
  var mainContent = document.getElementById('mainContent');
  mainContent.style.opacity = '0';
  mainContent.style.transition = 'opacity 0.5s ease';

  var logoImg = document.getElementById('logoImg');
  var logoTower = document.getElementById('logoTower');
  var logoArea = document.getElementById('logoArea');

  var modData = [];
  var baseModData = [];
  var activeCategory = 'all';
  var currentPage = 1;
  var ITEMS_PER_PAGE = 10;
  var allSiteData = {};
  var manifestCache = {};
  var dataLoadingPromises = {};

  var modGrid = document.getElementById('modGrid');
  var paginationEl = document.getElementById('pagination');
  var searchInput = document.getElementById('searchInput');
  var searchDropdown = document.getElementById('searchDropdown');
  var searchContainer = document.getElementById('searchContainer');
  var modalOverlay = document.getElementById('modalOverlay');
  var modalClose = document.getElementById('modalClose');
  var modalTitle = document.getElementById('modalTitle');
  var modalRid = document.getElementById('modalRid');
  var modalRidWrap = document.getElementById('modalRidWrap');
  var ridDropdown = document.getElementById('ridDropdown');
  var modalTags = document.getElementById('modalTags');
  var modalDescText = document.getElementById('modalDescText');
  var descToggle = document.getElementById('descToggle');
  var modalAuthor = document.getElementById('modalAuthor');
  var modalLinks = document.getElementById('modalLinks');
  var downloadButtons = document.getElementById('downloadButtons');
  var lightboxOverlay = document.getElementById('lightboxOverlay');
  var lightboxClose = document.getElementById('lightboxClose');
  var lightboxImg = document.getElementById('lightboxImg');
  var previewImagesBtn = document.getElementById('previewImagesBtn');
  var previewVideosBtn = document.getElementById('previewVideosBtn');
  var previewContentArea = document.getElementById('previewContentArea');
  var charaOverlay = document.getElementById('charaOverlay');
  var charaClose = document.getElementById('charaClose');
  var charaImg = document.getElementById('charaImg');
  var toast = document.getElementById('toast');

  var dataSources = {
    all: 'resources/json/post/sts2_mods/sts2_mods_1.json',
    skin: 'resources/json/post/O.o_interface/O.o_interface_1.json'
  };

  var dataCache = {};
  var currentImages = [];
  var currentIndex = 0;
  var currentMod = null;
  var activePreviewTab = null;

  var FALLBACK_LOADED2 = 'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif';
  window.loaded2GifSrc = null;

  var SITE_DOMAIN = 'axxxx.cyou';
  var toastTimer;

  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('show');
    toastTimer = setTimeout(function () {
      toast.classList.remove('show');
    }, 2200);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    } else {
      return new Promise(function (resolve, reject) {
        var textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try {
          document.execCommand('copy');
          document.body.removeChild(textarea);
          resolve();
        } catch (err) {
          document.body.removeChild(textarea);
          reject(err);
        }
      });
    }
  }
  function parseManifestRange(rangeStr) {
    if (!rangeStr || typeof rangeStr !== 'string') return [];
    var parts = rangeStr.split('~');
    if (parts.length !== 2) return [];
    var start = parseInt(parts[0], 10);
    var end = parseInt(parts[1], 10);
    if (isNaN(start) || isNaN(end)) return [];
    var result = [];
    for (var i = start; i <= end; i++) result.push(i);
    return result;
  }

  async function loadManifest(categoryKey) {
    if (manifestCache[categoryKey]) return manifestCache[categoryKey];

    var dirMap = { all: 'sts2_mods', skin: 'O.o_interface' };
    var dir = dirMap[categoryKey];
    if (!dir) return null;

    var manifestUrl = 'resources/json/post/' + dir + '/manifest.json';
    try {
      var resp = await fetch(manifestUrl, { cache: 'no-store' });
      if (!resp.ok) return null;
      var data = await resp.json();
      manifestCache[categoryKey] = data;
      return data;
    } catch (e) {
      return null;
    }
  }

  async function loadJsonByManifest(categoryKey, fileIndex) {
    var dirMap = { all: 'sts2_mods', skin: 'O.o_interface' };
    var dir = dirMap[categoryKey];
    if (!dir) return [];

    var url = 'resources/json/post/' + dir + '/' + dir + '_' + fileIndex + '.json';
    try {
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, 8000);
      var response = await fetch(url, { signal: controller.signal, cache: 'default' });
      clearTimeout(timeoutId);
      if (!response.ok) return [];
      var rawData = await response.json();
      rawData = sortModsByTimeId(rawData);
      return rawData;
    } catch (error) {
      return [];
    }
  }

  async function loadAllDataForCategory(categoryKey, forceNoStore) {
    if (!forceNoStore && allSiteData[categoryKey]) return allSiteData[categoryKey];
    if (!forceNoStore && dataLoadingPromises[categoryKey]) return await dataLoadingPromises[categoryKey];

    var promise = (async function () {
      var manifest = await loadManifest(categoryKey);
      var dirMap = { all: 'sts2_mods', skin: 'O.o_interface' };
      var dir = dirMap[categoryKey];

      if (manifest && manifest[dir]) {
        var rangeStr = manifest[dir];
        var indices = parseManifestRange(rangeStr);
        var dataArrays = await Promise.all(indices.map(function (idx) {
          if (forceNoStore) {
            return loadJsonByManifestForceNoStore(categoryKey, idx);
          }
          return loadJsonByManifest(categoryKey, idx);
        }));
        var allData = dataArrays.flat();
        if (forceNoStore) {
          return allData;
        }
        allSiteData[categoryKey] = allData;
        return allData;
      }

      var url = dataSources[categoryKey];
      if (!url) return [];
      try {
        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, 8000);
        var cacheOpt = forceNoStore ? 'no-store' : 'default';
        var response = await fetch(url, { signal: controller.signal, cache: cacheOpt });
        clearTimeout(timeoutId);
        if (!response.ok) return [];
        var rawData = await response.json();
        rawData = sortModsByTimeId(rawData);
        if (forceNoStore) {
          return rawData;
        }
        allSiteData[categoryKey] = rawData;
        return rawData;
      } catch (error) {
        return [];
      }
    })();

    if (!forceNoStore) {
      dataLoadingPromises[categoryKey] = promise;
    }
    try {
      var result = await promise;
      return result;
    } finally {
      if (!forceNoStore) {
        delete dataLoadingPromises[categoryKey];
      }
    }
  }

  async function loadJsonByManifestForceNoStore(categoryKey, fileIndex) {
    var dirMap = { all: 'sts2_mods', skin: 'O.o_interface' };
    var dir = dirMap[categoryKey];
    if (!dir) return [];

    var url = 'resources/json/post/' + dir + '/' + dir + '_' + fileIndex + '.json';
    try {
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, 8000);
      var response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timeoutId);
      if (!response.ok) return [];
      var rawData = await response.json();
      rawData = sortModsByTimeId(rawData);
      return rawData;
    } catch (error) {
      return [];
    }
  }
  var preloadState = { currentPreloadPage: 0 };

  function extractCoverUrls(dataSlice) {
    var urls = [];
    dataSlice.forEach(function (mod) {
      if (mod.coverImage) {
        var url = Array.isArray(mod.coverImage) ? (mod.coverImage[0] || '') : mod.coverImage;
        if (url.trim()) urls.push(url);
      }
    });
    return urls;
  }

  function extractPreviewImageUrls(dataSlice, maxPerMod) {
    maxPerMod = maxPerMod || 4;
    var urls = [];
    dataSlice.forEach(function (mod) {
      if (Array.isArray(mod.previewImages)) {
        mod.previewImages.slice(0, maxPerMod).forEach(function (item) {
          var candidates = toCandidates(item);
          if (candidates.length && candidates[0]) urls.push(candidates[0]);
        });
      }
    });
    return urls;
  }

  function getPageSlice(dataArray, pageNum) {
    var start = (pageNum - 1) * ITEMS_PER_PAGE;
    var end = start + ITEMS_PER_PAGE;
    return dataArray.slice(start, end);
  }

  function triggerAdjacentPreload(pageNum) {
    var totalPages = Math.ceil(modData.length / ITEMS_PER_PAGE);
    var nextPage = pageNum + 1;
    if (nextPage > totalPages) return;
    if (preloadState.currentPreloadPage >= nextPage) return;

    preloadState.currentPreloadPage = nextPage;
    var nextPageData = getPageSlice(modData, nextPage);
    var coverUrls = extractCoverUrls(nextPageData);

    preloadImagesWithConcurrency(coverUrls, 6).then(function () {
      var previewUrls = extractPreviewImageUrls(nextPageData, 3);
      return preloadImagesWithConcurrency(previewUrls, 4);
    });
  }

  async function priorityPreload() {
    await Promise.all([
      loadAllDataForCategory('all'),
      loadAllDataForCategory('skin')
    ]);

    var defaultData = allSiteData['all'] || [];
    var page1Data = getPageSlice(defaultData, 1);
    var page1Covers = extractCoverUrls(page1Data);
    await preloadImagesWithConcurrency(page1Covers, 6);

    var page2Data = getPageSlice(defaultData, 2);
    var page2Covers = extractCoverUrls(page2Data);
    await preloadImagesWithConcurrency(page2Covers, 6);

    var page1Previews = extractPreviewImageUrls(page1Data, 3);
    await preloadImagesWithConcurrency(page1Previews, 4);

    preloadState.currentPreloadPage = 2;
  }
      function renderPagination(totalItems, currentPageNum) {
        paginationEl.innerHTML = '';
        var totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
        if (totalPages <= 1) return;

        paginationEl.style.display = 'flex';
        paginationEl.style.flexWrap = 'nowrap';
        paginationEl.style.alignItems = 'center';
        paginationEl.style.width = '100%';
        paginationEl.style.maxWidth = '100%';
        paginationEl.style.boxSizing = 'border-box';
        paginationEl.style.overflow = 'hidden';

        function createBtn(type, content, disabled, clickHandler) {
            var btn = document.createElement('button');
            btn.className = type;
            btn.innerHTML = content;
            btn.style.flexShrink = '1';
            btn.style.minWidth = '0';
            if (disabled) btn.disabled = true;
            if (clickHandler) btn.addEventListener('click', clickHandler);
            return btn;
        }

        function createPageBtn(pageNum) {
            return createBtn('pagination-page' + (pageNum === currentPageNum ? ' active' : ''), 
                pageNum, false, function () {
                    currentPage = pageNum;
                    renderPage(pageNum);
                    modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
        }

        function createDots() {
            var span = document.createElement('span');
            span.className = 'pagination-dots';
            span.textContent = '...';
            span.style.flexShrink = '1';
            span.style.minWidth = '0';
            return span;
        }

        var items = [];

        items.push(createBtn('pagination-btn', '&#8249;', currentPageNum <= 1, function () {
            if (currentPageNum > 1) {
                currentPage--;
                renderPage(currentPage);
                modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }));

        items.push(createPageBtn(1));

        if (totalPages <= 4) {
            for (var i = 2; i <= totalPages; i++) {
                items.push(createPageBtn(i));
            }
        } else {
            if (currentPageNum <= 4) {
                for (var j = 2; j <= 4; j++) {
                    items.push(createPageBtn(j));
                }
                items.push(createDots());
                items.push(createPageBtn(totalPages));
            } else {
                items.push(createDots());
                
                if (currentPageNum - 1 > 1) {
                    items.push(createPageBtn(currentPageNum - 1));
                }
                items.push(createPageBtn(currentPageNum));
                if (currentPageNum + 1 < totalPages) {
                    items.push(createPageBtn(currentPageNum + 1));
                }

                items.push(createDots());
                items.push(createPageBtn(totalPages));
            }
        }

        items.push(createBtn('pagination-btn', '&#8250;', currentPageNum >= totalPages, function () {
            if (currentPageNum < totalPages) {
                currentPage++;
                renderPage(currentPage);
                modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }));

        items.forEach(function(item) {
            paginationEl.appendChild(item);
        });

        var gotoWrap = document.createElement('span');
        gotoWrap.className = 'pagination-goto';
        gotoWrap.style.flexShrink = '0';
        gotoWrap.style.marginLeft = '8px';

        var gotoInput = document.createElement('input');
        gotoInput.type = 'text';
        gotoInput.className = 'pagination-goto-input';
        gotoInput.placeholder = '\\';
        gotoInput.maxLength = 3;
        gotoInput.setAttribute('aria-label', '输入页码');

        var gotoBtn = document.createElement('button');
        gotoBtn.className = 'pagination-goto-btn';
        gotoBtn.innerHTML = '<svg class="goto-icon-svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="12.5" y1="12.5" x2="17.5" y2="17.5"/></svg>';
        gotoBtn.setAttribute('aria-label', '跳转到指定页');

        var gotoMobile = document.createElement('button');
        gotoMobile.className = 'pagination-goto-mobile-trigger';
        gotoMobile.innerHTML = '<svg class="goto-icon-svg goto-icon-svg-sm" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="12.5" y1="12.5" x2="17.5" y2="17.5"/></svg>';
        gotoMobile.setAttribute('aria-label', '跳转页码');

        function doGoto(value) {
            var num = parseInt(value, 10);
            if (isNaN(num) || num < 1 || num > totalPages) {
                showToast('页码范围：1 ~ ' + totalPages);
                return;
            }
            currentPage = num;
            renderPage(num);
            modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
            gotoInput.value = '';
        }

        gotoInput.addEventListener('input', function () {
            this.value = this.value.replace(/[^\d]/g, '').slice(0, 3);
        });
        gotoInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') doGoto(this.value);
        });
        gotoBtn.addEventListener('click', function () {
            doGoto(gotoInput.value);
        });
        gotoMobile.addEventListener('click', function () {
            openGotoPopup(totalPages);
        });

        gotoWrap.appendChild(gotoInput);
        gotoWrap.appendChild(gotoBtn);
        gotoWrap.appendChild(gotoMobile);
        paginationEl.appendChild(gotoWrap);
    }

  function openGotoPopup(totalPages) {
    var existing = document.getElementById('gotoPopupOverlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.className = 'goto-popup-overlay active';
    overlay.id = 'gotoPopupOverlay';

    var popup = document.createElement('div');
    popup.className = 'goto-popup';

    var title = document.createElement('div');
    title.className = 'goto-popup-title';
    title.textContent = '跳转到第几页？(共 ' + totalPages + ' 页)';

    var row = document.createElement('div');
    row.className = 'goto-popup-row';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'goto-popup-input';
    input.placeholder = '页码';
    input.maxLength = 3;
    input.inputMode = 'numeric';
    input.addEventListener('input', function () {
      this.value = this.value.replace(/[^\d]/g, '').slice(0, 3);
    });

    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'goto-popup-confirm';
    confirmBtn.textContent = '跳转';

    function doMobileGoto() {
      var num = parseInt(input.value, 10);
      if (isNaN(num) || num < 1 || num > totalPages) {
        showToast('页码范围：1 ~ ' + totalPages);
        return;
      }
      currentPage = num;
      renderPage(num);
      overlay.remove();
      setTimeout(function () {
        modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doMobileGoto();
    });

    confirmBtn.addEventListener('click', doMobileGoto);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    row.appendChild(input);
    row.appendChild(confirmBtn);
    popup.appendChild(title);
    popup.appendChild(row);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);
    setTimeout(function () { input.focus(); }, 100);
  }
  function renderPage(pageNum) {
    var start = (pageNum - 1) * ITEMS_PER_PAGE;
    var end = start + ITEMS_PER_PAGE;
    var pageData = modData.slice(start, end);
    renderModCards(pageData);
    renderPagination(modData.length, pageNum);

    setTimeout(function () {
      triggerAdjacentPreload(pageNum);
    }, 300);
  }

  function openLightbox(src) {
    lightboxImg.src = src;
    lightboxOverlay.classList.add('active');
  }

  async function raceImageWithRetry(urls, maxRetries) {
    maxRetries = maxRetries || 2;
    var lastError;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await raceImage(urls);
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          await new Promise(function (r) { setTimeout(r, 500); });
        }
      }
    }
    throw lastError;
  }

  function switchPreviewTab(tab) {
    activePreviewTab = (activePreviewTab === tab) ? null : tab;
    updatePreviewButtons();
    renderPreviewContent();
  }

  function updatePreviewButtons() {
    var imgActive = activePreviewTab === 'images';
    var vidActive = activePreviewTab === 'videos';
    previewImagesBtn.textContent = imgActive ? '预览图片 ▴' : '预览图片 ▾';
    previewVideosBtn.textContent = vidActive ? '预览视频 ▴' : '预览视频 ▾';
    previewImagesBtn.classList.toggle('active', imgActive);
    previewVideosBtn.classList.toggle('active', vidActive);
  }

  function renderPreviewContent() {
    if (!currentMod) {
      previewContentArea.innerHTML = '';
      return;
    }
    var mod = currentMod;
    previewContentArea.innerHTML = '<div class="preview-empty-card">正在加载预览资源...</div>';

    if (activePreviewTab === 'images') {
      renderPreviewImages(Array.isArray(mod.previewImages) ? mod.previewImages : []);
    } else if (activePreviewTab === 'videos') {
      renderPreviewVideos(Array.isArray(mod.previewVideos) ? mod.previewVideos : []);
    } else {
      previewContentArea.innerHTML = '';
    }
  }
  async function renderPreviewImages(items) {
    if (items.length === 0) {
      previewContentArea.innerHTML = '<div class="preview-empty-card">该MOD猫猫还没有配置图片资源哦</div>';
      return;
    }

    var grid = document.createElement('div');
    grid.className = 'preview-image-grid';
    previewContentArea.innerHTML = '';
    previewContentArea.appendChild(grid);

    var placeholders = items.map(function () {
      var ph = document.createElement('div');
      ph.className = 'preview-image-item';
      ph.style.background = '#f0f0f0';
      ph.style.aspectRatio = '16/9';
      ph.textContent = '加载中...';
      grid.appendChild(ph);
      return ph;
    });

    await Promise.allSettled(
      items.map(function (item, idx) {
        var urls = toCandidates(item);
        return raceImageWithRetry(urls, 2).then(function (url) {
          var img = document.createElement('img');
          img.src = url;
          img.loading = 'lazy';
          img.className = 'preview-image-item';
          img.style.cursor = 'zoom-in';
          img.addEventListener('click', function () { openLightbox(url); });
          grid.replaceChild(img, placeholders[idx]);
        }).catch(function () {
          placeholders[idx].textContent = '加载失败';
        });
      })
    );
  }

  async function renderPreviewVideos(items) {
    if (items.length === 0) {
      previewContentArea.innerHTML = '<div class="preview-empty-card">该MOD猫猫还没有配置视频资源哦</div>';
      return;
    }

    var list = document.createElement('div');
    list.className = 'preview-video-list';
    previewContentArea.innerHTML = '';
    previewContentArea.appendChild(list);

    var placeholders = items.map(function (item) {
      var ph = document.createElement('div');
      ph.className = 'preview-video-item';
      ph.style.background = '#f0f0f0';
      ph.style.height = '200px';
      ph.style.display = 'flex';
      ph.style.alignItems = 'center';
      ph.style.justifyContent = 'center';
      ph.textContent = '视频排队加载中...';
      list.appendChild(ph);
      return ph;
    });

    var tasks = items.map(function (item, idx) {
      return function () {
        return renderSingleVideo(item, placeholders[idx]);
      };
    });

    for (var i = 0; i < tasks.length; i++) {
      await videoQueueEnqueue(tasks[i]);
    }
  }

  async function renderSingleVideo(item, placeholder) {
    if (!placeholder.parentNode) return;

    placeholder.textContent = '视频加载中...';

    var bvid = null;
    var mp4Urls = [];
    var posterUrl = null;

    if (typeof item === 'string') {
      var extractedBvid = extractBvid(item);
      if (extractedBvid) {
        bvid = extractedBvid;
      } else if (isMir6ApiUrl(item)) {
        var mir6BvidMatch = item.match(/\/video\/(BV[a-zA-Z0-9]+)/);
        if (mir6BvidMatch) {
          bvid = mir6BvidMatch[1];
        } else {
          mp4Urls = [item];
        }
      } else {
        mp4Urls = [item];
      }
    } else if (item && typeof item === 'object') {
      if (item.bvid) {
        bvid = item.bvid;
      } else if (item.urls && Array.isArray(item.urls) && item.urls.length > 0) {
        var firstUrl = item.urls[0];
        var extractedBv = extractBvid(firstUrl);
        if (extractedBv) {
          bvid = extractedBv;
        } else {
          mp4Urls = item.urls;
        }
      } else if (item.url) {
        var extractedBv2 = extractBvid(item.url);
        if (extractedBv2) {
          bvid = extractedBv2;
        } else {
          mp4Urls = [item.url];
        }
      }
      if (item.poster) posterUrl = item.poster;
    }

    if (bvid) {
      var mp4Url = await resolveBvidToMp4(bvid);
      if (mp4Url) {
        try {
          var videoEl = await loadVideoElement(mp4Url, posterUrl);
          videoEl.className = 'preview-video-item';
          videoEl.controls = true;
          if (posterUrl) videoEl.poster = posterUrl;
          if (placeholder.parentNode) {
            placeholder.parentNode.replaceChild(videoEl, placeholder);
          }
          return;
        } catch (e) {
          // fall through to iframe
        }
      }

      var iframeEl = createBiliIframe(bvid);
      if (placeholder.parentNode) {
        placeholder.parentNode.replaceChild(iframeEl, placeholder);
      }
      return;
    }

    if (mp4Urls.length > 0) {
      try {
        var videoEl2 = await loadVideoElement(mp4Urls[0], posterUrl);
        videoEl2.className = 'preview-video-item';
        videoEl2.controls = true;
        if (posterUrl) videoEl2.poster = posterUrl;
        if (placeholder.parentNode) {
          placeholder.parentNode.replaceChild(videoEl2, placeholder);
        }
        return;
      } catch (e) {
        if (placeholder.parentNode) {
          placeholder.textContent = '视频加载失败';
        }
        return;
      }
    }

    if (placeholder.parentNode) {
      placeholder.textContent = '视频链接缺失';
    }
  }

  previewImagesBtn.addEventListener('click', function () {
    switchPreviewTab('images');
  });

  previewVideosBtn.addEventListener('click', function () {
    switchPreviewTab('videos');
  });
  async function openModal(mod) {
    currentMod = mod;
    modalTitle.textContent = mod.title;

    var modalCoverWrap = document.getElementById('modalCoverWrap');
    var modalCoverImg = document.getElementById('modalCoverImg');
    var modalCoverSrc = '';

    if (mod.coverImage) {
      if (Array.isArray(mod.coverImage)) {
        modalCoverSrc = mod.coverImage[0] || '';
      } else {
        modalCoverSrc = mod.coverImage;
      }
    }

    var hasModalCover = modalCoverSrc.trim() !== '';
    if (hasModalCover) {
      modalCoverImg.src = modalCoverSrc;
      modalCoverImg.style.objectFit = 'cover';
      modalCoverImg.style.cursor = 'zoom-in';
      modalCoverImg.onclick = function (e) {
        e.stopPropagation();
        openLightbox(modalCoverImg.src);
      };
      modalCoverWrap.style.display = 'block';
      modalCoverImg.style.display = 'block';
    } else {
      modalCoverWrap.style.display = 'none';
      modalCoverImg.src = '';
      modalCoverImg.onclick = null;
    }

    modalRid.textContent = 'RID: ' + (mod.id || '无');
    modalRid.onclick = function (e) {
      e.stopPropagation();
      var isVisible = ridDropdown.style.display === 'block';
      ridDropdown.style.display = isVisible ? 'none' : 'block';
    };

    ridDropdown.querySelectorAll('.rid-option').forEach(function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var action = btn.dataset.action;
        if (action === 'copy-rid') {
          var ridText = 'RID:' + (mod.id || '');
          copyText(ridText).then(function () {
            showToast('RID 已复制，快分享给小伙伴吧~');
          }).catch(function () {
            showToast('复制失败，请手动复制');
          });
        } else if (action === 'copy-link') {
          var linkText = 'https://' + SITE_DOMAIN + '/?rid=' + (mod.id || '');
          copyText(linkText).then(function () {
            showToast('帖子链接已复制~');
          }).catch(function () {
            showToast('复制失败，请手动复制');
          });
        }
        ridDropdown.style.display = 'none';
      };
    });

    modalTags.innerHTML = '';
    if (mod.tags && Array.isArray(mod.tags)) {
      mod.tags.forEach(function (tag) {
        var span = document.createElement('span');
        span.className = 'modal-tag ' + tag.toLowerCase();
        span.textContent = tag;
        modalTags.appendChild(span);
      });
    }

    var desc = (mod.description || '暂无介绍')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    var urlRegex = /(https?:\/\/[^\s<"]+)/g;
    desc = desc.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" class="desc-link">$1</a>');
    modalDescText.innerHTML = desc;
    modalDescText.classList.remove('expanded');
    descToggle.style.display = 'none';
    descToggle.textContent = '展开全文';

    modalAuthor.textContent = '作者：' + (mod.author || '佚名');

    modalLinks.innerHTML = '';
    if (mod.authorLinks) {
      if (Array.isArray(mod.authorLinks)) {
        mod.authorLinks.forEach(function (link) {
          if (link.text && link.url) {
            var a = document.createElement('a');
            a.className = 'modal-link';
            a.href = link.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = link.text;
            modalLinks.appendChild(a);
          }
        });
      } else {
        var links = [
          { name: 'Twitter', url: mod.authorLinks.twitter },
          { name: 'Pixiv', url: mod.authorLinks.pixiv },
          { name: 'Bilibili', url: mod.authorLinks.bilibili }
        ];
        links.forEach(function (link) {
          if (link.url) {
            var a = document.createElement('a');
            a.className = 'modal-link';
            a.href = link.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = link.name;
            modalLinks.appendChild(a);
          }
        });
      }
    }

    downloadButtons.innerHTML = '';
    var downloadLinks = mod.downloadLinks && mod.downloadLinks.length
      ? mod.downloadLinks
      : (mod.downloadUrl ? [{ text: '下载', url: mod.downloadUrl }] : []);
    downloadLinks.forEach(function (dl) {
      var btn = document.createElement('a');
      btn.className = 'download-btn-item';
      btn.href = dl.url;
      btn.target = '_blank';
      btn.rel = 'noopener noreferrer';
      btn.textContent = dl.text;
      downloadButtons.appendChild(btn);
    });

    activePreviewTab = null;
    updatePreviewButtons();
    renderPreviewContent();

    modalOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    setTimeout(function () {
      if (modalDescText.scrollHeight > modalDescText.clientHeight + 2) {
        descToggle.style.display = 'inline-block';
      }
    }, 50);
  }
  function closeModal() {
    modalOverlay.classList.remove('active');
    document.body.style.overflow = '';
    currentMod = null;
    activePreviewTab = null;
    ridDropdown.style.display = 'none';
    var modalCoverImg = document.getElementById('modalCoverImg');
    if (modalCoverImg) {
      modalCoverImg.src = '';
      modalCoverImg.onclick = null;
    }
  }

  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', function (e) {
    if (e.target === modalOverlay) closeModal();
  });

  descToggle.addEventListener('click', function () {
    var expanded = modalDescText.classList.toggle('expanded');
    descToggle.textContent = expanded ? '收起' : '展开全文';
  });

  lightboxClose.addEventListener('click', function () {
    lightboxOverlay.classList.remove('active');
  });

  lightboxOverlay.addEventListener('click', function (e) {
    if (e.target === lightboxOverlay) lightboxOverlay.classList.remove('active');
  });

  document.addEventListener('click', function (e) {
    if (!modalRidWrap.contains(e.target)) {
      ridDropdown.style.display = 'none';
    }
  });

  function handleTagClick(tagText) {
    searchInput.value = tagText;
    filterMods();
    searchInput.focus();
  }

  function attachCardSpinner(cardElement) {
    var coverInner = cardElement.querySelector('.mod-cover-inner');
    var coverImg = coverInner ? coverInner.querySelector('.mod-cover-img') : null;
    if (!coverInner || !coverImg) return;
    if (coverImg.complete && coverImg.naturalWidth > 0) return;

    var spinner = document.createElement('span');
    spinner.className = 'card-spinner';

    var hideSpinner = function () {
      if (spinner.parentNode) {
        spinner.style.display = 'none';
        spinner.remove();
      }
    };

    coverImg.addEventListener('load', hideSpinner, { once: true });
    coverImg.addEventListener('error', hideSpinner, { once: true });
    setTimeout(function () {
      if (coverImg.complete) hideSpinner();
    }, 500);

    coverInner.appendChild(spinner);
  }
  function renderModCards(dataArray) {
    modGrid.innerHTML = '';
    if (dataArray.length === 0) {
      modGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--text-muted);">没有找到相关MOD</div>';
      return;
    }

    var loaded2Src = window.loaded2GifSrc || FALLBACK_LOADED2;

    dataArray.forEach(function (mod) {
      var coverImgSrc = '';
      if (mod.coverImage) {
        if (Array.isArray(mod.coverImage)) {
          coverImgSrc = mod.coverImage[0] || '';
        } else {
          coverImgSrc = mod.coverImage;
        }
      }

      var hasCoverImg = coverImgSrc.trim() !== '';
      var imgSrc = hasCoverImg ? coverImgSrc : loaded2Src;
      var imgStyle = hasCoverImg ? 'object-fit: cover;' : 'object-fit: contain;';

      var tagsHtml = '';
      if (mod.tags && mod.tags.length) {
        tagsHtml = '<div class="mod-tag-list">' +
          mod.tags.map(function (t) {
            return '<span class="mod-tag-item ' + t.toLowerCase() + '">' + t + '</span>';
          }).join('') + '</div>';
      }

      var card = document.createElement('div');
      card.className = 'mod-card';
      card.innerHTML =
        '<div class="mod-cover">' +
          '<div class="mod-cover-inner">' +
            '<div class="mod-cover-gradient" style="background:' + mod.coverGradient + ';"></div>' +
            '<img src="' + imgSrc + '" alt="' + mod.title + '" class="mod-cover-img"' +
              ' style="position:absolute; width:100%; height:100%; ' + imgStyle + ' z-index:2; border-radius:inherit;"' +
              ' onerror="this.onerror=null; this.src=\'data:image/svg+xml;charset=UTF-8,' +
              encodeURIComponent('<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 48 48\' fill=\'none\' stroke=\'%239a92a5\' stroke-width=\'3\'><circle cx=\'24\' cy=\'24\' r=\'20\'/><path d=\'M24 16v12\'/><circle cx=\'24\' cy=\'32\' r=\'2\' fill=\'%239a92a5\'/></svg>') +
              '\'; this.style.opacity=0.4;">' +
          '</div>' +
          '<span class="mod-badge ' + mod.badgeClass + '">' + mod.badge + '</span>' +
        '</div>' +
        '<div class="mod-info">' +
          '<div class="mod-title">' + mod.title + '</div>' +
          tagsHtml +
          '<div class="mod-meta">' +
            '<span class="mod-meta-tag">大小 ' + mod.size + '</span>' +
            '<span class="mod-meta-tag">日期 ' + mod.date + '</span>' +
          '</div>' +
          '<button class="mod-download-btn view-detail-btn">查看详情</button>' +
        '</div>';

      var coverImgEl = card.querySelector('.mod-cover-img');
      if (coverImgEl && hasCoverImg) {
        coverImgEl.addEventListener('click', function (e) {
          e.stopPropagation();
          if (coverImgEl.src && coverImgEl.src.indexOf('data:image/svg') === -1) {
            openLightbox(coverImgEl.src);
          }
        });
      }

      card.querySelector('.view-detail-btn').addEventListener('click', function (e) {
        e.stopPropagation();
        openModal(mod);
      });

      card.querySelectorAll('.mod-tag-item').forEach(function (tagEl) {
        tagEl.addEventListener('click', function (e) {
          e.stopPropagation();
          handleTagClick(tagEl.textContent);
        });
      });

      modGrid.appendChild(card);
      attachCardSpinner(card);
    });
  }
  async function performGlobalRidSearch(rid, forceNoStore) {
    var categories = ['all', 'skin'];

    if (!forceNoStore) {
      for (var i = 0; i < categories.length; i++) {
        var cat = categories[i];
        if (allSiteData[cat]) {
          var found = allSiteData[cat].find(function (m) { return m.id === rid; });
          if (found) return found;
        }
      }

      for (var j = 0; j < categories.length; j++) {
        var cat2 = categories[j];
        if (!allSiteData[cat2]) {
          await loadAllDataForCategory(cat2);
        }
        if (allSiteData[cat2]) {
          var found2 = allSiteData[cat2].find(function (m) { return m.id === rid; });
          if (found2) return found2;
        }
      }
    } else {
      for (var k = 0; k < categories.length; k++) {
        var cat3 = categories[k];
        var freshData = await loadAllDataForCategory(cat3, true);
        if (freshData) {
          var found3 = freshData.find(function (m) { return m.id === rid; });
          if (found3) return found3;
        }
      }
    }

    return null;
  }

  function filterMods() {
    var filtered = baseModData.slice();
    var query = searchInput.value.trim();

    if (query) {
      var lowerQuery = query.toLowerCase();

      if (lowerQuery.startsWith('rid:')) {
        var ridPart = lowerQuery.slice(4).trim();
        performGlobalRidSearch(ridPart).then(function (found) {
          if (found) {
            openModal(found);
            searchInput.value = '';
            searchDropdown.classList.remove('active');
          } else {
            modGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--text-muted);">未找到该 RID</div>';
            paginationEl.innerHTML = '';
          }
        });
        return;
      } else if (/^\d+$/.test(query)) {
        performGlobalRidSearch(query).then(function (found) {
          if (found) {
            openModal(found);
            searchInput.value = '';
            searchDropdown.classList.remove('active');
          } else {
            modGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--text-muted);">未找到该 RID</div>';
            paginationEl.innerHTML = '';
          }
        });
        return;
      } else {
        filtered = filtered.filter(function (m) {
          if (m.title.toLowerCase().includes(lowerQuery)) return true;
          if (m.tags && m.tags.some(function (tag) { return tag.toLowerCase().includes(lowerQuery); })) return true;
          return false;
        });
      }
    }

    currentPage = 1;
    modData = filtered;
    preloadState.currentPreloadPage = 0;
    renderPage(1);
    updateSearchDropdown(query);
  }

  function updateSearchDropdown(query) {
    searchDropdown.innerHTML = '';
    if (!query || query.length < 1) {
      searchDropdown.classList.remove('active');
      return;
    }

    var lowerQuery = query.toLowerCase();
    if (lowerQuery.startsWith('rid:') || /^\d+$/.test(query)) {
      searchDropdown.classList.remove('active');
      return;
    }

    var matches = modData.filter(function (m) {
      if (m.title.toLowerCase().includes(lowerQuery)) return true;
      if (m.tags && m.tags.some(function (tag) { return tag.toLowerCase().includes(lowerQuery); })) return true;
      return false;
    });

    if (matches.length === 0) {
      searchDropdown.innerHTML = '<li style="padding:16px;text-align:center;color:var(--text-muted);">没有找到相关MOD</li>';
    } else {
      var escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var regex = new RegExp('(' + escapedQuery + ')', 'gi');
      matches.slice(0, 8).forEach(function (m) {
        var li = document.createElement('li');
        li.className = 'search-dropdown-item';
        li.innerHTML = m.title.replace(regex, '<mark>$1</mark>');
        li.addEventListener('click', function () {
          searchInput.value = m.title;
          searchDropdown.classList.remove('active');
          filterMods();
        });
        searchDropdown.appendChild(li);
      });
    }

    searchDropdown.classList.add('active');
  }
  async function loadModData(categoryKey) {
    categoryKey = categoryKey || 'all';
    currentPage = 1;
    preloadState.currentPreloadPage = 0;
    var loaded2Src = window.loaded2GifSrc || FALLBACK_LOADED2;

    if (allSiteData[categoryKey]) {
      modData = allSiteData[categoryKey];
      baseModData = modData;
      searchInput.value = '';
      searchDropdown.classList.remove('active');
      renderPage(1);
      return;
    }

    modGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;"><img src="' + loaded2Src + '" alt="加载中" style="max-width:200px;"></div>';
    paginationEl.innerHTML = '';

    var data = await loadAllDataForCategory(categoryKey);
    if (data && data.length) {
      modData = data;
      baseModData = data;
      searchInput.value = '';
      searchDropdown.classList.remove('active');
      renderPage(1);
    } else {
      modGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;">MOD数据加载失败，请稍后再试</div>';
    }
  }

  document.getElementById('categoryTags').addEventListener('click', function (e) {
    var tag = e.target.closest('.category-tag');
    if (!tag) return;
    document.querySelectorAll('.category-tag').forEach(function (t) { t.classList.remove('active'); });
    tag.classList.add('active');
    activeCategory = tag.getAttribute('data-category') || 'all';
    loadModData(activeCategory);
  });

  searchInput.addEventListener('input', filterMods);
  searchInput.addEventListener('focus', function () {
    if (searchInput.value.trim().length >= 1) updateSearchDropdown(searchInput.value.trim());
  });
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      searchDropdown.classList.remove('active');
      searchInput.blur();
    }
    if (e.key === 'Enter') {
      searchDropdown.classList.remove('active');
      filterMods();
    }
  });

  document.addEventListener('click', function (e) {
    if (!searchContainer.contains(e.target)) searchDropdown.classList.remove('active');
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (modData.length > 0) {
        renderPagination(modData.length, currentPage);
      }
    }, 200);
  });

  charaClose.addEventListener('click', function () {
    charaOverlay.classList.remove('active');
  });
  charaOverlay.addEventListener('click', function (e) {
    if (e.target === charaOverlay) charaOverlay.classList.remove('active');
  });

  function openCharaDetail() {
    if (logoImg.src && logoImg.style.display !== 'none') {
      charaImg.src = logoImg.src;
    } else {
      charaImg.src = '';
    }
    charaOverlay.classList.add('active');
  }

  async function handleUrlParams() {
    var params = new URLSearchParams(window.location.search);
    var rid = params.get('rid');
    if (rid) {
      var found = await performGlobalRidSearch(rid);
      if (found) {
        openModal(found);
      } else {
        found = await performGlobalRidSearch(rid, true);
        if (found) {
          openModal(found);
        } else {
          showToast('未找到该帖子');
        }
      }
      history.replaceState({}, document.title, window.location.pathname);
    }
  }
  async function initPage() {
    var loadingGifUrls = [
      'http://shp.qpic.cn/collector/1976464052/8ca28b73-c355-4abe-92e8-d4da82b9c560/0',
      'https://p.qpic.cn/psn_labels/ayJapABWAwW4hmBFXiaqn7icrqSOuPYeSRQw4iaPl6ZCFxU66CiaGkhEicLCnEibnfSRX2T4Zhze15Rbg/0'
    ];
    var logoUrls = [
      'http://shp.qpic.cn/collector/1976464052/96cdbd3e-dbfb-4d1e-894e-a213de625f4b/0',
      'http://shp.qpic.cn/collector/2716502452/2819511f-0d0a-440d-9f45-cd666ec577d8/0'
    ];
    var loaded2GifUrls = [
      'http://shp.qpic.cn/collector/1976464052/35195f23-993a-4bae-a95b-b01054c9aa2c/0',
      'https://p.qpic.cn/psn_labels/ayJapABWAwW4hmBFXiaqn7icrqSOuPYeSRb8kvrUia3vonmc1Qke2xRzZticdf6bkIGYzicc43F7x6RI/0'
    ];

    try {
      var fetchWithTimeout = Promise.race([
        fetch('resources/json/config.json', { cache: 'default' }),
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('timeout')); }, 3000);
        })
      ]);
      var resp = await fetchWithTimeout;
      if (resp.ok) {
        var config = await resp.json();
        if (config.loadingGifUrls && config.loadingGifUrls.length) loadingGifUrls = config.loadingGifUrls;
        if (config.logoUrls && config.logoUrls.length) logoUrls = config.logoUrls;
        if (config.loaded2GifUrls && config.loaded2GifUrls.length) loaded2GifUrls = config.loaded2GifUrls;
      }
    } catch (e) {}

    var gifPromise = raceImage(loadingGifUrls).catch(function () { return null; });
    gifPromise.then(function (src) {
      if (src) {
        loadingGif.src = src;
        loadingGif.style.display = 'block';
        if (potionWrapper) potionWrapper.style.display = 'none';
      }
    });

    var logoPromise = (async function loadLogoWithRetry() {
      for (var attempt = 0; attempt < 3; attempt++) {
        try {
          return await raceImage(logoUrls);
        } catch (err) {
          if (attempt < 2) {
            await new Promise(function (resolve) { setTimeout(resolve, 2000); });
          }
        }
      }
      return null;
    })();
    logoPromise.then(function (src) {
      if (src) {
        logoImg.src = src;
        logoImg.style.display = 'block';
        logoTower.style.display = 'none';
      }
    });

    var loaded2Promise = raceImage(loaded2GifUrls).catch(function () { return null; });
    loaded2Promise.then(function (src) {
      if (src) window.loaded2GifSrc = src;
    });

    var urlParams = new URLSearchParams(window.location.search);
    var hasRid = !!urlParams.get('rid');

    var preloadPromise = Promise.race([
      priorityPreload(),
      new Promise(function (resolve) { setTimeout(resolve, 6000); })
    ]);

    await preloadPromise;

    loadingOverlay.classList.add('hidden');
    mainContent.style.opacity = '1';

    if (allSiteData['all']) {
      modData = allSiteData['all'];
      baseModData = modData;
      renderPage(1);
    } else {
      loadModData('all');
    }

    if (hasRid) {
      handleUrlParams();
    }

    logoArea.addEventListener('click', function (e) {
      if (e.target === logoArea || e.target === logoImg || e.target.closest('.logo-img') || e.target.closest('.logo-tower')) {
        openCharaDetail();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
  } else {
    initPage();
  }
})();