# Deep Research Agent 扩展与声明式 Agent 配方体系设计

- **日期**：2026-11-25
- **关联文档**：[`2026-11-25-workspace-thread-decoupling.md`](./2026-11-25-workspace-thread-decoupling.md)
- **状态**：已确认并落地实现

---

## 1. 需求背景与目标

在已有的全栈建站 Coding Agent（`fullstack-app` 模板 + `sqlite-storage` 插件）与 `Workspace (1) : Thread (N)` 架构基础上，扩展平台为**多 Agent 配方驱动架构**，并接入第二个一等 Agent —— **Deep Research Agent**：

1. **声明式 Agent 配方目录 (`agents/`)**：
   - 与 `plugins/`、`templates/` 平级，每个 Agent 独立一个目录（如 `agents/fullstack-coder/`、`agents/deep-research/`），通过 `agent.json` + `SYSTEM.md` 清晰声明 `templateId`、`plugins`、意图描述与前端 UI 适配配置，在代码库中直观呈现每个 Agent 的配方组合。
2. **Deep Research 插件 (`plugins/deep-research/`)**：
   - **Skill (`SKILL.md`)**：基于 GitHub 生态热门开源 Deep Research Skill（参考 `affaan-m/everything-claude-code` 的 `deep-research` 方法论与多源交叉核验规范）适配为四阶段研究流水线（定界拆解 → 广度多源检索 → 网页精读与对抗核验 → 综合撰写与引用溯源）。
   - **外网搜索/爬虫 MCP (`mcp-server.mjs`, `web_research`)**：以零外部依赖 Stdio MCP Server 封装 `web_search`、`web_fetch`、`web_crawl`、`extract_links` 四类工具，内置 SSRF 安全拦截、零 Key 多源联邦检索（Bing RSS + Wikipedia + HackerNews + GitHub + arXiv）与正文 Markdown 抽取，同时支持 `.env` 配置 `TAVILY_API_KEY` / `FIRECRAWL_API_KEY` 自动升级专业检索能力。
3. **Deep Research 模板 (`templates/deep-research/`)**：
   - 预置研究目录规范（`plan.md`、`sources/`、`sources.json`、`report.md`）与一个**零构建交互式研究报告预览器**（Express 5 轻量静态服务 + 单页阅读器，支持目录大纲、Markdown 排版、内联引用高亮、信源列表与一键导出），无缝复用 `/preview/<workspaceId>/` 与右侧 VS Code 编辑器。
4. **对话开场引导、多 Agent 意图路由与跨 Agent 自动分叉 Thread**：
   - 对话开始即清晰提示用户可使用 **Deep Research 深度研究** 与 **Fullstack Coder 全栈开发**；聊天阶段由配方驱动的多路意图路由器决定留在本对话闲聊、执行目标 Agent，或按需手动指定模式。
   - **同对话跨 Agent 简化策略**：当一个已归属 Agent A 的对话中，用户新消息命中了不同的 Agent B（例如在 Coding 对话中请求深度调研，或在 Deep Research 对话中请求基于报告构建全栈网站）时，**不混用/污染原工作区**，而是直接自动创建一个绑定 Agent B 的新 Thread 与新 Workspace，并将原对话的关键上下文（如 `report.md` 摘要）作为交接背景注入新 Thread，在原对话留下可一键跳转的「交接卡片」，前端自动切换至新 Thread 实时执行。

---

## 2. 目录与配方体系设计

```text
atoms/
├── plugins/                       # 原子能力插件（Skill + MCP Server + Env）
│   ├── sqlite-storage/            # 全栈隔离 SQLite 代理插件
│   └── deep-research/             # 深度研究插件（GitHub Skill + web_research MCP）
│       ├── plugin.json
│       ├── SKILL.md
│       └── mcp-server.mjs
│
├── templates/                     # 工作区初始模板
│   ├── fullstack-app/             # React 19 + Express 5 + SQLite 全栈模板
│   └── deep-research/             # 研究工作区模板 + 零构建交互式报告预览器
│       ├── AGENTS.md
│       ├── package.json
│       ├── server/index.js
│       └── public/index.html
│
└── agents/                        # 一等 Agent 配方目录（Recipe Registry）
    ├── fullstack-coder/
    │   ├── agent.json             # aliases: ["fullstack-web"], template: fullstack-app, plugins: [sqlite-storage]
    │   └── SYSTEM.md
    └── deep-research/
        ├── agent.json             # template: deep-research, plugins: [deep-research]
        └── SYSTEM.md
```

### `agent.json` 核心契约

每个配方文件统一驱动后端注册、意图识别与前端展示，新增第 N 个 Agent 时无需散落修改硬编码分支：

| 字段 | 作用 |
|---|---|
| `id` / `aliases` | 配方唯一标识；`fullstack-coder` 通过 `aliases: ["fullstack-web"]` 兼容存量数据库记录 |
| `name` / `shortName` / `icon` | UI 展示名称、短标签与图标类型（`code` / `research`） |
| `templateId` | 关联的 `templates/<templateId>` |
| `plugins` | 挂载的 `plugins/<pluginId>` 列表（自动拼接其 `SKILL.md` 与 `mcp.json`） |
| `systemPromptFile` | 配方专属 `SYSTEM.md` 路径 |
| `intent` | 供意图路由器动态消费的描述、关键词、示例，避免在 `intent.ts` 硬编码 Agent 列表 |
| `ui` | 控制右侧面板可见 Tab（如 Deep Research 自动隐藏 `database` Tab）、预览 Tab 文案（`研究报告` vs `应用预览`）、工作区类型标签（`研究空间` vs `代码仓库`）以及开场提示词 |

