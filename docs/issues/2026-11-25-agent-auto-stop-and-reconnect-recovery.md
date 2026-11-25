# 线上 Agent 自动停止与断连/关闭页面状态恢复复盘与修复方案

- **日期**：2026-11-25
- **类型**：Bugfix / Reliability Enhancement
- **状态**：Fixed（已通过 `typecheck`、`build` 与真实 Agent 断连/重连 E2E 实测）

---

## 1. 现象描述

代码部署到线上（`https://atoms.maplink.site`，Caddy 反代 + systemd `atoms.service`）后出现：

1. 运行中的 Agent 会出现「自动停止」现象；
2. 服务端与前端连接断开、或用户刷新/关闭页面后重新打开时，缺少完整的重连握手与状态恢复机制，前端无法得知后端 Agent 是否仍在工作，也无法自动回到正在执行的对话。

线上 `journalctl -u atoms` 与内核 `dmesg` 排查确认：`atoms.service` 未崩溃、无 OOM Killer 记录；同时暴露了 `pi-manager.ts` 缺乏结构化 Agent 生命周期日志的问题。

---

## 2. 根因分析

### A. 前端断连 / 重连 / 关闭页面重开导致状态脱节（“假停”）

1. **SSE 缺少显式心跳帧与自愈重连机制**
   - `server/src/event-bus.ts` 原每 20s 仅发送注释帧 `: ping\n\n`，浏览器 `EventSource.onmessage` 无法感知，公网 NAT / 休眠导致的 TCP Half-open 假死连接不会被察觉。
   - `web/src/App.tsx` 直接使用裸 `new EventSource`，未监听 `onerror`、无心跳超时 watchdog、无指数退避重连，也未监听 `visibilitychange` / `focus` / `online`。
2. **全局流 `/api/events` 重连无握手同步**
   - 服务端仅发送 `{ type: 'user_connected', username }`，前端未处理该事件；断连期间的 `project_activity` / `project_run_finished` / `workspace_updated` 永久丢失。
3. **对话流 `/api/projects/:id/events` 握手存在 `seq` 卡死与漏同步 Bug**
   - `connected` 事件使用 `Math.max(lastStreamSeqRef.current, parsed.activeRun.seq)`，服务端若重启导致 `projectSeqs` 归零，前端会静默丢弃所有 `seq <= lastStreamSeqRef.current` 的新事件。
   - 断连期间若已完成整轮任务且断连前 `liveStreamRef` 为空，重连后不会补拉 `GET /api/projects/:id`；且完成后未刷新 `workspaces` 与 `previewRevision`。
4. **刷新 / 关闭页面重开后不会自动恢复现场**
   - `activeProjectId` 初始化固定为 `null`，未记忆 URL `?thread=` 或 `localStorage`，也未自动选中仍在 `building`/`queued` 的运行中对话。
5. **生产 Caddy 对 SSE 路由开启了全局压缩**
   - `deploy/Caddyfile` 顶层 `encode zstd gzip` 覆盖了 `/api/events` 与 `/api/projects/*/events`，容易引入流式缓冲延迟或断流。

### B. 服务端会导致 Agent 提前终止的隐患（“真停”）

6. **拦截并扼杀了 Pi 内置自动重试**
   - `server/src/pi-manager.ts` 在 `message_update` 收到 `assistantMessageEvent.type === 'error'` 时立即调用 `finalizeRun` 并 `SIGTERM` 杀死子进程，中断了 `@earendil-works/pi-coding-agent` 内置的 `auto_retry_start` / `auto_retry_end` 指数退避重试机制。
7. **固定 8 分钟总超时硬杀长任务**
   - `AGENT_TIMEOUT_MS` 默认仅 `480_000ms`（8 分钟）且按启动时刻硬截断，不区分「仍在活跃调用工具」与「真正卡死无响应」。
8. **运行期缺少 Checkpoint 持久化与生命周期日志**
   - 运行过程仅存内存，若进程异常退出则已完成的步骤记录全部丢失；且未打印 Agent 启停/重试/超时日志，线上难以排查。

---

## 3. 修复方案

### 模块 1：服务端 SSE 协议与生产反代加固
- `shared/src/types.ts`：
  - 新增 `heartbeat` 事件（项目流与全局流均支持）。
  - `connected` 握手事件新增 `serverBootId`、`projectStatus`、`latestMessageId`、`messageCount`。
  - `user_connected` 握手事件新增 `serverBootId`、`activeProjectIds`、`ts`。
