# dsh-zsxq

知识星球（zsxq）集成插件 for DeepSeek Harness：基于知识星球**非官方** web API（`api.zsxq.com/v2`）+ 登录 Cookie 认证，把星球内容能力暴露为 agent 工具，并提供扫码登录与 Web 设置面板。

> ⚠️ 知识星球**没有官方开放平台 API**。读操作（星球列表 / 主题列表 / 主题详情 / 搜索）在开源社区实践中稳定可用；写操作（发布 / 评论 / 点赞）为逆向接口，可能被知识星球风控，请谨慎使用。

## 功能

| 工具 | 说明 | 参数 |
| --- | --- | --- |
| `zsxq_status` | 登录状态（Cookie 配置/有效期、登录流程进度） | — |
| `zsxq_config` | 配置/清除 Cookie | `cookie` / `reset` |
| `zsxq_login` | 扫码登录（弹出系统 Chrome 窗口） | — |
| `zsxq_groups` | 我加入的星球列表 | — |
| `zsxq_topics` | 星球主题列表 | `group_id`, `scope`(all/digested), `hashtag_id`(指定 tab), `count`, `end_time` |
| `zsxq_hashtags` | 星球话题标签（球内 tab，如 #球友必看#）列表 | `group_id` |
| `zsxq_topic` | 主题详情 + 评论 | `topic_id`, `with_comments` |
| `zsxq_search` | 星球内搜索 | `group_id`, `keyword`, `count` |
| `zsxq_publish` | 发布主题（写操作） | `group_id`, `content` |
| `zsxq_comment` | 发表评论（写操作） | `topic_id`, `content` |
| `zsxq_like` | 点赞（写操作） | `topic_id` |

Web 设置面板：设置 → 知识星球（扫码登录 / 粘贴 Cookie / 测试连接 / 清除登录）。

## 内容爬虫（tools/crawler.cjs）

配套的**只读**爬虫：把星球的精华 / 全部 / 问答 / 只看星主 / 作业 / 话题标签 tab / 专栏（含长文全文）/ 星球文件索引，爬成 Obsidian 兼容的 Markdown 知识库（front-matter 元数据 + 断点续爬 + 节流退避）。零依赖，Node 18+ 直接运行：

```bash
# 精华（默认）
node tools/crawler.cjs --group <id> --scope digests --out zsxq-vault/
# 系统栏目：questions 问答 | by_owner 只看星主 | tasks 作业
node tools/crawler.cjs --group <id> --scope questions --comments 10 --out zsxq-vault/
# 球内话题标签 tab（名称或 hashtag_id，逗号分隔多个）
node tools/crawler.cjs --group <id> --tab 球友必看,面试 --out zsxq-vault/
# 右下角【专栏】全文 + 【星球文件】索引
node tools/crawler.cjs --group <id> --columns --files --comments 10 --out zsxq-vault/
```

要点：

- **长文全文自动补全**：星球长文（专栏文章、带文章附件的帖子）的 API `text` 只有约 60 字预览，爬虫会自动经 `talk.article.article_url` 抓取 `articles.zsxq.com` 的 SSR 全文页（**必须携带 Cookie**）并转换为 Markdown；偶发未登录空壳页会自动换 `inline_article_url` 重试。
- **问答完整内容**：q&a 类型主题渲染「提问（提问者）+ 回答（回答者）」两段，front-matter 记录 `answered_by` / `answered_by_is_owner`。
- **分页坑**：`end_time` 仅接受 ISO 8601 `create_time`（epoch 会报 1001/1059），且为闭区间（重复一条，按 topic_id 去重）；话题标签/专栏/文件接口用 `index` 偏移分页。
- **节流与风控**：默认 20s/请求（`--interval` 可调），遇风控按 60s → 300s → 1800s 退避重试；`_meta/state.json` 记录断点（每 scope / 每 tab 独立游标），重跑即为增量。
- **已知限制**：星球文件的下载链接接口返回 1030 权限不足，`--files` 仅生成元数据索引（含来源主题 ID）。

## 兼容性

要求 **DeepSeek Harness ≥ 0.1.5-rc.1**（已在包清单的 `dsh.engines.dsh` 中声明，DSH 插件市场据此显示兼容版本），并已在 **0.1.5-rc.1** 上实测通过。本构建包含 DSH 0.1.5 的适配：工具结果的严格校验契约（lossless-JSON 快照、`additionalProperties: false` 的 schema 校验、`output.render` 必须返回 `ContentBlock[]`），以及不依赖宿主 PATH 的可执行文件解析（launchd 托管的宿主 `PATH` 只有 `/usr/bin:/bin`）。 **本版起**在 `peerDependencies` 中显式声明兼容 **DSH 0.2.0-rc.2**（官方 DSH 包的版本范围已含 `^0.2.0-rc.2`），在 0.2.0-rc.2 上不会再出现兼容告警；功能与行为无变化。

## 安装

```bash
# 本地开发（link 挂载）
dsh plugin --profile web add link:/path/to/dsh-zsxq

# 或 npm 安装（发布后）
dsh plugin --profile web add dsh-zsxq
```

安装后重启 DSH GUI 生效。

## 使用

1. **登录**：`zsxq_login`（弹出 Chrome 窗口微信扫码，自动保存 Cookie），或 `zsxq_config` 粘贴 Cookie（浏览器打开 wx.zsxq.com → DevTools → Network → 任选 api.zsxq.com 请求 → 复制 Cookie 请求头），或在设置面板操作。
2. **读内容**：`zsxq_groups` 拿星球 ID → `zsxq_topics` 拿主题列表 → `zsxq_topic` 看详情评论；`zsxq_search` 站内搜索。
3. **写内容**（风险自担）：`zsxq_publish` / `zsxq_comment` / `zsxq_like`。

Cookie 有效期约 1–3 个月，过期后 API 返回 401，重新登录即可。凭据存 `~/.dsh/dsh-zsxq.json`（权限 0600）。

## 技术说明

- API 基址 `https://api.zsxq.com/v2`，请求头需 `Accept: application/json` + 浏览器 UA + `Referer/Origin: https://wx.zsxq.com/` + `Cookie`（**web 版接口无需签名**；带 MD5 签名的 `/v1/*` 是 App 端接口，本项目不涉及）。
- 扫码登录用 `playwright-core`（`channel: 'chrome'`，使用系统 Chrome，不下载 Chromium），无头关闭、窗口可见以便扫码。
- 结构：`src/zsxq/client.ts`（API 客户端）/ `login.ts`（扫码登录）/ `store.ts`（凭据 0600）/ `routes.ts`（`/api/dsh-zsxq/*`，loopback-only）/ `client/`（设置面板）。

## 开发

```bash
pnpm install        # 干净安装（勿复制其他插件的 node_modules）
pnpm typecheck
pnpm build          # tsc 声明 + tsdown（lib/index.js + lib/client.js）
pnpm test           # smoke 测试（fake fetch，无网络）
```

## License

MIT
