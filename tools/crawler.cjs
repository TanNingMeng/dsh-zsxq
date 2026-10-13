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
 *   node tools/crawler.js --group 88882228552542 --columns --files --out zsxq-vault/ # 右下角【专栏】+【星球文件】
 *   node tools/crawler.js --localize --out zsxq-vault/          # 离线补漏：把库内仍指向 CDN 的图片下载到本地
 *
 * 参数：
 *   --group <id>        指定星球（可多次传入）
 *   --all-groups        爬取已加入的全部星球
 *   --scope <s>         digests（默认）= 精华 | all = 全部 | questions = 问答 | by_owner = 只看星主 | tasks = 作业（与 --tab 互斥，--tab 优先）
 *   --tab <name|id>     话题标签 tab（如 球友必看、面试、Java 或 hashtag_id，可逗号分隔多个）
 *   --columns           抓右下角【专栏】全部文章（与 --scope/--tab 独立，可同时用）
 *   --files             建右下角【星球文件】索引清单（下载有权限限制，仅元数据+来源主题）
 *   --author <a>        owner = 只看球主 | admin = 球主+管理员 | all（默认）= 不过滤
 *   --likes <n>         只收点赞数 ≥ n 的主题
 *   --keywords <list>   逗号分隔词表，命中标题/正文才收录（不传则不过滤）
 *   --comments <n>      每篇附带前 n 条评论（默认 0 = 不带）
 *   --images / --no-images  图片本地化（默认开）：正文/文章图片下载到 <星球>/attachments/，Markdown 改写为相对链接
 *   --localize          只做图片本地化补漏（扫描已有 md，不发 API 请求；可配 --group 过滤星球目录名）
 *   （自动）每次爬取会把星球简介落盘为 <星球>/星球简介.md；front-matter 含 reading/readers 阅读数字段
 *   --deep              深挖模式：无视"整页已见"继续向历史翻页（新渠道首次全量补史必开；靠空页或 --max-pages 终止）
 *   --no-official      禁用官方 MCP 通道（zsxq-cli）：默认启用时元数据/评论/标签走官方免风控接口
 *   --max-pages <n>     每星球每 scope 最多翻页数（默认 50，安全阀）
 *   --interval <sec>    请求间隔秒数（默认 15）
 *   --out <dir>         输出根目录（默认 ./zsxq-vault）
 *   --limit <n>         每星球最多收录主题数（调试用，默认无限）
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

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

// ---------- 官方 MCP 通道（zsxq-cli，OAuth 登录后免风控；仅覆盖未被星球级门禁的端点） ----------
const ZSXQ_CLI_JS = process.env.ZSXQ_CLI_JS
  ?? path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "zsxq-cli", "npm", "scripts", "zsxq-cli.js");
