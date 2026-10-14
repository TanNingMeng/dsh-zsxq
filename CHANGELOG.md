# Changelog

本项目的所有重要变更都记录在这里。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- `zsxq_hashtags` 工具：列出星球话题标签（球内 tab，如 #球友必看#）；`zsxq_topics` 支持 `hashtag_id` 参数直接抓取指定 tab 下的主题。
- `tools/crawler.cjs` 只读内容爬虫：支持系统栏目（`digests`/`all`/`questions` 问答/`by_owner` 只看星主/`tasks` 作业）、话题标签 tab（`--tab`）、右下角专栏全文（`--columns`）与星球文件索引（`--files`），输出 Obsidian 兼容 Markdown，含断点续爬与风控退避。
- 长文全文自动补全：带 `talk.article` 的主题（专栏文章、长文帖）自动经 `articles.zsxq.com` SSR 页抓取全文并转 Markdown（需 Cookie；空壳页自动换 `inline_article_url` 重试）。
- 问答（q&a）主题完整渲染提问与回答双方内容，front-matter 新增 `answered_by`/`answered_by_is_owner` 等字段。
- 图片本地化：正文/文章图片自动下载到 `<星球>/attachments/`（URL 哈希命名、进程内去重、温和节流），Markdown 改写为相对链接，Obsidian 离线可预览；`images.zsxq.com` 签名 URL（带过期 token）不再依赖 CDN 时效。默认开启（`--no-images` 关闭）。
- `--localize` 补漏模式：扫描已有库内 Markdown，把仍指向 zsxq CDN 的图片补下载到本地并改写链接（纯本地 + 图片 CDN，不发星球 API 请求；可配 `--group` 过滤星球目录）。
- 星球简介落盘：每次爬取自动生成 `<星球>/星球简介.md`（front-matter 含成员/主题/精华数，正文含简介与资源清单、星主介绍、公告）。
- 主题 front-matter 新增 `reading`/`readers` 阅读数字段，可用于按热度筛选内容。
- 官方 MCP 通道集成（`zsxq-cli`，OAuth 登录后可用）：评论、话题标签、星球详情、专栏列表走官方接口免 1059 风控且不受 20s 节流约束，失败自动回退 cookie 直连（`--no-official` 可禁用）；评论渲染新增楼中楼（`replied_comments`）。正文端点受星球级 Skill 门禁，仍走 cookie 直连。
- 专栏爬取鲁棒性：单篇文章详情失败不再炸掉整个专栏步骤——短重试 2 次后记入 `state.column_detail_failures` 跳过清单（疑似已删/受限主题），后续运行自动跳过；列表空页（软风控塞空数据）重试一次后再判断是否到底，防误判提前收工。
- `--deep` 陈旧数据熔断：风控会把每一页都替换成同样的首屏内容（正常游标翻页绝不会重复同一组主题 ID），连续 2 页完全重复即判定陈旧数据模式、中止本频道深挖，避免空烧数百页请求（实际案例：7 页的频道烧了近 200 页）。
- 专栏跳过清单跨轮计数：失败条目记录累计轮数（兼容老 ISO 字符串格式），累计 ≥3 轮才视为已证实的死主题；风控批量拦截触发洗白时保留已证实条目，不再把已知死主题一并洗掉导致每轮重踩。
- **官方网页客户端签名**（重大）：逆向 wx.zsxq.com 前端签名机制——`X-Signature = SHA1("<绝对URL> <时间戳> <请求随机ID>")`，无盐，已用真实流量样本离线验证；所有 API 请求现在带全套 `X-Request-Id`/`X-Version`/`X-Signature`/`X-Timestamp`/`X-Aduid` 头（Aduid 设备 ID 持久化于 state），与官方网页端请求同构，绕开 1059"非官方工具访问"风控。此前数日的间歇性 `succeeded=false`/空页封锁实为签名校验逐步收紧所致，与账号量级惩罚无关。

### 修复

- 精华 scope 实际取值为 `digests`（`digested` 会返回 code=19301），内部自动映射。
- 分页：`end_time` 仅接受 ISO 8601 `create_time` 且为闭区间（需按 topic_id 去重）；站内搜索改用 `/search/topics`（旧路径已 404）。
- API 标题字段为约 40 字截断预览，标题优先取正文首行还原。
- `crawlColumns` 引用未定义变量 `articleUrl` 导致 `--columns` 处理第一个文章即抛 ReferenceError。

## [0.1.4] - 2026-09-29

### 兼容性

- 声明兼容 **DSH 0.2.0-rc.2**：`peerDependencies` 中官方 DSH 包的版本范围追加 `^0.2.0-rc.2`。功能与行为无变化，仅解除新版 DSH 下的兼容告警。