---

## 3. 外网爬虫 MCP 工具与安全设计 (`plugins/deep-research/mcp-server.mjs`)

| MCP 工具名 | 输入参数 | 能力说明 |
|---|---|---|
| `web_search` | `query`, `maxResults?`, `source?` (`auto`/`web`/`tech`/`academic`/`github`/`wiki`) | 优先走 `TAVILY_API_KEY` / `FIRECRAWL_API_KEY`；未配置时自动并行联邦检索 Bing RSS、Wikipedia、HackerNews Algolia、GitHub API、arXiv 并按相关性去重返回 |
| `web_fetch` | `url`, `maxChars?` | 抓取目标网页并抽取结构化正文（标题、摘要、Markdown 正文与出站链接）；对 GitHub 仓库自动支持提取 `README.md`；支持可选 Firecrawl 增强 |
| `web_crawl` | `url`, `maxPages?`, `sameDomainOnly?` | 浅层广度爬取：从入口页提取高价值子链接并抓取最多 `maxPages`（默认 4，上限 6）页内容，用于精读官方文档或竞品站 |
| `extract_links` | `url`, `sameDomainOnly?`, `limit?` | 快速提取某网页的导航与正文链接清单，便于 Agent 决定需要深入爬取哪些子页 |

**安全与健壮性约束**：
- **SSRF 防护**：所有 `web_fetch` / `web_crawl` / `extract_links` 均校验协议仅允许 `http:` / `https:`，拒绝 `localhost`、`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、`::1`、`fc00::/7`、`fe80::/10`、`*.local`、`*.internal`。
- **资源上限**：单次抓取强制 `12s` 超时与 `2MB` 体积上限，返回正文按 `maxChars`（默认 `12000`，上限 `24000`）安全截断，防止撑爆模型上下文。

---

## 4. 意图路由与跨 Agent 自动新建 Thread 流程

```text
用户发送消息 (projectId, content, targetAgentId?)
        │
        ▼
  是否显式指定 targetAgentId？
   ├── 是 ──► decision = { intent: 'run_agent', targetAgentId }
   └── 否 ──► classifyIntent(history, content, currentAgent, hasWorkspace, allAgents)
                    │
                    ├── intent === 'chat' ──► 流式聊天回复（不改工作区）
                    │
                    └── intent === 'run_agent' (targetAgentId)
                              │
                              ▼
              当前 Thread 是否已绑定 Workspace？
               ├── 否（空白/未绑定对话）
               │      └─► 留在当前 Thread：将 preset_id 设为 targetAgentId，
               │          创建对应 Workspace 并启动 Agent 执行
               │
               └── 是（当前归属 Agent A）
                      ├── targetAgentId === Agent A
                      │      └─► 留在当前 Thread：继续在原 Workspace 迭代执行
                      │
                      └── targetAgentId !== Agent A  ◄── 跨 Agent 冲突
                             1. 抽取原 Thread / 原 Workspace 交接摘要（如 report.md 核心内容）
                             2. 自动创建新 Workspace (Agent B) + 新 Thread (Agent B)
                             3. 原 Thread 写入用户消息 + 带跳转链接的「交接卡片」消息
                             4. 新 Thread 写入用户消息并注入 HANDOFF_CONTEXT，立即启动 Agent B
                             5. 广播全局 SSE，前端自动切换焦点到新 Thread 并打开右侧预览
```

### 上下文交接（Handoff Context）机制
- **Deep Research → Fullstack Coder**：若原研究空间存在 `report.md`，自动截取最多 4000 字符的报告核心内容（附来源清单路径说明），写入新 Coding 工作区的 `PROJECT_CONTEXT.md` 中，让 Coding Agent 直接基于真实调研数据构建交互式网站。
- **Fullstack Coder → Deep Research**：将原对话最近的讨论需求与项目标题注入新研究空间的 `PROJECT_CONTEXT.md`，让 Deep Research Agent 精准围绕原项目背景展开技术选型或竞品调研。

---

## 5. 前端交互升级清单

1. **欢迎页双 Agent 引导**：空白对话页顶部展示 **Deep Research 深度研究** 与 **Fullstack Coder 全栈开发** 能力徽章，并渲染覆盖两种 Agent 的一键示例卡片。
2. **输入框轻量路由模式切换**：默认 `✨ 自动识别`，也可手动点选 `🔬 深度研究` 或 `💻 全栈构建` 强制路由，降低误判成本。
3. **跨 Agent 交接卡片**：当触发跨 Agent 自动新建 Thread 时，原对话保留结构化交接卡片（显示目标 Agent、新对话标题与「前往新对话 →」跳转按钮），前端自动切入新对话并展示实时执行进度。
4. **左侧边栏类型区分**：工作区列表根据 `presetId` 使用不同图标与标签区分（`📁 代码仓库` vs `🔬 研究空间`），`+ 新建工作区` 支持选择创建「代码仓库」或「研究空间」。
5. **右侧面板按配方自适应**：`deep-research` 工作区将首个 Tab 显示为「研究报告」并隐藏无关的「数据库」Tab；`fullstack-coder` 保持「应用预览 / VS Code / 数据库 / 日志」四 Tab 完整体验。