let officialEnabled = true; // --no-official 可关
function officialCliReady() {
  return officialEnabled && fs.existsSync(ZSXQ_CLI_JS);
}
/** 调 zsxq-cli 的 MCP 工具，返回解析后的 JSON（{ok,success,...}）。 */
function officialApi(tool, params) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [ZSXQ_CLI_JS, "api", "call", tool, "--params", JSON.stringify(params)], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const out = String(stdout ?? "");
      if (!out && err) return reject(new ZsxqError(`官方通道 ${tool} 失败: ${String(err.message).slice(0, 120)}`, 0));
      let j;
      try {
        j = JSON.parse(out);
      } catch {
        return reject(new ZsxqError(`官方通道 ${tool} 返回非 JSON`, 0));
      }
      if (j.ok === false || j.success === false) {
        return reject(new ZsxqError(`官方通道 ${tool}: ${j.error?.message ?? "未知错误"}`, 0));
      }
      resolve(j);
    });
  });
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
    if (officialCliReady()) {
      return officialApi("call_zsxq_api", { method: "GET", path: `/v2/groups/${groupId}` })
        .then((j) => {
          if (j.body?.succeeded) return j.body.resp_data;
          throw new ZsxqError(`官方通道群详情失败: ${j.body?.resp_err?.msg ?? "?"}`, 0);
        })
        .catch((err) => {
          console.warn(`[官方] 群详情回退 cookie 直连: ${err.message}`);
          return this.request("GET", `/groups/${groupId}`);
        });
    }
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
  /** 话题标签（球内 tab，如 #球友必看#）列表。官方通道优先。 */
  listHashtags(groupId) {
    if (officialCliReady()) {
      return officialApi("get_group_hashtags", { group_id: String(groupId) })
        .then((j) => j.hashtags ?? [])
        .catch((err) => {
          console.warn(`[官方] 标签列表回退 cookie 直连: ${err.message}`);
          return this.request("GET", `/groups/${groupId}/hashtags`).then((d) => d.hashtags ?? []);
        });
    }
    return this.request("GET", `/groups/${groupId}/hashtags`).then((d) => d.hashtags ?? []);
  }
  /** 某话题标签下的主题列表。分页规则同 listTopics：ISO create_time 游标、闭区间需去重，无 next_end_time。 */
  listHashtagTopics(hashtagId, count = 20, endTime) {
    return this.request("GET", `/hashtags/${hashtagId}/topics`, {
      count,
      end_time: endTime ?? ""
    });
  }
  /** 主题详情（专栏文章的全文要靠它拿，列表/专栏接口只有 ~60 字预览）。 */
  getTopic(topicId) {
    return this.request("GET", `/topics/${topicId}`).then((d) => d.topic ?? {});
  }
  /** 评论列表：官方 MCP 免风控优先（扁平结构，渲染层 c.comment ?? c 兼容），失败回退 cookie 直连。 */
  listComments(topicId, count = 20) {
    if (officialCliReady()) {
      return officialApi("get_topic_comments", { topic_id: String(topicId), limit: count })
        .then((j) => ({ comments: j.comments ?? [] }))
        .catch((err) => {
          console.warn(`[官方] 评论回退 cookie 直连: ${err.message}`);
          return this.request("GET", `/topics/${topicId}/comments`, { count });
        });
    }
    return this.request("GET", `/topics/${topicId}/comments`, { count });
  }
  /** 专栏列表（右下角【专栏】）。官方通道优先。 */
  listColumns(groupId) {
    if (officialCliReady()) {
      return officialApi("call_zsxq_api", { method: "GET", path: `/v2/groups/${groupId}/columns` })
        .then((j) => {
          if (j.body?.succeeded) return j.body.resp_data.columns ?? [];
          throw new ZsxqError(`官方通道专栏列表失败: ${j.body?.resp_err?.msg ?? "?"}`, 0);
        })
        .catch((err) => {
          console.warn(`[官方] 专栏列表回退 cookie 直连: ${err.message}`);
          return this.request("GET", `/groups/${groupId}/columns`).then((d) => d.columns ?? []);
        });
    }
    return this.request("GET", `/groups/${groupId}/columns`).then((d) => d.columns ?? []);
  }
  /** 专栏文章列表。轻量结构 {topic_id,title,text,create_time}，index 为偏移分页。 */
  listColumnTopics(groupId, columnId, count = 20, index = 0) {
    return this.request("GET", `/groups/${groupId}/columns/${columnId}/topics`, { count, index });
  }
  /** 星球文件列表（右下角【星球文件】）。index 为偏移分页，元素为 {file:{name,size,...}, topic:{topic_id,...}}。 */
  listFiles(groupId, count = 20, index = 0) {
    return this.request("GET", `/groups/${groupId}/files`, { count, index });
  }
  /** 抓取专栏长文全文页（articles.zsxq.com 的 SSR HTML，必须带 Cookie，否则返回空壳）。 */
  async getArticleHtml(url) {
    const resp = await fetch(url, {
      headers: {
        Cookie: this.cookie,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36",
        Referer: "https://wx.zsxq.com/"
      },
      signal: AbortSignal.timeout(3e4)
    });
    if (!resp.ok) throw new ZsxqError(`文章页返回 HTTP ${resp.status}`, resp.status);
    return resp.text();
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
    columns: false,
    files: false,
    author: "all",
    likes: 0,
    keywords: [],
    comments: 0,
    images: true,
    official: true,
    localize: false,
    deep: false,
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
    else if (a === "--columns") args.columns = true;
    else if (a === "--files") args.files = true;
    else if (a === "--author") args.author = argv[++i];
    else if (a === "--likes") args.likes = Number(argv[++i]) || 0;
    else if (a === "--keywords") args.keywords = String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--comments") args.comments = Number(argv[++i]) || 0;
    else if (a === "--images") args.images = true;
    else if (a === "--no-images") args.images = false;
    else if (a === "--localize") args.localize = true;
    else if (a === "--no-official") args.official = false;
    else if (a === "--deep") args.deep = true;
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
// ---------- 专栏长文 HTML → Markdown ----------
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
/** 轻量 HTML→Markdown：覆盖 quill 编辑器的 p/strong/em/ul/ol/li/img/a/hr/br。 */
function htmlToMd(html) {
  let s = String(html);
  // 图片与链接先保护起来
  const imgs = [];
  s = s.replace(/<img[^>]*src="([^"]*)"[^>]*>/g, (_, src) => `\u0000IMG${imgs.push(decodeEntities(src)) - 1}\u0000`);
  const links = [];
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `\u0000A${links.push([decodeEntities(href), text]) - 1}\u0000`);
  // 结构转换
  s = s.replace(/<(strong|b)>[\s\S]*?<\/\1>/gi, (m) => `**${m.replace(/<[^>]*>/g, "")}**`);
  s = s.replace(/<(em|i)>[\s\S]*?<\/\1>/gi, (m) => `*${m.replace(/<[^>]*>/g, "")}*`);
  s = s.replace(/<hr[^>]*>/gi, "\n\n---\n\n");
  s = s.replace(/<li[^>]*>[\s\S]*?<\/li>/gi, (m) => "\n- " + m.replace(/<[^>]*>/g, "").trim());
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, "\n");
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n\n## ${t.replace(/<[^>]*>/g, "").trim()}\n`);
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n\n### ${t.replace(/<[^>]*>/g, "").trim()}\n`);
  s = s.replace(/<p[^>]*>/gi, "\n\n").replace(/<\/p>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // 还原链接/图片
  s = s.replace(/\u0000A(\d+)\u0000/g, (_, i) => { const [href, text] = links[Number(i)]; return `[${text.replace(/<[^>]*>/g, "").trim() || href}](${href})`; });
  s = s.replace(/\u0000IMG(\d+)\u0000/g, (_, i) => `\n\n![图片](${imgs[Number(i)]})\n\n`);
  // 清掉残余标签
  s = s.replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
/** 从文章页 HTML 提取正文 div（content ql-editor / milkdown / tiptap 兜底）。 */
function extractArticleBody(html) {
  const start = html.search(/<div class="content[^"]*ql-editor[^"]*"/);
  if (start >= 0) {
    const rest = html.slice(start);
    const end = rest.search(/<div class="(milkdown-preview|tiptap-preview|risk_warning_tips)"/);
    return rest.slice(rest.indexOf(">") + 1, end > 0 ? end : undefined);
  }
  const m2 = html.match(/<div class="milkdown-preview"[^>]*>([\s\S]*?)<\/div>/);
  if (m2) return m2[1];
  return null;
}

// ---------- 图片本地化 ----------
let COOKIE = "";
const IMG_CDN_RE = /\.zsxq\.com\//;
const MD_IMG_RE = /(!\[[^\]]*\]\()\s*(https?:\/\/[^\s)]+)\s*(\))/g;
const EXT_BY_CT = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp", "image/svg+xml": ".svg" };
const imgCache = new Map(); // "attachmentsDir\u0000url" → 绝对路径 | null（失败）
const imgStats = { downloaded: 0, cached: 0, failed: 0, bytes: 0 };

