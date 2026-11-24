原始需求是，希望将一些工具的官方文档交给notebooklm进行处理，然后利用“ 零幻觉官方语料检索 ”的特性加速自己的查阅能力，且快速把握工具的特性和使用方法，而页面一个个去加载不合适，因此本地一次性导入是最佳方案。

由于未采用第一性原理解构需求，习惯性试图将web转pdf，中途遇到很多麻烦，效果还不太行。
本次采用第一性原理拆解，实际上真实需求应该是“把面向人类浏览器的交互式网页视图，重构为面向大模型 RAG 检索系统的高信噪比、上下文自洽的纯文本语料库”



### 1、V1 设计边界：将 Defuddle 冻结为“黑盒”

在第一版中明确做出工程取舍，把精力全部集中在 **“全站获取 → 结构还原 → NotebookLM 适配”** 三个真正决定体验的环节：

* **V1 做什么**：多策略全站 URL 发现与排序、本地 HTML 缓存与断点续传、黑盒调用 `defuddle/node` 转 Markdown、语境元数据注头、面向 NotebookLM 限制的智能分域打包、全局目录地图生成、异常页质检报告。
* **V1 明确不做（预留接口给 V2）**：不做自定义 DOM 手术刀清洗、不做跨页高频样板统计去噪、不做图片 OCR/视觉转写、不做复杂表格降级修复。

---

### 2、V1 完整开发方案

#### 1. 技术栈选型

保持纯 **TypeScript + Node.js (≥ 20)** 单语言栈，直接原生调用 `defuddle/node`，避免跨语言进程调度：

* **核心转译**：`defuddle`（使用 `defuddle/node` 导出，自带 Markdown 转换、代码块、Callout 提示框与公式标准化）+ `linkedom`（比 JSDOM 快一个量级的轻量 DOM 解析器）。
* **抓取层**：默认原生 `fetch`（应对静态站极快）；按需加载 `playwright`（仅当目标站是纯 SPA / 客户端渲染时启用）。
* **工程基础**：`zod`（站点配置校验）、`p-limit`（并发与限速控制）、`commander`（CLI 命令入口）。

---

#### 2. 核心数据模型（模块间解耦契约）

四个阶段全部通过本地 JSON / 文件落盘通信，任意阶段失败均可断点续跑，后续调整打包策略无需重新抓网页：

```typescript
// 1. 站点配置（每接入一个新工具，仅需新建一个配置文件）
export interface SiteConfig {
  id: string;                      // 工具标识，如 "caddy"
  name: string;                    // 工具显示名，如 "Caddy Server"
  entryUrl: string;                // 使用文档首页（如 Quickstart）
  discover: {
    strategy: 'sidebar' | 'next-chain' | 'sitemap';
    sidebarSelector?: string;      // strategy=sidebar 时必填
    nextSelector?: string;         // strategy=next-chain 时使用，默认 'a[rel="next"]'
    breadcrumbSelector?: string;   // 可选，未提供时退化为按 URL 路径分层
    sitemapUrl?: string;           // strategy=sitemap 时使用
  };
  scope: {
    allowPrefixes: string[];       // 严格锁死“使用文档”前缀与版本号
    excludePatterns?: string[];    // 排除 /api/, /changelog/, /blog/ 等正则
  };
  fetch: {
    mode: 'http' | 'browser';      // 静态站用 http，SPA 用 browser
    concurrency?: number;          // 默认 http=5, browser=2
    delayMs?: number;              // 请求间隔，默认 200ms
    waitForSelector?: string;      // browser 模式下等待正文渲染完成
  };
  notebooklm: {
    groupByDepth?: number;         // 按第几级目录分模块，默认 1
    targetMaxFiles?: number;       // 期望输出文件上限，默认 25（安全低于免费版 50 槽位）
    maxWordsPerFile?: number;      // 单文件词数硬上限，默认 120000（远低于 50 万词上限以保检索精度）
    minWordsToMerge?: number;      // 小于此词数的零碎小模块自动合并，默认 3000
    keepExternalImages?: boolean;  // 是否保留 Markdown 图片链接，默认 true
  };
}

// 2. 拓扑清单项（Stage 1 产物：manifest.json）
export interface ManifestItem {
  index: number;                   // 全局严格阅读序号（0, 1, 2...）
  url: string;                     // 规范化后的唯一 URL
  hash: string;                    // sha1(url).slice(0, 10)，用作本地缓存文件名
  title?: string;                  // 发现阶段拿到的标题
  breadcrumb: string[];            // 纵向层级路径，如 ["Guide", "Performance", "Caching"]
  moduleKey: string;               // 所属一级模块标识
}

// 3. 提取结果项（Stage 3 产物：extracted.json）
export interface ExtractedPage extends ManifestItem {
  finalTitle: string;              // Defuddle 识别的最终标题
  description?: string;            // Defuddle 提取的页面摘要
  prevTitle?: string;              // 从 DOM 嗅探的上一页标题（可选上下文）
  nextTitle?: string;              // 从 DOM 嗅探的下一页标题（可选上下文）
  headings: Array<{ level: number; text: string }>; // 从 Markdown 提取的 H2/H3 骨架，用于生成总地图
  wordCount: number;               // 词/字数统计（中英混合按可读单元估算）
  mdFilePath: string;              // 本地单页 md 路径
  status: 'ok' | 'empty' | 'error';
  errorMessage?: string;
}

```

