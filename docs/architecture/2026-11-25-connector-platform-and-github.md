# 通用外部账号连接器平台与 GitHub 连接器设计

- **日期**：2026-11-25
- **状态**：`TODO / Backlog`（待评审确认后排期实现）
- **关联文档**：
  - [`2026-11-25-workspace-thread-decoupling.md`](./2026-11-25-workspace-thread-decoupling.md)
  - [`2026-11-25-deep-research-agent-and-recipes.md`](./2026-11-25-deep-research-agent-and-recipes.md)

---

## 1. 需求背景与目标

当前所有生成的代码和研究产物均仅存放在服务端本地磁盘（`data/workspaces/`），存在单点数据风险且不便与外部工程协作流打通。本需求旨在建设：

1. **通用可扩展的外部账号连接器框架（Connector Platform）**：允许用户在 Atoms 账号维度安全绑定外部网站账号，并把受控的外部操作能力以统一 MCP / 插件形式注入 Agent 会话；未来可持续平滑扩展 Vercel、GitLab、Notion、飞书、Cloudflare 等外部服务。
2. **首个落地实现 —— GitHub 连接器 (`connector-github`)**：支持用户登录/绑定自己的 GitHub 账号，在工作区开发或调研到一定阶段时，通过 **UI 一键同步** 或 **对话驱动 Agent 调用 MCP** 将工作区代码安全推送到 GitHub 仓库。

---

## 2. 核心安全与分层架构

严格遵循「**凭证不进 Agent / 不进工作区 / 不进 LLM 上下文**」原则，复用现有 `db-proxy` 的 Broker Proxy + MCP Plugin 思路分为三层：

```text
用户浏览器 (外部连接器中心弹窗 / 右侧一键同步按钮)
      │  1. OAuth 登录 或 PAT 绑定（用户级账号维度）
      ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: 平台连接器注册表 & 加密凭证库 (Connector Vault)     │
│  - platform.db: user_connections (AES-256-GCM 静态加密)      │
│  - platform.db: workspace_bindings (工作区 ↔ 外部资源绑定)    │
│  - platform.db: connector_audit_logs (外部写操作审计日志)     │
└──────────────────────────┬──────────────────────────────────┘
                           │ 2. 服务端受控代理（HMAC 短时效 Broker Token）
                           │    POST /api/connector-proxy/:connectorId/:action
┌──────────────────────────▼──────────────────────────────────┐
│  Layer 2: 通用连接器代理层 (Connector Broker Proxy)           │
│  - 解密真实凭证执行外部 API 或临时 GIT_ASKPASS Git 操作       │
│  - 强制安全护栏（过滤敏感文件、默认私有仓、禁止 force push）    │
└──────────────────────────┬──────────────────────────────────┘
                           │ 3. Stdio MCP 协议暴露给 Pi Agent
┌──────────────────────────▼──────────────────────────────────┐
│  Layer 3: 连接器插件层 (plugins/connector-<name>/)           │
│  - plugin.json + SKILL.md + mcp-server.mjs                  │
│  - 首批：plugins/connector-github/ (MCP: github_connector)   │
└─────────────────────────────────────────────────────────────┘
```

### 动态按需挂载
- `agents/*/agent.json` 声明支持的 `connectors`（如 `["connector-github"]`）；
- `PluginRegistry` 在启动 Pi Agent 前检查当前用户是否已绑定该连接器：已绑定则自动签发受限 Broker Token 并挂载对应 MCP 工具与 Skill；未绑定则不注入冗余工具。

---

## 3. 目录与数据模型设计

### 3.1 规划目录结构
```text
atoms/
├── plugins/
│   └── connector-github/
│       ├── plugin.json             # kind: "connector", connectorId: "github"
│       ├── SKILL.md                # 安全建仓、提交规范与同步工作流说明
│       └── mcp-server.mjs          # 薄 Stdio MCP 壳，转发至 /api/connector-proxy/github/*
└── server/src/
    ├── connector-vault.ts          # AES-256-GCM 加密存储 + HMAC Broker Token 签发/校验
    ├── connector-registry.ts       # 通用 ConnectorProvider 接口与注册表
    └── connectors/
        └── github.ts               # GitHub OAuth / PAT 验证 + API + 安全 Git Push/Pull
```