/** 下载单张图片到 attachmentsDir，文件名为 URL 的 sha1 前 20 位（同名已存在直接复用）。失败返回 null。 */
async function downloadImage(url, attachmentsDir) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { Cookie: COOKIE, "User-Agent": BROWSER_UA, Referer: "https://wx.zsxq.com/" },
        signal: AbortSignal.timeout(30_000)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const ct = (resp.headers.get("content-type") ?? "").split(";")[0].trim();
      const buf = Buffer.from(await resp.arrayBuffer());
      if (!ct.startsWith("image/") || buf.length < 500) throw new Error(`非图片响应（${ct || "unknown"}, ${buf.length}B）`);
      const file = path.join(attachmentsDir, crypto.createHash("sha1").update(url).digest("hex").slice(0, 20) + (EXT_BY_CT[ct] ?? ".jpg"));
      if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
      return file;
    } catch (err) {
      if (attempt === 1) {
        console.warn(`[图片] 下载失败 ${url} → ${err.message}`);
        return null;
      }
      await sleep(3_000);
    }
  }
  return null;
}

/** 把 Markdown 里指向 zsxq CDN 的图片下载到 attachmentsDir 并改写为相对链接（mdDir 为该 md 所在目录）。 */
async function localizeImagesInMd(md, mdDir, attachmentsDir) {
  const urls = [...new Set([...md.matchAll(MD_IMG_RE)].map((m) => m[2]).filter((u) => IMG_CDN_RE.test(u)))];
  if (urls.length === 0) return md;
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const resolved = new Map();
  for (const u of urls) {
    const key = attachmentsDir + "\u0000" + u;
    if (!imgCache.has(key)) {
      const file = await downloadImage(u, attachmentsDir);
      imgCache.set(key, file);
      if (file) {
        imgStats.downloaded++;
        imgStats.bytes += fs.statSync(file).size;
      } else imgStats.failed++;
      await sleep(300); // 图片 CDN 温和节流
    } else if (imgCache.get(key)) {
      imgStats.cached++;
    }
    const f = imgCache.get(key);
    if (f) resolved.set(u, f);
  }
  if (resolved.size === 0) return md;
  return md.replace(MD_IMG_RE, (whole, pre, url, post) => {
    const f = resolved.get(url);
    if (!f) return whole;
    return pre + path.relative(mdDir, f).split(path.sep).join("/") + post;
  });
}