---

#### 3. 四阶段流水线详细设计

##### Stage 1：拓扑发现与边界锁死（`01-discover.ts`）

支持三种可切换策略，优先级按文档站点特征选择：

1. **`sidebar`（首选）**：抓取入口页，递归遍历侧边栏容器的嵌套 `<ul>/<ol>/<a>` 树，天然同时拿到**严格 DFS 顺序 + 完整 `breadcrumb` 层级**。
2. **`next-chain`（免侧边栏方案）**：从 `entryUrl` 起步，循环抓取并查找 `nextSelector`（支持自动回退匹配 `a[rel="next"]` 或含 `Next` / `下一页` 的底部翻页链接），直到无下一页或触达 `visited` 集合闭环。每页同步提取 `breadcrumbSelector`；若无面包屑 DOM，则直接用 URL 相对路径分段作为 `breadcrumb`。
3. **`sitemap`（兜底）**：拉取 `sitemap.xml`，用 `allowPrefixes` 和 `excludePatterns` 过滤后，按 URL 路径字典序排序并用路径分段生成 `breadcrumb`。

所有策略统一执行 **URL 规范化**（剔除 `#hash`、无意义追踪参数、统一末尾 `/` 规则）和边界过滤，最终输出 `workspace/<id>/manifest.json`。

##### Stage 2：快照抓取与缓存（`02-fetch.ts`）

* 读取 `manifest.json`，检查 `workspace/<id>/raw_html/<hash>.html` 是否已存在；存在直接跳过（天然断点续传，支持 `--force` 强制刷新）。
* `http` 模式用原生 `fetch` + 常见浏览器 `User-Agent`；`browser` 模式复用单个 Playwright Browser Context 开多标签并发，等待 `waitForSelector` 或 `networkidle`。
* 若开启了 `next-chain` 策略，Stage 1 与 Stage 2 复用同一份落盘 HTML 缓存，绝不重复请求同一 URL。

##### Stage 3：黑盒转译与轻量元数据嗅探（`03-extract.ts`）

全部在本地基于 `raw_html/` 离线执行，单页处理逻辑极简：

1. 用 `linkedom` 解析本地 HTML 为 `document`。
2. **提取 Defuddle 不会主动保留的结构元数据**：
* 若 Stage 1 没拿到 `breadcrumb`，此时从 `breadcrumbSelector`（或常见语义标签 `nav[aria-label*="breadcrumb" i]`）补提。
* 嗅探 `prevTitle` / `nextTitle`（供需要时写入语境头）。


3. **直接黑盒调用 `Defuddle**`：
```typescript
import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';

const { document } = parseHTML(rawHtml);
const result = await Defuddle(document, item.url, {
  markdown: true,
  // V1 可选透传参数，默认全部遵循 Defuddle 自身最佳配置
  removeImages: !config.notebooklm.keepExternalImages,
});

```


*（预留扩展点：此处留一个空的 `postProcessMarkdown(md, ctx)` 钩子函数，V1 直接 `return md`，未来 V2 若要加去噪直接填这里。）*
4. 从产出的 Markdown 中用正则快速提取所有非代码块内的 `H2` / `H3` 标题列表（供 Stage 4 生成全局地图），统计字数，落盘到 `pages_md/<hash>.md` 并更新 `extracted.json`。

##### Stage 4：NotebookLM 专属适配与打包层（`04-package.ts`）

这是 V1 最核心的价值所在，专门针对 NotebookLM 的检索与交互机制做四件事：

**① 单页语境封装与标题降级（防止切片语境断裂）**
将多页拼进一个模块 `.md` 文件时，不能直接裸拼，必须做两项处理：

* **标题层级整体下移 1 级**：把模块文件最顶部的 `# 模块名` 留作 `H1`；每篇子页面的主标题设为 `## 页面标题`；正文里原本的 `#` / `##` / `###` 统一顺延一级（跳过 fenced code blocks 里的 `#` 注释！），保证合并后整份文件是一棵严格合法的 Markdown AST，让 RAG 的按标题切块策略（Markdown Header Splitter）准确工作。
* **注入标准语境头**：紧贴在每页 `## 页面标题` 下方插入固定格式的引用块，把目录路径和官网溯源地址固化进切片上下文：
```markdown
## 缓存与内存控制
> **所属路径**：核心指南 > 性能调优 > 缓存与内存控制
> **原始文档**：https://docs.example.com/guide/performance/cache
> **阅读顺序**：上一页「并发模型」 / 下一页「基准测试」

（此处接 Defuddle 直出的降级后正文）

```



