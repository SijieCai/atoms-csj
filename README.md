# Atoms Mini — 最小可用 AI 全栈建站 Demo

一个轻量级的类 Atoms（原 MGX）全栈 AI 建站工作台：

- **免注册登录**：环境变量 `DEMO_USERS` 预置体验账号 + HMAC Cookie 鉴权
- **首屏 Chat + 自动建项目**：自然对话沉淀上下文，自动持久化到平台 SQLite（`data/platform.db`）
- **意图识别 + 隔离 Coding Agent**：识别构建全栈网站意图后，在项目专属目录 `data/workspaces/<projectId>/` 启动独立 **Pi (`@earendil-works/pi-coding-agent`)** RPC 子进程，自动开发、安装依赖与编译
- **实时反馈与双向交互**：SSE 流式展示思考、工具调用、文件编辑与终端日志，运行中支持随时插话（`steer`）或一键停止（`abort`）
- **真实数据持久化 + 在线预览分享**：内置可扩展的 `sqlite-storage` 插件（`SKILL.md` + `atoms_db` MCP Server + `server/db.js` 代理 SDK），所有建表与 SQL 统一走平台 DB Proxy，自动加用户名前缀（`u_<username>_<project>__<table>`）实现租户隔离，并通过 `/preview/<projectId>/` 提供免登录在线预览
- **内置 VS Code 编辑器 + 服务端真实 LSP**：每个用户可管理多个项目；进入项目对话模式的右侧面板，可直接查看并操作服务端项目目录树（新建文件/文件夹、编辑、删除、`Cmd/Ctrl+S` 保存与「保存并预览」），前端嵌入 Monaco Editor（VS Code 内核）并通过鉴权 WebSocket（`/api/projects/:id/lsp`）直连服务端每项目独立的 `typescript-language-server`（JSON-RPC 2.0 + 虚拟 URI 隔离），提供跨文件补全、悬停类型提示、转到定义与实时语法/语义诊断
- **可扩展插件与领域子 Agent 预设**：通过组合 `templates/*` 模板与 `plugins/*` 插件（每个插件可包含 `plugin.json`、`SKILL.md`、MCP Server、运行时环境变量与提示词），在 `presets/presets.json` 中声明即可扩展出不同领域的子 Agent

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

### 一键部署到 ECS

```bash
# 在本地将代码同步到 ECS 的 /opt/atoms
rsync -avz --exclude node_modules --exclude data --exclude .env --exclude dist \
  ./ root@<ECS_PUBLIC_IP>:/opt/atoms/

# 登录 ECS，编辑 .env 并运行一键初始化脚本
ssh root@<ECS_PUBLIC_IP>
cd /opt/atoms
cp .env.example .env && nano .env   # 填入 GLM_API_KEY、DEMO_USERS、SESSION_SECRET

# 无域名（公网 IP 直连）：
sudo bash deploy/setup-ecs.sh

# 有域名（自动签发 HTTPS 证书）：
sudo bash deploy/setup-ecs.sh demo.yourdomain.com
```