/** --localize 补漏模式：扫描库内全部 Markdown（可按 --group 过滤星球目录名），把远程图片补下载到本地。纯本地 + 图片 CDN，不发 API 请求。 */
async function localizeVault(outDir, groupFilter) {
  const skipDirs = new Set(["_meta", "attachments"]);
  function walk(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) out.push(...walk(p));
      } else if (e.name.endsWith(".md")) out.push(p);
    }
    return out;
  }
  const files = walk(outDir).filter((f) => {
    if (groupFilter.length === 0) return true;
    return groupFilter.includes(path.relative(outDir, f).split(path.sep)[0]);
  });
  console.log(`[localize] 待扫描 ${files.length} 个 md 文件...`);
  let changed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const groupDir = path.join(outDir, path.relative(outDir, f).split(path.sep)[0]);
    const md = fs.readFileSync(f, "utf8");
    const next = await localizeImagesInMd(md, path.dirname(f), path.join(groupDir, "attachments"));
    if (next !== md) {
      fs.writeFileSync(f, next, "utf8");
      changed++;
    }
    if ((i + 1) % 50 === 0) console.log(`[localize] 进度 ${i + 1}/${files.length}（改写 ${changed}，下载 ${imgStats.downloaded}，失败 ${imgStats.failed}）`);
  }
  console.log(`[localize] 完成：扫描 ${files.length} 个 md，改写 ${changed} 个；新下载 ${imgStats.downloaded} 张（${(imgStats.bytes / 1048576).toFixed(1)} MB），缓存复用 ${imgStats.cached} 次，失败 ${imgStats.failed} 张。`);
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
    `reading: ${topic.reading_count ?? 0}`,
    `readers: ${topic.readers_count ?? 0}`,
    `digested: ${!!topic.digested}`,
    `clawed_at: ${new Date().toISOString()}`
  ];
  if (meta?.tab) lines.push(`tab: "${esc(meta.tab)}"`);
  if (meta?.fullText !== undefined && topic.talk?.article?.article_url) lines.push(`article_url: "${esc(topic.talk.article.article_url)}"`);
  const ans = answerOf(topic);
  if (ans) {
    lines.push(`answered: ${ans.create_time ?? ""}`);
    lines.push(`answered_by: "${esc(ans.owner?.name ?? "匿名")}"`);
    lines.push(`answered_by_id: ${ans.owner?.user_id ?? ""}`);
    if (meta) lines.push(`answered_by_is_owner: ${ans.owner?.user_id === meta.ownerId}`);
  }
  if (meta?.keywords?.length) lines.push(`tags: [${meta.keywords.map((k) => esc(k)).join(", ")}]`);
  lines.push("---", "", `# ${titleOf(topic)}`, "", meta?.fullText !== undefined ? meta.fullText : renderText(topic), "");
  if (comments && comments.length > 0) {
    lines.push(`## 评论（${comments.length} 条）`, "");
    for (const c of comments) {
      const cm = c.comment ?? c;
      const who = cm.owner?.name ?? "匿名";
      const ctext = String(cm.text ?? "").replace(/\s+/g, " ").slice(0, 500);
      lines.push(`- **${who}**：${ctext}`);
      for (const rc of cm.replied_comments ?? []) {
        const rtext = String(rc.text ?? "").replace(/\s+/g, " ").slice(0, 300);
        lines.push(`  - ↳ **${rc.owner?.name ?? "匿名"}**：${rtext}`);
      }
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

  // L5：星球详情（1 次请求）：球主/管理员信息 + 星球简介落盘
  let ownerId = null;
  let adminIds = [];
  await limiter.wait();
  const detail = await requestWithBackoff(client, () => client.groupDetail(gid), `${label}/detail`);
  const grpInfo = detail.group ?? {};
  ownerId = grpInfo.owner?.user_id ?? null;
  adminIds = grpInfo.admin_ids ?? [];
  if (args.author === "owner" && !ownerId) {
    console.warn(`[${label}] 未拿到球主信息，跳过 author 过滤`);
  }
  writeGroupIntro(outDirSafe, sanitizeFilename(groupName), grpInfo, label);

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
  let emptyStreak = 0; // 连续空页计数（软风控会返回"成功但空"的数据）

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
    if (topics.length === 0) {
      // 空页两种可能：真到底 / 软风控塞空数据。先重试一次再下结论
      emptyStreak++;
      if (emptyStreak >= 2) break;
      console.warn(`[${label}] ${scope} 第 ${page} 页为空，45s 后重试同一页（防软风控空页误判到底）`);
      await sleep(45_000);
      page--;
      continue;
    }
    emptyStreak = 0;

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
        if (!officialCliReady()) await limiter.wait(); // 官方通道不受 20s 节流约束
        try {
          const cd = await requestWithBackoff(client, () => client.listComments(tid, args.comments), `${label}/comments/${tid}`);
          comments = (cd.comments ?? []).slice(0, args.comments);
        } catch (err) {
          console.warn(`[${label}] 评论获取失败 ${tid}: ${err.message}`);
        }
      }

      // ---- 长文全文（talk.article 存在时列表 text 只是预览，需抓 SSR 文章页）----
      let fullTextOverride;
      if (topic.talk?.article?.article_url || topic.talk?.article?.inline_article_url) {
        fullTextOverride = await fetchFullArticle(client, limiter, label, tid, topic.talk, textOf(topic));
      }

      // ---- 落盘 ----
      const month = (topic.create_time ?? "").slice(0, 7) || "unknown";
      const dir = path.join(outDirSafe, sanitizeFilename(groupName), month);
      fs.mkdirSync(dir, { recursive: true });
      const fileBase = `${(topic.create_time ?? "").slice(0, 10)}-${sanitizeFilename(titleOf(topic))}-${tid}`;
      const file = path.join(dir, `${fileBase}.md`);
      let md = renderTopicMd(
        topic,
        { groupName, ownerId, adminIds, keywords: hitKeywords, tab: ch.tabTitle, fullText: fullTextOverride },
        comments
      );
      if (args.images) {
        md = await localizeImagesInMd(md, dir, path.join(outDirSafe, sanitizeFilename(groupName), "attachments"));
      }
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
    if (!anyNew && !args.deep) break; // 增量模式：追到已见内容即完成；--deep 模式无视已见继续向历史深挖（靠空页/翻页上限终止）
  }

  gState.cursors[cursorKey] = cursor;
  gState.seen_topic_ids = [...seen].slice(-50000);
  gState.last_run = new Date().toISOString();
  stats[`[${label}] 收录 ${collected} 篇`] = true;
  console.log(`[${label}] ✔ 收录 ${collected} 篇（scope=${scope}, author=${args.author}）`);
  } // end channels
}

