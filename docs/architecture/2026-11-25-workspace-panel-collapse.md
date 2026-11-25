# 右侧工作区面板支持最小化/右折叠优化

- **日期**：2026-11-25
- **分支**：`feat/workspace-panel-collapse`
- **关联文档**：[`2026-11-25-workspace-thread-decoupling.md`](./2026-11-25-workspace-thread-decoupling.md)

---

## 1. 问题背景

当对话关联代码仓库或研究空间后，右侧 `<WorkspacePanel />` 默认固定占用 `48%–58%`（且 `min-w-[460px]`）的屏幕宽度，无法最小化或向右折叠。用户在长对话阅读、查看 Agent 思考步骤或窄屏设备上使用时，Chat 区域空间受挤压。

---

## 2. 交互与实现方案

1. **右侧面板顶部折叠按钮 (`WorkspacePanel.tsx`)**：
   - 在顶部 Tab 栏右侧新增「折叠右侧面板」按钮（`PanelRightClose` 图标），点击即可一键最小化右侧工作区面板，将主区域空间归还给 Chat。
2. **保持同工作区实例状态不丢失（零闪烁恢复）**：
   - 折叠状态下通过 CSS `hidden` 隐藏同一 `<WorkspacePanel key={activeWorkspace.id} />` 实例而非销毁卸载，这样重新展开时可秒级恢复 VS Code 已打开标签页、未保存草稿、LSP 会话与预览滚动位置；同时仍严格保留 `key={activeWorkspace.id}`，切换不同工作区时依旧彻底重建隔离。
3. **右侧窄停靠条（Dock Rail）+ Chat 顶部一键展开 (`App.tsx`, `ChatPanel.tsx`)**：
   - 折叠后在视口最右侧展示一条 `44px` 宽的轻量停靠条，包含：
     - 展开按钮（`PanelRightOpen`）
     - 当前工作区状态图标（代码仓库 / 研究空间，构建中显示脉冲/旋转指示）
     - 快捷直达按钮：点击可直接展开并切至「预览 / 研究报告」、「VS Code」或「数据表」Tab
   - 同时在 Chat 顶栏右侧显示「展开工作区」按钮；点击消息中的「查看在线预览 / 查看交互式研究报告」或工作区徽章也会自动展开右侧面板。
