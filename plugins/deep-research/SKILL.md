---
name: deep-research
description: Multi-source deep research using web_research MCP (search, fetch, crawl). Adapted from popular open-source GitHub deep-research skills (affaan-m/everything-claude-code & adversarial verification workflows). Produces thorough, fact-checked, cited research reports with source attribution, confidence ratings, and gap analysis.
---

# Deep Research Skill (Multi-Source Web Investigation)

> Adapted from the open-source GitHub `deep-research` Agent Skill workflow (`affaan-m/everything-claude-code`, MIT) with explicit multi-source verification, adversarial cross-checking, and structured workspace deliverables (`plan.md`, `sources/`, `sources.json`, `report.md`).

Shallow research repeats the top search result with false confidence. **Deep research** plans its angles, triangulates primary sources, checks counter-arguments, and delivers an actionable report with traceable receipts and honest caveats.

## Available MCP Tools (`web_research`)

1. `mcp__web_research__web_search` — Multi-source federated web search (`source`: `"auto"` | `"web"` | `"tech"` | `"academic"` | `"github"` | `"wiki"`). Supports optional Tavily/Firecrawl API upgrade and built-in zero-key Bing RSS + Wikipedia + HackerNews + GitHub + arXiv search.
2. `mcp__web_research__web_fetch` — Fetch a single public URL and extract clean readable Markdown text, title, description, and links (with SSRF protection and GitHub README awareness).
3. `mcp__web_research__web_crawl` — Shallow breadth-first crawl from a seed URL across up to `maxPages` (default 4, max 6) high-value subpages. Ideal for official documentation, pricing pages, or competitor sites.
4. `mcp__web_research__extract_links` — Inspect outbound/internal links on a page before deciding which pages to deep-read.

---

## 4-Phase Deep Research Pipeline

### Phase 1 — Scope & Research Plan (`plan.md`)
Before searching broadly:
1. Pin down the exact research question, target audience, comparison dimensions, and recency window (check current year).
2. Decompose the topic into **3–5 concrete sub-questions** covering:
   - Core facts / architecture / landscape
   - Primary vendor / official documentation or academic benchmarks
   - Trade-offs, critiques, failure modes, and dissenting viewpoints
   - Practical recommendations / decision matrix
3. Write this plan immediately into `plan.md` in the workspace root so the user can inspect the investigation strategy in real time.

### Phase 2 — Fan-Out Search (Breadth First, Budget-Bounded)
1. Execute **3–6 distinct** `mcp__web_research__web_search` calls — do NOT endlessly loop or reword the same query:
   - Use both English and Chinese queries when researching global technology/markets (English queries often uncover primary engineering docs, benchmarks, and GitHub repos).
   - Mix `source` modes where relevant: `"auto"`, `"web"`, `"github"`, `"tech"`, `"academic"`, `"wiki"`.
   - Explicitly run at least one **contrarian / critique query** (e.g., `"<topic> limitations OR drawbacks OR vs"`).
2. Prefer **primary sources** (official docs, GitHub repositories, papers, release notes, benchmarks) over aggregator listicles.
3. Aim to deep-fetch **4–8 highest-value primary sources** rather than 30+ noisy pages — quality and timely synthesis beat exhaustive crawling.

### Phase 3 — Deep Crawl & Incremental Persistence (`sources/` + `sources.json`)
1. Never cite a page solely from a search snippet if it backs a load-bearing claim — call `mcp__web_research__web_fetch` (or `web_crawl` for multi-page docs) to read the actual primary content!
2. **Automatic archiving is built into `web_research` MCP**: every `web_search` automatically logs snippets into `sources/00-search-digest.md` & `sources.json`, and every `web_fetch` / `web_crawl` automatically saves a full structured note file into `sources/NN-*.md` and updates `sources.json` (`status: "fetched"`, `summary`, `noteFile`). You can refine `summary` / `reliability` in `sources.json` as needed, but do NOT spend extra turns re-copying raw pages.
3. **Budget Discipline**: if the platform sends a budget warning (`75%+` of time/cost/tokens/steps used), **stop searching immediately** and move directly to Phase 4 (`report.md`) using the already-archived `sources.json` and `sources/*.md`.
   ```json
   [
     {
       "id": 1,
       "title": "Source Title",
       "url": "https://...",
       "domain": "example.com",
       "type": "primary | docs | repo | paper | discussion | news",
       "status": "fetched | snippet",
       "noteFile": "sources/01-example-com-title.md",
       "publishedAt": "2026-05",
       "reliability": "high | medium | low",
       "summary": "Key verified facts extracted from this source"
     }
   ]
   ```
3. **Adversarial checks before trusting a claim**:
   - Distinguish vendor self-claims from independent benchmarks.
   - Check publication dates — never present 2023/2024 numbers as current without stating the date.
   - Surface disagreements honestly instead of smoothing them into false consensus.
   - Assign confidence labels on key conclusions: `高置信（多源交叉印证）` / `中置信（单一主源）` / `存在分歧` / `待进一步验证`.

### Phase 4 — Synthesize Cited Report (`report.md`)
Write a thorough, publication-grade Markdown report to `report.md` following this structure:

1. **标题与元数据**（研究主题、调研日期、覆盖信源数、总体置信度）
2. **核心结论摘要（Executive Summary）**：先给明确、可行动的结论，而不是铺垫废话
3. **分维度深度分析**：每个维度包含对比表格（Markdown Table）、关键事实、**内联引用编号 `[1]`、`[2]`** 与置信度标注
4. **争议点、局限性与风险（Disagreements & Caveats）**：哪些观点存在分歧、哪些数据尚未查证、什么前提变化会推翻结论
5. **落地建议 / 决策矩阵（Recommendations）**
6. **参考信源清单（References）**：按 `[1] [标题](URL) — 简注` 严格与 `sources.json` 一一对应

## Non-Negotiable Rules
- **NEVER fabricate a URL, statistic, or citation.** Every `[n]` in `report.md` MUST correspond to a real URL returned by `web_search` / `web_fetch` / `web_crawl` in this session.
- If a source fails to fetch (paywall, timeout, anti-bot), note the gap transparently and look for an alternative primary source rather than guessing its contents.
- Update `sources.json` and `report.md` before finishing so the live **Research Report Preview** renders immediately and accurately.
- Respond in the user's language (default Chinese when prompted in Chinese) with a crisp executive summary in chat pointing them to the full interactive report in the right-hand preview panel.
