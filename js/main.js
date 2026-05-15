(function() {
    function raceImage(urls, timeout = 3500) {
        if (!urls || urls.length === 0) return Promise.reject('no urls');
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('image load timeout')), timeout)
        );
        const loadPromises = urls.map(url => new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(url);
            img.onerror = reject;
            img.src = url;
        }));
        return Promise.any([timeoutPromise, ...loadPromises]);
    }

    function raceVideo(urls) {
        if (!urls || urls.length === 0) return Promise.reject('no urls');
        const videos = [];
        const promises = urls.map(url => new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.preload = 'auto';
            video.muted = true;
            video.playsInline = true;
            video.onloadeddata = () => {
                resolve({ url, video });
            };
            video.onerror = reject;
            video.src = url;
            videos.push(video);
        }));
        return Promise.any(promises).then(result => {
            videos.forEach(v => {
                if (v !== result.video) {
                    v.onloadeddata = v.onerror = null;
                    v.src = '';
                    v.load();
                }
            });
            const cleanVideo = result.video.cloneNode(true);
            cleanVideo.muted = true;
            cleanVideo.playsInline = true;
            cleanVideo.preload = 'metadata';
            return cleanVideo;
        }).catch(e => {
            videos.forEach(v => {
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

    function generateTimeId() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const ms = String(now.getMilliseconds()).padStart(3, '0');
        return `${year}${month}${day}${hours}${minutes}${seconds}${ms}`;
    }

    function sortModsByTimeId(dataArray) {
        return dataArray.slice().sort((a, b) => (b.id || '').localeCompare(a.id || ''));
    }

    const loadingOverlay = document.getElementById('loadingOverlay');
    const loadingGif = document.getElementById('loadingGif');
    const loadingText = document.getElementById('loadingText');
    const mainContent = document.getElementById('mainContent');
    mainContent.style.opacity = '0';
    mainContent.style.transition = 'opacity 0.5s ease';

    const logoImg = document.getElementById('logoImg');
    const logoTower = document.getElementById('logoTower');
    const logoArea = document.getElementById('logoArea');

    let modData = [];
    let activeCategory = 'all';
    const modGrid = document.getElementById('modGrid');
    const searchInput = document.getElementById('searchInput');
    const searchDropdown = document.getElementById('searchDropdown');
    const searchContainer = document.getElementById('searchContainer');

    const modalOverlay = document.getElementById('modalOverlay');
    const modalClose = document.getElementById('modalClose');
    const modalTitle = document.getElementById('modalTitle');
    const modalRid = document.getElementById('modalRid');
    const modalTags = document.getElementById('modalTags');
    const modalDescText = document.getElementById('modalDescText');
    const descToggle = document.getElementById('descToggle');
    const modalAuthor = document.getElementById('modalAuthor');
    const modalLinks = document.getElementById('modalLinks');
    const downloadButtons = document.getElementById('downloadButtons');
    const carouselTrack = document.getElementById('carouselTrack');
    const carouselDots = document.getElementById('carouselDots');
    const carouselPrev = document.getElementById('carouselPrev');
    const carouselNext = document.getElementById('carouselNext');
    const carouselContainer = document.getElementById('carouselContainer');
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

    const dataSources = { all: 'json/sts2_mods.json', skin: 'json/O.o_interface.json' };
    const dataCache = {};

    let currentImages = [];
    let currentIndex = 0;
    let currentMod = null;
    let activePreviewTab = null;

    window.loaded2GifSrc = null;

    let toastTimer;
    function showToast(message) {
        clearTimeout(toastTimer);
        toast.textContent = message;
        toast.classList.add('show');
        toastTimer = setTimeout(() => {
            toast.classList.remove('show');
        }, 2200);
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

    function updateCarousel(images) {
        currentImages = images || [];
        currentIndex = 0;
        if (!currentImages.length) {
            carouselContainer.style.display = 'none';
            return;
        }
        carouselContainer.style.display = 'block';
        carouselTrack.innerHTML = currentImages.map((src, idx) => `
            <div class="carousel-slide" data-index="${idx}">
                <img src="${src}" alt="预览图 ${idx+1}">
            </div>
        `).join('');
        carouselDots.innerHTML = currentImages.map((_, idx) => `
            <span class="carousel-dot ${idx === 0 ? 'active' : ''}" data-index="${idx}"></span>
        `).join('');
        carouselTrack.style.transform = `translateX(0%)`;
        carouselTrack.querySelectorAll('.carousel-slide').forEach(slide => {
            slide.addEventListener('click', () => {
                const idx = parseInt(slide.dataset.index);
                if (currentImages[idx]) {
                    lightboxImg.src = currentImages[idx];
                    lightboxOverlay.classList.add('active');
                }
            });
        });
        carouselDots.querySelectorAll('.carousel-dot').forEach(dot => {
            dot.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.index);
                setCurrentIndex(idx);
            });
        });
        carouselPrev.onclick = () => {
            if (currentImages.length <= 1) return;
            setCurrentIndex((currentIndex - 1 + currentImages.length) % currentImages.length);
        };
        carouselNext.onclick = () => {
            if (currentImages.length <= 1) return;
            setCurrentIndex((currentIndex + 1) % currentImages.length);
        };
    }

    function setCurrentIndex(idx) {
        currentIndex = idx;
        carouselTrack.style.transform = `translateX(-${idx * 100}%)`;
        const dots = carouselDots.querySelectorAll('.carousel-dot');
        dots.forEach((dot, i) => dot.classList.toggle('active', i === idx));
    }

    function switchPreviewTab(tab) {
        if (activePreviewTab === tab) {
            activePreviewTab = null;
        } else {
            activePreviewTab = tab;
        }
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
        if (!currentMod) {
            previewContentArea.innerHTML = '';
            return;
        }
        const mod = currentMod;
        previewContentArea.innerHTML = '<div class="preview-empty-card">正在加载预览资源...</div>';
        if (activePreviewTab === 'images') {
            const items = Array.isArray(mod.previewImages) ? mod.previewImages : [];
            renderPreviewImages(items);
        } else if (activePreviewTab === 'videos') {
            const items = Array.isArray(mod.previewVideos) ? mod.previewVideos : [];
            renderPreviewVideos(items);
        } else {
            previewContentArea.innerHTML = '';
        }
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
                return raceImage(urls).then(url => {
                    const img = document.createElement('img');
                    img.src = url;
                    img.className = 'preview-image-item';
                    img.style.cursor = 'zoom-in';
                    img.addEventListener('click', () => {
                        lightboxImg.src = url;
                        lightboxOverlay.classList.add('active');
                    });
                    grid.replaceChild(img, placeholders[idx]);
                }).catch(() => {
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
        const list = document.createElement('div');
        list.className = 'preview-video-list';
        previewContentArea.innerHTML = '';
        previewContentArea.appendChild(list);
        items.forEach((item, idx) => {
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
            if (item.urls && Array.isArray(item.urls) && item.urls.length > 0) {
                urls = item.urls;
            } else if (item.url) {
                urls = [item.url];
            }
            if (urls.length === 0) {
                ph.textContent = '视频链接缺失';
                return;
            }
            raceVideo(urls).then(video => {
                video.className = 'preview-video-item';
                video.controls = true;
                if (item.poster) video.poster = item.poster;
                list.replaceChild(video, ph);
            }).catch(() => {
                ph.textContent = '视频加载失败';
            });
        });
    }

    previewImagesBtn.addEventListener('click', () => switchPreviewTab('images'));
    previewVideosBtn.addEventListener('click', () => switchPreviewTab('videos'));

    async function openModal(mod) {
        currentMod = mod;

        modalTitle.textContent = mod.title;

        modalRid.textContent = 'RID: ' + (mod.id || '无');
        modalRid.onclick = () => {
            const ridText = 'RID:' + (mod.id || '');
            copyText(ridText).then(() => {
                showToast('RID 已复制，快分享给小伙伴吧~');
            }).catch(() => {
                showToast('复制失败，请手动复制');
            });
        };

        modalTags.innerHTML = '';
        if (mod.tags && Array.isArray(mod.tags)) {
            mod.tags.forEach(tag => {
                const span = document.createElement('span');
                span.className = 'modal-tag ' + tag.toLowerCase();
                span.textContent = tag.toUpperCase();
                modalTags.appendChild(span);
            });
        }

        modalDescText.textContent = mod.description || '暂无介绍';
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

        carouselContainer.style.display = 'block';
        carouselTrack.innerHTML = '<div style="text-align:center;padding:60px;">萌图竞速中...</div>';
        carouselDots.innerHTML = '';
        carouselPrev.style.display = 'none';
        carouselNext.style.display = 'none';

        modalOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';

        setTimeout(() => {
            if (modalDescText.scrollHeight > modalDescText.clientHeight + 2) {
                descToggle.style.display = 'inline-block';
            }
        }, 50);

        let imageCandidates = [];
        if (mod.images && mod.images.length > 0) {
            imageCandidates = mod.images;
        } else if (mod.coverImage) {
            imageCandidates = [mod.coverImage];
        }

        try {
            const finalImages = (await Promise.all(
                imageCandidates.map(item => raceImage(toCandidates(item)).catch(() => null))
            )).filter(url => url !== null);

            if (currentMod === mod) {
                updateCarousel(finalImages);
                carouselPrev.style.display = '';
                carouselNext.style.display = '';
            }
        } catch (e) {}
    }

    function closeModal() {
        modalOverlay.classList.remove('active');
        document.body.style.overflow = '';
        currentMod = null;
        activePreviewTab = null;
    }

    modalClose.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModal();
    });

    descToggle.addEventListener('click', () => {
        const expanded = modalDescText.classList.toggle('expanded');
        descToggle.textContent = expanded ? '收起' : '展开全文';
    });

    lightboxClose.addEventListener('click', () => lightboxOverlay.classList.remove('active'));
    lightboxOverlay.addEventListener('click', (e) => {
        if (e.target === lightboxOverlay) lightboxOverlay.classList.remove('active');
    });

    function handleTagClick(tagText) {
        searchInput.value = tagText;
        document.querySelectorAll('.category-tag').forEach(t => t.classList.remove('active'));
        const allTag = document.querySelector('.category-tag[data-category="all"]');
        if (allTag) allTag.classList.add('active');
        activeCategory = 'all';
        filterMods();
        searchInput.focus();
    }

    function attachCardSpinner(cardElement) {
        const coverInner = cardElement.querySelector('.mod-cover-inner');
        const coverImg = coverInner ? coverInner.querySelector('.mod-cover-img') : null;
        if (!coverInner || !coverImg) return;

        const spinner = document.createElement('span');
        spinner.className = 'card-spinner';

        const hideSpinner = () => {
            if (spinner.parentNode) spinner.style.display = 'none';
        };

        if (coverImg.complete) {
            hideSpinner();
        } else {
            coverImg.addEventListener('load', hideSpinner);
            coverImg.addEventListener('error', hideSpinner);
        }
        coverInner.appendChild(spinner);
    }

    function renderModCards(dataArray) {
        modGrid.innerHTML = '';
        if (dataArray.length === 0) {
            modGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--text-muted);">没有找到相关MOD</div>`;
            return;
        }
        const loaded2Src = window.loaded2GifSrc || 'img/loaded_2.gif';

        dataArray.forEach(mod => {
            let coverImgSrc = '';
            if (mod.coverImage) {
                if (Array.isArray(mod.coverImage)) {
                    coverImgSrc = mod.coverImage[0] || '';
                } else {
                    coverImgSrc = mod.coverImage;
                }
            }
            const hasCoverImg = coverImgSrc.trim() !== '';
            const imgSrc = hasCoverImg ? coverImgSrc : loaded2Src;
            const imgStyle = hasCoverImg
                ? 'object-fit: cover;'
                : 'object-fit: contain;';

            let tagsHtml = '';
            if (mod.tags && mod.tags.length) {
                tagsHtml = '<div class="mod-tag-list">' +
                    mod.tags.map(t => `<span class="mod-tag-item ${t.toLowerCase()}">${t.toUpperCase()}</span>`).join('') +
                    '</div>';
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
            card.querySelector('.view-detail-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                openModal(mod);
            });
            card.querySelectorAll('.mod-tag-item').forEach(tagEl => {
                tagEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    handleTagClick(tagEl.textContent);
                });
            });
            modGrid.appendChild(card);
            attachCardSpinner(card);
        });
    }

    function filterMods() {
        let filtered = [...modData];
        if (activeCategory !== 'all') {
            filtered = filtered.filter(m => m.category === activeCategory);
        }
        const query = searchInput.value.trim();
        if (query) {
            const lowerQuery = query.toLowerCase();
            if (lowerQuery.startsWith('rid:')) {
                const ridPart = lowerQuery.slice(4).trim();
                filtered = filtered.filter(m => m.id === ridPart);
            } else if (/^\d+$/.test(query)) {
                filtered = filtered.filter(m => m.id === query);
            } else {
                filtered = filtered.filter(m => {
                    if (m.title.toLowerCase().includes(lowerQuery)) return true;
                    if (m.tags && m.tags.some(tag => tag.toLowerCase().includes(lowerQuery))) return true;
                    return false;
                });
            }
        }
        renderModCards(filtered);
        updateSearchDropdown(query);
    }

    function updateSearchDropdown(query) {
        searchDropdown.innerHTML = '';
        if (!query || query.length < 1) {
            searchDropdown.classList.remove('active');
            return;
        }
        const lowerQuery = query.toLowerCase();
        if (lowerQuery.startsWith('rid:') || /^\d+$/.test(query)) {
            searchDropdown.classList.remove('active');
            return;
        }
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
                li.addEventListener('click', () => {
                    searchInput.value = m.title;
                    searchDropdown.classList.remove('active');
                    filterMods();
                });
                searchDropdown.appendChild(li);
            });
        }
        searchDropdown.classList.add('active');
    }

    async function loadModData(categoryKey = 'all') {
        const url = dataSources[categoryKey];
        if (!url) return;
        const loaded2Src = window.loaded2GifSrc || 'img/loaded_2.gif';
        modGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;"><img src="${loaded2Src}" alt="加载中" style="max-width:200px;"></div>`;
        try {
            if (dataCache[url]) {
                modData = dataCache[url];
            } else {
                const response = await fetch(url);
                if (!response.ok) throw new Error('加载失败');
                let rawData = await response.json();
                rawData = sortModsByTimeId(rawData);
                modData = rawData;
                dataCache[url] = modData;
            }
            searchInput.value = '';
            searchDropdown.classList.remove('active');
            renderModCards(modData);
        } catch (error) {
            modGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;">MOD数据加载失败，请稍后再试</div>';
        }
    }

    document.getElementById('categoryTags').addEventListener('click', (e) => {
        const tag = e.target.closest('.category-tag');
        if (!tag) return;
        document.querySelectorAll('.category-tag').forEach(t => t.classList.remove('active'));
        tag.classList.add('active');
        activeCategory = tag.getAttribute('data-category') || 'all';
        loadModData(activeCategory);
    });

    searchInput.addEventListener('input', filterMods);
    searchInput.addEventListener('focus', () => {
        if (searchInput.value.trim().length >= 1) updateSearchDropdown(searchInput.value.trim());
    });
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { searchDropdown.classList.remove('active'); searchInput.blur(); }
        if (e.key === 'Enter')  { searchDropdown.classList.remove('active'); filterMods(); }
    });
    document.addEventListener('click', (e) => {
        if (!searchContainer.contains(e.target)) searchDropdown.classList.remove('active');
    });

    charaClose.addEventListener('click', () => charaOverlay.classList.remove('active'));
    charaOverlay.addEventListener('click', (e) => {
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

    async function initPage() {
        let loadingGifUrls = ['img/loaded.gif'];
        let logoUrls = ['img/Lihui.gif'];
        let loaded2GifUrls = [
            'img/loaded_2.gif',
            'http://shp.qpic.cn/collector/1976464052/35195f23-993a-4bae-a95b-b01054c9aa2c/0',
            'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif',
            'https://cdn.jsdelivr.net/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif'
        ];

        try {
            const resp = await fetch('json/config.json');
            if (resp.ok) {
                const config = await resp.json();
                if (config.loadingGifUrls && config.loadingGifUrls.length) {
                    loadingGifUrls = config.loadingGifUrls;
                }
                if (config.logoUrls && config.logoUrls.length) {
                    logoUrls = config.logoUrls;
                }
                if (config.loaded2GifUrls && config.loaded2GifUrls.length) {
                    loaded2GifUrls = config.loaded2GifUrls;
                }
            }
        } catch (e) {}

        const [gifResult, logoResult, loaded2Result] = await Promise.allSettled([
            raceImage(loadingGifUrls).catch(() => null),
            raceImage(logoUrls).catch(() => null),
            raceImage(loaded2GifUrls).catch(() => null)
        ]);

        const gifSrc = gifResult.status === 'fulfilled' ? gifResult.value : null;
        const logoSrc = logoResult.status === 'fulfilled' ? logoResult.value : null;
        const loaded2Src = loaded2Result.status === 'fulfilled' ? loaded2Result.value : null;
        window.loaded2GifSrc = loaded2Src || 'img/loaded_2.gif';

        if (gifSrc) {
            const tempImg = new Image();
            tempImg.onload = () => {
                loadingGif.src = gifSrc;
                loadingGif.style.display = 'block';
                loadingText.style.display = 'block';
                setTimeout(() => {
                    loadingOverlay.classList.add('hidden');
                    mainContent.style.opacity = '1';
                }, 600);
            };
            tempImg.onerror = () => {
                loadingGif.style.display = 'none';
                loadingText.style.display = 'none';
                setTimeout(() => {
                    loadingOverlay.classList.add('hidden');
                    mainContent.style.opacity = '1';
                }, 400);
            };
            tempImg.src = gifSrc;
        } else {
            loadingGif.style.display = 'none';
            loadingText.style.display = 'none';
            setTimeout(() => {
                loadingOverlay.classList.add('hidden');
                mainContent.style.opacity = '1';
            }, 400);
        }

        if (logoSrc) {
            logoImg.src = logoSrc;
            logoImg.style.display = 'block';
            logoTower.style.display = 'none';
        }

        logoArea.addEventListener('click', (e) => {
            if (e.target === logoArea || e.target === logoImg || e.target.closest('.logo-img') || e.target.closest('.logo-tower')) {
                openCharaDetail();
            }
        });

        loadModData('all');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPage);
    } else {
        initPage();
    }
})();