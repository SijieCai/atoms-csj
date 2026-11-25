# Issue: 切换不同项目时子 Agent 工作状态丢失

- **日期**：2026-11-25
- **影响范围**：多项目并发构建、项目切换、页面刷新、左侧项目列表状态同步
- **严重程度**：High（用户切换项目后无法感知后台子 Agent 是否仍在正常工作，也无法看到当前进度）

---

## 一、问题现象

1. 用户在项目 A 启动全栈构建（子 Agent `Pi Coding Agent` 正在后台执行工具调用、写代码、编译）。
2. 用户切换到项目 B 查看或对话，随后切回项目 A（或刷新浏览器）。
3. 切回项目 A 后：
   - 之前展示的思考过程、工具调用步骤卡片和实时输出全部消失；
   - 后续子 Agent 继续执行的新步骤也不再出现在界面上，界面呈现“静止/无反应”状态，直到最终构建结束才突然弹出完整结果；
   - 停留在项目 B 时，左侧边栏无法实时感知项目 A 的当前阶段、是否完成或是否报错。

---

## 二、根因分析

服务端 `PiAgentManager` 实际上按 `projectId` 独立维护每个项目的子进程（`ActiveRun`），进程本身并未中断，问题出在前后端状态同步存在 4 处断层：

1. **前端切回项目后丢弃全部后续增量事件（最致命）**
   - `web/src/App.tsx` 在 `handleSelectProject` 切换项目时会关闭旧 SSE 并执行 `setLiveStream(null)`。
   - 切回运行中的项目 A 时，由于错过了最初的 `agent_start` 事件，`liveStream` 维持为 `null`。
   - 前端对 `agent_thinking_delta`、`agent_text_delta`、`agent_tool_start/update/end`、`agent_status` 的处理都带有前置守卫：
     ```ts
     if (!prev || prev.messageId !== parsed.messageId) return prev;
     ```
     导致所有新到达的增量事件被静默忽略。

2. **后端缺少“运行态快照（Snapshot）”下发与序号去重**
   - `server/src/pi-manager.ts` 的 `ActiveRun` 内存中完整保存了 `thinkingText`、`assistantText`、`steps[]` 与当前状态，但 `GET /api/projects/:id` 与 SSE `connected` 事件仅返回 `isBuilding: boolean`。
   - 普通流式对话（`streamChatReply`）也没有内存态快照，切回即丢。

3. **构建收尾期存在状态空窗（`finalizeRun` 竞态）**
   - `server/src/pi-manager.ts` 的 `finalizeRun` 在 `await run.onSettled(...)`（执行 `vite build` 与启动预览服务，耗时数秒）之前就先执行了 `this.activeRuns.delete(run.projectId)`。
   - 若用户恰好在编译/重启预览的这几秒内切回项目，此时 `activeRuns` 已删除而最终消息尚未写入 SQLite，会出现数秒的状态空白。

4. **缺少用户级全局状态推送 & 服务重启后的僵尸状态自愈**
   - 目前 SSE 仅绑定单项目（`/api/projects/:id/events`），切到项目 B 后侧边栏收不到项目 A 的阶段进度或完成/失败通知。
   - 若服务端进程在构建中途重启，SQLite 中 `status = 'building'` 的项目会永久卡在构建中状态。

---

## 三、修复方案（4 层闭环）

### 1. 服务端运行态快照（Snapshot）+ 单调事件序号（`seq`）
- **统一快照模型**（`shared/src/types.ts`）：
  - 新增 `ActiveRunSnapshot`：`runId?`、`messageId`、`mode`（`'build' | 'chat'`）、`startedAt`、`lastActivityAt`、`statusText?`、`thinking`、`text`、`steps: AgentToolStep[]`、`seq`。
  - 所有项目 SSE 事件通过 `eventBus.emit(projectId, event)` 自动附加按项目单调递增的 `seq: number`。
- **完整生命周期覆盖**（`server/src/pi-manager.ts` & `server/src/index.ts`）：
  - `ActiveRun` 持续记录 `startedAt`、`lastActivityAt`、`statusText`、`lastSeq`，提供 `getActiveRunSnapshot(projectId)` 与 `getActiveSummary(projectId)`。
  - 修复 `finalizeRun`：直到 `onSettled` 完成、最终消息落库并广播 `agent_done` 之后，才从 `activeRuns` 移除该记录（用 `finalizing` 标记防重入与拦截期间插话）。
  - 普通流式对话（`streamChatReply`）同样在服务端维护轻量 `activeChatRuns` 快照，支持切回恢复。
  - `GET /api/projects/:id` 与 `GET /api/projects/:id/events`（`connected` 首帧）均返回最新 `activeRun: ActiveRunSnapshot | null`。

### 2. 前端快照水合 + `seq` 去重 + 竞态保护
- **`web/src/App.tsx`**：
  - 切换项目或重连 SSE 时，用 `getProject` / `connected` 中的 `activeRun` 立刻水合 `liveStream`，完整恢复已有思考、文本、工具步骤与时间戳。
  - 记录每个流最后处理的 `seq`，自动忽略 `event.seq <= liveStream.seq` 的过期事件，确保快照与增量无缝续接、不重复拼接。
  - 若极端情况下收到 `agent_*` / `chat_delta` 时 `liveStream` 仍为 `null`，按 `parsed.messageId` 懒初始化而不是丢弃。
  - 为 `handleSelectProject` 引入单调切换序号，防止快速连续切换项目时旧请求回包覆盖当前项目状态。

### 3. 用户级全局 SSE（侧边栏跨项目实时状态同步）
- **后端**：`eventBus` 新增按登录用户（`owner`）维度的订阅与广播；新增 `GET /api/events` SSE 端点，实时推送用户所有项目的状态变更、当前活跃步骤摘要（`activeStep`）、最近活跃时间（`lastActivityAt`）以及后台完成/报错提醒。
- **前端**：
  - 登录后建立持久 `/api/events` 连接，实时更新左侧 `Sidebar` 中所有项目的状态、当前步骤副标题（例如 `正在执行: npm run build`）。
  - 非当前项目在后台完成或失败时，侧边栏展示未读提示点/完成徽标，点击切换至该项目后自动清除。

### 4. 活跃度可视化与僵尸状态自愈
- **活跃度心跳指示**（`web/src/components/ChatPanel.tsx` & `AgentStepCard.tsx`）：
  - 运行中实时显示 `已耗时 mm:ss` 与 `X 秒前活跃`（基于服务端真实的 `startedAt` 与 `lastActivityAt`），直观确认子 Agent 仍在工作。
- **启动自愈**（`server/src/db.ts` & `server/src/index.ts`）：
  - 服务端启动时自动扫描 `status = 'building'` 且无存活子进程的残留项目，将有工作区的项目恢复为 `ready`、无工作区的恢复为 `error`，并追加一条系统提示消息。

---

## 四、验收标准

1. **切换项目恢复完整进度**：项目 A 运行构建产生思考与多个工具步骤 → 切到项目 B → 再切回项目 A，立即看到已产生的所有步骤与输出，且后续新步骤继续实时流式追加、无重复拼接。
2. **收尾期无空窗**：在 `onSettled` 预览构建阶段切回项目 A，仍能看到「正在启动预览服务」状态并平稳过渡到最终消息。
3. **跨项目侧边栏同步**：停留在项目 B 时，左侧边栏实时反映项目 A 的运行中步骤摘要、构建完成/失败状态变化及未读提醒。
4. **重启自愈**：数据库中存在残留 `status = 'building'` 的项目时，服务重启后自动修复为合理终态。
