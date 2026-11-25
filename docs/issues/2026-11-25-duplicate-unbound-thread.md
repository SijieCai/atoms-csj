# 新建对话发送首个问题时出现两个重复「未绑定对话」排查复盘

- **日期**：2026-11-25
- **分支**：`fix/duplicate-unbound-thread`
- **影响范围**：`web/src/App.tsx`、`web/src/components/ChatPanel.tsx`

---

## 1. 现象

点击左侧「新建对话」进入空白对话页，输入首个问题并发送后，左侧「未绑定对话」列表会立刻出现**两条完全相同的对话记录**（刷新页面后恢复为 1 条）。

---

## 2. 根因定位

这是一起**全局用户级 SSE 推送与 HTTP 响应竞态**叠加前端状态未去重导致的 bug：

1. 在空白对话页（`activeProjectId === null`）发送首条消息时，`App.tsx::handleSend` 会调用 `POST /api/projects` 自动建对话。
2. 后端 `server/src/index.ts` 在落库后、返回 HTTP `201` 之前，会立刻通过用户级全局 SSE（`/api/events`）广播 `project_updated` 事件。
3. 前端全局 SSE 监听器先于 `fetch('/api/projects')` Promise resolve 收到 `project_updated`，将新建的 `project` 写入了 `projects` state。
4. 几毫秒后 `await api.createProject(...)` 返回，`App.tsx::handleSend` 中执行了无去重的前置拼接：
   ```ts
   setProjects((prev) => [created.project, ...prev]);
   ```
   导致同一 `project.id` 在 `projects` 数组中被插入两次，侧边栏「未绑定对话」遂渲染出两条重复条目。
5. 顺带排查：`ChatPanel.tsx::handleKeyDown` 未拦截中文输入法组合态（`e.nativeEvent.isComposing`），且 `handleSend` 读取的是渲染闭包中的 `activeProjectId` 而非 `activeProjectIdRef.current`，在极快连续按键下也有二次建对话风险。

---

## 3. 修复方案

1. **统一 `upsertById` 去重写入 (`web/src/App.tsx`)**：
   - 新增通用纯函数 `upsertById<T extends { id: string }>(list, item)`，替换 `App.tsx` 中所有 `setProjects` / `setWorkspaces` 的手动前置拼接逻辑，从结构上杜绝 HTTP 响应与全局 SSE 竞态产生的重复项。
   - `handleSend` 使用 `activeProjectIdRef.current` 并加 `creatingProjectRef` 锁防止并发重复建对话。
2. **中文输入法组合态保护 (`web/src/components/ChatPanel.tsx`)**：
   - 在 `handleKeyDown` 中增加 `if (e.nativeEvent.isComposing || e.keyCode === 229) return;`，避免拼音候选敲回车误触发送。

---

## 4. 验证

- `npm run typecheck && npm run build` 全部通过；
- 核对全局 SSE `project_updated` 与 `api.createProject()` 并发到达场景，`upsertById` 保证同一 `project.id` 仅保留单条最新状态。
