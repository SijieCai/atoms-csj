# 仓库维护与研发协作规范（Repository Maintenance Guide）

为保证 `atoms` 仓库在多 Agent、多插件、多需求持续演进过程中保持**架构清晰、决策可追溯、主干随时可部署**，后续所有需求与修复均须遵守本规范。

---

## 1. 一需求一分支（Branch-per-Requirement）

**严禁直接在 `main` 分支上开发并提交新需求。**

每个需求开始前，先确保本地 `main` 已同步最新提交，再按规范从 `main` 切出独立分支：

| 分支前缀 | 适用场景 | 命名示例 |
|---|---|---|
| `feat/<topic>` | 新功能、新 Agent 配方、新插件、新模板 | `feat/deep-research-agent-and-recipes` |
| `fix/<topic>` | Bug 修复、竞态修复、稳定性与安全加固 | `fix/project-switch-agent-state-loss` |
| `refactor/<topic>` | 架构重构、目录或数据模型调整 | `refactor/workspace-thread-decoupling` |
| `docs/<topic>` | 纯文档、规范、设计草案 | `docs/repo-maintenance-guide` |
| `chore/<topic>` | 构建脚本、依赖升级、部署脚本维护 | `chore/update-deploy-script` |

命名要求：
- 全小写英文 `kebab-case`，简明表达本次需求主题（如 `feat/deep-research-agent`）；
- 一个分支只聚焦一个清晰边界的需求，避免多个无关改动混在一个分支；
- 开发与验证完成后，推送分支至远端并通过 PR（或经审查后的 `--no-ff` 合并）合入 `main`，保留清晰的分支研发脉络。

```bash
# 标准起步命令
git checkout main && git pull --ff-only origin main
git checkout -b feat/<short-topic>
```

---

## 2. 先沉淀文档，再写代码（Docs-First Workflow）

每个需求在进入编码前，**必须先将讨论过程、边界约束、关键决策与技术方案记录到 `docs/` 目录下**，并与需求代码留在同一个分支中一起提交：

| 文档类型 | 存放路径 | 记录内容 |
|---|---|---|
| 新需求 / 架构设计 / 方案讨论 | `docs/architecture/YYYY-MM-DD-<topic>.md` | 需求背景、讨论中确认的关键取舍、目录/数据模型/API/前端交互设计、向后兼容与演进路径 |
| 缺陷排查 / 故障复盘 / 根因分析 | `docs/issues/YYYY-MM-DD-<topic>.md` | 复现步骤、根因定位、修复方案、防回归验证项 |

维护要求：
1. **讨论结论及时入库**：如果与维护者/协作者对实现细节做了多轮讨论或补充确认（如安全策略、交互简化原则、兜底机制），需如实写入对应文档，避免决策只停留在聊天记录里。
2. **变更同步文档**：实现过程中如发现边缘场景或调整了原方案，须同步更新对应文档与 [`docs/README.md`](./docs/README.md) 索引。

---

## 3. 扩展能力目录约定（Plugins / Templates / Agents）

新增领域能力时，遵循仓库三层解耦目录结构：

- **`plugins/<plugin-id>/`**：原子能力包，包含 `plugin.json`、`SKILL.md` 与可选 `mcp-server.mjs`。
- **`templates/<template-id>/`**：工作区初始模板，包含 `AGENTS.md`、`package.json` 及运行入口。
- **`agents/<agent-id>/`**：声明式 Agent 配方，包含 `agent.json`（声明组合的 `templateId`、`plugins`、意图规则与 UI 配置）和 `SYSTEM.md`。新增 Agent 优先通过新增配方目录完成，尽量避免在核心路由里写硬编码分支。

---

## 4. 提交与合并前自检清单

推送分支或合并到 `main` 前，务必全部确认通过：

1. **文档已就位**：本次需求的讨论与方案已记录至 `docs/` 并更新 `docs/README.md` 索引。
2. **类型与全量构建通过**：
   ```bash
   npm run typecheck && npm run build
   ```
3. **端到端验证通过**：针对本次需求的核心路径与边界条件跑通真实服务端/接口/工具验证（不以纯静态编译代替实测）。
4. **公网仓库安全检查**：严禁提交 `.env`、`data/`、`dist/`、`node_modules/`、`package-lock.json`、真实 API Key 或内部环境域名。
