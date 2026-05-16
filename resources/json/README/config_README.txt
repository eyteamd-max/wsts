../resources/json/config.json 各字段说明
=====================

loadingGifUrls
--------------
首屏加载动画 GIF（显示的"药水咕嘟"动画）
1. http://shp.qpic.cn/collector/1976464052/8ca28b73-c355-4abe-92e8-d4da82b9c560/0 - 腾讯 QQ 图床备用1，图源"QQ收藏"
2. https://p.qpic.cn/psn_labels/ayJapABWAwW4hmBFXiaqn7icrqSOuPYeSRQw4iaPl6ZCFxU66CiaGkhEicLCnEibnfSRX2T4Zhze15Rbg/0 - 腾讯 QQ 图床备用2，图源"名片标签"
3. https://files.zohopublic.com.cn/public/workdrive-public/download/uim415f0a48fc29b7488aae76f9456e19b726 - Zoho WorkDrive 备用下载链接
4. https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded.gif - jsdmirror CDN 镜像，国内访问较快
5. https://cdn.jsdelivr.net/gh/eyteamd-max/HTML-full-linked-html-/loaded.gif - jsdelivr CDN 官方，国外访问较快

logoUrls
--------
页面左上角 LOGO 立绘图片（故障机器人/鸡煲立绘）
1. https://files.zohopublic.com.cn/public/workdrive-public/download/uim41085635847b0a47b1bdb1edbc8b2df24c - Zoho WorkDrive 备用下载链接
2. https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/Lihui.gif - jsdmirror CDN 镜像，国内访问较快
3. https://cdn.jsdelivr.net/gh/eyteamd-max/HTML-full-linked-html-/Lihui.gif - jsdelivr CDN 官方，国外访问较快

loaded2GifUrls
--------------
MOD 卡片没有封面图时的占位图（"正在加载"占位动画）
1. http://shp.qpic.cn/collector/1976464052/35195f23-993a-4bae-a95b-b01054c9aa2c/0 - 腾讯 QQ 图床备用1，图源"QQ收藏"
2. https://p.qpic.cn/psn_labels/ayJapABWAwW4hmBFXiaqn7icrqSOuPYeSRb8kvrUia3vonmc1Qke2xRzZticdf6bkIGYzicc43F7x6RI/0 - 腾讯 QQ 图床备用2，图源"名片标签"
3. https://files.zohopublic.com.cn/public/workdrive-public/download/uim41f1f1b701a34e42018829b2cd34eaaecd - Zoho WorkDrive 备用下载链接
4. https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif - jsdmirror CDN 镜像
5. https://cdn.jsdelivr.net/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif - jsdelivr CDN 全球节点

加载逻辑说明
=====================
- 每个图片字段都支持多个 URL 作为备用地址
- 前端使用 raceImage 函数同时请求所有 URL，取最先加载成功的一个
- 单个图片请求超时时间为 3.5 秒，整体竞速总超时为 6.5 秒
- 所有图片加载不阻塞页面显示（页面会在 100ms 后直接展示，图片后台异步更新）
- 如果某个图片字段所有 URL 都加载失败，对应的元素会保持 CSS 默认状态或留空
