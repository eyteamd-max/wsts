(function() {
  // ========== 工具函数 ==========
  function raceImage(urls, timeout = 3500) {
    if (!urls || urls.length === 0) return Promise.reject('no urls');
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('image load timeout')), timeout));
    const loadPromises = urls.map(url => new Promise((resolve, reject) => {
      const img = new Image();
      const stallTimer = setTimeout(() => reject(new Error('image load stalled')), timeout + 2000);
      img.onload = img.onerror = (e) => {
        clearTimeout(stallTimer);
        if (e.type === 'load') resolve(url);
        else reject(new Error('image load failed'));
      };
      img.src = url;
    }));
    return Promise.race([
      Promise.any([timeoutPromise, ...loadPromises]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('total timeout')), timeout + 3000))
    ]);
  }

  function raceVideo(urls) {
    if (!urls || urls.length === 0) return Promise.reject('no urls');
    const videos = [];
    const promises = urls.map(url => new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      const timer = setTimeout(() => reject(new Error('video load stalled')), 8000);
      video.onloadeddata = () => { clearTimeout(timer); resolve({ url, video }); };
      video.onerror = () => { clearTimeout(timer); reject(new Error('video load failed')); };
      video.src = url;
      videos.push(video);
    }));
    return Promise.any(promises).then(result => {
      videos.forEach(v => {
        if (v !== result.video) { v.onloadeddata = v.onerror = null; v.src = ''; v.load(); }
      });
      const cleanVideo = result.video.cloneNode(true);
      cleanVideo.muted = true;
      cleanVideo.playsInline = true;
      cleanVideo.preload = 'metadata';
      return cleanVideo;
    }).catch(e => {
      videos.forEach(v => { v.onloadeddata = v.onerror = null; v.src = ''; });
      throw e;
    });
  }

  function toCandidates(item) {
    if (Array.isArray(item)) return item.length ? item : [item];
    return [item];
  }

  function sortModsByTimeId(dataArray) {
    return dataArray.slice().sort((a, b) => (b.id || '').localeCompare(a.id || ''));
  }

  // ========== DOM元素 ==========
  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingGif = document.getElementById('loadingGif');
  const loadingText = document.getElementById('loadingText');
  const potionWrapper = document.getElementById('potionWrapper');
  const mainContent = document.getElementById('mainContent');
  mainContent.style.opacity = '0';
  mainContent.style.transition = 'opacity 0.5s ease';

  const logoImg = document.getElementById('logoImg');
  const logoTower = document.getElementById('logoTower');
  const logoArea = document.getElementById('logoArea');

  let modData = [];          // 当前显示的卡片数据
  let activeCategory = 'all'; // 'all' → sts2_mods, 'skin' → O.o_interface
  let currentPage = 1;
  let totalPages = 1;
  const ITEMS_PER_PAGE = 8;

  // 分区与目录映射
  const categoryKeyMap = {
    all: 'sts2_mods',
    skin: 'O.o_interface'
  };

  const modGrid = document.getElementById('modGrid');
  const searchInput = document.getElementById('searchInput');
  const searchDropdown = document.getElementById('searchDropdown');
  const searchContainer = document.getElementById('searchContainer');
  const modalOverlay = document.getElementById('modalOverlay');
  const modalClose = document.getElementById('modalClose');
  const modalTitle = document.getElementById('modalTitle');
  const modalRid = document.getElementById('modalRid');
  const ridCopyMenu = document.getElementById('ridCopyMenu');
  const ridCopyRid = document.getElementById('ridCopyRid');
  const ridCopyLink = document.getElementById('ridCopyLink');
  const modalTags = document.getElementById('modalTags');
  const modalDescText = document.getElementById('modalDescText');
  const descToggle = document.getElementById('descToggle');
  const modalAuthor = document.getElementById('modalAuthor');
  const modalLinks = document.getElementById('modalLinks');
  const downloadButtons = document.getElementById('downloadButtons');
  const carouselPrev = document.getElementById('carouselPrev');
  const carouselNext = document.getElementById('carouselNext');
  const lightboxOverlay = document.getElementById('lightboxOverlay');
  const lightboxClose = document.getElementById('lightboxClose');
  const lightboxImg = document.getElementById('lightboxImg');
  const previewImagesBtn = document.getElementById('previewImagesBtn');
  const previewVideosBtn = document.getElementById('previewVideosBtn');
  const previewContentArea = document.getElementById('previewContentArea');
  const charaOverlay = document.getElementById('charaOverlay');
  const charaClose = document.getElementById('charaClose');
  const charaImg = document.getElementById('charaImg');
  const toast = document.getElementById('toast');
  const paginationWrapper = document.getElementById('paginationWrapper');

  // 图片资源常量
  const FALLBACK_LOADED2 = 'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif';
  window.loaded2GifSrc = null;

  // 当前详情页数据
  let currentMod = null;
  let currentImages = [];
  let currentIndex = 0;
  let activePreviewTab = null;

  // Toast 工具
  let toastTimer;
  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('show');
    toastTimer = setTimeout(() => { toast.classList.remove('show'); }, 2200);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    } else {
      return new Promise((resolve, reject) => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try { document.execCommand('copy'); document.body.removeChild(textarea); resolve(); }
        catch (err) { document.body.removeChild(textarea); reject(err); }
      });
    }
  }

  // ========== RID 弹出菜单 ==========
  modalRid.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!currentMod) return;
    const rect = modalRid.getBoundingClientRect();
    ridCopyMenu.style.top = rect.bottom + 4 + 'px';
    ridCopyMenu.style.left = rect.left + 'px';
    ridCopyMenu.classList.toggle('active');
  });

  ridCopyRid.addEventListener('click', () => {
    if (!currentMod) return;
    const ridText = 'RID:' + (currentMod.id || '');
    copyText(ridText).then(() => showToast('RID 已复制')).catch(() => showToast('复制失败'));
    ridCopyMenu.classList.remove('active');
  });

  ridCopyLink.addEventListener('click', () => {
    if (!currentMod) return;
    const link = `https://axxxx.cyou/?rid=${currentMod.id || ''}`;
    copyText(link).then(() => showToast('帖子链接已复制')).catch(() => showToast('复制失败'));
    ridCopyMenu.classList.remove('active');
  });

  // 点击其他地方关闭菜单
  document.addEventListener('click', (e) => {
    if (!ridCopyMenu.contains(e.target) && e.target !== modalRid) {
      ridCopyMenu.classList.remove('active');
    }
  });

  // ========== 分页器 ==========
  function renderPagination() {
    paginationWrapper.innerHTML = '';
    if (totalPages <= 1) return;

    const prevBtn = document.createElement('span');
    prevBtn.className = 'pagination-btn';
    prevBtn.innerHTML = '‹';
    prevBtn.disabled = currentPage === 1;
    prevBtn.addEventListener('click', () => {
      if (currentPage > 1) goToPage(currentPage - 1);
    });

    const nextBtn = document.createElement('span');
    nextBtn.className = 'pagination-btn';
    nextBtn.innerHTML = '›';
    nextBtn.disabled = currentPage === totalPages;
    nextBtn.addEventListener('click', () => {
      if (currentPage < totalPages) goToPage(currentPage + 1);
    });

    paginationWrapper.appendChild(prevBtn);

    for (let p = 1; p <= totalPages; p++) {
      const pageBtn = document.createElement('span');
      pageBtn.className = 'pagination-page';
      if (p === currentPage) pageBtn.classList.add('active');
      pageBtn.textContent = p;
      pageBtn.addEventListener('click', () => goToPage(p));
      paginationWrapper.appendChild(pageBtn);
    }

    paginationWrapper.appendChild(nextBtn);
  }

  function goToPage(page) {
    if (page < 1 || page > totalPages || page === currentPage) return;
    currentPage = page;
    loadPageData(activeCategory, currentPage);
  }

  // ========== 数据加载（基于 manifest + 分页） ==========
  const jsonCache = {}; // 缓存已加载的 JSON 文件数据

  async function fetchJSON(url, timeoutMs = 8000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error('加载失败');
    return response.json();
  }

  async function loadManifest(categoryKey) {
    const manifestUrl = `resources/json/post/${categoryKey}/manifest.json`;
    try {
      const manifest = await fetchJSON(manifestUrl, 5000);
      return manifest;
    } catch (e) {
      throw new Error('配置加载失败，请刷新重试');
    }
  }

  async function loadPageData(categoryKey, page) {
    const catDir = categoryKeyMap[categoryKey] || categoryKey;
    // 显示加载占位
    const loaded2Src = window.loaded2GifSrc || FALLBACK_LOADED2;
    modGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;"><img src="${loaded2Src}" alt="加载中" style="max-width:200px;"></div>`;
    paginationWrapper.innerHTML = '';

    try {
      // 1. 读取 manifest 获取总页数
      const manifest = await loadManifest(catDir);
      const range = manifest[catDir];
      if (!range) throw new Error('manifest 配置无效');
      const parts = range.split('~');
      const maxPage = parseInt(parts[1]) || 1;
      totalPages = maxPage;
      if (currentPage > totalPages) currentPage = totalPages;

      // 2. 拼接当前页 JSON 文件名
      const jsonFileName = `${catDir}_${currentPage}.json`;
      const jsonUrl = `resources/json/post/${catDir}/${jsonFileName}`;

      // 3. 使用缓存或加载
      let data;
      if (jsonCache[jsonUrl]) {
        data = jsonCache[jsonUrl];
      } else {
        data = await fetchJSON(jsonUrl, 8000);
        data = sortModsByTimeId(data);
        jsonCache[jsonUrl] = data;
      }

      modData = data;
      renderModCards(modData);
      renderPagination();
      // 回到顶部
      window.scrollTo({ top: modGrid.offsetTop - 20, behavior: 'smooth' });

    } catch (error) {
      if (error.message === '配置加载失败，请刷新重试') {
        modGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;">${error.message}</div>`;
      } else {
        modGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;">该页数据走丢了，点击重试</div>`;
        modGrid.querySelector('div').style.cursor = 'pointer';
        modGrid.querySelector('div').addEventListener('click', () => loadPageData(activeCategory, currentPage));
      }
      totalPages = 1;
      currentPage = 1;
      renderPagination();
    }
  }

  // 切换分区时重置页码
  function switchCategory(categoryKey) {
    activeCategory = categoryKey;
    currentPage = 1;
    loadPageData(categoryKey, 1);
  }

  // ========== 全站 RID 搜索 ==========
  async function searchRIDAcrossAll(rid) {
    const allDirs = ['sts2_mods', 'O.o_interface'];
    for (const dir of allDirs) {
      try {
        const manifest = await loadManifest(dir);
        const range = manifest[dir];
        if (!range) continue;
        const parts = range.split('~');
        const max = parseInt(parts[1]) || 1;
        for (let p = 1; p <= max; p++) {
          const jsonFileName = `${dir}_${p}.json`;
          const jsonUrl = `resources/json/post/${dir}/${jsonFileName}`;
          let data;
          if (jsonCache[jsonUrl]) {
            data = jsonCache[jsonUrl];
          } else {
            data = await fetchJSON(jsonUrl, 8000);
            data = sortModsByTimeId(data);
            jsonCache[jsonUrl] = data;
          }
          const found = data.find(m => m.id === rid);
          if (found) return found;
        }
      } catch (e) {
        // 某个分区加载失败不影响继续搜索
        continue;
      }
    }
    return null;
  }

  // ========== 卡片渲染与事件 ==========
  function attachCardSpinner(cardElement) {
    const coverInner = cardElement.querySelector('.mod-cover-inner');
    const coverImg = coverInner ? coverInner.querySelector('.mod-cover-img') : null;
    if (!coverInner || !coverImg) return;
    // 清除已有 spinner
    const existing = coverInner.querySelector('.card-spinner');
    if (existing) existing.remove();

    const spinner = document.createElement('span');
    spinner.className = 'card-spinner';
    const hideSpinner = () => { if (spinner.parentNode) spinner.remove(); };

    if (coverImg.complete) {
      // 图片已加载，不显示spinner
    } else {
      coverImg.addEventListener('load', hideSpinner);
      coverImg.addEventListener('error', hideSpinner);
      coverInner.appendChild(spinner);
    }
  }

  function renderModCards(dataArray) {
    modGrid.innerHTML = '';
    if (dataArray.length === 0) {
      modGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--text-muted);">没有找到相关MOD</div>`;
      return;
    }
    const loaded2Src = window.loaded2GifSrc || FALLBACK_LOADED2;
    dataArray.forEach(mod => {
      let coverImgSrc = '';
      if (mod.coverImage) {
        if (Array.isArray(mod.coverImage)) { coverImgSrc = mod.coverImage[0] || ''; }
        else { coverImgSrc = mod.coverImage; }
      }
      const hasCoverImg = coverImgSrc.trim() !== '';
      const imgSrc = hasCoverImg ? coverImgSrc : loaded2Src;
      const imgStyle = hasCoverImg ? 'object-fit: cover;' : 'object-fit: contain;';
      let tagsHtml = '';
      if (mod.tags && mod.tags.length) {
        tagsHtml = '<div class="mod-tag-list">' + mod.tags.map(t =>
          `<span class="mod-tag-item ${t.toLowerCase()}">${t.toUpperCase()}</span>`
        ).join('') + '</div>';
      }
      const card = document.createElement('div');
      card.className = 'mod-card';
      card.innerHTML = `
        <div class="mod-cover">
          <div class="mod-cover-inner">
            <div class="mod-cover-gradient" style="background:${mod.coverGradient};"></div>
            <img src="${imgSrc}" alt="${mod.title}" class="mod-cover-img"
              style="position:absolute; width:100%; height:100%; ${imgStyle} z-index:2; border-radius:inherit;"
              onerror="this.onerror=null; this.src='data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none' stroke='%239a92a5' stroke-width='3'><circle cx='24' cy='24' r='20'/><path d='M24 16v12'/><circle cx='24' cy='32' r='2' fill='%239a92a5'/></svg>`)}'; this.style.opacity=0.4;">
          </div>
          <span class="mod-badge ${mod.badgeClass}">${mod.badge}</span>
        </div>
        <div class="mod-info">
          <div class="mod-title">${mod.title}</div>
          ${tagsHtml}
          <div class="mod-meta">
            <span class="mod-meta-tag">大小 ${mod.size}</span>
            <span class="mod-meta-tag">日期 ${mod.date}</span>
          </div>
          <button class="mod-download-btn view-detail-btn">查看详情</button>
        </div>`;
      card.querySelector('.view-detail-btn').addEventListener('click', (e) => { e.stopPropagation(); openModal(mod); });
      card.querySelectorAll('.mod-tag-item').forEach(tagEl => {
        tagEl.addEventListener('click', (e) => { e.stopPropagation(); handleTagClick(tagEl.textContent); });
      });
      modGrid.appendChild(card);
      attachCardSpinner(card);
    });
  }

  function handleTagClick(tagText) {
    searchInput.value = tagText;
    // 不切换 active 分区，只触发搜索
    filterMods();
    searchInput.focus();
  }

  // ========== 搜索与过滤（含全站RID） ==========
  function filterMods() {
    const query = searchInput.value.trim();
    if (!query) {
      // 空搜索：加载当前分区当前页数据
      loadPageData(activeCategory, currentPage);
      updateSearchDropdown('');
      return;
    }
    const lowerQuery = query.toLowerCase();

    // 判断是否为 RID 搜索
    const isRidSearch = lowerQuery.startsWith('rid:') || /^\d+$/.test(query);
    if (isRidSearch) {
      const ridPart = lowerQuery.startsWith('rid:') ? lowerQuery.slice(4).trim() : query;
      searchDropdown.classList.remove('active');
      // 全站搜索 RID
      searchRIDAcrossAll(ridPart).then(mod => {
        if (mod) {
          openModal(mod);
        } else {
          modGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px;">未找到该 RID 对应的 MOD</div>';
          paginationWrapper.innerHTML = '';
        }
      }).catch(() => {
        modGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px;">搜索失败，请重试</div>';
      });
      return;
    }

    // 普通搜索：在当前已加载数据中过滤（保持分页结果）
    let filtered = modData.filter(m => {
      if (m.title.toLowerCase().includes(lowerQuery)) return true;
      if (m.tags && m.tags.some(tag => tag.toLowerCase().includes(lowerQuery))) return true;
      return false;
    });
    renderModCards(filtered);
    updateSearchDropdown(query);
  }

  function updateSearchDropdown(query) {
    searchDropdown.innerHTML = '';
    if (!query || query.length < 1) { searchDropdown.classList.remove('active'); return; }
    const lowerQuery = query.toLowerCase();
    if (lowerQuery.startsWith('rid:') || /^\d+$/.test(query)) { searchDropdown.classList.remove('active'); return; }
    const matches = modData.filter(m => {
      if (m.title.toLowerCase().includes(lowerQuery)) return true;
      if (m.tags && m.tags.some(tag => tag.toLowerCase().includes(lowerQuery))) return true;
      return false;
    });
    if (matches.length === 0) {
      searchDropdown.innerHTML = '<li style="padding:16px;text-align:center;color:var(--text-muted);">没有找到相关MOD</li>';
    } else {
      const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escapedQuery})`, 'gi');
      matches.slice(0, 8).forEach(m => {
        const li = document.createElement('li');
        li.className = 'search-dropdown-item';
        li.innerHTML = m.title.replace(regex, '<mark>$1</mark>');
        li.addEventListener('click', () => { searchInput.value = m.title; searchDropdown.classList.remove('active'); filterMods(); });
        searchDropdown.appendChild(li);
      });
    }
    searchDropdown.classList.add('active');
  }

  // ========== 详情弹窗 ==========
  async function openModal(mod) {
    currentMod = mod;
    // 加载中遮罩
    const loadingOverlayEl = document.createElement('div');
    loadingOverlayEl.className = 'modal-loading-overlay';
    loadingOverlayEl.innerHTML = `<div class="modal-loading-spinner"></div><div class="modal-loading-text">网页有点重，猫猫正在努力叼过来...</div>`;
    document.body.appendChild(loadingOverlayEl);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-loading-close';
    closeBtn.innerHTML = '&times;';
    document.body.appendChild(closeBtn);
    let cancelled = false;
    const cleanupLoading = () => {
      if (loadingOverlayEl.parentNode) loadingOverlayEl.remove();
      if (closeBtn.parentNode) closeBtn.remove();
    };
    closeBtn.addEventListener('click', () => { cancelled = true; cleanupLoading(); currentMod = null; });

    let imageCandidates = [];
    if (mod.images && mod.images.length > 0) imageCandidates = mod.images;
    else if (mod.coverImage) imageCandidates = [mod.coverImage];

    let finalImages = [];
    try {
      const results = await Promise.all(
        imageCandidates.map(item => raceImage(toCandidates(item)).catch(() => null))
      );
      if (cancelled) return;
      finalImages = results.filter(url => url !== null);
    } catch (e) { if (cancelled) return; }

    cleanupLoading();
    if (cancelled) { currentMod = null; return; }

    modalTitle.textContent = mod.title;
    modalRid.textContent = 'RID: ' + (mod.id || '无');

    modalTags.innerHTML = '';
    if (mod.tags && Array.isArray(mod.tags)) {
      mod.tags.forEach(tag => {
        const span = document.createElement('span');
        span.className = 'modal-tag ' + tag.toLowerCase();
        span.textContent = tag.toUpperCase();
        modalTags.appendChild(span);
      });
    }

    // 描述文本，自动识别链接
    const desc = (mod.description || '暂无介绍');
    const urlRegex = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    const descHtml = desc
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(urlRegex, (url) => {
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
      })
      .replace(/\n/g, '<br>');
    modalDescText.innerHTML = descHtml;
    modalDescText.classList.remove('expanded');
    descToggle.style.display = 'none';
    descToggle.textContent = '展开全文';

    modalAuthor.textContent = '作者：' + (mod.author || '佚名');

    modalLinks.innerHTML = '';
    if (mod.authorLinks) {
      if (Array.isArray(mod.authorLinks)) {
        mod.authorLinks.forEach(link => {
          if (link.text && link.url) {
            const a = document.createElement('a');
            a.className = 'modal-link';
            a.href = link.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = link.text;
            modalLinks.appendChild(a);
          }
        });
      } else {
        const links = [
          { name: 'Twitter', url: mod.authorLinks.twitter },
          { name: 'Pixiv', url: mod.authorLinks.pixiv },
          { name: 'Bilibili', url: mod.authorLinks.bilibili }
        ];
        links.forEach(link => {
          if (link.url) {
            const a = document.createElement('a');
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
    const downloadLinks = mod.downloadLinks && mod.downloadLinks.length
      ? mod.downloadLinks
      : (mod.downloadUrl ? [{ text: '下载', url: mod.downloadUrl }] : []);
    downloadLinks.forEach(dl => {
      const btn = document.createElement('a');
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

    // 去掉图片框，保留翻页按钮（只有存在图片时才显示按钮）
    currentImages = finalImages;
    currentIndex = 0;
    if (currentImages.length > 0) {
      carouselPrev.style.display = '';
      carouselNext.style.display = '';
    } else {
      carouselPrev.style.display = 'none';
      carouselNext.style.display = 'none';
    }

    modalOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
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
    ridCopyMenu.classList.remove('active');
  }

  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
  descToggle.addEventListener('click', () => {
    const expanded = modalDescText.classList.toggle('expanded');
    descToggle.textContent = expanded ? '收起' : '展开全文';
  });

  // 轮播按钮（虽然没有容器，但切换预览图片）
  carouselPrev.addEventListener('click', () => {
    if (!currentImages.length) return;
    currentIndex = (currentIndex - 1 + currentImages.length) % currentImages.length;
    // 可将当前图片显示在 lightbox 或其他位置，此处简单切换 lightbox
    lightboxImg.src = currentImages[currentIndex];
    lightboxOverlay.classList.add('active');
  });
  carouselNext.addEventListener('click', () => {
    if (!currentImages.length) return;
    currentIndex = (currentIndex + 1) % currentImages.length;
    lightboxImg.src = currentImages[currentIndex];
    lightboxOverlay.classList.add('active');
  });

  lightboxClose.addEventListener('click', () => lightboxOverlay.classList.remove('active'));
  lightboxOverlay.addEventListener('click', (e) => { if (e.target === lightboxOverlay) lightboxOverlay.classList.remove('active'); });

  // ========== 预览资源（三次重试） ==========
  function switchPreviewTab(tab) {
    activePreviewTab = (activePreviewTab === tab) ? null : tab;
    updatePreviewButtons();
    renderPreviewContent();
  }

  function updatePreviewButtons() {
    const imgActive = activePreviewTab === 'images';
    const vidActive = activePreviewTab === 'videos';
    previewImagesBtn.textContent = imgActive ? '预览图片 ▴' : '预览图片 ▾';
    previewVideosBtn.textContent = vidActive ? '预览视频 ▴' : '预览视频 ▾';
    previewImagesBtn.classList.toggle('active', imgActive);
    previewVideosBtn.classList.toggle('active', vidActive);
  }

  function renderPreviewContent() {
    if (!currentMod) { previewContentArea.innerHTML = ''; return; }
    const mod = currentMod;
    previewContentArea.innerHTML = '<div class="preview-empty-card">正在加载预览资源...</div>';
    if (activePreviewTab === 'images') {
      renderPreviewImages(Array.isArray(mod.previewImages) ? mod.previewImages : []);
    } else if (activePreviewTab === 'videos') {
      renderPreviewVideos(Array.isArray(mod.previewVideos) ? mod.previewVideos : []);
    } else {
      previewContentArea.innerHTML = '';
    }
  }

  async function loadImageWithRetry(urls, retries = 3) {
    let lastError;
    for (let i = 0; i < retries; i++) {
      try {
        const url = await raceImage(urls);
        return url;
      } catch (e) {
        lastError = e;
        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 500)); // 短暂延迟
        }
      }
    }
    throw lastError;
  }

  async function renderPreviewImages(items) {
    if (items.length === 0) {
      previewContentArea.innerHTML = '<div class="preview-empty-card">该MOD猫猫还没有配置图片资源哦</div>';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'preview-image-grid';
    previewContentArea.innerHTML = '';
    previewContentArea.appendChild(grid);
    const placeholders = items.map(() => {
      const ph = document.createElement('div');
      ph.className = 'preview-image-item';
      ph.style.background = '#f0f0f0';
      ph.style.aspectRatio = '16/9';
      ph.textContent = '加载中...';
      grid.appendChild(ph);
      return ph;
    });
    await Promise.allSettled(
      items.map((item, idx) => {
        const urls = toCandidates(item);
        return loadImageWithRetry(urls, 3).then(url => {
          const img = document.createElement('img');
          img.src = url;
          img.className = 'preview-image-item';
          img.style.cursor = 'zoom-in';
          img.addEventListener('click', () => { lightboxImg.src = url; lightboxOverlay.classList.add('active'); });
          grid.replaceChild(img, placeholders[idx]);
        }).catch(() => { placeholders[idx].textContent = '加载失败'; });
      })
    );
  }

  async function renderPreviewVideos(items) {
    if (items.length === 0) {
      previewContentArea.innerHTML = '<div class="preview-empty-card">该MOD猫猫还没有配置视频资源哦</div>';
      return;
    }
    const list = document.createElement('div');
    list.className = 'preview-video-list';
    previewContentArea.innerHTML = '';
    previewContentArea.appendChild(list);
    items.forEach((item) => {
      const ph = document.createElement('div');
      ph.className = 'preview-video-item';
      ph.style.background = '#f0f0f0';
      ph.style.height = '200px';
      ph.style.display = 'flex';
      ph.style.alignItems = 'center';
      ph.style.justifyContent = 'center';
      ph.textContent = '视频加载中...';
      list.appendChild(ph);
      let urls = [];
      if (item.urls && Array.isArray(item.urls) && item.urls.length > 0) urls = item.urls;
      else if (item.url) urls = [item.url];
      if (urls.length === 0) { ph.textContent = '视频链接缺失'; return; }
      raceVideo(urls).then(video => {
        video.className = 'preview-video-item';
        video.controls = true;
        if (item.poster) video.poster = item.poster;
        list.replaceChild(video, ph);
      }).catch(() => { ph.textContent = '视频加载失败'; });
    });
  }

  previewImagesBtn.addEventListener('click', () => switchPreviewTab('images'));
  previewVideosBtn.addEventListener('click', () => switchPreviewTab('videos'));

  // ========== 分区切换 ==========
  document.getElementById('categoryTags').addEventListener('click', (e) => {
    const tag = e.target.closest('.category-tag');
    if (!tag) return;
    document.querySelectorAll('.category-tag').forEach(t => t.classList.remove('active'));
    tag.classList.add('active');
    const category = tag.getAttribute('data-category') || 'all';
    switchCategory(category);
  });

  // ========== 搜索框事件 ==========
  searchInput.addEventListener('input', filterMods);
  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim().length >= 1) updateSearchDropdown(searchInput.value.trim());
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchDropdown.classList.remove('active'); searchInput.blur(); }
    if (e.key === 'Enter') { searchDropdown.classList.remove('active'); filterMods(); }
  });
  document.addEventListener('click', (e) => {
    if (!searchContainer.contains(e.target)) searchDropdown.classList.remove('active');
  });

  // ========== 鸡煲弹窗 ==========
  charaClose.addEventListener('click', () => charaOverlay.classList.remove('active'));
  charaOverlay.addEventListener('click', (e) => { if (e.target === charaOverlay) charaOverlay.classList.remove('active'); });

  function openCharaDetail() {
    if (logoImg.src && logoImg.style.display !== 'none') { charaImg.src = logoImg.src; }
    else { charaImg.src = ''; }
    charaOverlay.classList.add('active');
  }

  // ========== 启动与URL参数处理 ==========
  async function initPage() {
    let loadingGifUrls = [
      'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded.gif'
    ];
    let logoUrls = [
      'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/Lihui.gif'
    ];
    let loaded2GifUrls = [
      'http://shp.qpic.cn/collector/1976464052/35195f23-993a-4bae-a95b-b01054c9aa2c/0',
      'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif',
      'https://cdn.jsdelivr.net/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif'
    ];

    try {
      const fetchWithTimeout = Promise.race([
        fetch('resources/json/config.json'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]);
      const resp = await fetchWithTimeout;
      if (resp.ok) {
        const config = await resp.json();
        if (config.loadingGifUrls && config.loadingGifUrls.length) loadingGifUrls = config.loadingGifUrls;
        if (config.logoUrls && config.logoUrls.length) logoUrls = config.logoUrls;
        if (config.loaded2GifUrls && config.loaded2GifUrls.length) loaded2GifUrls = config.loaded2GifUrls;
      }
    } catch (e) {}

    const gifPromise = raceImage(loadingGifUrls).catch(() => null);
    const logoPromise = raceImage(logoUrls).catch(() => null);
    const loaded2Promise = raceImage(loaded2GifUrls).catch(() => null);

    // 检查 URL 参数 ?rid=xxx
    const urlParams = new URLSearchParams(window.location.search);
    const ridFromUrl = urlParams.get('rid');
    if (ridFromUrl) {
      // 全站搜索并直接打开详情
      loadingOverlay.classList.add('hidden');
      mainContent.style.opacity = '1';
      searchRIDAcrossAll(ridFromUrl).then(mod => {
        if (mod) {
          openModal(mod);
        } else {
          showToast('未找到该帖子');
        }
      }).catch(() => showToast('搜索失败'));
    } else {
      setTimeout(() => {
        loadingOverlay.classList.add('hidden');
        mainContent.style.opacity = '1';
        loadPageData('all', 1);
      }, 100);
    }

    gifPromise.then(src => {
      if (src) {
        loadingGif.src = src;
        loadingGif.style.display = 'block';
        if (potionWrapper) potionWrapper.style.display = 'none';
      }
    });
    logoPromise.then(src => {
      if (src) {
        logoImg.src = src;
        logoImg.style.display = 'block';
        logoTower.style.display = 'none';
      }
    });
    loaded2Promise.then(src => {
      if (src) window.loaded2GifSrc = src;
    });

    logoArea.addEventListener('click', (e) => {
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