# Deep Research 搜索摘要自动落盘保护与通用 Agent 预算控制（Budget Guard）

- **日期**：2026-11-25
- **分支**：`fix/deep-research-persistence-and-agent-budget`
- **类型**：Bugfix + Architecture Enhancement
- **状态**：Fixed（已完成 typecheck / build + MCP 归档实测 + 真实 Deep Research 中途 Abort 自动保留摘要与 Budget 遥测 E2E 验证）

---

## 1. 问题现象与根因分析

用户反馈线上运行 Deep Research 时出现两个痛点：
1. **调研过程耗时很长、检索/阅读了大量文档，却没有把文章摘要记录下来；一旦主动终止，工作区几乎什么也没留下。**
2. **缺少 Agent Budget（预算）控制，无法在耗时过长或费用/Token 过高时快速收口并终止。**

经代码排查，定位到以下 4 个根因：

| # | 根因 | 影响 |
|---|---|---|
| 1 | `plugins/deep-research/mcp-server.mjs` 未挂载工作区目录，所有 `web_search` / `web_fetch` / `web_crawl` 结果仅以文本返回给 LLM 上下文，**未自动落盘到 `sources/` 和 `sources.json`** | 模型若在 Phase 2/3 连续检索 20~40 篇网页迟迟未进入 Phase 4，一旦中断则磁盘上零摘要、零信源 |
| 2 | `server/src/pi-manager.ts` 仅在 `status === 'succeeded'` 时才启动/刷新 Preview Viewer | 手动点击「停止」或超时终止时，即使磁盘已有部分成果，右侧「研究报告」也不会生成阶段性摘要或刷新预览 |
| 3 | Deep Research Skill/Prompt 未约束单轮检索次数上限与增量落盘纪律 | 模型容易贪多求全无限发散搜索，耗费大量时间与 Token |
| 4 | `pi-manager.ts` 未解析 Pi RPC 的 `usage`（`input`/`output`/`cacheRead`/`totalTokens`），`models.json` 单价全为 0，且无任何时间/费用/Token/工具步数预算护栏 | 无法追踪实时消耗，也无法在超预算前自动提醒收口或到达上限时快速终止 |

---

## 2. 解决方案设计

### Part A：Deep Research 工具层自动归档 + 中断兜底报告（永不空手而归）

1. **注入 `ATOMS_WORKSPACE_DIR` 给 `web_research` MCP Server**
   - `plugins/deep-research/plugin.json` 在 `envNeeds` 中声明 `ATOMS_WORKSPACE_DIR`；
   - `server/src/plugin-registry.ts` 在 `prepareProjectAgentBundle` 时自动传入当前工作区路径。
2. **MCP Server 原子化自动落盘（`plugins/deep-research/mcp-server.mjs`）**
   - **`web_search`**：每次检索自动追加记录到 `sources/_search-log.json` 与 `sources/00-search-digest.md`，并将去重后的候选结果以 `status: "snippet"` 合并进 `sources.json`（不覆盖已有 `"fetched"` 精读条目）。
   - **`web_fetch` / `web_crawl`**：每次成功抓取网页正文后，自动将标题、URL、抓取时间、自动提炼摘要与清洗后 Markdown 写入 `sources/NN-<domain>-<slug>.md`，并原子化（临时文件 + rename）upsert 到 `sources.json`（升级为 `status: "fetched"`，附带 `noteFile`、`summary`、`charCount`、`fetchedAt`）。
   - 工具响应附带 `archived` 元数据，明确告知 Agent 已落盘路径与编号，避免模型重复搬运全文。
3. **中断/超预算兜底报告合成器 + 自动刷新预览（`server/src/pi-manager.ts`）**
   - 在 `finalizeRun` 中，对 `deep-research` 工作区：无论 `status` 是 `aborted`、`failed` 还是预算触发终止，若 `report.md` 仍为空或初始占位模板，但 `sources.json` / `sources/` 已有自动归档信源，则自动合成一份《阶段性深度调研摘要（已自动保存）》写入 `report.md`（含终止原因、预算消耗统计、研究计划、所有已精读文章摘要与笔记路径、所有已检索文章清单与原链接），并**启动/刷新右侧报告预览服务**。