**② 智能分域打包与体积护栏（解决粒度悖论）**
按 `moduleKey`（默认取 `breadcrumb[0]`）将有序页面聚合，随后执行两条自动护栏算法：

* **大模块自动切分**：如果某个模块累计词数超过 `maxWordsPerFile`（默认 12 万词），按二级目录 `breadcrumb[1]` 自动拆分为 `03a-配置参考-网络.md`、`03b-配置参考-存储.md`，确保既不触发 50 万词上限，又维持高检索精度。
* **零碎小模块收纳**：如果最终模块数超过 `targetMaxFiles`（默认 25 个），按相邻阅读顺序把词数小于 `minWordsToMerge` 的小模块合并（如 `08-生态与周边工具集.md`），避免挤占 NotebookLM 的来源槽位和增加侧边栏勾选负担。
* **文件命名规范**：采用两位序号前缀 + 模块名（如 `01-快速开始.md`、`02-核心概念.md`），上传到 NotebookLM 后在左侧来源列表里天然按学习顺序排列。

**③ 自动合成全局认知地图（`00-文档总览与目录地图.md`）**
生成一份体积很小（通常几千词）但信息密度极高的总索引文件，放在最前面一并导入 NotebookLM：

```markdown
# Caddy Server 官方使用文档 — 全局目录地图

- **文档入口**：https://caddyserver.com/docs/
- **收录范围**：仅包含使用文档，共 64 页，整理为 9 个模块文件
- **抓取日期**：2026-11-24

## 一、模块文件索引（按需在左侧勾选）
| 模块文件 | 覆盖章节 | 页数 | 约计词数 |
| :--- | :--- | :--- | :--- |
| `01-快速开始.md` | Quick-starts / Install | 6 | 8,400 |
| `02-核心配置.md` | Caddyfile / JSON Config | 18 | 42,100 |

## 二、全站树状目录与小节提纲
### 01-快速开始 (`01-快速开始.md`)
- **安装指南** (`https://...`)
  - Linux 安装 / Docker 部署 / 系统服务配置
- **反向代理快速上手** (`https://...`)
  - 命令行启动 / Caddyfile 示例
...

```

当你在 NotebookLM 里问“请全面总结这个工具的所有核心特性、性能机制和适用场景”时，它能依托这份地图文件做到全局不漏项。

**④ 自动化质检报告（`report.json` + 终端摘要）**
因为 V1 信任 Defuddle 直出，必须用一份客观体检单帮你兜底发现极端异常页面（不阻断打包，仅高亮告警）：

* `emptyOrTinyPages`：词数小于 50 词的页面列表（立刻定位 SPA 未渲染完或反爬拦截页）。
* `oversizedPages`：单页大于 25,000 词的页面（排查是否误把某个巨型 API 字典页抓进来了）。
* `failedPages`：HTTP 报错或 Defuddle 抛异常的 URL 列表。
* `bundleSummary`：最终生成的模块文件清单、总文件数、总词数与最大单文件词数。

---

#### 4. 项目目录与 CLI 交互设计

```text
doc2nlm/
├── package.json
├── tsconfig.json
├── sites/                          # 站点配置仓库（纳入 Git 长期积累）
│   └── example.json
├── src/
│   ├── cli.ts                      # 命令行入口
│   ├── config.ts                   # Zod Schema 校验与默认值填充
│   ├── core/
│   │   ├── url.ts                  # URL 规范化、前缀/排除匹配、哈希
│   │   ├── markdown.ts             # 安全标题降级（跳过代码块）、H2/H3 提取、词数统计
│   │   └── fs.ts                   # 缓存读写
│   └── pipeline/
│       ├── 01-discover.ts          # sidebar / next-chain / sitemap 三种发现器
│       ├── 02-fetch.ts             # http / playwright 抓取 + 本地缓存
│       ├── 03-extract.ts           # linkedom + defuddle/node 黑盒提取
│       └── 04-package.ts           # 语境封装 + 智能分合 + 00-地图 + 质检报告
└── workspace/                      # 运行产物（gitignore）
    └── <site-id>/
        ├── manifest.json
        ├── raw_html/               # 原始 HTML 缓存
        ├── pages_md/               # Defuddle 直出单页
        ├── extracted.json
        ├── report.json
        └── output/                 # <-- 直接全选拖进 NotebookLM 的最终成品
            ├── 00-文档总览与目录地图.md
            ├── 01-快速开始.md
            └── ...

```

CLI 设计支持既能一键跑全流程，也能单步调试：

* `doc2nlm run sites/caddy.json`：按顺序跑完 1 → 4，最后在终端打印 `report.json` 摘要。
* `doc2nlm discover sites/caddy.json`：只跑发现阶段，先人工看一眼 `manifest.json` 确认有没有混进开发文档、数量对不对，再决定要不要开抓。
* `doc2nlm repack sites/caddy.json`：改完 `maxWordsPerFile` 或 `groupByDepth` 后，1 秒内基于本地缓存重新打包，零网络请求。

---