(function () {
    var VideoLoadQueue = {
        maxConcurrent: 2,
        running: 0,
        queue: [],
        taskIdCounter: 0,
        activeTasks: {},
        enqueue: function (taskFn) {
            var taskId = ++this.taskIdCounter;
            var self = this;
            return new Promise(function (resolve, reject) {
                self.activeTasks[taskId] = {
                    resolve: resolve,
                    reject: reject,
                    cancelled: false
                };
                self.queue.push({
                    taskId: taskId,
                    run: function () {
                        if (!self.activeTasks[taskId] || self.activeTasks[taskId].cancelled) {
                            delete self.activeTasks[taskId];
                            self.running--;
                            self._next();
                            return;
                        }
                        taskFn().then(function (result) {
                            if (!self.activeTasks[taskId]) {
                                self.running--;
                                self._next();
                                return;
                            }
                            if (self.activeTasks[taskId].cancelled) {
                                delete self.activeTasks[taskId];
                                self.running--;
                                self._next();
                                return;
                            }
                            self.activeTasks[taskId].resolve(result);
                            delete self.activeTasks[taskId];
                            self.running--;
                            self._next();
                        }).catch(function (err) {
                            if (!self.activeTasks[taskId]) {
                                self.running--;
                                self._next();
                                return;
                            }
                            if (self.activeTasks[taskId].cancelled) {
                                delete self.activeTasks[taskId];
                                self.running--;
                                self._next();
                                return;
                            }
                            self.activeTasks[taskId].reject(err);
                            delete self.activeTasks[taskId];
                            self.running--;
                            self._next();
                        });
                    }
                });
                self._next();
            });
        },
        _next: function () {
            while (this.running < this.maxConcurrent && this.queue.length > 0) {
                var task = this.queue.shift();
                this.running++;
                task.run();
            }
        },
        cancelAll: function () {
            this.queue = [];
            for (var id in this.activeTasks) {
                if (this.activeTasks.hasOwnProperty(id)) {
                    this.activeTasks[id].cancelled = true;
                }
            }
        }
    };

    var ImageLoadQueue = {
        maxConcurrent: 4,
        running: 0,
        queue: [],
        enqueue: function (taskFn) {
            var self = this;
            return new Promise(function (resolve, reject) {
                self.queue.push({
                    fn: taskFn,
                    resolve: resolve,
                    reject: reject
                });
                self._next();
            });
        },
        _next: function () {
            var self = this;
            while (self.running < self.maxConcurrent && self.queue.length > 0) {
                var item = self.queue.shift();
                self.running++;
                item.fn().then(function (result) {
                    item.resolve(result);
                    self.running--;
                    self._next();
                }).catch(function (err) {
                    item.reject(err);
                    self.running--;
                    self._next();
                });
            }
        }
    };

    var pendingVideos = [];
    var videoLoadGeneration = 0;
    var renderSessionId = 0;

    function cleanupPendingVideos() {
        if (pendingVideos.length === 0) return;
        var videos = pendingVideos.slice();
        pendingVideos = [];
        videos.forEach(function (v) {
            v.onloadedmetadata = v.onloadeddata = v.onerror = null;
            v.removeAttribute('src');
            v.load();
        });
    }

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
                video.preload = 'metadata';
                video.muted = true;
                video.playsInline = true;
                var timer = setTimeout(function () {
                    var pIdx = pendingVideos.indexOf(video);
                    if (pIdx !== -1) pendingVideos.splice(pIdx, 1);
                    reject(new Error('video load stalled'));
                }, 5000);
                video.onloadedmetadata = function () {
                    clearTimeout(timer);
                    var pIdx = pendingVideos.indexOf(video);
                    if (pIdx !== -1) pendingVideos.splice(pIdx, 1);
                    resolve({ url: url, video: video });
                };
                video.onerror = function () {
                    clearTimeout(timer);
                    var pIdx = pendingVideos.indexOf(video);
                    if (pIdx !== -1) pendingVideos.splice(pIdx, 1);
                    reject(new Error('video load failed'));
                };
                video.src = url;
                videos.push(video);
                pendingVideos.push(video);
            });
        });
        return Promise.any(promises).then(function (result) {
            videos.forEach(function (v) {
                if (v !== result.video) {
                    v.onloadedmetadata = v.onerror = null;
                    v.removeAttribute('src');
                    v.load();
                }
            });
            var cleanVideo = result.video.cloneNode(true);
            cleanVideo.muted = true;
            cleanVideo.playsInline = true;
            cleanVideo.preload = 'metadata';
            result.video.onloadedmetadata = result.video.onerror = null;
            result.video.removeAttribute('src');
            result.video.load();
            return cleanVideo;
        }).catch(function (e) {
            videos.forEach(function (v) {
                v.onloadedmetadata = v.onerror = null;
                v.removeAttribute('src');
                v.load();
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
            var uncachedUrls = urls.filter(function(url) {
                var status = imageCache[url];
                return !status || status === 'error';
            });
            if (uncachedUrls.length === 0) {
                resolve();
                return;
            }
            var index = 0;
            var running = 0;
            var total = uncachedUrls.length;
            function next() {
                if (index >= total) {
                    if (running === 0) resolve();
                    return;
                }
                var url = uncachedUrls[index++];
                running++;
                var img = new Image();
                var timer = setTimeout(function () {
                    imageCache[url] = 'loading';
                    running--;
                    next();
                }, 2500);
                img.onload = function () {
                    clearTimeout(timer);
                    imageCache[url] = 'loaded';
                    running--;
                    next();
                };
                img.onerror = function () {
                    clearTimeout(timer);
                    imageCache[url] = 'error';
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
    var logoArea = document.getElementById('logoArea');
    var menuBtn = document.getElementById('menuBtn');
    var menuPanel = document.getElementById('menuPanel');
    var themeToggle = document.getElementById('themeToggle');
    var themeIconSun = document.getElementById('themeIconSun');
    var themeIconMoon = document.getElementById('themeIconMoon');
    var modData = [];
    var baseModData = [];
    var activeCategory = 'all';
    var currentPage = 1;
    var ITEMS_PER_PAGE = 10;
    var allSiteData = {};
    var manifestCache = {};
    var dataLoadingPromises = {};
    var mG = document.getElementById('mG');
    var paginationEl = document.getElementById('pagination');
    var sI = document.getElementById('sI');
    var searchDropdown = document.getElementById('searchDropdown');
    var searchContainer = document.getElementById('searchContainer');
    var mO = document.getElementById('mO');
    var mX = document.getElementById('mX');
    var mC = document.getElementById('mC');
    var lO = document.getElementById('lO');
    var lX = document.getElementById('lX');
    var lI = document.getElementById('lI');
    var pO = document.getElementById('pO');
    var pB = document.getElementById('pB');
    var tT = document.getElementById('tT');
    var dataSources = {
        all: 'resources/json/post/sts2_mods/sts2_mods_1.json',
        skin: 'resources/json/post/O.o_interface/O.o_interface_1.json'
    };
    var dataCache = {};
    var currentMod = null;
    var currentCl = null;
    var activePreviewTab = null;
    var FALLBACK_LOADED2 = 'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif';
    window.loaded2GifSrc = null;
    var SITE_DOMAIN = 'axxxx.cyou';
    var toastTimer;
    var groupInviteToast = document.getElementById('groupInviteToast');
    var groupInviteShown = false;
    var menuBadge = document.getElementById('menuBadge');
    var menuNotifications = document.getElementById('menuNotifications');
    var menuUserSection = document.getElementById('menuUserSection');
    var menuUserEmpty = document.getElementById('menuUserEmpty');
    var NOTIF_KEY = 'sts2_notifications_v2_guest';
    var notifications = [];
    var currentNotifTab = 'reply';
    var currentMenuUser = null;
    var dlS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="width:12px;height:12px"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6M7 10l5 5 5-5M12 15V3"/></svg>';
    var imS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
    var viS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';
    var coS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
    var shS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
    var imageCache = {};

    function showToast(message) {
        clearTimeout(toastTimer);
        tT.textContent = message;
        tT.classList.add('sh2');
        toastTimer = setTimeout(function () {
            tT.classList.remove('sh2');
        }, 2200);
    }

    // ---------- 评论 API 辅助（与评论区共享认证 Cookie） ----------
    async function cmApi(path, opts) {
        opts = opts || {};
        opts.credentials = 'include';
        if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
            opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
            opts.body = JSON.stringify(opts.body);
        }
        var r = await fetch(window.COMMENT_API_BASE + path, opts);
        var data = null;
        try { data = await r.json(); } catch (e) {}
        if (!r.ok) throw { status: r.status, message: (data && data.error) || ('请求失败 (' + r.status + ')') };
        return data;
    }

    // ---------- 全局通知系统（右上角菜单） ----------
    function notifTitle(type) {
        switch (type) {
            case 'reply': return '回复我的';
            case 'like': return '收到的赞';
            case 'reject': return '审核未通过';
            case 'mute': return '禁言通知';
            case 'unmute': return '禁言解除';
            case 'system': return '系统通知';
            default: return '通知';
        }
    }
    function notifIcon(type) {
        var color = '#e89b9b';
        if (type === 'system') color = '#f4b960';
        if (type === 'reply') color = '#a8d8c8';
        if (type === 'like') color = '#e89b9b';
        if (type === 'reject' || type === 'mute') color = '#b14b4b';
        if (type === 'unmute') color = '#4a8a5a';
        var path = 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0';
        if (type === 'reply') path = 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z';
        if (type === 'like') path = 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z';
        if (type === 'reject') path = 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01';
        if (type === 'mute') path = 'M11 5L6 9H2v6h4l5 4V5z M19.07 4.93a10 10 0 0 1 0 14.14 M15.54 8.46a5 5 0 0 1 0 7.07';
        if (type === 'unmute') path = 'M11 5L6 9H2v6h4l5 4V5z M22 12h-6 M18 8l-4 4 4 4';
        return '<svg viewBox="0 0 24 24" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><path d="' + path + '"/></svg>';
    }
    function relTimeNotif(ts) {
        if (!ts) return '';
        var d = new Date(ts.replace(' ', 'T') + (ts.indexOf('T') === -1 ? 'Z' : ''));
        var diff = (Date.now() - d.getTime()) / 1000;
        if (isNaN(diff)) return ts.slice(0, 10);
        if (diff < 60) return '刚刚';
        if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
        if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
        if (diff < 2592000) return Math.floor(diff / 86400) + '天前';
        return ts.slice(0, 10);
    }
    function loadNotifications(userId) {
        NOTIF_KEY = 'sts2_notifications_v2_' + (userId || 'guest');
        try {
            var raw = localStorage.getItem(NOTIF_KEY);
            if (raw) notifications = JSON.parse(raw);
        } catch (e) { notifications = []; }
        if (!Array.isArray(notifications)) notifications = [];
        renderNotifications();
        updateNotifBadge();
    }
    function saveNotifications() {
        try {
            localStorage.setItem(NOTIF_KEY, JSON.stringify(notifications.slice(0, 100)));
        } catch (e) {}
    }
    function addNotification(message, type, data) {
        type = type || 'system';
        var n = {
            id: 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            type: type,
            title: notifTitle(type),
            message: String(message || ''),
            read: false,
            createdAt: new Date().toISOString(),
            data: data || null
        };
        notifications.unshift(n);
        saveNotifications();
        renderNotifications();
        updateNotifBadge();
    }
    function getFilteredNotifications() {
        var tab = currentNotifTab;
        return notifications.filter(function (n) {
            if (tab === 'reply') return n.type === 'reply';
            if (tab === 'like') return n.type === 'like';
            if (tab === 'system') return ['mute', 'unmute', 'reject', 'system'].indexOf(n.type) !== -1;
            return true;
        });
    }
    function renderNotifications() {
        if (!menuNotifications) return;
        var h = '<div class="notif-tabs">' +
            '<button class="notif-tab' + (currentNotifTab === 'reply' ? ' active' : '') + '" data-tab="reply">回复我的</button>' +
            '<button class="notif-tab' + (currentNotifTab === 'like' ? ' active' : '') + '" data-tab="like">收到的赞</button>' +
            '<button class="notif-tab' + (currentNotifTab === 'system' ? ' active' : '') + '" data-tab="system">系统通知</button>' +
            '</div>';
        var filtered = getFilteredNotifications();
        if (!filtered.length) {
            h += '<div class="menu-empty">暂无消息</div>';
            menuNotifications.innerHTML = h;
            bindNotifTabs();
            return;
        }
        h += '<div class="notif-list">';
        for (var i = 0; i < filtered.length; i++) {
            var n = filtered[i];
            var msg = String(n.message || '');
            if (msg.length > 72) msg = msg.slice(0, 72) + '…';
            h += '<div class="menu-notification ' + (n.read ? '' : 'unread') + ' type-' + esc(n.type) + '" data-id="' + esc(n.id) + '">';
            h += '<div class="menu-notification-icon">' + notifIcon(n.type) + '</div>';
            h += '<div class="menu-notification-body">';
            h += '<div class="menu-notification-title">' + esc(notifTitle(n.type)) + '</div>';
            h += '<div class="menu-notification-msg">' + esc(msg) + '</div>';
            h += '<div class="menu-notification-time">' + esc(relTimeNotif(n.createdAt)) + '</div>';
            h += '</div></div>';
        }
        h += '</div>';
        menuNotifications.innerHTML = h;
        bindNotifTabs();
        menuNotifications.querySelectorAll('.menu-notification').forEach(function (el) {
            el.addEventListener('click', function () {
                markNotifRead(el.getAttribute('data-id'));
            });
        });
    }
    function bindNotifTabs() {
        if (!menuNotifications) return;
        menuNotifications.querySelectorAll('.notif-tab').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                currentNotifTab = btn.getAttribute('data-tab');
                renderNotifications();
            });
        });
    }
    function updateNotifBadge() {
        if (!menuBadge) return;
        var unread = notifications.filter(function (n) { return !n.read && n.type === 'reply'; }).length;
        menuBadge.style.display = unread > 0 ? 'block' : 'none';
        menuBadge.textContent = unread > 99 ? '99+' : (unread > 0 ? String(unread) : '');
    }
    function markNotifRead(id) {
        var n = notifications.find(function (x) { return String(x.id) === String(id); });
        if (n && !n.read) {
            n.read = true;
            saveNotifications();
            renderNotifications();
            updateNotifBadge();
            if (n.serverId && window.COMMENT_API_BASE) {
                fetch(window.COMMENT_API_BASE + '/api/notifications/' + n.serverId + '/read', { method: 'POST', credentials: 'include' }).catch(function () {});
            }
        }
        // 点击通知后跳转到对应帖子
        if (n && n.data && n.data.rid) {
            if (menuPanel) menuPanel.classList.remove('open');
            openModByRid(n.data.rid, n.data.commentId, n.data.parentId);
        }
    }

    // 轮询等待评论区加载完成（#cmRoot 存在且不在 loading 态）
    function waitForCommentsLoaded(timeoutMs) {
        timeoutMs = timeoutMs || 6000;
        return new Promise(function (resolve) {
            var start = Date.now();
            function check() {
                var root = document.getElementById('cmRoot');
                if (root && !root.querySelector('.cm-loading')) { resolve(true); return; }
                if (Date.now() - start >= timeoutMs) { resolve(false); return; }
                setTimeout(check, 150);
            }
            check();
        });
    }

    async function openModByRid(rid, commentId, parentId) {
        if (!rid) return;
        showToast('正在跳转…');
        var found = await performGlobalRidSearch(rid);
        if (!found) { showToast('该帖子可能已下架'); return; }
        oM(found);
        var loaded = await waitForCommentsLoaded(6000);
        if (!loaded) {
            // 超时兜底：滚动到评论区顶部
            var cmFb = document.getElementById('cmRoot') || document.querySelector('.cm-root');
            if (cmFb) cmFb.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        if (parentId) {
            // 是回复：先打开楼层详情页，再定位到子回复
            if (window._openReplyDetail) {
                window._openReplyDetail(parentId);
                // 详情页异步渲染，延迟后高亮（highlightComment 内含重试）
                setTimeout(function () { highlightComment(commentId); }, 400);
            } else {
                var cm = document.getElementById('cmRoot') || document.querySelector('.cm-root');
                if (cm) cm.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        } else if (commentId) {
            // 是楼层：直接定位
            highlightComment(commentId);
        } else {
            // 无 commentId：滚动到评论区顶部
            var cm2 = document.getElementById('cmRoot') || document.querySelector('.cm-root');
            if (cm2) cm2.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // 高亮指定评论并闪烁（未找到时重试，覆盖详情页异步渲染场景）
    function highlightComment(commentId, retries) {
        if (!commentId) return;
        retries = (typeof retries === 'number') ? retries : 6;
        var el = document.querySelector('[data-id="' + commentId + '"]');
        if (!el) {
            // 可能在详情页内
            var overlay = document.getElementById('cmDetailOverlay');
            if (overlay) el = overlay.querySelector('[data-id="' + commentId + '"]');
        }
        if (!el) {
            if (retries > 0) {
                setTimeout(function () { highlightComment(commentId, retries - 1); }, 200);
                return;
            }
            // 重试耗尽，元素真的找不到
            showToast('评论已删除或正在加载');
            return;
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('cm-highlight');
        setTimeout(function () { el.classList.remove('cm-highlight'); }, 3000);
    }
    function markAllNotifRead() {
        var changed = false;
        notifications.forEach(function (n) { if (!n.read) { n.read = true; changed = true; } });
        if (changed) {
            saveNotifications();
            renderNotifications();
            updateNotifBadge();
            if (window.COMMENT_API_BASE) {
                fetch(window.COMMENT_API_BASE + '/api/notifications/read-all', { method: 'POST', credentials: 'include' }).catch(function () {});
            }
        }
    }
    function mergeServerNotifications(list) {
        if (!Array.isArray(list)) return;
        var changed = false;
        list.forEach(function (srv) {
            if (!srv || !srv.id) return;
            var exists = notifications.find(function (n) { return n.serverId === srv.id; });
            if (!exists) {
                notifications.unshift({
                    serverId: srv.id,
                    id: 'srv_' + srv.id,
                    type: srv.type || 'system',
                    title: notifTitle(srv.type),
                    message: String(srv.message || ''),
                    read: !!srv.read,
                    createdAt: srv.createdAt || new Date().toISOString(),
                    data: srv.data || null
                });
                changed = true;
            } else if (!!srv.read && !exists.read) {
                exists.read = true;
                changed = true;
            }
        });
        if (changed) {
            saveNotifications();
            renderNotifications();
            updateNotifBadge();
        }
    }
    var notifFetching = false;
    var notifLastFetch = 0;
    async function fetchServerNotifications() {
        if (!window.COMMENT_API_BASE) return;
        // 未登录用户不请求通知
        if (!currentMenuUser) return;
        var now = Date.now();
        // 防抖：30 秒内不重复请求
        if (now - notifLastFetch < 30000) return;
        // 去重：如果已有请求在飞，不重复发
        if (notifFetching) return;
        notifFetching = true;
        notifLastFetch = now;
        try {
            var r = await fetch(window.COMMENT_API_BASE + '/api/notifications', { credentials: 'include' });
            if (r.status === 401) {
                console.log('[notif] 401 未登录');
                if (currentMenuUser) {
                    currentMenuUser = null;
                    renderMenuUser(null);
                    loadNotifications(null);
                    showToast('登录已过期，请重新登录');
                }
                return;
            }
            if (!r.ok) { console.log('[notif] 非 ok 状态', r.status); return; }
            var d = await r.json();
            mergeServerNotifications(d.notifications || []);
        } catch (e) {
            console.log('[fetchServerNotifications]', e);
        } finally {
            notifFetching = false;
        }
    }

    // 智能轮询调度：菜单开 5 秒高频、关 30 秒慢频、页面隐藏暂停
    var notifSlowTimer = null;
    var notifFastTimer = null;
    function clearNotifTimers() {
        if (notifSlowTimer) { clearInterval(notifSlowTimer); notifSlowTimer = null; }
        if (notifFastTimer) { clearInterval(notifFastTimer); notifFastTimer = null; }
    }
    function startNotifPolling() {
        clearNotifTimers();
        // 未登录用户不轮询
        if (!currentMenuUser) return;
        // 页面隐藏或窗口失焦时完全停止轮询（visibilitychange 监听器会负责恢复）
        if (document.hidden || document.visibilityState !== 'visible') return;
        var menuOpen = menuPanel && menuPanel.classList.contains('open');
        if (menuOpen) {
            // 菜单打开：60 秒
            notifFastTimer = setInterval(fetchServerNotifications, 60000);
        } else {
            // 菜单关闭：10 分钟（仅更新红点）
            notifSlowTimer = setInterval(fetchServerNotifications, 600000);
        }
    }

    // ---------- 菜单用户信息 ----------
    function avatarUrl(key) {
        return key ? (window.COMMENT_API_BASE + '/api/files/' + encodeURIComponent(key)) : null;
    }
    function avatarHtml(user, cls) {
        cls = cls || 'menu-user-avatar';
        var nick = (user && user.nickname) || '?';
        var u = avatarUrl(user && user.avatarKey);
        if (u) return '<img class="' + cls + '" src="' + esc(u) + '" alt="' + esc(nick) + '" onerror="this.outerHTML=\'<div class=&quot;' + cls + ' def&quot;>' + esc(nick.slice(0, 1)) + '</div>\'">';
        return '<div class="' + cls + ' def">' + esc(nick.slice(0, 1)) + '</div>';
    }
    function renderMenuUser(user) {
        currentMenuUser = user || null;
        if (!menuUserSection) return;
        if (!user) {
            menuUserSection.innerHTML =
                '<div class="menu-user-info">' +
                '<div class="menu-user-main">' +
                '<div class="menu-user-avatar def">?</div>' +
                '<div class="menu-user-text">' +
                '<div class="menu-user-title">未登录</div>' +
                '<div class="menu-user-subtitle">登录后可评论、点赞与接收通知</div>' +
                '</div></div>' +
                '<button class="menu-item menu-user-action" id="menuLoginBtn">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10,17 15,12 10,7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>' +
                '<span>登录 / 注册</span></button>' +
                '</div>';
            bindMenuLogin();
            return;
        }
        var tags = '';
        if (user.isAdmin) tags += '<span class="menu-user-tag admin">管理员</span>';
        if (user.isVerified) tags += '<span class="menu-user-tag verified">已验证</span>';
        else tags += '<span class="menu-user-tag unverified">未验证</span>';
        var mutedHtml = '';
        if (user.mutedUntil && new Date(user.mutedUntil) > new Date()) {
            mutedHtml = '<div class="menu-user-muted">禁言中，结束时间：' + esc(new Date(user.mutedUntil).toLocaleString()) + '</div>';
        }
        var adminHtml = '';
        // 管理功能已集成到评论区管理面板中，不再需要独立入口
        menuUserSection.innerHTML =
            '<div class="menu-user-info">' +
            '<div class="menu-user-main">' +
            avatarHtml(user, 'menu-user-avatar') +
            '<div class="menu-user-text">' +
            '<div class="menu-user-title">' + esc(user.nickname) + '</div>' +
            '<div class="menu-user-subtitle">' + esc(user.email) + '</div>' +
            '<div class="menu-user-tags">' + tags + '</div>' +
            mutedHtml +
            '</div></div>' +
            '<div class="menu-user-actions">' +
            '<button class="menu-item" id="menuProfileBtn">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' +
            '<span>个人资料</span></button>' +
            adminHtml +
            '<button class="menu-item" id="menuLogoutBtn">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16,17 21,12 16,7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' +
            '<span>退出登录</span></button>' +
            '</div>' +
            '</div>';
        bindMenuLogout();
        bindMenuProfile();
    }
    function bindMenuProfile() {
        var btn = document.getElementById('menuProfileBtn');
        if (!btn) return;
        btn.onclick = function (e) {
            e.stopPropagation();
            menuPanel.classList.remove('open');
            if (mO && mO.classList.contains('act')) {
                if (typeof window._cmOpenProfile === 'function') window._cmOpenProfile();
                else showToast('请在评论区头像处打开个人资料');
            } else {
                showToast('请打开任意 MOD 详情页后查看个人资料');
            }
        };
    }
    function bindMenuLogin() {
        var btn = document.getElementById('menuLoginBtn');
        if (!btn) return;
        btn.onclick = function (e) {
            e.stopPropagation();
            menuPanel.classList.remove('open');
            // 优先调用评论区弹窗（如果评论区已挂载）
            if (typeof window._cmOpenAuth === 'function') {
                window._cmOpenAuth('login');
            } else if (mO && mO.classList.contains('act') && typeof window._openCmAuth === 'function') {
                window._openCmAuth('login');
            } else {
                showToast('请打开任意 MOD 详情页，在评论区点击登录');
            }
        };
    }
    function bindMenuLogout() {
        var btn = document.getElementById('menuLogoutBtn');
        if (!btn) return;
        btn.onclick = async function (e) {
            e.stopPropagation();
            try { await cmApi('/api/auth/logout', { method: 'POST' }); } catch (err) {}
            currentMenuUser = null;
            notifications = [];
            loadNotifications(null);
            renderMenuUser(null);
            if (typeof window._onUserChange === 'function') window._onUserChange(null);
            showToast('已退出登录');
        };
    }
    async function loadMenuUser() {
        if (!window.COMMENT_API_BASE) return;
        try {
            var d = await cmApi('/api/auth/me');
            renderMenuUser(d.user);
            loadNotifications(d.user && d.user.id);
        } catch (e) {
            renderMenuUser(null);
            loadNotifications(null);
        }
    }
    window._addNotification = addNotification;
    window.fetchServerNotifications = fetchServerNotifications;
    window._onUserChange = function (user) {
        renderMenuUser(user);
        if (user && user.id) loadNotifications(user.id);
    };
    window._openModByRid = openModByRid;

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

    function esc(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function gCS(m) {
        if (!m.coverImage) return '';
        if (Array.isArray(m.coverImage)) return m.coverImage[0] || '';
        return m.coverImage;
    }

    function gPI(t, u) {
        t = (t || '').toLowerCase();
        u = (u || '').toLowerCase();
        if (/b站|bilibili/.test(t) || /bilibili|b23\.tv/.test(u)) return { n: 'B站', c: 'tb' };
        if (/twitter|x[（(]/.test(t) || /twitter\.com|x\.com/.test(u)) return { n: 'X', c: 'tx' };
        if (/steam/.test(t) || /steamcommunity\.com/.test(u)) return { n: 'Steam', c: 'ts' };
        if (/github/.test(t) || /github\.com/.test(u)) return { n: 'GitHub', c: 'tg' };
        if (/爱发电|ifdian/.test(t) || /ifdian/.test(u)) return { n: '爱发电', c: 'ta' };
        if (/n网|nexus/.test(t) || /nexusmods/.test(u)) return { n: 'N网', c: 'tn' };
        if (/youtube|油管/.test(t) || /youtube\.com/.test(u)) return { n: 'YouTube', c: 'ty' };
        if (/夸克|quark/.test(t) || /quark/.test(u)) return { n: '夸克', c: 'tq' };
        if (/pixiv/.test(t) || /pixiv\.net/.test(u)) return { n: 'Pixiv', c: 'tp' };
        if (/fanbox/.test(t) || /fanbox\.cc/.test(u)) return { n: 'Fanbox', c: 'tf' };
        if (/patreon/.test(t) || /patreon\.com/.test(u)) return { n: 'Patreon', c: 'tpr' };
        if (/qq/.test(t) || /qq\.com|gljlw\.com\/qq/.test(u)) return { n: 'QQ', c: 'tqq' };
        return { n: t, c: '' };
    }

    function gRC(r) {
        r = (r || '').toLowerCase();
        if (/发布|发布者|作者/.test(r)) return 'rp';
        if (/形象|原画|美术|插画|立绘|画师/.test(r)) return 'ra';
        if (/技术|mod|代码|开发|支持|程序/.test(r)) return 'rt';
        return 'rd';
    }

    function pA(s) {
        if (!s) return [];
        if (!/\[[^\]]+\]/.test(s)) return [{ role: '', name: s.trim() }];
        var r = [], m, re = /\[([^\]]+)\]\s*[-－—]\s*([^\[]*?)(?=\s*\[|$)/g;
        while ((m = re.exec(s)) !== null) {
            var ro = m[1].trim(), nm = m[2].trim().replace(/\s+/g, ' ');
            if (nm) r.push({ role: ro, name: nm });
        }
        return r.length ? r : [{ role: '', name: s.trim() }];
    }

    function eNL(t) {
        var p = t.split(/[｜|]/);
        return p.length > 1 ? p.slice(1).join('｜').trim() : t.trim();
    }

    function mLA(a, l) {
        if (!l || !l.length) return a.map(function (x) { return Object.assign({}, x, { links: [] }); });
        if (a.length === 1) return [Object.assign({}, a[0], { links: l })];
        return a.map(function (x) {
            var mt = [];
            l.forEach(function (li) {
                var ln = eNL(li.text);
                if (ln && x.name && (x.name.indexOf(ln) !== -1 || ln.indexOf(x.name) !== -1 || x.name.replace(/[（）()]/g, '').indexOf(ln.replace(/[（）()]/g, '')) !== -1)) mt.push(li);
            });
            return Object.assign({}, x, { links: mt });
        });
    }

    function sGP(arr) {
        var main = [], prereqs = [];
        arr.forEach(function (l) {
            if (l.text.includes('前置')) prereqs.push(l);
            else main.push(l);
        });
        return { main: main, prereqs: prereqs };
    }

    function cLL(ls) {
        var la = [], al = [], hi = [], tb = [];
        if (!ls || !ls.length) return { latest: { main: [], prereqs: [] }, alternative: al, history: { main: [], prereqs: [] }, testBranch: { main: [], prereqs: [] } };
        ls.forEach(function (l) {
            if (l.category) {
                if (l.category === 'history') hi.push(l);
                else if (l.category === 'alternative') al.push(l);
                else if (l.category === 'testBranch') tb.push(l);
                else la.push(l);
            } else {
                var t = l.text;
                if (t.includes('兼容') || t.includes('备选') || t.includes('旧版') || t.includes('历史版本')) hi.push(l);
                else if (t.includes('在线解析') || t.includes('N网') || /官方帖子/.test(t)) al.push(l);
                else if (t.includes('测试') || t.includes('分支') || t.includes('beta') || /抢先/.test(t)) tb.push(l);
                else la.push(l);
            }
        });
        return { latest: sGP(la), alternative: al, history: sGP(hi), testBranch: sGP(tb) };
    }

    function cOF(te, tg) {
        if (te.textContent.length > 40) {
            tg.style.display = 'inline-block';
            return;
        }
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                if (te.scrollHeight > te.clientHeight + 2) tg.style.display = 'inline-block';
                else tg.style.display = 'none';
            });
        });
    }

    function gDLM(dl) {
        var dm = [];
        if (dl.version) dm.push(dl.version);
        if (dl.size) dm.push(dl.size);
        if (dl.date) dm.push(dl.date);
        return dm.length ? '<span class="dm">' + dm.map(function(p){return esc(p)}).join(' · ') + '</span>' : '';
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
        var dirMap = {
            all: 'sts2_mods',
            skin: 'O.o_interface'
        };
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
        var dirMap = {
            all: 'sts2_mods',
            skin: 'O.o_interface'
        };
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

    async function loadAllDataForCategory(categoryKey, forceRefresh) {
        if (!forceRefresh && allSiteData[categoryKey]) return allSiteData[categoryKey];
        if (dataLoadingPromises[categoryKey]) return await dataLoadingPromises[categoryKey];
        if (forceRefresh && allSiteData[categoryKey]) {
            delete allSiteData[categoryKey];
        }
        var promise = (async function () {
            var manifest = await loadManifest(categoryKey);
            var dirMap = {
                all: 'sts2_mods',
                skin: 'O.o_interface'
            };
            var dir = dirMap[categoryKey];
            if (manifest && manifest[dir]) {
                var rangeStr = manifest[dir];
                var indices = parseManifestRange(rangeStr);
                var dataArrays = await Promise.all(indices.map(function (idx) { return loadJsonByManifest(categoryKey, idx); }));
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

    function refreshAllData() {
        allSiteData = {};
        preloadState.currentPreloadPage = 0;
        currentPage = 1;
        loadModData('all');
        showToast('数据已刷新');
    }

    var preloadState = {
        currentPreloadPage: 0
    };

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
        function createBtn(type, content, disabled, clickHandler) {
            var btn = document.createElement('button');
            btn.className = type;
            btn.innerHTML = content;
            if (disabled) btn.disabled = true;
            if (clickHandler) btn.addEventListener('click', clickHandler);
            return btn;
        }
        function createPageBtn(pageNum) {
            return createBtn('pagination-page' + (pageNum === currentPageNum ? ' active' : ''), pageNum, false, function () {
                currentPage = pageNum;
                renderPage(pageNum);
                mG.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }
        function createDots() {
            var span = document.createElement('span');
            span.className = 'pagination-dots';
            span.textContent = '...';
            return span;
        }
        var items = [];
        // 上一页按钮
        items.push(createBtn('pagination-btn', '&#8249;', currentPageNum <= 1, function () {
            if (currentPageNum > 1) {
                currentPage--;
                renderPage(currentPage);
                mG.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }));
        // 第1页
        items.push(createPageBtn(1));
        // 中间页码逻辑
        if (totalPages > 1) {
            if (totalPages <= 5) {
                // 总页数<=5时，显示所有页码
                for (var i = 2; i <= totalPages; i++) {
                    items.push(createPageBtn(i));
                }
            } else {
                // 总页数>5时，按照新规则显示
                if (currentPageNum <= 3) {
                    // 首页或1~3页：显示 [1] [2] [3] [4] ... [totalPages]
                    for (var j = 2; j <= 4; j++) {
                        items.push(createPageBtn(j));
                    }
                    items.push(createDots());
                    items.push(createPageBtn(totalPages));
                } else if (currentPageNum >= totalPages - 2) {
                    // 尾页或最后3页：显示 [1] ... [totalPages-3] [totalPages-2] [totalPages-1] [totalPages]
                    items.push(createDots());
                    for (var k = totalPages - 3; k <= totalPages; k++) {
                        items.push(createPageBtn(k));
                    }
                } else {
                    // 中间页（4~totalPages-3）：显示 [1] ... [currentPage-1] [currentPage] [currentPage+1] ... [totalPages]
                    items.push(createDots());
                    items.push(createPageBtn(currentPageNum - 1));
                    items.push(createPageBtn(currentPageNum));
                    items.push(createPageBtn(currentPageNum + 1));
                    items.push(createDots());
                    items.push(createPageBtn(totalPages));
                }
            }
        }
        // 下一页按钮
        items.push(createBtn('pagination-btn', '&#8250;', currentPageNum >= totalPages, function () {
            if (currentPageNum < totalPages) {
                currentPage++;
                renderPage(currentPage);
                mG.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }));
        items.forEach(function (item) {
            paginationEl.appendChild(item);
        });
        var gotoWrap = document.createElement('span');
        gotoWrap.className = 'pagination-goto';
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
            mG.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
                mG.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        setTimeout(function () {
            input.focus();
        }, 100);
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

    function renderModCards(dataArray) {
        mG.innerHTML = '';
        if (dataArray.length === 0) {
            mG.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--tm)">没有找到相关MOD</div>';
            return;
        }
        var query = sI.value.trim();
        var lowerQuery = query ? query.toLowerCase() : '';
        var hasQuery = !!lowerQuery;
        var escapedQuery = hasQuery ? query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
        var regex = hasQuery ? new RegExp('(' + escapedQuery + ')', 'gi') : null;

        dataArray.forEach(function (mod) {
            var c = document.createElement('div');
            c.className = 'cd';
            var cs = gCS(mod);
            var ch = cs ? '<img src="' + cs + '" alt="' + esc(mod.title) + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'"><div class="cp" style="display:none">📦</div>' : '<div class="cp">📦</div>';

            var rawTitle = mod.title || '';
            var titleEscaped = esc(rawTitle);
            var titleHTML = titleEscaped;
            var titleEndMatch = false;
            if (hasQuery && regex) {
                titleHTML = titleEscaped.replace(regex, function (m) {
                    return '<mark>' + esc(m) + '</mark>';
                });
                var lowerRawTitle = rawTitle.toLowerCase();
                var idx = lowerRawTitle.lastIndexOf(lowerQuery);
                if (idx !== -1 && idx + lowerQuery.length >= lowerRawTitle.length) {
                    titleEndMatch = true;
                }
            }
            var titleClass = 'tt' + (titleEndMatch ? ' tt-ellipsis-highlight' : '');

            var MX = 4;
            var tg = mod.tags || [];
            var vt = tg.slice();
            var titleMatched = false;
            var tagMatched = false;
            var descMatched = false;
            if (hasQuery) {
                titleMatched = (mod.title || '').toLowerCase().indexOf(lowerQuery) !== -1;
                for (var i = 0; i < tg.length; i++) {
                    if ((tg[i] || '').toLowerCase().indexOf(lowerQuery) !== -1) {
                        tagMatched = true;
                        var matchedTagIndex = i;
                        break;
                    }
                }
                var descField = mod.description || mod.body || '';
                descMatched = descField && descField.toLowerCase().indexOf(lowerQuery) !== -1;
                if (tagMatched && matchedTagIndex >= MX) {
                    var matchedTag = tg[matchedTagIndex];
                    vt = tg.filter(function (_, idx) { return idx !== matchedTagIndex; });
                    vt.splice(1, 0, matchedTag);
                }
            }
            var visibleTags = vt.slice(0, MX);
            var ec = vt.length - MX;
            var th = visibleTags.map(function (t) {
                var tagEscaped = esc(t);
                var tagHTML = tagEscaped;
                if (hasQuery && regex && (t || '').toLowerCase().indexOf(lowerQuery) !== -1) {
                    tagHTML = tagEscaped.replace(regex, function (m) {
                        return '<mark>' + esc(m) + '</mark>';
                    });
                }
                return '<span class="ti ' + t.toLowerCase() + '">' + tagHTML + '</span>';
            }).join('');
            if (ec > 0) th += '<span class="tm2">+' + ec + '</span>';

            var matchHintHTML = '';
            if (hasQuery) {
                var matchCount = (titleMatched ? 1 : 0) + (tagMatched ? 1 : 0) + (descMatched ? 1 : 0);
                if (matchCount > 0) {
                    var hintClass = '';
                    var hintText = '';
                    if (matchCount > 1) {
                        hintClass = 'mh mh-multi';
                        hintText = '综合命中';
                    } else if (titleMatched) {
                        hintClass = 'mh mh-title';
                        hintText = '标题命中';
                    } else if (tagMatched) {
                        hintClass = 'mh mh-tag';
                        hintText = '标签命中';
                    } else if (descMatched) {
                        hintClass = 'mh mh-desc';
                        hintText = '简介命中';
                    }
                    if (hintClass) {
                        matchHintHTML = '<span class="' + hintClass + '">' + hintText + '</span>';
                    }
                }
            }

            c.innerHTML = '<div class="cv" style="background:' + mod.coverGradient + '">' + ch + '</div>' +
                '<div class="ci"><div class="tr"><span class="' + titleClass + '">' + titleHTML + '</span><span class="tv">' + esc(mod.badge) + '</span></div>' +
                '<div class="tl">' + th + '</div>' +
                '<div class="mt"><span>' + esc(mod.size) + '</span><span class="md">·</span><span>' + esc(mod.date) + '</span>' + matchHintHTML + '</div></div>';
            c.addEventListener('click', function () {
                oM(mod);
            });
            mG.appendChild(c);
        });
    }

    function oLB(s) {
        lI.src = s;
        lO.classList.add('act');
    }

    lX.addEventListener('click', function () {
        lO.classList.remove('act');
    });
    lO.addEventListener('click', function (e) {
        if (e.target === lO) lO.classList.remove('act');
    });

    function rPI(imgs) {
        if (!imgs || !imgs.length) return '<div class="pe">暂无图片预览资源</div>';
        var h = '<div class="pig">';
        for (var i = 0; i < imgs.length; i++) {
            h += '<img class="pii" src="' + imgs[i] + '" onclick="window._oLB(this.src)" onerror="this.style.display=\'none\'">';
        }
        return h + '</div>';
    }

    function rPV(vids) {
        if (!vids || !vids.length) return '<div class="pe">暂无视频预览资源</div>';
        var h = '<div class="pvl">';
        for (var i = 0; i < vids.length; i++) {
            h += '<div class="pvi-wrap" data-video-src="' + vids[i] + '"><video class="pvi" playsinline webkit-playsinline preload="metadata" src="' + vids[i] + '"></video><canvas class="pvi-poster" data-video-src="' + vids[i] + '"></canvas><div class="pvi-overlay"><div class="pvi-play-btn"></div></div></div>';
        }
        return h + '</div>';
    }

    // 上报查看量（fire-and-forget，10 分钟内同一帖子不重复上报）
    var reportedViews = {};
    function reportModView(rid) {
      var now = Date.now();
      if (reportedViews[rid] && (now - reportedViews[rid] < 600000)) return;
      reportedViews[rid] = now;
      try {
        fetch((window.COMMENT_API_BASE || '') + '/api/mod-stats/' + encodeURIComponent(rid) + '/view', {
          method: 'POST',
          credentials: 'include'
        }).catch(function () {});
      } catch (e) {}
    }
    // 上报下载量（fire-and-forget，10 分钟内同一帖子不重复上报）
    var reportedDownloads = {};
    function reportModDownload(rid) {
      var now = Date.now();
      if (reportedDownloads[rid] && (now - reportedDownloads[rid] < 600000)) return;
      reportedDownloads[rid] = now;
      try {
        fetch((window.COMMENT_API_BASE || '') + '/api/mod-stats/' + encodeURIComponent(rid) + '/download', {
          method: 'POST',
          credentials: 'include'
        }).catch(function () {});
      } catch (e) {}
    }
    // mod-stats 本地缓存（5 分钟内同一 rid 不重复请求）
    var modStatsCache = {};
    var MOD_STATS_CACHE_TTL = 300000; // 5 分钟
    // 加载并显示统计
    function loadModStats(rid) {
      var el = document.getElementById('mmsStats');
      if (!el) return;
      // 检查缓存
      var cached = modStatsCache[rid];
      var now = Date.now();
      if (cached && (now - cached.ts < MOD_STATS_CACHE_TTL)) {
        el.innerHTML = '<span class="mms-stat" style="font-size:inherit;font-weight:inherit;color:inherit;">' + (cached.data.viewCount || 0) + ' 次查看</span><span class="mms-sep" style="color:inherit;opacity:.5;">·</span><span class="mms-stat" style="font-size:inherit;font-weight:inherit;color:inherit;">' + (cached.data.downloadCount || 0) + ' 次下载</span>';
        return;
      }
      fetch((window.COMMENT_API_BASE || '') + '/api/mod-stats/' + encodeURIComponent(rid), {
        credentials: 'include'
      }).then(function (r) { return r.json(); }).then(function (d) {
        modStatsCache[rid] = { ts: now, data: d };
        if (el) el.innerHTML = '<span class="mms-stat" style="font-size:inherit;font-weight:inherit;color:inherit;">' + (d.viewCount || 0) + ' 次查看</span><span class="mms-sep" style="color:inherit;opacity:.5;">·</span><span class="mms-stat" style="font-size:inherit;font-weight:inherit;color:inherit;">' + (d.downloadCount || 0) + ' 次下载</span>';
      }).catch(function () {
        if (el) el.innerHTML = '<span class="mms-stat" style="font-size:inherit;font-weight:inherit;color:inherit;">- 次查看</span><span class="mms-sep" style="color:inherit;opacity:.5;">·</span><span class="mms-stat" style="font-size:inherit;font-weight:inherit;color:inherit;">- 次下载</span>';
      });
    }
    window._rMD = reportModDownload;

    function oM(mod) {
        currentMod = mod;
        window._cMR = mod.rid;
        var cl = cLL(mod.downloadLinks);
        currentCl = cl;
        var h = '';
        var cs = gCS(mod);
        if (cs) h += '<div class="miw"><img class="mii" src="' + cs + '" alt="' + esc(mod.title) + '" onclick="window._oLB(this.src)" onerror="this.parentElement.style.display=\'none\'"></div>';
        h += '<h2 class="mit">' + esc(mod.title) + '</h2>';
        h += '<div class="mml">';
        h += '<span class="mmi">' + esc(mod.badge) + '</span><span class="mms">·</span>';
        h += '<span class="mmi">' + esc(mod.size) + '</span><span class="mms">·</span>';
        h += '<span class="mmi">' + esc(mod.date) + '</span><span class="mms">·</span>';
        h += '<span class="mmi">axxxx.cyou</span>';
        h += '</div>';
        h += '<div class="mms-stats" id="mmsStats" style="font-size:.78rem;font-weight:400;color:#9a92a5;line-height:1.4;margin:6px 0 10px;"><span class="mms-stat" style="font-size:inherit;font-weight:inherit;color:inherit;">加载中</span><span class="mms-sep" style="color:inherit;opacity:.5;">·</span><span class="mms-stat" style="font-size:inherit;font-weight:inherit;color:inherit;">加载中</span></div>';
        h += '<div class="mrg-wrap">';
        h += '<span class="mr"><span class="mrt">RID ' + mod.rid + '</span></span>';
        h += '<a class="mra" onclick="event.preventDefault();window._cPT(\'RID:' + mod.rid + '\').then(function(){window._sTM(\'RID已复制\')})" title="复制RID">' + coS + '复制</a>';
        h += '<a class="mra" onclick="event.preventDefault();window._cPT(\'https://axxxx.cyou/?rid=' + mod.rid + '\').then(function(){window._sTM(\'分享链接已复制\')})" title="复制分享链接">' + shS + '分享</a>';
        h += '</div>';
        if (mod.tags && mod.tags.length) {
            h += '<div class="mts">';
            mod.tags.forEach(function (t) {
                h += '<span class="mtg ' + t.toLowerCase() + '">' + esc(t) + '</span>';
            });
            h += '</div>';
        }
        h += '<div class="dsl"><span>简介</span></div>';
        var de = (mod.description || '暂无介绍').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        de = de.replace(/(https?:\/\/[^\s<"]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
        h += '<div class="mde"><div class="dt" id="dT">' + de + '</div><span class="dto" id="dO" style="display:none">展开全文</span></div>';
        h += '<div class="sl"><span>下载方式</span></div>';
        h += '<div class="dsw ls"><div class="sh" onclick="window._tS(this)"><span class="st">正式版本<span class="sc">(' + cl.latest.main.length + ')</span></span><span class="sa2 op">▾</span></div><div class="sb"><div class="sbi">';
        if (cl.latest.main.length) {
            cl.latest.main.forEach(function (dl, i) {
                h += '<div class="di"><div class="dic"><div class="dih"><span class="dn"><a href="#" onclick="event.preventDefault();window._rMD(window._cMR);window.open(\'' + dl.url + '\',\'_blank\')" target="_blank" rel="noopener noreferrer">' + esc(dl.text) + '</a></span>';
                var dlMeta = gDLM(dl);
                if (i === 0) {
                    var v = dl.version || mod.badge;
                    var s = dl.size || mod.size;
                    var d = dl.date || mod.date;
                    h += '<span class="dm">' + esc(v) + ' · ' + esc(s) + ' · ' + esc(d) + '</span>';
                } else if (dlMeta) {
                    h += dlMeta;
                }
                h += '</div>';
                if (dl.desc) h += '<div class="id" id="lD' + i + '">' + esc(dl.desc) + '</div><span class="idt" data-target="lD' + i + '" onclick="window._tID(this)" style="display:none">展开</span>';
                var hasPr = cl.latest.prereqs && cl.latest.prereqs.length;
                if (dl.type === 'password') {
                    h += '</div><a class="db" href="#" onclick="event.preventDefault();window._rMD(window._cMR);window.open(\'' + dl.url + '\',\'_blank\')" target="_blank" rel="noopener noreferrer">' + dlS + '前往</a></div>';
                } else if (hasPr) {
                    h += '</div><a class="db" href="#" onclick="event.preventDefault();window._oP(window._cPR(\'latest\'),\'' + dl.url + '\')" target="_blank" rel="noopener noreferrer">' + dlS + '下载</a></div>';
                } else {
                    h += '</div><a class="db" href="#" onclick="event.preventDefault();window._rMD(window._cMR);window.open(\'' + dl.url + '\',\'_blank\')" target="_blank" rel="noopener noreferrer">' + dlS + '下载</a></div>';
                }
            });
        } else {
            h += '<div class="eh">暂无直接下载链接</div>';
        }
        h += '</div></div></div>';
        if (cl.testBranch.main.length) {
            h += '<div class="dsw"><div class="sh" onclick="window._tS(this)"><span class="st">测试分支版本<span class="sc">(' + cl.testBranch.main.length + ')</span></span><span class="sa2">▾</span></div><div class="sb co"><div class="sbi">';
            cl.testBranch.main.forEach(function (dl, i) {
                h += '<div class="di"><div class="dic"><div class="dih"><span class="dn"><a href="#" onclick="event.preventDefault();window._rMD(window._cMR);window.open(\'' + dl.url + '\',\'_blank\')" target="_blank" rel="noopener noreferrer">' + esc(dl.text) + '</a></span>';
                if (i === 0) {
                    var v = dl.version || mod.badge;
                    var s = dl.size || mod.size;
                    var d = dl.date || mod.date;
                    h += '<span class="dm">' + esc(v) + ' · ' + esc(s) + ' · ' + esc(d) + '</span>';
                } else {
                    h += gDLM(dl);
                }
                h += '</div>';
                if (dl.desc) h += '<div class="id" id="tD' + i + '">' + esc(dl.desc) + '</div><span class="idt" data-target="tD' + i + '" onclick="window._tID(this)" style="display:none">展开</span>';
                var hasPr = cl.testBranch.prereqs && cl.testBranch.prereqs.length;
                if (dl.type === 'password') {
                    h += '</div><a class="db" href="#" onclick="event.preventDefault();window._rMD(window._cMR);window.open(\'' + dl.url + '\',\'_blank\')" target="_blank" rel="noopener noreferrer">' + dlS + '前往</a></div>';
                } else if (hasPr) {
                    h += '</div><a class="db" href="#" onclick="event.preventDefault();window._oP(window._cPR(\'testBranch\'),\'' + dl.url + '\')" target="_blank" rel="noopener noreferrer">' + dlS + '下载</a></div>';
                } else {
                    h += '</div><a class="db" href="#" onclick="event.preventDefault();window._rMD(window._cMR);window.open(\'' + dl.url + '\',\'_blank\')" target="_blank" rel="noopener noreferrer">' + dlS + '下载</a></div>';
                }
            });
            h += '</div></div></div>';
        }
        h += '<div class="sl"><span>更多</span></div>';
        h += '<div class="dsw"><div class="sh" onclick="window._tS(this)"><span class="st">历史版本<span class="sc">' + (cl.history.main.length ? '(' + cl.history.main.length + ')' : '') + '</span></span><span class="sa2">▾</span></div><div class="sb co"><div class="sbi">';
        if (cl.history.main.length) {
            cl.history.main.forEach(function (dl, i) {
                h += '<div class="di"><div class="dic"><div class="dih"><span class="dn"><a href="#" onclick="event.preventDefault();window._rMD(window._cMR);window.open(\'' + dl.url + '\',\'_blank\')" target="_blank" rel="noopener noreferrer">' + esc(dl.text) + '</a></span>';
                h += gDLM(dl);
                h += '</div>';
                if (dl.desc) h += '<div class="id" id="hD' + i + '">' + esc(dl.desc) + '</div><span class="idt" data-target="hD' + i + '" onclick="window._tID(this)" style="display:none">展开</span>';
                var hasPr = cl.history.prereqs && cl.history.prereqs.length;
                if (dl.type === 'password') {
                    h += '</div><a class="db" href="#" onclick="event.preventDefault();window._rMD(window._cMR);window.open(\'' + dl.url + '\',\'_blank\')" target="_blank" rel="noopener noreferrer">' + dlS + '前往</a></div>';
                } else if (hasPr) {
                    h += '</div><a class="db" href="#" onclick="event.preventDefault();window._oP(window._cPR(\'history\'),\'' + dl.url + '\')" target="_blank" rel="noopener noreferrer">' + dlS + '下载</a></div>';
                } else {
                    h += '</div><a class="db" href="#" onclick="event.preventDefault();window._rMD(window._cMR);window.open(\'' + dl.url + '\',\'_blank\')" target="_blank" rel="noopener noreferrer">' + dlS + '下载</a></div>';
                }
            });
        } else {
            h += '<div class="eh">暂无历史版本</div>';
        }
        h += '</div></div></div>';
        if (cl.alternative.length) {
            h += '<div class="dsw"><div class="sh" onclick="window._tS(this)"><span class="st">其他下载方式<span class="sc">(' + cl.alternative.length + ')</span></span><span class="sa2">▾</span></div><div class="sb co"><div class="sbi">';
            cl.alternative.forEach(function (dl, i) {
                h += '<div class="di"><div class="dic"><div class="dih"><span class="dn"><a href="#" onclick="event.preventDefault();window._rMD(window._cMR);window.open(\'' + dl.url + '\',\'_blank\')" target="_blank" rel="noopener noreferrer">' + esc(dl.text) + '</a></span>';
                h += gDLM(dl);
                h += '</div>';
                if (dl.desc) h += '<div class="id" id="aD' + i + '">' + esc(dl.desc) + '</div><span class="idt" data-target="aD' + i + '" onclick="window._tID(this)" style="display:none">展开</span>';
                h += '</div><a class="db" href="#" onclick="event.preventDefault();window._rMD(window._cMR);window.open(\'' + dl.url + '\',\'_blank\')" target="_blank" rel="noopener noreferrer">' + dlS + '前往</a></div>';
            });
            h += '</div></div></div>';
        }
        var au = pA(mod.author || '佚名'), awl = mLA(au, mod.authorLinks || []), is = awl.length === 1 && !awl[0].role;
        h += '<div class="sl"><span>作者</span></div><div class="as' + (is ? ' sa' : '') + '">';
        awl.forEach(function (a) {
            h += '<div class="ar">';
            if (a.role) h += '<span class="arl ' + gRC(a.role) + '">' + esc(a.role) + '</span>';
            h += '<span class="an">' + esc(a.name) + '</span>';
            if (a.links && a.links.length) {
                a.links.forEach(function (l) {
                    var p = gPI(l.text, l.url);
                    h += '<a class="alt ' + p.c + '" href="' + l.url + '" target="_blank" rel="noopener noreferrer">' + esc(p.n) + '</a>';
                });
            }
            h += '</div>';
        });
        h += '</div>';
        h += '<div class="sl"><span>预览</span></div>';
        var hi = mod.previewImages && mod.previewImages.length > 0, hv = mod.previewVideos && mod.previewVideos.length > 0;
        if (hi && hv) {
            h += '<div class="ps"><button class="pt act" id="pIT" onclick="window._sP(\'images\')">' + imS + ' 预览图片<span class="pc">(' + mod.previewImages.length + ')</span></button><button class="pt" id="pVT" onclick="window._sP(\'videos\')">' + viS + ' 预览视频<span class="pc">(' + mod.previewVideos.length + ')</span></button></div><div id="pA"><div class="pp">' + rPI(mod.previewImages) + '</div></div>';
        } else if (hi) {
            h += '<div class="psg">' + imS + ' 预览图片<span class="psgc">(' + mod.previewImages.length + ')</span></div><div class="pp">' + rPI(mod.previewImages) + '</div>';
        } else if (hv) {
            h += '<div class="psg">' + viS + ' 预览视频<span class="psgc">(' + mod.previewVideos.length + ')</span></div><div class="pp">' + rPV(mod.previewVideos) + '</div>';
        } else {
            h += '<div class="pe">该MOD暂无预览资源</div>';
        }
        mC.innerHTML = h;
        mO.classList.add('act');
        document.body.style.overflow = 'hidden';
        mO.scrollTop = 0;
        var dTe = document.getElementById('dT'), dO = document.getElementById('dO');
        if (dTe && dO) {
            cOF(dTe, dO);
            dO.addEventListener('click', function () {
                var e = dTe.classList.toggle('exp');
                dO.textContent = e ? '收起' : '展开全文';
            });
        }
        setTimeout(function () {
            document.querySelectorAll('.id').forEach(function (el) {
                var tg = el.nextElementSibling;
                if (tg && tg.classList.contains('idt')) cOF(el, tg);
            });
        }, 100);
        window._cm = mod;
        window._ap = hi && hv ? 'images' : null;
        reportModView(mod.rid);
        loadModStats(mod.rid);
    }

    function cM() {
        mO.classList.remove('act');
        document.body.style.overflow = '';
        currentMod = null;
        currentCl = null;
        activePreviewTab = null;
        window._cP();
    }

    mX.addEventListener('click', cM);
    mO.addEventListener('click', function (e) {
        if (e.target === mO) cM();
    });

    window._oLB = oLB;
    window._cPT = copyText;
    window._sTM = showToast;

    window._oP = function (prereqs, dlUrl) {
        var h = '';
        prereqs.forEach(function (p) {
            var name = p.text.replace(/[#＃\s-]+/g, ' ').replace(/^\s+|\s+$/g, '').replace(/前置/g, '').replace(/\s+/g, ' ').trim();
            h += '<div class="pbi"><div class="pbl"><div class="pbin">' + esc(name) + '</div>';
            if (p.version || p.size) {
                var meta = [];
                if (p.version) meta.push(p.version);
                if (p.size) meta.push(p.size);
                h += '<div class="pbie">' + meta.map(function(x){return esc(x)}).join(' · ') + '</div>';
            }
            h += '</div><a class="pbil" href="#" onclick="event.preventDefault();window.open(\'' + p.url + '\',\'_blank\')" target="_blank" rel="noopener noreferrer">安装</a></div>';
        });
        h += '<div class="pbi pblb"><div class="pbl"><div class="pbin" style="font-weight:600">已装前置？下载模组本体 →</div></div><a class="pbil pbdl" href="#" onclick="event.preventDefault();window._rMD(window._cMR);window.open(\'' + dlUrl + '\',\'_blank\');window._cP()" target="_blank" rel="noopener noreferrer">下载</a></div>';
        pB.innerHTML = h;
        document.body.style.overflow = 'hidden';
        pO.classList.add('act');
    };

    window._cPR = function (cat) {
        if (!currentCl || !currentCl[cat]) return [];
        return currentCl[cat].prereqs || [];
    };

    window._cP = function () {
        pO.classList.remove('act');
        setTimeout(function () {
            document.body.style.overflow = '';
        }, 200);
    };

    pO.addEventListener('click', function (e) {
        if (e.target === pO) window._cP();
    });
    window._tS = function (el) {
        var b = el.nextElementSibling, a = el.querySelector('.sa2'), c = b.classList.contains('co');
        if (c) {
            b.classList.remove('co');
            b.style.maxHeight = b.scrollHeight + 'px';
            a.classList.add('op');
        } else {
            b.style.maxHeight = b.scrollHeight + 'px';
            requestAnimationFrame(function () {
                b.classList.add('co');
                a.classList.remove('op');
            });
        }
    };
    window._tID = function (el) {
        var tid = el.getAttribute('data-target'), de = document.getElementById(tid);
        if (!de) return;
        var e = de.classList.toggle('exp');
        el.textContent = e ? '收起' : '展开';
        var sb = de.closest('.sb');
        if (sb && !sb.classList.contains('co')) sb.style.maxHeight = sb.scrollHeight + 'px';
    };
    window._sP = function (tab) {
        var mod = window._cm;
        if (!mod) return;
        var a = document.getElementById('pA');
        if (!a) return;
        var it = document.getElementById('pIT'), vt = document.getElementById('pVT');
        if (window._ap === tab) return;
        window._ap = tab;
        if (it) it.classList.toggle('act', tab === 'images');
        if (vt) vt.classList.toggle('act', tab === 'videos');
        a.innerHTML = '<div class="pp">' + (tab === 'images' ? rPI(mod.previewImages) : rPV(mod.previewVideos)) + '</div>';
        if (tab === 'videos') {
            initVideoPlayers();
        }
    };

    function initVideoPlayers() {
        document.querySelectorAll('.pvi-wrap').forEach(function(wrap) {
            var video = wrap.querySelector('video');
            var canvas = wrap.querySelector('canvas');
            var overlay = wrap.querySelector('.pvi-overlay');
            var playBtn = wrap.querySelector('.pvi-play-btn');
            if (!video || !overlay || !playBtn) return;
            function generatePoster() {
                if (!canvas || !video.videoWidth) return;
                var ctx = canvas.getContext('2d');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                canvas.style.display = 'block';
            }
            video.addEventListener('loadedmetadata', function() {
                video.currentTime = 0.1;
            });
            video.addEventListener('seeked', function() {
                generatePoster();
            });
            video.addEventListener('loadeddata', function() {
                if (!canvas || canvas.style.display === 'block') return;
                generatePoster();
            });
            video.load();
            playBtn.addEventListener('click', function() {
                var vp = document.createElement('div');
                vp.className = 'video-player-overlay';
                vp.innerHTML = '<div class="vpo-close"></div><video class="vpo-video" src="' + video.src + '" controls playsinline webkit-playsinline></video>';
                document.body.appendChild(vp);
                document.body.style.overflow = 'hidden';
                var vpoVideo = vp.querySelector('.vpo-video');
                vpoVideo.play();
                vp.querySelector('.vpo-close').addEventListener('click', function() {
                    vp.remove();
                    document.body.style.overflow = '';
                });
                vp.addEventListener('click', function(e) {
                    if (e.target === vp) {
                        vp.remove();
                        document.body.style.overflow = '';
                    }
                });
            });
        });
    }

    async function performGlobalRidSearch(rid) {
        var categories = ['all', 'skin'];
        for (var i = 0; i < categories.length; i++) {
            var cat = categories[i];
            if (allSiteData[cat]) {
                var found = allSiteData[cat].find(function (m) { return m.rid === rid; });
                if (found) return found;
            }
        }
        for (var j = 0; j < categories.length; j++) {
            var cat2 = categories[j];
            if (!allSiteData[cat2]) {
                await loadAllDataForCategory(cat2);
            }
            if (allSiteData[cat2]) {
                var found2 = allSiteData[cat2].find(function (m) { return m.rid === rid; });
                if (found2) return found2;
            }
        }
        return null;
    }

    function scoreModMatch(mod, query) {
        var lowerQuery = query.toLowerCase();
        var titleScore = 0;
        var tagScore = 0;
        var descScore = 0;
        var titleMatched = false;
        var tagMatched = false;
        var descMatched = false;

        if (mod.title) {
            var lowerTitle = mod.title.toLowerCase();
            if (lowerTitle === lowerQuery) {
                titleScore = 100;
            } else if (lowerTitle.indexOf(lowerQuery) !== -1) {
                titleScore = 60;
            }
            if (titleScore > 0) titleMatched = true;
        }

        if (mod.tags && mod.tags.length) {
            for (var i = 0; i < mod.tags.length; i++) {
                var lowerTag = (mod.tags[i] || '').toLowerCase();
                if (lowerTag === lowerQuery) {
                    tagScore = Math.max(tagScore, 50);
                } else if (lowerTag.indexOf(lowerQuery) !== -1) {
                    tagScore = Math.max(tagScore, 30);
                }
            }
            if (tagScore > 0) tagMatched = true;
        }

        var descField = mod.description || mod.body || '';
        if (descField) {
            var lowerDesc = descField.toLowerCase();
            if (lowerDesc.indexOf(lowerQuery) !== -1) {
                descScore = 20;
                descMatched = true;
            }
        }

        if (titleScore === 0 && tagScore === 0 && descScore === 0) return null;

        var totalScore = titleScore + tagScore + descScore;
        var matchFields = { title: titleMatched, tag: tagMatched, desc: descMatched };

        var idScore = 0;
        if (mod.id) {
            idScore = (mod.id || '').localeCompare ? 0 : parseInt(mod.id, 10) || 0;
        }

        return { score: totalScore, matchFields: matchFields, idScore: idScore };
    }

    function filterMods() {
        var filtered = baseModData.slice();
        var query = sI.value.trim();
        if (query) {
            var lowerQuery = query.toLowerCase();
            if (lowerQuery.startsWith('rid:')) {
                var ridPart = lowerQuery.slice(4).trim();
                performGlobalRidSearch(ridPart).then(function (found) {
                    if (found) {
                        oM(found);
                        sI.value = '';
                        searchDropdown.classList.remove('active');
                    } else {
                        mG.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--tm)">未找到该 RID</div>';
                        paginationEl.innerHTML = '';
                    }
                });
                return;
            } else if (/^\d{8}$/.test(query)) {
                performGlobalRidSearch(query).then(function (found) {
                    if (found) {
                        oM(found);
                        sI.value = '';
                        searchDropdown.classList.remove('active');
                    } else {
                        mG.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--tm)">未找到该 RID</div>';
                        paginationEl.innerHTML = '';
                    }
                });
                return;
            } else {
                var scored = [];
                for (var i = 0; i < filtered.length; i++) {
                    var m = filtered[i];
                    var result = scoreModMatch(m, query);
                    if (result) {
                        scored.push({ mod: m, result: result });
                    }
                }
                scored.sort(function (a, b) {
                    if (b.result.score !== a.result.score) return b.result.score - a.result.score;
                    return b.result.idScore - a.result.idScore;
                });
                filtered = scored.map(function (s) { return s.mod; });
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
        if (lowerQuery.startsWith('rid:') || /^\d{8}$/.test(query)) {
            searchDropdown.classList.remove('active');
            return;
        }

        var scored = [];
        for (var i = 0; i < modData.length; i++) {
            var m = modData[i];
            var result = scoreModMatch(m, query);
            if (result) {
                scored.push({ mod: m, result: result });
            }
        }
        scored.sort(function (a, b) {
            if (b.result.score !== a.result.score) return b.result.score - a.result.score;
            return b.result.idScore - a.result.idScore;
        });

        if (scored.length === 0) {
            searchDropdown.innerHTML = '<li style="padding:16px;text-align:center;color:var(--tm)">没有找到相关MOD</li>';
        } else {
            var escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            var regex = new RegExp('(' + escapedQuery + ')', 'gi');
            for (var j = 0; j < scored.length; j++) {
                var entry = scored[j];
                var m = entry.mod;
                var mf = entry.result.matchFields;

                var matchType = '';
                var matchCount = (mf.title ? 1 : 0) + (mf.tag ? 1 : 0) + (mf.desc ? 1 : 0);
                if (matchCount > 1) {
                    matchType = 'multi';
                } else if (mf.title) {
                    matchType = 'title';
                } else if (mf.tag) {
                    matchType = 'tag';
                } else if (mf.desc) {
                    matchType = 'desc';
                }

                var li = document.createElement('li');
                li.className = 'search-dropdown-item';

                var titleEscaped = esc(m.title || '');
                var highlightedTitle = titleEscaped.replace(regex, function (m2) {
                    return '<mark>' + esc(m2) + '</mark>';
                });

                var typeLabel = '';
                var typeClass = '';
                switch (matchType) {
                    case 'title': typeLabel = '标题'; typeClass = 'sdi-match-title'; break;
                    case 'tag':   typeLabel = '标签'; typeClass = 'sdi-match-tag';   break;
                    case 'desc':  typeLabel = '简介'; typeClass = 'sdi-match-desc';  break;
                    case 'multi': typeLabel = '综合'; typeClass = 'sdi-match-multi'; break;
                }

                li.innerHTML = '<span class="sdi-title">' + highlightedTitle + '</span>' +
                    '<span class="sdi-match ' + typeClass + '">' + typeLabel + '</span>';

                li.addEventListener('click', function (mod) {
                    return function () {
                        sI.value = mod.title;
                        searchDropdown.classList.remove('active');
                        filterMods();
                    };
                }(m));
                searchDropdown.appendChild(li);
            }
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
            sI.value = '';
            searchDropdown.classList.remove('active');
            renderPage(1);
            return;
        }
        mG.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;"><img src="' + loaded2Src + '" alt="加载中" style="max-width:200px;"></div>';
        paginationEl.innerHTML = '';
        var data = await loadAllDataForCategory(categoryKey);
        if (data && data.length) {
            modData = data;
            baseModData = data;
            sI.value = '';
            searchDropdown.classList.remove('active');
            renderPage(1);
        } else {
            mG.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;">MOD数据加载失败，请稍后再试</div>';
        }
    }

    document.getElementById('categoryTabs').addEventListener('click', function (e) {
        var tab = e.target.closest('.category-tab');
        if (!tab) return;
        document.querySelectorAll('.category-tab').forEach(function (t) {
            t.classList.remove('active');
        });
        tab.classList.add('active');
        activeCategory = tab.getAttribute('data-category') || 'all';
        loadModData(activeCategory);
    });

    sI.addEventListener('input', filterMods);
    sI.addEventListener('focus', function () {
        if (sI.value.trim().length >= 1) updateSearchDropdown(sI.value.trim());
    });
    sI.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            searchDropdown.classList.remove('active');
            sI.blur();
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

    if (menuBtn && menuPanel) {
        menuBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            menuPanel.classList.toggle('open');
            if (menuPanel.classList.contains('open')) {
                fetchServerNotifications();
            }
            startNotifPolling();
        });
        document.addEventListener('click', function (e) {
            if (menuPanel.classList.contains('open') && !menuPanel.contains(e.target) && e.target !== menuBtn) {
                menuPanel.classList.remove('open');
                startNotifPolling();
            }
        });
    }
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            // 页面切到后台时立即停止轮询，节省 Workers 配额
            clearNotifTimers();
        } else {
            // 切回前台时立即拉一次 + 恢复轮询
            fetchServerNotifications();
            startNotifPolling();
        }
    });
    // 窗口失焦（切到其他窗口/应用）时也暂停轮询
    window.addEventListener('blur', clearNotifTimers);
    window.addEventListener('focus', function () {
        if (document.visibilityState === 'visible') {
            fetchServerNotifications();
            startNotifPolling();
        }
    });
    var menuClearAll = document.getElementById('menuClearAll');
    if (menuClearAll) {
        menuClearAll.addEventListener('click', function (e) {
            e.stopPropagation();
            markAllNotifRead();
        });
    }

    var DARK_KEY = 'sts2_dark_mode';
    function applyTheme(isDark) {
        if (isDark) {
            document.documentElement.classList.add('dark');
            if (themeIconSun) themeIconSun.style.display = 'none';
            if (themeIconMoon) themeIconMoon.style.display = 'block';
        } else {
            document.documentElement.classList.remove('dark');
            if (themeIconSun) themeIconSun.style.display = 'block';
            if (themeIconMoon) themeIconMoon.style.display = 'none';
        }
    }
    var savedDark = localStorage.getItem(DARK_KEY) === '1';
    applyTheme(savedDark);
    if (themeToggle) {
        themeToggle.addEventListener('click', function (e) {
            e.stopPropagation();
            var isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem(DARK_KEY, isDark ? '1' : '0');
            applyTheme(isDark);
            if (menuPanel) menuPanel.classList.remove('open');
        });
    }

    async function handleUrlParams() {
        var params = new URLSearchParams(window.location.search);
        var rid = params.get('rid');
        var commentId = params.get('commentId');
        if (rid) {
            var found = await performGlobalRidSearch(rid);
            if (found) {
                oM(found);
                if (commentId) {
                    var loaded = await waitForCommentsLoaded(6000);
                    if (loaded) highlightComment(Number(commentId));
                }
            } else {
                showToast('未找到该帖子');
            }
            history.replaceState({}, document.title, window.location.pathname);
        }
    }

    async function initPage() {
        await loadMenuUser();
        fetchServerNotifications();
        startNotifPolling();

        var loadingGifUrls = [
            'http://shp.qpic.cn/collector/1976464052/8ca28b73-c355-4abe-92e8-d4da82b9c560/0',
            'https://p.qpic.cn/psn_labels/ayJapABWAwW4hmBFXiaqn7icrqSOuPYeSRQw4iaPl6ZCFxU66CiaGkhEicLCnEibnfSRX2T4Zhze15Rbg/0'
        ];
        var loaded2GifUrls = [
            'http://shp.qpic.cn/collector/1976464052/35195f23-993a-4bae-a95b-b01054c9aa2c/0',
            'https://p.qpic.cn/psn_labels/ayJapABWAwW4hmBFXiaqn7icrqSOuPYeSRb8kvrUia3vonmc1Qke2xRzZticdf6bkIGYzicc43F7x6RI/0'
        ];
        try {
            var fetchWithTimeout = Promise.race([
                fetch('resources/json/config.json', { cache: 'no-store' }),
                new Promise(function (_, reject) {
                    setTimeout(function () {
                        reject(new Error('timeout'));
                    }, 3000);
                })
            ]);
            var resp = await fetchWithTimeout;
            if (resp.ok) {
                var config = await resp.json();
                if (config.loadingGifUrls && config.loadingGifUrls.length) loadingGifUrls = config.loadingGifUrls;
                if (config.loaded2GifUrls && config.loaded2GifUrls.length) loaded2GifUrls = config.loaded2GifUrls;
            }
        } catch (e) {}
        var gifPromise = raceImage(loadingGifUrls).catch(function () {
            return null;
        });
        gifPromise.then(function (src) {
            if (src) {
                loadingGif.src = src;
                loadingGif.style.display = 'block';
                if (potionWrapper) potionWrapper.style.display = 'none';
            }
        });
        var loaded2Promise = raceImage(loaded2GifUrls).catch(function () {
            return null;
        });
        loaded2Promise.then(function (src) {
            if (src) window.loaded2GifSrc = src;
        });
        var urlParams = new URLSearchParams(window.location.search);
        var hasRid = !!urlParams.get('rid');
        await priorityPreload();
        if (allSiteData['all']) {
            modData = allSiteData['all'];
            baseModData = modData;
            renderPage(1);
        } else {
            loadModData('all');
        }
        await waitForFirstScreenImages();
        loadingOverlay.classList.add('hidden');
        mainContent.style.opacity = '1';
        if (hasRid) {
            handleUrlParams();
        }
        // 显示群邀请提示（加载完成后立即显示）
        if (groupInviteToast && !groupInviteShown) {
            setTimeout(function () {
                groupInviteToast.style.display = 'flex';
                // 强制重排，确保display:flex已经应用后再添加show类触发动画
                void groupInviteToast.offsetWidth;
                groupInviteToast.classList.add('show');
                groupInviteShown = true;
                // 6秒后自动隐藏
                setTimeout(function () {
                    groupInviteToast.classList.remove('show');
                    // 等待动画完成后隐藏元素
                    setTimeout(function () {
                        groupInviteToast.style.display = 'none';
                    }, 400);
                }, 6000);
            }, 300); // 只延迟300毫秒，几乎立即显示
        }
    }

    function waitForFirstScreenImages() {
        return new Promise(function(resolve) {
            var images = mG.querySelectorAll('img');
            if (images.length === 0) {
                setTimeout(resolve, 500);
                return;
            }
            var loadedCount = 0;
            var totalCount = images.length;
            var timeout = setTimeout(function() {
                resolve();
            }, 8000);
            images.forEach(function(img) {
                if (img.complete) {
                    loadedCount++;
                    if (loadedCount === totalCount) {
                        clearTimeout(timeout);
                        resolve();
                    }
                } else {
                    img.addEventListener('load', function() {
                        loadedCount++;
                        if (loadedCount === totalCount) {
                            clearTimeout(timeout);
                            resolve();
                        }
                    });
                    img.addEventListener('error', function() {
                        loadedCount++;
                        if (loadedCount === totalCount) {
                            clearTimeout(timeout);
                            resolve();
                        }
                    });
                }
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPage);
    } else {
        initPage();
    }
})();
