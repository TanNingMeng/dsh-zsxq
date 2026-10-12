#!/usr/bin/env node
/**
 * zsxq-crawler — 知识星球只读内容爬取（TanNingMeng/dsh-zsxq fork 配套工具）
 *
 * 原则：只读（绝不调用发布/评论/点赞接口）、低频节流、断点续爬、输出 Obsidian 兼容 Markdown。
 *
 * 用法示例：
 *   node tools/crawler.js --group 48418884588288 --scope digests --out zsxq-vault/
 *   node tools/crawler.js --all-groups --author owner --out zsxq-vault/          # 只看球主发言
 *   node tools/crawler.js --group 48418884588288 --author admin --likes 10 --out zsxq-vault/
 *   node tools/crawler.js --group 48418884588288 --tab 球友必看 --out zsxq-vault/   # 按球内 tab（话题标签）抓
 *
 * 参数：
 *   --group <id>        指定星球（可多次传入）
 *   --all-groups        爬取已加入的全部星球
 *   --scope <s>         digests（默认）= 精华 | all = 全部 | questions = 问答 | by_owner = 只看星主 | tasks = 作业（与 --tab 互斥，--tab 优先）
 *   --tab <name|id>     话题标签 tab（如 球友必看、面试、Java 或 hashtag_id，可逗号分隔多个）
 *   --author <a>        owner = 只看球主 | admin = 球主+管理员 | all（默认）= 不过滤
 *   --likes <n>         只收点赞数 ≥ n 的主题
 *   --keywords <list>   逗号分隔词表，命中标题/正文才收录（不传则不过滤）
 *   --comments <n>      每篇附带前 n 条评论（默认 0 = 不带）
 *   --max-pages <n>     每星球每 scope 最多翻页数（默认 50，安全阀）
 *   --interval <sec>    请求间隔秒数（默认 15）
 *   --out <dir>         输出根目录（默认 ./zsxq-vault）
 *   --limit <n>         每星球最多收录主题数（调试用，默认无限）
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ---------- 精简只读客户端（逻辑与 lib/index.js 修好的 ZsxqClient 一致） ----------
const API_BASE = "https://api.zsxq.com/v2";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

class ZsxqError extends Error {
  constructor(message, status, apiCode) {
    super(message);
    this.status = status;
    this.apiCode = apiCode;
  }
}

function loadCookie() {
  const file = process.env.DSH_ZSXQ_CONFIG || path.join(os.homedir(), ".dsh", "dsh-zsxq.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!record.cookie || !record.cookie.includes("zsxq_access_token=")) {
    throw new Error(`未找到有效登录 Cookie（${file}），请先在 DSH 中完成知识星球登录`);
  }
  return record.cookie;
}

class ZsxqClient {
  constructor(cookie) {
    this.cookie = cookie;
  }
  async request(method, apiPath, query, body) {
    const url = new URL(API_BASE + apiPath);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      }
    }
    const headers = {
      Accept: "application/json",
      "User-Agent": BROWSER_UA,
      Referer: "https://wx.zsxq.com/",
      Origin: "https://wx.zsxq.com",
      Cookie: this.cookie,
      ...(body !== undefined ? { "Content-Type": "application/json;charset=UTF-8" } : {})
    };
    const resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000)
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new ZsxqError(`知识星球返回 ${resp.status}（Cookie 无效或已过期，请重新登录）`, resp.status);
    }
    let json;
    try {
      // topic_id/user_id 等为 16 位长整数，超出 JS Number 安全精度，先文本级转字符串再 parse
      const raw = (await resp.text())
        .replace(/("(?:topic_id|topic_uid|user_id|group_id|owner_id)"\s*:\s*)(\d{15,})/g, '$1"$2"')
        .replace(/("(?:admin_ids|guest_ids)"\s*:\s*\[)([^\]]*?)(\])/g, (_, head, ids, tail) =>
          head + ids.replace(/(\d{15,})/g, '"$1"') + tail
        );
      json = JSON.parse(raw);
    } catch {
      throw new ZsxqError(`知识星球返回非 JSON（HTTP ${resp.status}），疑似风控或接口变更`, resp.status);
    }
    if (!json.succeeded) {
      throw new ZsxqError(
        `知识星球接口失败: ${json.resp_err?.msg ?? `succeeded=false（code=${json.resp_err?.code ?? "?"}）`}`,
        resp.status,
        json.resp_err?.code
      );
    }
    return json.resp_data;
  }
  // ---- 只读封装 ----
  listGroups() {
    return this.request("GET", "/groups", { scope: "joined" }).then((d) => d.groups ?? []);
  }
  groupDetail(groupId) {
    return this.request("GET", `/groups/${groupId}`);
  }
  /** scope 对外沿用 digested 语义，内部映射官方的 digests。分页游标为 ISO create_time（闭区间，需按 topic_id 去重）。 */
  listTopics(groupId, scope, count = 20, endTime) {
    return this.request("GET", `/groups/${groupId}/topics`, {
      scope: scope === "digested" || scope === "digests" ? "digests" : scope,
      count,
      end_time: endTime ?? ""
    });
  }
  /** 话题标签（球内 tab，如 #球友必看#）列表。 */
  listHashtags(groupId) {
    return this.request("GET", `/groups/${groupId}/hashtags`).then((d) => d.hashtags ?? []);
  }
  /** 某话题标签下的主题列表。分页规则同 listTopics：ISO create_time 游标、闭区间需去重，无 next_end_time。 */
  listHashtagTopics(hashtagId, count = 20, endTime) {
    return this.request("GET", `/hashtags/${hashtagId}/topics`, {
      count,
      end_time: endTime ?? ""
    });
  }
  listComments(topicId, count = 20) {
    return this.request("GET", `/topics/${topicId}/comments`, { count });
  }
}