/** 星球简介落盘：简介/资源清单、星主介绍、公告、统计。每次爬取覆盖写，幂等。 */
function writeGroupIntro(outDir, groupDirName, grp, label) {
  try {
    const stat = grp.statistics ?? {};
    const lines = [
      "---",
      `group_id: ${grp.group_id ?? ""}`,
      `name: "${esc(grp.name ?? "")}"`,
      `owner: "${esc(grp.owner?.name ?? "")}"`,
      `category: "${esc(grp.category ?? "")}"`,
      `created: ${grp.create_time ?? ""}`,
      `members: ${stat.members_count ?? grp.members_count ?? 0}`,
      `topics: ${stat.topics_count ?? grp.topics_count ?? 0}`,
      `digests: ${stat.digests_count ?? grp.digests_count ?? 0}`,
      `clawed_at: ${new Date().toISOString()}`,
      "---",
      "",
      `# ${grp.name ?? label} 星球简介`,
      ""
    ];
    const noticeText = grp.notice ? String(typeof grp.notice === "string" ? grp.notice : grp.notice.text ?? "").trim() : "";
    if (noticeText) lines.push(`## 公告`, "", noticeText, "");
    const desc = String(grp.description ?? "").trim();
    if (desc) lines.push(`## 简介 / 资源清单`, "", desc, "");
    const ownerDesc = String(grp.owner?.description ?? "").trim();
    if (ownerDesc || grp.owner?.name) {
      lines.push(`## 星主介绍`, "", `**${grp.owner?.name ?? "星主"}**${grp.owner?.alias ? `（${grp.owner.alias}）` : ""}`, "", ownerDesc || "（未填写）", "");
    }
    fs.mkdirSync(path.join(outDir, groupDirName), { recursive: true });
    fs.writeFileSync(path.join(outDir, groupDirName, "星球简介.md"), lines.join("\n"), "utf8");
  } catch (err) {
    console.warn(`[${label}] 星球简介写入失败：${err.message}`);
  }
}