4. **收紧研究 Prompt & Skill 收敛纪律**
   - 更新 `agents/deep-research/SYSTEM.md`、`plugins/deep-research/SKILL.md`、`templates/deep-research/AGENTS.md`：明确 3–6 次聚焦检索 + 4–8 篇核心精读后立刻收敛撰写 `report.md`，禁止无限递归深挖，且必须响应系统预算收口提示。
5. **报告预览器增强（`templates/deep-research/public/index.html`）**
   - 在「参考信源库」区分显示 `已精读`（`status === 'fetched'`）与 `检索摘要`（`status === 'snippet'`）徽标及对应 `sources/*.md` 笔记文件名。

### Part B：通用两阶段 Agent Budget Control（软警告收口 + 硬阈值强停 + UI 实时展示）

1. **四维预算配置（配方默认值 + `.env` 全局覆盖）**
   - 维度：`maxDurationMs`（时长）、`maxCostCny`（估算费用，人民币 CNY）、`maxTokens`（总 Token）、`maxToolCalls`（工具调用次数）、`softWarnRatio`（软警告比例，默认 `0.75`）。
   - 配方级默认值（`agents/*/agent.json`）：
     - `deep-research`：`maxDurationMs = 360_000`（6 分钟）、`maxCostCny = 2.0`、`maxTokens = 300_000`、`maxToolCalls = 25`、`softWarnRatio = 0.75`
     - `fullstack-coder`：`maxDurationMs = 720_000`（12 分钟）、`maxCostCny = 5.0`、`maxTokens = 500_000`、`maxToolCalls = 45`、`softWarnRatio = 0.75`
   - 环境变量定价与覆写（`server/src/config.ts` & `.env.example`）：
     - `GLM_INPUT_PRICE_PER_M` / `GLM_OUTPUT_PRICE_PER_M` / `GLM_CACHE_READ_PRICE_PER_M`（按百万 Token 人民币单价可配）
     - `AGENT_BUDGET_MAX_DURATION_MS` / `AGENT_BUDGET_MAX_COST_CNY` / `AGENT_BUDGET_MAX_TOKENS` / `AGENT_BUDGET_MAX_TOOL_CALLS` / `AGENT_BUDGET_SOFT_RATIO`
2. **精确 Token 与费用统计（零重复累加）**
   - `committedUsage` 在每轮 `message_end`（`role === 'assistant'`）与 `compaction_end` 时权威累加；
   - `inflightUsage` 跟踪当前未结束轮次的 `message_update.usage` 并在 `message_end` 清零；
   - 实时消耗 = `committedUsage + inflightUsage`，实时按配置单价折算 `estimatedCostCny`。
3. **两阶段优雅收口机制**
   - **Soft Warning（任意维度 ≥ 75%）**：自动向 Pi 发送 `steer` 收口指令（要求立刻停止搜索/发散，基于已有成果立即输出 `report.md` 或完成构建），广播 `agent_status` 与 `agent_budget_update`。
   - **Hard Stop（任意维度 ≥ 100%）**：立即触发 `abort`（4s 后 `SIGKILL`），记录精确超限原因（如「达到费用预算上限 ¥2.00」或「达到时间预算上限 6 分钟」），并在 Deep Research 中自动触发兜底摘要报告合成。
4. **前端实时预算条（`AgentStepCard.tsx`）**
   - 新增 `agent_budget_update` SSE 事件并在 `ActiveRunSnapshot` / `MessageMetadata` 持久化；
   - 运行中实时显示：已耗时/上限、工具步数/上限、Token 数/上限、估算费用（`¥X.XXXX / ¥Y.YY`）与彩色进度条（75% 橙色预警，100% 红色超限）；结束后保留精简消耗汇总条。

---

## 3. 验证计划

1. `npm run typecheck && npm run build` 零错误。
2. MCP Server 自动归档实测：直接调用 `web_search` 与 `web_fetch`，验证工作区 `sources.json`、`sources/00-search-digest.md`、`sources/01-*.md` 原子生成且字段完整。
3. 端到端中断保护与 Budget 实测：
   - 启动真实 Deep Research 任务，中途（检索/抓取几篇后尚未写 `report.md` 时）手动调用 `/abort`；
   - 验证磁盘自动留存了 `sources.json`、`sources/*.md` 以及服务端自动合成的阶段性 `report.md`，且 `previewUrl` 可访问渲染出全部文章摘要；
   - 验证 Token / Cost / ToolCalls 统计与 Budget 超限快速终止逻辑正常工作。