// ---------- 节流 + 指数退避 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RateLimiter {
  constructor(intervalSec) {
    this.intervalMs = Math.max(1, intervalSec) * 1000;
    this.last = 0;
  }
  async wait() {
    const now = Date.now();
    const delta = now - this.last;
    if (delta < this.intervalMs) await sleep(this.intervalMs - delta);
    this.last = Date.now();
  }
}

/** 带退避的请求：1min → 5min → 30min，连续 3 次失败抛出。 */
async function requestWithBackoff(client, fn, label) {
  const backoffs = [60_000, 300_000, 1_800_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ZsxqError && (err.status === 401 || err.status === 403)) throw err; // 登录失效，立即终止
      if (attempt >= backoffs.length) throw new Error(`[${label}] 连续 ${attempt + 1} 次失败，终止：${err.message}`);
      console.warn(`[${label}] 失败（${err.message}），${backoffs[attempt] / 1000}s 后重试...`);
      await sleep(backoffs[attempt]);
    }
  }
}

// ---------- 工具函数 ----------
function parseArgs(argv) {
  const args = {
    groups: [],
    allGroups: false,
    scope: "digests",
    tabs: [],
    author: "all",
    likes: 0,
    keywords: [],
    comments: 0,
    maxPages: 50,
    intervalSec: 15,
    out: "./zsxq-vault",
    limit: 0
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--group") args.groups.push(String(argv[++i]));
    else if (a === "--all-groups") args.allGroups = true;
    else if (a === "--scope") args.scope = argv[++i];
    else if (a === "--tab") args.tabs.push(...String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--author") args.author = argv[++i];
    else if (a === "--likes") args.likes = Number(argv[++i]) || 0;
    else if (a === "--keywords") args.keywords = String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--comments") args.comments = Number(argv[++i]) || 0;
    else if (a === "--max-pages") args.maxPages = Number(argv[++i]) || 50;
    else if (a === "--interval") args.intervalSec = Number(argv[++i]) || 15;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]) || 0;
    else throw new Error(`未知参数：${a}`);
  }
  if (!args.allGroups && args.groups.length === 0) throw new Error("请指定 --group <id> 或 --all-groups");
  if (args.tabs.length === 0 && !["digests", "digested", "all", "questions", "by_owner", "tasks"].includes(args.scope))
    throw new Error(`--scope 仅支持 digests|all|questions(问答)|by_owner(只看星主)|tasks(作业)，收到 ${args.scope}`);
  if (!["owner", "admin", "all"].includes(args.author)) throw new Error(`--author 仅支持 owner|admin|all，收到 ${args.author}`);
  return args;
}