- `server/src/event-bus.ts`：
  - 引入进程级 `bootId`；每 15s 发送真实 JSON SSE `heartbeat` 数据帧。
  - 维护每对话轻量环形事件缓存（`MAX_BUFFER = 200`）并在删除对话时清理。
- `server/src/index.ts`：
  - `GET /api/projects/:id/events` 原子化构建握手快照并先写入 `connected` 再订阅 `eventBus`，保证单线程事件循环下零竞态、后续事件严格满足 `seq > connected.seq`。
  - `GET /api/events` 握手携带 `serverBootId` 与 `activeProjectIds`。
- `deploy/Caddyfile`：
  - 通过 `@compressible` matcher 排除 `/api/events` 与 `/api/projects/*/events` 的压缩。

### 模块 2：前端自愈连接器与任意场景状态恢复
- 新增 `web/src/sse.ts`（`ResilientEventSource`）：
  - 35s 心跳 Watchdog（超时即判半开假死并重连）、`onerror` 自动关闭并指数退避重连（1s → 2s → 4s → 8s → 15s）、401 鉴权失效自动停止重连、支持 `reconnectNow()` 主动拉起。
- `web/src/App.tsx`：
  - 全局流与项目流全部迁移至 `ResilientEventSource`，向 `ChatPanel` 透传 `connectionState`。
  - `connected` 握手直接以服务端权威 `seq` 校准 `lastStreamSeqRef`（并追踪 `serverBootId`），任何 `activeRun` 变化、消息数/末条消息 ID 差异或重连均自动触发 `reconcileActiveProject`，同步消息、工作区与预览版本。
  - `user_connected` 重连触发 `refreshAll()` + 当前对话对账。
  - 监听 `visibilitychange` / `focus` / `online` 自动唤醒重连与对账。
  - 运行期间若 SSE 处于 `reconnecting`，启动 4s HTTP 兜底轮询 `GET /api/projects/:id`，SSE 恢复后自动停止。
  - 持久化 `activeProjectId` 到 URL `?thread=` 与 `localStorage`；页面刷新或关闭重开后自动按「URL `?thread=` → `localStorage` → 任意正在运行中的对话」顺序恢复现场。
- `web/src/components/ChatPanel.tsx`：
  - 连接重连期间在顶部展示轻量提示条，告知用户「服务端 Agent 仍在后台独立运行，重连后自动同步进度」。

### 模块 3：服务端 Agent 防误停、智能超时、Checkpoint 与可观测性
- `server/src/config.ts` & `.env.example`：
  - 新增 `AGENT_IDLE_TIMEOUT_MS`（默认 300,000ms = 5 分钟无任何事件才判卡死）。
  - `AGENT_TIMEOUT_MS`（总耗时上限）默认提升至 `1_800_000ms`（30 分钟）。
- `server/src/pi-manager.ts`：
  - 不再在 `message_update(error)` 提前 `finalizeRun`，改为记录 `lastError` 并等待 Pi 自动重试；完整处理 `auto_retry_start` / `auto_retry_end` / `compaction_start` / `compaction_end` / `message_end(stopReason)`，以 `agent_settled` 为最终权威收敛点。
  - 双计时器（空闲看门狗 + 总时长硬上限），任何子进程事件/输出均刷新空闲看门狗。
  - 每 8s 或每完成一个工具调用，节流持久化 Checkpoint 到 SQLite `messages` 表。
  - 输出结构化 `[pi-agent]` 生命周期日志（`start` / `auto_retry` / `compaction` / `idle_timeout` / `max_timeout` / `child_close` / `finalized`）。
- `server/src/db.ts`：
  - 升级 `recoverStaleBuildingProjects()`：保留已落盘 Checkpoint 的工具步骤与思考过程，仅补充中断说明，避免丢失历史进度。

---

## 4. 验证计划

1. `npm run typecheck && npm run build`（含 `shared`、`server`、`web`）。
2. 服务端接口与 SSE 握手测试：验证 `connected` / `user_connected` 含 `serverBootId`、`activeProjectIds`、`latestMessageId`、`messageCount`，且 15s 内收到真实 `heartbeat` 事件。
3. 模拟断连与重连恢复 E2E：在 Agent 运行中途断开 SSE / 模拟服务端重启 / 刷新页面（带 `?thread=` 与裸 URL），验证自动恢复 `activeProjectId`、`liveStream` 快照、无丢事件、完成后正确更新消息与预览。
4. Pi 重试与超时逻辑单元测试/验证：确认瞬时 stream error 不再提前杀死子进程，且结构化日志正常输出。
