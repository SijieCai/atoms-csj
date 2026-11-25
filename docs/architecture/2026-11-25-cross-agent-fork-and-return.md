# 跨 Agent 双向上下文管理：Coding ↔ Deep Research（Fork & Return）

- **日期**：2026-11-25
- **状态**：`TODO / Backlog`（待评审确认后排期实现）
- **关联文档**：
  - [`2026-11-25-deep-research-agent-and-recipes.md`](./2026-11-25-deep-research-agent-and-recipes.md)
  - [`2026-11-25-workspace-thread-decoupling.md`](./2026-11-25-workspace-thread-decoupling.md)

---

## 1. 问题背景

当用户在编码项目（`fullstack-coder`）的对话中提出深度调研需求（`deep-research`）时，仅做单向分叉创建新 Thread 还不够，完整的工程闭环需要解决**双向上下文传递**：

1. **下传（Coding → Research）**：Deep Research 需要感知原编码会话的背景与代码仓库画像（技术栈、依赖、目录结构、当前诉求），同时在自己**完全独立的工作目录和工作项**中执行，不污染原代码仓库、不占用原仓库写锁。
2. **回传（Research → Coding）**：Deep Research 完成后，需要将**提炼后的结论摘要与完整报告产物**自动回流到原编码对话与原编码工作区，使原 Coding Agent 后续可以直接读取并指导编码。

---

## 2. 行业主流产品模式参考

| 模式 | 代表产品 | 核心做法 | 优点与局限 |
|---|---|---|---|
| **隔离函数调用模式（Task Subagent）** | Claude Code | 父 Agent 提炼 Task Brief 下传，子 Agent 在干净上下文独立执行，结束后仅将精炼 Summary + Artifact Ref 回传父对话 | 父上下文极度干净、省 Token；但子任务较黑盒，用户不便直接切入子会话追问或精修报告 |
| **独立子 Thread + 父会话活卡片模式** | Cursor / Background Agent | 子任务是一等公民独立 Thread（可随时切入交互），父对话保留实时状态卡片；子任务完成后自动回传结论摘要与可引用文件 | 兼具隔离性与可交互性；默认 **Human-in-the-loop**（回传结论待用户确认再改代码），避免盲目改乱仓库 |

---

## 3. 拟定 `atoms` 落地设计（Fork & Return）

结合上述两种模式的优点，在现有 `Workspace (1) : Thread (N)` 架构上做克制扩展：

### 3.1 持久化父子血缘关系
在 `platform.db` 的 `projects` 表新增轻量血缘字段：
- `parent_project_id`：发起本次分叉的来源对话 ID
- `parent_workspace_id`：来源对话绑定的工作区 ID
- `handoff_message_id`：父对话中交接卡片的消息 ID（用于实时同步状态）

### 3.2 下传阶段：代码感知上下文包 (`HANDOFF_CONTEXT.md`)
从 Coding Thread 分叉创建 Research Workspace 时，服务端只读采集原代码仓库画像并注入新研究空间的 `HANDOFF_CONTEXT.md`：
- 原仓库名称、目录文件树、`package.json` 依赖清单、已有 SQLite 表结构概要；
- 原对话最近讨论摘要与本次明确研究问题；
- 委派提示：告知 Research Agent 其调研结论将回传用于指导上述技术栈开发，重点输出可落地的选型对比与风险提示。

### 3.3 执行阶段：物理隔离 + 父卡片实时同步
- Research 在独立 `ws_...` 目录维护 `plan.md`、`sources/`、`sources.json`、`report.md`，不阻塞原代码仓库的构建队列；
- 父对话的交接卡片通过全局 SSE 实时更新状态（`🔬 调研中...` → `✅ 调研完成`）；
- 子对话顶栏提供 `← 返回来源编码对话` 面包屑快捷跳转。

### 3.4 回传阶段：双通道自动回流（Return Hook）
当子 Research Agent 完成（`piManager.finalizeRun` 成功）且存在 `parent_project_id` 时，自动触发：
1. **只读产物挂载到父代码仓库**：
   - 将完整 `report.md` 同步复制到父代码仓库的 `.atoms-research/<researchWsId>-report.md`（隔离于 `client/`、`server/` 之外，Coding Agent 后续可直接 `read`，且不撑爆聊天上下文）。
2. **向父编码对话写入「调研结论回传卡片」**：
   - 包含 `report.md` 提炼的核心结论摘要、信源条数、挂载路径；
   - 提供快捷动作按钮：`📄 查看完整研究报告` 与 `💻 采纳结论并继续开发`。

---

## 4. 待确认项（Todo Decisions）

- [ ] **回传后是否自动唤醒父 Coding Agent**：
  - 默认建议 **Human-in-the-loop**（先回传结论卡片，用户确认后再继续写代码）；
  - 可选增强：识别用户明确串联指令（如“先调研完直接帮我集成进项目”）时支持自动续跑（`continueAfterReturn`）。
- [ ] **导航交互**：触发分叉后是否保持自动切到子 Research Thread，同时在顶部展示「← 返回来源编码对话」面包屑。
- [ ] **排期优先级**：与 [`2026-11-25-connector-platform-and-github.md`](./2026-11-25-connector-platform-and-github.md) 协调先后顺序。
