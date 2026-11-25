# Atoms 文档索引（Docs Index）

本目录沉淀仓库所有需求的**讨论过程、架构设计决策、待办规划（Todo Backlog）与问题排查复盘**。新增需求或修复请遵循 [`CONTRIBUTING.md`](../CONTRIBUTING.md) 中的「一需求一分支 + 先文档后编码」规范。

---

## 待办需求与设计规划（Todo Backlog）

| 日期 | 状态 | 文档 | 核心主题 |
|---|---|---|---|
| 2026-11-25 | `TODO / Backlog` | [`2026-11-25-cross-agent-fork-and-return.md`](./architecture/2026-11-25-cross-agent-fork-and-return.md) | 跨 Agent 双向上下文管理（Coding ↔ Deep Research Fork & Return：父子血缘、代码感知下传、报告自动挂载与回传卡片） |
| 2026-11-25 | `TODO / Backlog` | [`2026-11-25-connector-platform-and-github.md`](./architecture/2026-11-25-connector-platform-and-github.md) | 通用外部账号连接器平台（AES 加密凭证库 + Broker Proxy + Connector MCP 插件规范）与 GitHub 连接器同步方案 |

---

## 已落地架构设计与需求方案 (`docs/architecture/`)

| 日期 | 状态 | 文档 | 核心主题 |
|---|---|---|---|
| 2026-11-25 | `Implemented` | [`2026-11-25-workspace-thread-decoupling.md`](./architecture/2026-11-25-workspace-thread-decoupling.md) | P0 IDE/工作区视图彻底隔离 + P1 `Workspace (1) : Thread (N)` 领域解耦与同仓库串行写队列 |
| 2026-11-25 | `Implemented` | [`2026-11-25-deep-research-agent-and-recipes.md`](./architecture/2026-11-25-deep-research-agent-and-recipes.md) | Deep Research Agent 扩展（GitHub Skill + 外网爬虫 MCP + 报告模板）、`agents/` 声明式配方目录、多 Agent 意图路由与跨 Agent 自动新建 Thread |
| 2026-11-25 | `Implemented` | [`2026-11-25-workspace-panel-collapse.md`](./architecture/2026-11-25-workspace-panel-collapse.md) | 右侧工作区面板支持最小化/右折叠（保留编辑与预览状态、右侧轻量停靠条与快捷展开） |
| 2026-11-25 | `Implemented` | [`2026-11-25-env-separation-and-ecs-deploy.md`](./architecture/2026-11-25-env-separation-and-ecs-deploy.md) | 开发 / 线上环境分层配置（`.env.development` / `.env.production` + Vite env + HTTPS Cookie）与阿里云 ECS（`atoms.maplink.site`）共存部署方案 |

---

## 问题排查与修复复盘 (`docs/issues/`)

| 日期 | 状态 | 文档 | 核心主题 |
|---|---|---|---|
| 2026-11-25 | `Fixed` | [`2026-11-25-project-switch-agent-state-loss.md`](./issues/2026-11-25-project-switch-agent-state-loss.md) | 多项目切换导致子 Agent 运行状态丢失与侧边栏同步修复（ActiveRun 快照 + SSE seq 去重 + 全局用户 SSE） |
| 2026-11-25 | `Fixed` | [`2026-11-25-duplicate-unbound-thread.md`](./issues/2026-11-25-duplicate-unbound-thread.md) | 新建对话首条消息时全局 SSE 与 HTTP 响应竞态导致侧边栏出现重复「未绑定对话」修复 |
| 2026-11-25 | `Fixed` | [`2026-11-25-agent-auto-stop-and-reconnect-recovery.md`](./issues/2026-11-25-agent-auto-stop-and-reconnect-recovery.md) | 线上 Agent 自动停止与断连/关闭页面状态恢复修复（SSE 心跳与自愈重连、重连握手对账、URL/存储自动复原、Pi 自动重试放行、空闲超时与 Checkpoint） |
