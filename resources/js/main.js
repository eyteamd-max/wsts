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

  function raceVideo(urls) {
    if (!urls || urls.length === 0) return Promise.reject('no urls');

    var videos = [];
    var promises = urls.map(function (url) {
      return new Promise(function (resolve, reject) {
        var video = document.createElement('video');
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;

        var timer = setTimeout(function () {
          reject(new Error('video load stalled'));
        }, 8000);

        video.onloadeddata = function () {
          clearTimeout(timer);
          resolve({ url: url, video: video });
        };
        video.onerror = function () {
          clearTimeout(timer);
          reject(new Error('video load failed'));
        };

        video.src = url;
        videos.push(video);
      });
    });

    return Promise.any(promises).then(function (result) {
      videos.forEach(function (v) {
        if (v !== result.video) {
          v.onloadeddata = v.onerror = null;
          v.src = '';
          v.load();
        }
      });

      var cleanVideo = result.video.cloneNode(true);
      cleanVideo.muted = true;
      cleanVideo.playsInline = true;
      cleanVideo.preload = 'metadata';
      return cleanVideo;
    }).catch(function (e) {
      videos.forEach(function (v) {
        v.onloadeddata = v.onerror = null;
        v.src = '';
      });
      throw e;
    });
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

  async function loadAllDataForCategory(categoryKey) {
    if (allSiteData[categoryKey]) return allSiteData[categoryKey];
    if (dataLoadingPromises[categoryKey]) return await dataLoadingPromises[categoryKey];

    var promise = (async function () {
      var manifest = await loadManifest(categoryKey);
      var dirMap = { all: 'sts2_mods', skin: 'O.o_interface' };
      var dir = dirMap[categoryKey];

      if (manifest && manifest[dir]) {
        var rangeStr = manifest[dir];
        var indices = parseManifestRange(rangeStr);
        var dataArrays = await Promise.all(indices.map(function (idx) {
          return loadJsonByManifest(categoryKey, idx);
        }));
        var allData = dataArrays.flat();
        allSiteData[categoryKey] = allData;
        return allData;
      }

      var url = dataSources[categoryKey];
      if (!url) return [];
      try {
        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, 8000);
        var response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeoutId);
        if (!response.ok) return [];
        var rawData = await response.json();
        rawData = sortModsByTimeId(rawData);
        allSiteData[categoryKey] = rawData;
        return rawData;
      } catch (error) {
        return [];
      }
    })();

    dataLoadingPromises[categoryKey] = promise;
    try {
      var result = await promise;
      return result;
    } finally {
      delete dataLoadingPromises[categoryKey];
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

    function createPageBtn(pageNum, isActive) {
      var btn = document.createElement('button');
      btn.className = 'pagination-page' + (isActive ? ' active' : '');
      btn.textContent = pageNum;
      btn.addEventListener('click', function () {
        currentPage = pageNum;
        renderPage(pageNum);
        modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return btn;
    }

    function createDots() {
      var dots = document.createElement('span');
      dots.className = 'pagination-dots';
      dots.textContent = '...';
      return dots;
    }

    var isMobile = window.innerWidth <= 480;

    var prevBtn = document.createElement('button');
    prevBtn.className = 'pagination-btn';
    prevBtn.innerHTML = '&#8249;';
    prevBtn.disabled = currentPageNum <= 1;
    prevBtn.addEventListener('click', function () {
      if (currentPageNum > 1) {
        currentPage = currentPageNum - 1;
        renderPage(currentPage);
        modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    paginationEl.appendChild(prevBtn);

    if (isMobile && totalPages > 5) {
      var pages = [];
      pages.push(1);
      if (currentPageNum !== 1) {
        pages.push('...');
        pages.push(currentPageNum);
      }
      if (currentPageNum !== totalPages) {
        pages.push('...');
        pages.push(totalPages);
      }
      pages.forEach(function (item) {
        if (item === '...') {
          paginationEl.appendChild(createDots());
        } else {
          paginationEl.appendChild(createPageBtn(item, item === currentPageNum));
        }
      });
    } else if (totalPages <= 5) {
      for (var i = 1; i <= totalPages; i++) {
        paginationEl.appendChild(createPageBtn(i, i === currentPageNum));
      }
    } else {
      paginationEl.appendChild(createPageBtn(1, 1 === currentPageNum));

      var leftNeighbor = currentPageNum - 1;
      var rightNeighbor = currentPageNum + 1;
      var middleSet = new Set();

      if (leftNeighbor > 1 && leftNeighbor < totalPages) middleSet.add(leftNeighbor);
      if (currentPageNum > 1 && currentPageNum < totalPages) middleSet.add(currentPageNum);
      if (rightNeighbor > 1 && rightNeighbor < totalPages) middleSet.add(rightNeighbor);

      var middlePages = Array.from(middleSet).sort(function (a, b) { return a - b; });

      if (middlePages.length > 0 && middlePages[0] > 2) {
        paginationEl.appendChild(createDots());
      }
      middlePages.forEach(function (p) {
        paginationEl.appendChild(createPageBtn(p, p === currentPageNum));
      });
      if (middlePages.length > 0 && middlePages[middlePages.length - 1] < totalPages - 1) {
        paginationEl.appendChild(createDots());
      }

      paginationEl.appendChild(createPageBtn(totalPages, totalPages === currentPageNum));
    }

    var nextBtn = document.createElement('button');
    nextBtn.className = 'pagination-btn';
    nextBtn.innerHTML = '&#8250;';
    nextBtn.disabled = currentPageNum >= totalPages;
    nextBtn.addEventListener('click', function () {
      if (currentPageNum < totalPages) {
        currentPage = currentPageNum + 1;
        renderPage(currentPage);
        modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    paginationEl.appendChild(nextBtn);
    var gotoWrap = document.createElement('span');
    gotoWrap.className = 'pagination-goto';

    var gotoInput = document.createElement('input');
    gotoInput.type = 'text';
    gotoInput.className = 'pagination-goto-input';
    gotoInput.placeholder = totalPages + '';
    gotoInput.maxLength = 3;
    gotoInput.setAttribute('aria-label', '输入页码');

    var gotoBtn = document.createElement('button');
    gotoBtn.className = 'pagination-goto-btn';
    gotoBtn.innerHTML = '';
    gotoBtn.className = 'pagination-goto-btn goto-search-icon';
    gotoBtn.setAttribute('aria-label', '跳转到指定页');

    var gotoMobile = document.createElement('button');
    gotoMobile.className = 'pagination-goto-mobile-trigger goto-search-icon';
    gotoMobile.innerHTML = '';
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
      if (e.key === 'Enter') {
        doGoto(this.value);
      }
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

  async function raceVideoWithRetry(urls, maxRetries) {
    maxRetries = maxRetries || 2;
    var lastError;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await raceVideo(urls);
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

    items.forEach(function (item) {
      var ph = document.createElement('div');
      ph.className = 'preview-video-item';
      ph.style.background = '#f0f0f0';
      ph.style.height = '200px';
      ph.style.display = 'flex';
      ph.style.alignItems = 'center';
      ph.style.justifyContent = 'center';
      ph.textContent = '视频加载中...';
      list.appendChild(ph);

      var urls = [];
      if (typeof item === 'string') {
        urls = [item];
      } else if (item.urls && Array.isArray(item.urls) && item.urls.length > 0) {
        urls = item.urls;
      } else if (item.url) {
        urls = [item.url];
      }

      if (urls.length === 0) {
        ph.textContent = '视频链接缺失';
        return;
      }

      raceVideoWithRetry(urls).then(function (video) {
        video.className = 'preview-video-item';
        video.controls = true;
        if (item.poster) video.poster = item.poster;
        list.replaceChild(video, ph);
      }).catch(function () {
        ph.textContent = '视频加载失败';
      });
    });
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
    var urlRegex = /(https?:\/\/[^\s<<"]+)/g;
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
  async function performGlobalRidSearch(rid) {
    var categories = ['all', 'skin'];

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
        showToast('未找到该帖子');
      }
      history.replaceState({}, document.title, window.location.pathname);
    }
  }
  async function initPage() {
    var loadingGifUrls = [
      'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded.gif'
    ];
    var logoUrls = [
      'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/Lihui.gif'
    ];
    var loaded2GifUrls = [
      'http://shp.qpic.cn/collector/1976464052/35195f23-993a-4bae-a95b-b01054c9aa2c/0',
      'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif',
      'https://cdn.jsdelivr.net/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif'
    ];

    try {
      var fetchWithTimeout = Promise.race([
        fetch('resources/json/config.json', { cache: 'no-store' }),
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