/** 长文全文获取：talk.article.article_url 的 SSR 页（偶发空壳页时换 URL 重试）。返回最终正文（Markdown 或 API 文本）。 */
async function fetchFullArticle(client, limiter, label, tid, talk, fallbackText) {
  let fullText = fallbackText;
  const articleUrl = talk?.article?.article_url ?? talk?.article?.inline_article_url ?? null;
  if (!articleUrl) return fullText;
  const candidates = [...new Set([articleUrl, talk?.article?.inline_article_url, talk?.article?.article_url].filter(Boolean))];
  for (const u of candidates) {
    await limiter.wait();
    try {
      const html = await requestWithBackoff(client, () => client.getArticleHtml(u), `${label}/article:${tid}`);
      const bodyHtml = extractArticleBody(html);
      if (!bodyHtml) {
        console.warn(`[${label}] 文章页疑似空壳（${html.length}B）：${u}，换下一个 URL`);
        continue;
      }
      const md = htmlToMd(bodyHtml);
      if (md.length > fullText.replace(/<[^>]*>/g, "").length) fullText = md; // 全文优先
      break;
    } catch (err) {
      console.warn(`[${label}] 文章全文获取失败 ${tid}: ${err.message}（回退为 API 文本）`);
    }
  }
  return fullText;
}