function textOf(topic) {
  const t = topic.talk ?? topic.question ?? topic.answer ?? {};
  return String(t.text ?? "");
}
/** q&a 主题的回答者（无则 null）。 */
function answerOf(topic) {
  return topic.answer ?? null;
}
function authorOf(topic) {
  const t = topic.talk ?? topic.question ?? topic.answer ?? {};
  return t.owner ?? {};
}
/** 标题：API 的 title 字段是约 40 字预览串（自带 "..."），优先用正文首行还原完整标题。 */
function titleOf(topic) {
  const plain = textOf(topic)
    .replace(/<e[^>]*>/g, "")
    .replace(/<\/e>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const raw = String(topic.title ?? "").trim();
  const firstLine = plain.slice(0, 60);
  // title 被官方截断（以 .../… 结尾）且正文更长时，用正文首行作为标题
  if (raw && !/[…]{1,3}$|\.\.\.?$/.test(raw)) return raw;
  return firstLine || raw || "无标题";
}
/** 实体还原 + 图片附加（对任意 text 字段复用）。 */
function renderRich(topic, text, images) {
  // hashtag/web/link 实体还原为可读形式
  text = String(text ?? "").replace(/<e type="hashtag"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<\/e>/g, (_, t) => `#${decodeURIComponent(t)}#`);
  text = text.replace(/<e type="web"[^>]*href="([^"]*)"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<\/e>/g, (_, href, title) => {
    const url = decodeURIComponent(href);
    const name = decodeURIComponent(title || url);
    return `[${name}](${url})`;
  });
  text = text.replace(/<\/?e[^>]*>/g, "");
  for (const u of (images ?? []).map((img) => img.large?.url ?? img.thumbnail?.url ?? "").filter(Boolean)) {
    text += `\n\n![图片](${u})`;
  }
  return text.trim();
}
/** 完整正文。q&a 类型渲染「提问者的问题 + 回答者的回答」两段，缺一不可。 */
function renderText(topic) {
  if (topic.type === "q&a" || (topic.question && topic.answer)) {
    const q = topic.question ?? {};
    const a = topic.answer ?? null;
    let out = `**提问**（${q.owner?.name ?? "匿名"}）：\n\n` + renderRich(topic, q.text, q.images ?? topic.question?.images);
    if (a) {
      out += `\n\n---\n\n**回答**（${a.owner?.name ?? "匿名"}）：\n\n` + renderRich(topic, a.text, a.images);
    } else {
      out += `\n\n---\n\n*（该问题暂无回答）*`;
    }
    return out;
  }
  const t = topic.talk ?? topic.question ?? topic.answer ?? {};
  return renderRich(topic, t.text, topic.talk?.images);
}
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|&]/g, " ").replace(/\s+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "");
}
function esc(s) {
  return String(s ?? "").replace(/"/g, '\\"');
}

// ---------- state.json ----------
function stateFile(outDir) {
  return path.join(outDir, "_meta", "state.json");
}
function loadState(outDir) {
  const f = stateFile(outDir);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  return { groups: {}, topics: {} };
}
function saveState(outDir, state) {
  fs.mkdirSync(path.dirname(stateFile(outDir)), { recursive: true });
  fs.writeFileSync(stateFile(outDir), JSON.stringify(state, null, 2));
}

// ---------- Markdown 渲染 ----------
function renderTopicMd(topic, meta, comments) {
  const author = authorOf(topic);
  const created = topic.create_time ?? "";
  const isOwner = meta && author.user_id === meta.ownerId;
  const isAdmin = meta && (meta.adminIds ?? []).includes(author.user_id);
  const lines = [
    "---",
    `topic_id: ${topic.topic_id}`,
    `group: "${esc(meta?.groupName ?? topic.group?.name ?? "")}"`,
    `author: "${esc(author.name ?? "匿名")}"`,
    `author_id: ${author.user_id ?? ""}`,
    `is_owner: ${isOwner}`,
    `is_admin: ${isAdmin}`,
    `created: ${created}`,
    `likes: ${topic.likes_count ?? 0}`,
    `comments: ${topic.comments_count ?? 0}`,
    `digested: ${!!topic.digested}`,
    `clawed_at: ${new Date().toISOString()}`
  ];
  if (meta?.tab) lines.push(`tab: "${esc(meta.tab)}"`);
  const ans = answerOf(topic);
  if (ans) {
    lines.push(`answered: ${ans.create_time ?? ""}`);
    lines.push(`answered_by: "${esc(ans.owner?.name ?? "匿名")}"`);
    lines.push(`answered_by_id: ${ans.owner?.user_id ?? ""}`);
    if (meta) lines.push(`answered_by_is_owner: ${ans.owner?.user_id === meta.ownerId}`);
  }
  if (meta?.keywords?.length) lines.push(`tags: [${meta.keywords.map((k) => esc(k)).join(", ")}]`);
  lines.push("---", "", `# ${titleOf(topic)}`, "", renderText(topic), "");
  if (comments && comments.length > 0) {
    lines.push(`## 评论（${comments.length} 条）`, "");
    for (const c of comments) {
      const cm = c.comment ?? c;
      const who = cm.owner?.name ?? "匿名";
      const ctext = String(cm.text ?? "").replace(/\s+/g, " ").slice(0, 500);
      lines.push(`- **${who}**：${ctext}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- 单星球爬取 ----------
async function crawlGroup(client, limiter, group, args, state, stats) {
  const gid = String(group.group_id);
  const groupName = group.name ?? gid;
  const label = groupName;
  const gState = (state.groups[gid] ??= {
    name: groupName,
    cursors: {},
    seen_topic_ids: [],
    last_run: null,
    failures: 0
  });

  // L5：球主/管理员信息（1 次请求）
  let ownerId = null;
  let adminIds = [];
  if (args.author !== "all") {
    await limiter.wait();
    const detail = await requestWithBackoff(client, () => client.groupDetail(gid), `${label}/detail`);
    ownerId = detail.group?.owner?.user_id ?? null;
    adminIds = detail.group?.admin_ids ?? [];
    if (args.author === "owner" && !ownerId) {
      console.warn(`[${label}] 未拿到球主信息，跳过 author 过滤`);
    }
  }

  // 解析 --tab：名称（模糊匹配，忽略#）或直接给 ID。tab 模式下忽略 --scope。
  let channels = [];
  if (args.tabs.length > 0) {
    await limiter.wait();
    const hashtags = await requestWithBackoff(client, () => client.listHashtags(gid), `${label}/hashtags`);
    for (const tab of args.tabs) {
      const hit = hashtags.find((h) => String(h.hashtag_id) === tab)
        ?? hashtags.find((h) => String(h.title ?? "").replace(/^#|##$/g, "") === tab.replace(/^#|##$/g, ""))
        ?? hashtags.find((h) => String(h.title ?? "").includes(tab.replace(/^#|##$/g, "")));
      if (!hit) {
        console.warn(`[${label}] 找不到 tab「${tab}」，可用：${hashtags.map((h) => h.title).join("、")}`);
        continue;
      }
      channels.push({ cursorKey: `tab:${hit.hashtag_id}`, scopeLabel: `tab:${hit.title}`, tabTitle: hit.title, fetcher: (cursor) => client.listHashtagTopics(String(hit.hashtag_id), 20, cursor) });
    }
    if (channels.length === 0) throw new Error(`[${label}] 没有任何可用的 tab`);
  } else {
    const scope = args.scope;
    channels = [{ cursorKey: scope === "all" ? "all" : scope === "digested" ? "digests" : scope, scopeLabel: scope, tabTitle: null, fetcher: (cursor) => client.listTopics(gid, scope, 20, cursor) }];
  }

  const seen = new Set(gState.seen_topic_ids);
  let collected = 0;
  for (const ch of channels) {
  const cursorKey = ch.cursorKey;
  const scope = ch.scopeLabel;
  let cursor = gState.cursors[cursorKey] ?? "";

  for (let page = 0; page < args.maxPages; page++) {
    await limiter.wait();
    let data;
    try {
      data = await requestWithBackoff(client, () => ch.fetcher(cursor), `${label}/${scope}#${page}`);
      gState.failures = 0;
    } catch (err) {
      gState.failures++;
      saveState(outDirSafe, state);
      throw err;
    }
    const topics = data.topics ?? [];
    if (topics.length === 0) break;

    let newCount = 0;
    for (const topic of topics) {
      const tid = String(topic.topic_id);
      if (cursor && tid === String(state.groups[gid]?.[`last_${cursorKey}_id`])) continue; // 闭区间重叠条
      if (seen.has(tid)) continue;
      seen.add(tid);
      newCount++;

      // ---- 过滤链：作者 → 点赞 → 关键词 ----
      const author = authorOf(topic);
      if (args.author === "owner" && ownerId && author.user_id !== ownerId) continue;
      if (args.author === "admin" && ownerId && adminIds.length >= 0) {
        const inAdmin = author.user_id === ownerId || adminIds.includes(author.user_id);
        if (!inAdmin) continue;
      }
      if (args.likes > 0 && (topic.likes_count ?? 0) < args.likes) continue;
      const hitKeywords = args.keywords.filter(
        (k) => titleOf(topic).includes(k) || textOf(topic).includes(k)
      );
      if (args.keywords.length > 0 && hitKeywords.length === 0) continue;

      // ---- 评论（可选，1 次请求/篇）----
      let comments = [];
      if (args.comments > 0 && (topic.comments_count ?? 0) > 0) {
        await limiter.wait();
        try {
          const cd = await requestWithBackoff(client, () => client.listComments(tid, args.comments), `${label}/comments/${tid}`);
          comments = (cd.comments ?? []).slice(0, args.comments);
        } catch (err) {
          console.warn(`[${label}] 评论获取失败 ${tid}: ${err.message}`);
        }
      }

      // ---- 落盘 ----
      const month = (topic.create_time ?? "").slice(0, 7) || "unknown";
      const dir = path.join(outDirSafe, sanitizeFilename(groupName), month);
      fs.mkdirSync(dir, { recursive: true });
      const fileBase = `${(topic.create_time ?? "").slice(0, 10)}-${sanitizeFilename(titleOf(topic))}-${tid}`;
      const file = path.join(dir, `${fileBase}.md`);
      const md = renderTopicMd(
        topic,
        { groupName, ownerId, adminIds, keywords: hitKeywords, tab: ch.tabTitle },
        comments
      );
      fs.writeFileSync(file, md, "utf8");

      state.topics[tid] = { file: path.relative(outDirSafe, file), likes_last: topic.likes_count ?? 0, updated: new Date().toISOString() };
      collected++;
      if (args.limit > 0 && collected >= args.limit) break;
    }

    // 翻页游标：最后一条的 create_time（闭区间会重复，靠 last_id 跳过）
    const last = topics[topics.length - 1];
    cursor = last.create_time ?? "";
    state.groups[gid][`last_${cursorKey}_id`] = String(last.topic_id);

    const anyNew = newCount > 0;
    if (args.limit > 0 && collected >= args.limit) break;
    if (!anyNew && page > 0 && scope === "digests") {
      // 精华列表翻到重复页即认为到底（增量场景）
      // 注意：首次全量时第一页全是新内容，不影响
    }
    if (!anyNew) break; // 追到已见内容，增量完成
  }

  gState.cursors[cursorKey] = cursor;
  gState.seen_topic_ids = [...seen].slice(-50000);
  gState.last_run = new Date().toISOString();
  stats[`[${label}] 收录 ${collected} 篇`] = true;
  console.log(`[${label}] ✔ 收录 ${collected} 篇（scope=${scope}, author=${args.author}）`);
  } // end channels
}

// ---------- 主流程 ----------
let outDirSafe = "./zsxq-vault";

async function main() {
  const args = parseArgs(process.argv);
  outDirSafe = path.resolve(args.out);
  fs.mkdirSync(outDirSafe, { recursive: true });

  const client = new ZsxqClient(loadCookie());
  const limiter = new RateLimiter(args.intervalSec);
  const state = loadState(outDirSafe);
  const stats = {};

  let groups;
  if (args.allGroups) {
    await limiter.wait();
    groups = await requestWithBackoff(client, () => client.listGroups(), "groups");
    console.log(`已加入星球 ${groups.length} 个`);
  } else {
    groups = args.groups.map((id) => ({ group_id: id, name: id }));
  }

  for (const group of groups) {
    try {
      await crawlGroup(client, limiter, group, args, state, stats);
    } catch (err) {
      console.error(`[${group.name ?? group.group_id}] ✘ ${err.message}`);
      stats[`[${group.name ?? group.group_id}] 失败：${err.message}`] = true;
    }
    saveState(outDirSafe, state);
  }

  saveState(outDirSafe, state);
  const total = Object.keys(state.topics).length;
  console.log(`\n完成。本次结果：${Object.keys(stats).join("；") || "无"}`);
  console.log(`知识库累计主题：${total}，输出目录：${outDirSafe}`);
}

main().catch((err) => {
  console.error("致命错误:", err.message);
  process.exit(1);
});
