# 架构升级：代码仓库（Workspace）与对话线程（Thread）解耦（P0 + P1）

- **日期**：2026-11-25
- **背景**：多代码项目并行开发 & 单代码项目多对话协作时的上下文边界与视图隔离问题

---

## 一、问题背景与诊断

### 1. 用户遇到的现象
1. 在一个对话中构建了「在线计算器」，服务端生成了对应代码目录。
2. 并行新建第二个对话后，点击右上角「打开 VS Code」，体感上与原有仓库的上下文关系混乱；
3. 当用户同时拥有**多个独立代码项目**，或希望用**多个并行对话在同一个代码项目里协作**时，现有单一 `Project` 模型无法准确表达这两种关系。

### 2. 根因拆解
- **P0（前端视图隔离 Bug）**：
  - `web/src/App.tsx` 的 `<WorkspacePanel />` 与 `web/src/components/WorkspacePanel.tsx` 的 `<CodeEditorIDE />` 未绑定 `key`，切换项目时 React 复用组件实例，导致旧项目的文件树、已打开 Tab、Monaco Model 在异步刷新前短暂残留。
  - 点击「打开 VS Code」仅触发 `workspace/init`，未自动切换到右侧的 `VS Code` 标签页，且右侧面板缺少显式的「当前所属代码仓库」上下文标识。
- **P1（核心领域模型耦合）**：
  - 此前系统中 `Project` 同时承担了「一次对话（Chat/Agent Session）」和「一个代码仓库（Workspace/Repo）」两个角色（强 1:1 绑定）。
  - 后果：
    1. “新建对话”隐式等同于“新建空仓库”，无法在已有仓库上开启第二个并行对话；
    2. 多个对话无法共享同一个代码目录、SQLite 命名空间和预览服务；
    3. 缺乏按代码仓库维度的写并发控制。

---

## 二、P0 + P1 目标架构：`Workspace (1) : Thread (N)`

将原来的单一实体拆分为两个正交的一级概念：

| 概念 | 职责 | 物理隔离边界 |
|---|---|---|
| **`Workspace`（代码仓库 / 工作区）** | 代码、数据与运行环境的唯一边界 | `data/workspaces/<workspaceId>/`、SQLite 表前缀 `u_<owner>_<short>__`、预览路由 `/preview/<workspaceId>/`、LSP `WS /api/workspaces/:wsId/lsp` |
| **`Thread / Project`（对话线程）** | 需求讨论、任务上下文与子 Agent 执行会话 | 独立消息表 `messages`、独立 Pi 会话目录 `.pi-sessions/<threadId>/`；可绑定到一个 `Workspace`，也可为 `workspaceId = null` 的独立对话 |

### 1. 向后兼容与平滑数据迁移
- 新增 SQLite 表 `workspaces (id, owner, name, preset_id, created_at, updated_at)`。
- `projects` 表新增可空外键列 `workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL`。
- 服务启动时自动迁移存量数据：对 `has_workspace = 1 AND workspace_id IS NULL` 的旧项目，直接用原 `project.id` 创建同名 `workspaces` 记录并回填 `workspace_id = id` —— **磁盘目录、SQLite 物理表前缀、以及既有 `/preview/<id>/` 分享链接 100% 无损保留**。

### 2. 并发策略：不同仓库全并行 + 同仓库「读/聊并行，写任务队列」
- **不同 Workspace**：完全并行执行各自的子 Agent（受全局 `MAX_CONCURRENT_AGENTS` 上限保护）。
- **同一 Workspace 下的多个对话**：
  - **聊天 / 查代码 / 开 VS Code / 查数据表**：完全并行，互不阻塞。
  - **写代码构建任务（Build）**：按 `workspaceId` 维护 **写锁 + FIFO 队列**：
    - 当对话 A 正在修改某个 `Workspace` 时，同仓库的对话 B 发起构建会自动进入该仓库的等待队列（状态标记为 `queued`，UI 明确显示「排队中 · 等待『对话 A』完成当前修改」）；
    - 对话 A 完成或中止后，服务端自动拉起队列中的对话 B；
    - 排队中的对话也支持随时点击「停止 / 取消排队」；
    - 同一对话正在执行中继续发消息，仍走原有的 `steer` 实时插话。
- **Pi 会话目录隔离**：每个对话的 Pi Session 存放在 `<workspaceDir>/.pi-sessions/<threadId>/`，同仓库下多个对话的上下文互不污染。

### 3. 前端 P0 隔离与 P1 交互设计
- **P0 严格隔离**：
  - `<WorkspacePanel key={activeWorkspace.id} ... />` 与 `<CodeEditorIDE key={workspace.id} ... />` 按 `workspace.id` 强制重置实例，杜绝跨仓库视图/编辑器状态残留。
  - 点击「打开 VS Code」或关联/新建仓库后，自动展开右侧工作区并切到 `VS Code` 标签页。
  - 右侧工作区顶部增加醒目的**仓库上下文标识条**（`📁 仓库名` + `workspaceId` + 正在构建该仓库的对话提示）。
- **P1 清晰的两层导航与显式绑定**：
  - 左侧 `Sidebar` 分为两个区域：
    1. **代码仓库列表（Workspaces）**：每个仓库可展开查看归属它的所有对话；仓库行内置「+ 新对话」快捷按钮（直接在当前仓库下开并行对话）与删除按钮。
    2. **未绑定对话（Standalone Chats）**：展示尚未绑定任何代码仓库的纯对话。
  - 在未绑定仓库的对话顶部，提供显式选择入口：
    - **新建独立代码仓库**（创建全新 `ws_xxx` 目录并在右侧打开 VS Code）；
    - **关联已有代码仓库**（下拉选择已有仓库如「在线计算器」，立刻挂载该仓库的代码、数据表与预览）；
    - 若用户在未绑定对话中直接发起构建指令，则自动新建独立 `Workspace` 并绑定，保持首屏一句话建站的零门槛体验。

---

## 三、后续演进预留（P2）

在 P1 解耦完成后，如需在同一代码仓库中让多个子 Agent **真正同时修改代码**，可在此架构上平滑升级为 **Git Worktree 隔离**：每个并行写任务基于 `Workspace` 仓库创建独立 `worktrees/<threadId>` 分支目录，完成后提供 Diff 审阅与一键合并回主分支。

---

## 四、验收标准

1. **老数据无损迁移**：已有 `在线计算器` 等旧项目自动迁移为独立 `Workspace`，原有文件、SQLite 表与预览链接正常工作。
2. **P0 彻底隔离**：切换不同代码仓库时，右侧文件树、VS Code 打开的 Tab、LSP 连接与预览 iframe 完全独立无残留；点击「打开 VS Code」自动切到编辑器视图并显示所属仓库名。
3. **P1 多仓库 & 单仓库多对话**：
   - 可在「在线计算器」仓库下新建第二个对话，两个对话共享同一套代码目录、数据表与预览，但拥有各自独立的聊天记录与 Pi Session；
   - 可在未绑定对话中显式选择「新建独立仓库」或「关联已有仓库」。
4. **同仓库写任务队列**：同一仓库的两个对话同时触发构建时，第二个任务正确进入排队态并在第一个任务完成/中止后自动启动，不同仓库的任务保持并发。