// ---------- 专栏 / 星球文件（右下角入口） ----------
/** 爬取星球全部专栏文章为 Markdown。幂等：文件名含 topic_id，已存在则跳过；详情失败的主题记入 state 跳过，不炸全场。 */
async function crawlColumns(client, limiter, group, args, stats, state) {
  const gid = String(group.group_id);
  const label = group.name ?? gid;
  const gState = (state.groups[gid] ??= { name: label, cursors: {}, seen_topic_ids: [], last_run: null, failures: 0 });
  const failedDetails = (gState.column_detail_failures ??= {});
  let colFailStreak = 0; // 连续详情失败计数（≥5 判定接口被批量拦截）
  const colFailBuffer = []; // 本轮连续失败的主题，成功后洗白
  await limiter.wait();
  const columns = await requestWithBackoff(client, () => client.listColumns(gid), `${label}/columns`);
  if (columns.length === 0) {
    console.log(`[${label}] 该星球没有专栏`);
    return;
  }
  let collected = 0;
  for (const col of columns) {
    const colDir = path.join(outDirSafe, sanitizeFilename(label), "columns", sanitizeFilename(col.name ?? String(col.column_id)));
    fs.mkdirSync(colDir, { recursive: true });
    for (let index = 0, pages = 0; ; index += 20, pages++) {
      if (pages >= Math.max(args.maxPages, 20)) {
        console.warn(`[${label}] 专栏「${col.name}」翻页达 ${pages} 页上限，转入下一个专栏`);
        break;
      }
      await limiter.wait();
      const data = await requestWithBackoff(client, () => client.listColumnTopics(gid, String(col.column_id), 20, index), `${label}/column:${col.name}#${index}`);
      const items = data.topics ?? [];
      if (items.length === 0) break;
      for (const t of items) {
        const tid = String(t.topic_id ?? "");
        const file = path.join(colDir, `${String(t.create_time ?? "").slice(0, 10) || "unknown"}-${sanitizeFilename(String(t.title ?? "无标题"))}-${tid}.md`);
        if (tid && fs.existsSync(file)) continue; // 幂等
        if (failedDetails[tid]) continue; // 曾详情失败的问题主题，直接跳过
        // 专栏列表接口的 text 只有 ~60 字预览；详情接口对长文也只有截断 text，全文在 talk.article.article_url 的 SSR 页面里
        // 详情最多尝试 2 次（不走长退避，防止单篇死主题拖死整个专栏）
        let detail = null;
        for (let attempt = 0; attempt < 2 && !detail; attempt++) {
          if (attempt > 0) await sleep(15_000);
          await limiter.wait();
          try {
            detail = await client.getTopic(tid);
          } catch (err) {
            console.warn(`[${label}] 专栏文章详情失败 ${tid}（第 ${attempt + 1} 次）: ${err.message}`);
          }
        }
        if (!detail || Object.keys(detail).length === 0) {
          // 连续失败 = 风控批量拦截详情接口，中止本轮专栏（不污染跳过清单）；零星失败 = 死主题，记入永久跳过
          colFailStreak++;
          colFailBuffer.push(tid);
          if (colFailStreak >= 5) {
            for (const b of colFailBuffer) delete failedDetails[b]; // 本轮连续失败全是风控误伤，洗白
            colFailBuffer.length = 0;
            console.warn(`[${label}] 连续 ${colFailStreak} 篇专栏详情失败，判定详情接口被批量拦截，专栏步骤本轮中止（下次运行续爬）`);
            stats[`[${label}] 专栏详情被批量拦截，本轮中止`] = true;
            return;
          }
          failedDetails[tid] = new Date().toISOString();
          console.warn(`[${label}] 专栏文章 ${tid} 详情不可用（疑似已删除/受限），记入跳过清单`);
          continue;
        }
        if (colFailStreak > 0) {
          // 详情恢复：洗白连续失败期间误记的主题
          for (const b of colFailBuffer) delete failedDetails[b];
          console.warn(`[${label}] 专栏详情恢复，洗白 ${colFailBuffer.length} 个误记主题`);
          colFailBuffer.length = 0;
          colFailStreak = 0;
        }
        const talk = detail.talk ?? {};
        const articleUrl = talk?.article?.article_url ?? talk?.article?.inline_article_url ?? null;
        const owner = talk.owner ?? t.owner ?? col.owner ?? { name: "匿名" };
        // 拉全文
        const fullText = await fetchFullArticle(client, limiter, label, tid, talk, talk.text ?? t.text ?? "");
        // 评论（可选）
        let comments = [];
        if (args.comments > 0 && (detail.comments_count ?? 0) > 0) {
          if (!officialCliReady()) await limiter.wait(); // 官方通道不受 20s 节流约束
          try {
            const cd = await requestWithBackoff(client, () => client.listComments(tid, args.comments), `${label}/column-comments/${tid}`);
            comments = (cd.comments ?? []).slice(0, args.comments);
          } catch (err) {
            console.warn(`[${label}] 专栏评论获取失败 ${tid}: ${err.message}`);
          }
        }
        const body = renderRich(t, fullText, talk.images ?? []);
        const lines = [
          "---",
          `topic_id: ${tid}`,
          `column: "${esc(col.name ?? "")}"`,
          `author: "${esc(owner.name ?? "匿名")}"`,
          `author_id: ${owner.user_id ?? ""}`,
          `created: ${detail.create_time ?? t.create_time ?? ""}`,
          `likes: ${detail.likes_count ?? 0}`,
          `comments: ${detail.comments_count ?? 0}`,
          `reading: ${detail.reading_count ?? 0}`,
          ...(articleUrl ? [`article_url: "${esc(articleUrl)}"`] : []),
          `clawed_at: ${new Date().toISOString()}`,
          "---",
          "",
          `# ${t.title ?? detail.title ?? "无标题"}`,
          "",
          body,
          ""
        ];
        if (comments.length > 0) {
          lines.push(`## 评论（${comments.length} 条）`, "");
          for (const c of comments) {
            const cm = c.comment ?? c;
            const who = cm.owner?.name ?? "匿名";
            const ctext = renderRich(t, String(cm.text ?? ""), cm.images).replace(/\s+/g, " ").slice(0, 500);
            lines.push(`- **${who}**：${ctext}`);
            for (const rc of cm.replied_comments ?? []) {
              const rtext = String(rc.text ?? "").replace(/\s+/g, " ").slice(0, 300);
              lines.push(`  - ↳ **${rc.owner?.name ?? "匿名"}**：${rtext}`);
            }
          }
          lines.push("");
        }
        let colMd = lines.join("\n");
        if (args.images) {
          colMd = await localizeImagesInMd(colMd, path.dirname(file), path.join(outDirSafe, sanitizeFilename(label), "attachments"));
        }
        fs.writeFileSync(file, colMd, "utf8");
        collected++;
        if (args.limit > 0 && collected >= args.limit) break;
      }
      if (items.length < 20 || (args.limit > 0 && collected >= args.limit)) break;
    }
    console.log(`[${label}] ✔ 专栏「${col.name}」处理完成`);
  }
  stats[`[${label}] 专栏收录 ${collected} 篇`] = true;
  console.log(`[${label}] ✔ 专栏共收录 ${collected} 篇`);
}