### 3.2 `platform.db` 新增表
1. **`user_connections`**：`(id, owner, connector_id, auth_type, account_id, account_login, account_name, avatar_url, scopes, secret_encrypted, status, created_at, updated_at)`，唯一约束 `UNIQUE(owner, connector_id)`。
2. **`workspace_bindings`**：`(id, workspace_id, connector_id, external_id, external_name, external_url, branch, last_synced_at, last_commit_sha, meta_json)`。
3. **`connector_audit_logs`**：`(id, owner, workspace_id, connector_id, action, target, status, detail, created_at)`。

---

## 4. GitHub 认证方式与 MCP 工具设计

### 4.1 双模式认证
- **模式 A：GitHub OAuth Web Flow（推荐线上部署）** — 配置 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` 后启用一键 OAuth 授权（`repo`, `read:user`，带 CSRF `state` 校验）。
- **模式 B：GitHub PAT 快速绑定（零配置兜底）** — 本地开发或纯 IP 部署无需注册 OAuth App，直接粘贴 Personal Access Token，经 `GET https://api.github.com/user` 校验后加密入库。

### 4.2 MCP 工具清单 (`mcp__github_connector__*`)
- `github_whoami`：查询当前用户绑定的 GitHub 账号与权限（绝不返回 Token）
- `github_list_repos`：列出/搜索用户可访问的 GitHub 仓库
- `github_create_repo`：创建新仓库（**默认 `private: true` 私有仓库**）并绑定到当前 Workspace
- `github_bind_repo`：绑定当前 Workspace 到已有 GitHub 仓库
- `github_sync_status`：查看绑定仓库、本地未提交变更清单与上次同步时间
- `github_push_workspace`：初始化 Git → 强制补全安全 `.gitignore` → `git add` → `git commit` → 通过一次性 `GIT_ASKPASS` 推送（禁止 `--force`）
- `github_pull_workspace`：安全拉取远端更新（fast-forward 优先，冲突清晰提示不强覆盖）

### 4.3 强制安全护栏
- 推送前自动确保 `.gitignore` 排除 `.pi-agent/`、`.pi-sessions/`、`PROJECT_CONTEXT.md`、`node_modules/`、`dist/`、`.env`、`.env.*`、`*.db`、`data/`；
- `.git/config` 永不写入明文 Token，仅保存干净的 `https://github.com/<owner>/<repo>.git`；
- 严格校验 `workspaceId` 归属与路径边界；所有外部写操作落审计日志。

---

## 5. 前端交互规划

1. **左下角「连接器 / Integrations」管理弹窗**：统一管理当前用户的外部账号连接（GitHub 绑定/解绑、头像与状态展示，预留未来 Vercel / Notion / 飞书扩展位）。
2. **右侧 WorkspacePanel 顶栏「GitHub 同步」入口**：支持直接建私有仓并推送、绑定已有仓库、一键输入 commit message 直接同步（免耗 LLM Token）及跳转 GitHub 链接。
3. **对话内自然驱动**：用户在对话中说“帮我把当前项目同步到 GitHub 私有仓库 xxx”，Agent 自动经由 `github_connector` MCP 完成同步并贴回仓库链接。

---

## 6. 待确认项（Todo Decisions）

- [ ] **GitHub 认证方式**：确认是否采用「OAuth Web Flow + PAT 快速连接」双模式，或额外增加 GitHub Device Flow（设备码登录）。
- [ ] **Agent Push 确认策略**：确认允许 Agent 在用户明确指令下直接安全推送（默认私有仓 + 禁 force push + 审计日志），还是强制二次弹窗确认。
- [ ] **实施顺序**：与 [`2026-11-25-cross-agent-fork-and-return.md`](./2026-11-25-cross-agent-fork-and-return.md) 确认先后排期；V1 落地通用 Connector 平台 + GitHub 连接器，V2 扩展 Vercel / Notion / 通用站点连接器。
