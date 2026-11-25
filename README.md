# Atoms Mini — 最小可用 AI 全栈建站 Demo

一个轻量级的类 Atoms（原 MGX）全栈 AI 建站工作台：

- **免注册登录**：环境变量 `DEMO_USERS` 预置体验账号 + HMAC Cookie 鉴权
- **首屏 Chat + 自动建项目**：自然对话沉淀上下文，自动持久化到平台 SQLite（`data/platform.db`）
- **意图识别 + 隔离 Coding Agent**：识别构建全栈网站意图后，在项目专属目录 `data/workspaces/<projectId>/` 启动独立 **Pi (`@earendil-works/pi-coding-agent`)** RPC 子进程，自动开发、安装依赖与编译
- **实时反馈与双向交互**：SSE 流式展示思考、工具调用、文件编辑与终端日志，运行中支持随时插话（`steer`）或一键停止（`abort`）
- **真实数据持久化 + 在线预览分享**：内置可扩展的 `sqlite-storage` 插件（`SKILL.md` + `atoms_db` MCP Server + `server/db.js` 代理 SDK），所有建表与 SQL 统一走平台 DB Proxy，自动加用户名前缀（`u_<username>_<project>__<table>`）实现租户隔离，并通过 `/preview/<projectId>/` 提供免登录在线预览
- **Built-in VS Code 编辑器 + 服务端真实 LSP**：每个代码仓库/研究空间拥有独立目录，右侧面板可直接浏览和编辑文件（新建、保存、删除），前端嵌入 Monaco Editor（VS Code 内核）并通过鉴权 WebSocket（`/api/workspaces/:wsId/lsp`）直连服务端独立 `typescript-language-server`
- **Workspace (1) : Thread (N) 领域解耦**：支持多个独立工作区真正并行运行，同一工作区下可开启多个并行对话（聊天气泡并发、写入/构建自动 FIFO 排队，删除对话不删除共享工作区）
- **声明式多 Agent 配方体系 (`agents/` + `plugins/` + `templates/`)**：
  - **`agents/fullstack-coder/`**：组合 `templates/fullstack-app` + `plugins/sqlite-storage`（全栈建站 + 租户隔离 SQLite 代理）
  - **`agents/deep-research/`**：组合 `templates/deep-research` + `plugins/deep-research`（GitHub 热门 `deep-research` Skill + 外网搜索/爬取 `web_research` MCP + 零构建交互式研究报告预览器）
  - **多 Agent 意图路由与跨 Agent 自动分叉 Thread**：聊天时自动识别意图路由至合适 Agent；若在同一对话中触发不同 Agent（例如研究完转去建站），系统自动新建独立 Thread 并传递上下文摘要（如 `report.md`），不污染原工作区

> 研发与维护规范：请先阅读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)（一需求一分支规范 + 先沉淀文档到 [`docs/`](./docs/README.md) 再编码）。

---

## 本地开发与验证（要求 Node.js >= 22.19）

```bash
# 1. 安装平台依赖与全栈模板依赖（预装模板依赖可让首次建站提速至秒级）
npm install
npm run setup:template

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 GLM_API_KEY、GLM_BASE_URL、GLM_MODEL 和 DEMO_USERS

# 3. 启动本地开发（后端 3000 + 前端 Vite 5173）
npm run dev
```

打开 `http://localhost:5173`，使用 `.env` 中配置的预置账号（默认 `demo` / `atoms2026`）登录体验。

### GLM 端点对照

> 注意：智谱开放平台的 **标准按量 API Key** 与 **GLM Coding Plan 套餐 Key** 互不通用，请按 Key 类型匹配对应 `GLM_BASE_URL`。

- **智谱国内通用按量 API（推荐 `glm-5.3-flash` / `glm-5.3-flashx` / `glm-5.3`）**：`GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4`，`GLM_MODEL=glm-5.3-flash`（1M 上下文、128K 输出、原生多模态）
- **智谱国内 GLM Coding Plan 套餐**：`GLM_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4`，`GLM_MODEL=glm-5.3-flash`（或 `glm-5.3` / `glm-5.4`）
- **海外 Z.AI Coding Plan**：`GLM_BASE_URL=https://api.z.ai/api/coding/paas/v4`，`GLM_MODEL=glm-5.3-flash`

---

## 阿里云最小资源清单与部署

### 需要申请的最小资源（仅 1 台服务器）

1. **阿里云轻量应用服务器或 ECS（1 台）**：2核 4G、40GB SSD、**Ubuntu 24.04 LTS**
   - 推荐地域：**中国香港 / 新加坡**（免 ICP 备案、npm 速度快）
   - 安全组放行端口：`22`、`80`（有域名再放行 `443`）
2. **GLM API Key**（已有）
3. **可选域名**（无域名可直接通过 `http://<ECS公网IP>` 访问全部功能）
4. **无需申请**：RDS、Redis、OSS、SLB、Docker/K8s

## 开发环境与线上环境区分

项目通过分层环境变量区分开发态与线上态：

| 环境 | 启动命令 | 版本化默认配置（入库，无密钥） | 默认访问地址 | Session Cookie `Secure` |
|---|---|---|---|---|
| 开发环境 | `npm run dev` | `.env.development`、`web/.env.development` | `http://localhost:5173` | `false` |
| 线上环境 | `npm run start` / `atoms.service` | `.env.production`、`web/.env.production` | `https://atoms.maplink.site` | `true` |

服务端加载优先级（从高到低，不覆盖高优先级）：
`进程环境变量` > `.env.<env>.local` > `.env.<env>` > `.env.local` > `.env`（共享密钥与账号，如 `GLM_API_KEY`、`DEMO_USERS`）。

### 一键部署到阿里云 ECS

```bash
# 同步源码与本地 .env 到 ECS（/opt/atoms），生产构建并重启 atoms.service
npm run deploy:ecs

# 首次全新 ECS 初始化（安装 Node 24、Swap、systemd 与 Caddy）
sudo bash deploy/setup-ecs.sh atoms.maplink.site
```
