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

### 修复

- 精华 scope 实际取值为 `digests`（`digested` 会返回 code=19301），内部自动映射。
- 分页：`end_time` 仅接受 ISO 8601 `create_time` 且为闭区间（需按 topic_id 去重）；站内搜索改用 `/search/topics`（旧路径已 404）。
- API 标题字段为约 40 字截断预览，标题优先取正文首行还原。
- `crawlColumns` 引用未定义变量 `articleUrl` 导致 `--columns` 处理第一个文章即抛 ReferenceError。

## [0.1.4] - 2026-09-29

### 兼容性

- 声明兼容 **DSH 0.2.0-rc.2**：`peerDependencies` 中官方 DSH 包的版本范围追加 `^0.2.0-rc.2`。功能与行为无变化，仅解除新版 DSH 下的兼容告警。