/** 建星球文件索引（单个 Markdown 清单）。下载链接接口有权限限制（1030），仅记录元数据与来源主题。 */
async function crawlFiles(client, limiter, group, args, stats) {
  const gid = String(group.group_id);
  const label = group.name ?? gid;
  const rows = [];
  for (let index = 0; ; index += 20) {
    await limiter.wait();
    const data = await requestWithBackoff(client, () => client.listFiles(gid, 20, index), `${label}/files#${index}`);
    const items = data.files ?? [];
    if (items.length === 0) break;
    for (const entry of items) {
      const f = entry.file ?? {};
      const tp = entry.topic ?? {};
      rows.push({
        name: String(f.name ?? "未命名"),
        size: f.size ?? 0,
        create_time: f.create_time ?? "",
        downloads: f.download_count ?? 0,
        file_id: String(f.file_id ?? ""),
        topic_id: String(tp.topic_id ?? "")
      });
    }
    if (items.length < 20) break;
  }
  if (rows.length === 0) {
    console.log(`[${label}] 该星球没有文件`);
    return;
  }
  rows.sort((a, b) => (a.create_time < b.create_time ? 1 : -1));
  const lines = [
    "---",
    `group_id: ${gid}`,
    `files: ${rows.length}`,
    `clawed_at: ${new Date().toISOString()}`,
    "---",
    "",
    `# ${label} 星球文件索引（${rows.length} 个）`,
    "",
    "| 文件 | 大小 | 上传时间 | 下载次数 | 来源主题 |",
    "|---|---|---|---|---|"
  ];
  for (const r of rows) {
    const kb = r.size >= 1048576 ? (r.size / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(r.size / 1024)) + " KB";
    lines.push(`| ${r.name.replace(/\|/g, "\\|")} | ${kb} | ${r.create_time.slice(0, 10)} | ${r.downloads} | ${r.topic_id} |`);
  }
  lines.push("", "> 注：文件下载链接接口有权限限制（code 1030），请通过星球 App/网页下载。`来源主题` 即包含该文件的主题 topic_id，可在本库中搜索定位上下文。", "");
  const dir = path.join(outDirSafe, sanitizeFilename(label));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "星球文件索引.md");
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  stats[`[${label}] 文件索引 ${rows.length} 个`] = true;
  console.log(`[${label}] ✔ 文件索引完成：${rows.length} 个 → ${path.basename(file)}`);
}

// ---------- 主流程 ----------
let outDirSafe = "./zsxq-vault";

async function main() {
  const args = parseArgs(process.argv);
  outDirSafe = path.resolve(args.out);
  fs.mkdirSync(outDirSafe, { recursive: true });
  COOKIE = loadCookie();
  officialEnabled = args.official;
  if (officialCliReady()) console.log("官方 MCP 通道：已启用（元数据/评论/标签走 zsxq-cli，正文走 cookie 直连）");

  // --localize：只做图片本地化补漏，不发起任何星球 API 请求
  if (args.localize) {
    await localizeVault(outDirSafe, args.groups);
    return;
  }

  const client = new ZsxqClient(COOKIE);
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
      if (args.columns) await crawlColumns(client, limiter, group, args, stats, state);
      if (args.files) await crawlFiles(client, limiter, group, args, stats);
      if (args.columns || args.files) { saveState(outDirSafe, state); continue; }
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
  if (imgStats.downloaded + imgStats.failed > 0) {
    console.log(`图片本地化：新下载 ${imgStats.downloaded} 张（${(imgStats.bytes / 1048576).toFixed(1)} MB），缓存复用 ${imgStats.cached} 次，失败 ${imgStats.failed} 张`);
  }
  console.log(`知识库累计主题：${total}，输出目录：${outDirSafe}`);
}

main().catch((err) => {
  console.error("致命错误:", err.message);
  process.exit(1);
});
