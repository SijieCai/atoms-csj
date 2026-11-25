import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  ActiveRunSnapshot,
  AgentBudgetConfig,
  AgentBudgetSnapshot,
  AgentToolStep,
  AgentUsageStats,
  MessageDTO,
  MessageMetadata,
} from '@atoms/shared';
import { config, ensureDataDirs } from './config.js';
import { dbStore, generateId, toProjectDTO, toWorkspaceDTO } from './db.js';
import { eventBus } from './event-bus.js';
import { pluginRegistry } from './plugin-registry.js';

function resolvePiCliPath(): string {
  const candidates = [
    path.join(config.repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent'),
    path.join(config.repoRoot, 'server', 'node_modules', '@earendil-works', 'pi-coding-agent'),
  ];
  for (const pkgDir of candidates) {
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
        bin?: string | Record<string, string>;
      };
      const relBin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi || 'dist/bundle/cli.js';
      const resolved = path.resolve(pkgDir, relBin);
      if (fs.existsSync(resolved)) return resolved;
    }
  }
  const binFallback = path.join(config.repoRoot, 'node_modules', '.bin', 'pi');
  if (fs.existsSync(binFallback)) return binFallback;
  throw new Error('无法找到 @earendil-works/pi-coding-agent，请先运行 npm install');
}

export function ensurePiConfigFile(): void {
  ensureDataDirs();
  const modelsJsonPath = path.join(config.piConfigDir, 'models.json');
  const isGlm5Series = /^glm-5/i.test(config.glmModel);
  const isMultimodal = /flash|v/i.test(config.glmModel);
  const modelsConfig = {
    providers: {
      glm: {
        name: 'Zhipu GLM',
        baseUrl: config.glmBaseUrl,
        api: 'openai-completions',
        apiKey: '$GLM_API_KEY',
        authHeader: true,
        models: [
          {
            id: config.glmModel,
            name: config.glmModel,
            reasoning: true,
            input: isMultimodal ? ['text', 'image'] : ['text'],
            contextWindow: isGlm5Series ? 1_000_000 : 204_800,
            maxTokens: isGlm5Series ? 65_536 : 16_384,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
            compat: {
              supportsStore: false,
              supportsReasoningEffort: false,
              maxTokensField: 'max_tokens',
              thinkingFormat: 'zai',
              zaiToolStream: true,
            },
          },
        ],
      },
    },
  };
  fs.writeFileSync(modelsJsonPath, JSON.stringify(modelsConfig, null, 2), 'utf8');
}

function summarizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const obj = args as Record<string, unknown>;
  if (typeof obj.command === 'string') return obj.command.slice(0, 120);
  if (typeof obj.path === 'string') return obj.path;
  if (typeof obj.file_path === 'string') return obj.file_path;
  if (typeof obj.pattern === 'string') return obj.pattern;
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';
  return `${toolName}(${keys.slice(0, 3).join(', ')})`;
}

function extractTextFromToolResult(result: unknown): string {
  if (typeof result === 'string') return result.slice(0, 1200);
  if (!result || typeof result !== 'object') return '';
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.content)) {
    return obj.content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string') {
          return (item as Record<string, unknown>).text as string;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .slice(0, 1200);
  }
  if (typeof obj.output === 'string') return obj.output.slice(0, 1200);
  return JSON.stringify(obj).slice(0, 800);
}

export interface StartBuildParams {
  owner: string;
  projectId: string;
  workspaceId: string;
  presetId?: string;
  workspaceDir: string;
  userMessage: string;
  history: MessageDTO[];
  isInitialBuild: boolean;
  handoffContext?: string;
  onSettled: (workspaceId: string, ok: boolean) => Promise<string | null>;
}

interface UsageBucket {
  input: number;
  output: number;
  cacheRead: number;
  total: number;
}

function emptyUsageBucket(): UsageBucket {
  return { input: 0, output: 0, cacheRead: 0, total: 0 };
}

function parseUsageBucket(raw: unknown): UsageBucket | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const input = Number(obj.input ?? obj.promptTokens ?? obj.input_tokens ?? 0);
  const output = Number(obj.output ?? obj.completionTokens ?? obj.output_tokens ?? 0);
  const cacheRead = Number(obj.cacheRead ?? obj.cache_read_input_tokens ?? 0);
  const totalRaw = Number(obj.totalTokens ?? obj.total_tokens ?? 0);
  const safeIn = Number.isFinite(input) && input > 0 ? input : 0;
  const safeOut = Number.isFinite(output) && output > 0 ? output : 0;
  const safeCache = Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead : 0;
  const total = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : safeIn + safeOut + safeCache;
  if (total === 0 && safeIn === 0 && safeOut === 0 && safeCache === 0) return null;
  return { input: safeIn, output: safeOut, cacheRead: safeCache, total };
}

function resolveEffectiveBudget(
  isResearch: boolean,
  recipeBudget?: Partial<AgentBudgetConfig>,
): AgentBudgetConfig {
  const defaultDuration = isResearch ? 360_000 : 720_000;
  const defaultCost = isResearch ? 2.0 : 5.0;
  const defaultTokens = isResearch ? 300_000 : 500_000;
  const defaultTools = isResearch ? 25 : 45;

  const rawDuration = config.agentBudgetMaxDurationMs ?? recipeBudget?.maxDurationMs ?? defaultDuration;
  const maxDurationMs = Math.max(30_000, Math.min(config.agentTimeoutMs, rawDuration));
  const maxCostCny = Math.max(0.05, config.agentBudgetMaxCostCny ?? recipeBudget?.maxCostCny ?? defaultCost);
  const maxTokens = Math.max(10_000, config.agentBudgetMaxTokens ?? recipeBudget?.maxTokens ?? defaultTokens);
  const maxToolCalls = Math.max(3, config.agentBudgetMaxToolCalls ?? recipeBudget?.maxToolCalls ?? defaultTools);
  const rawSoft = config.agentBudgetSoftRatio ?? recipeBudget?.softWarnRatio ?? 0.75;
  const softWarnRatio = Math.min(0.95, Math.max(0.5, rawSoft));

  return { maxDurationMs, maxCostCny, maxTokens, maxToolCalls, softWarnRatio };
}

interface ArchivedSourceItem {
  id?: number;
  title?: string;
  url?: string;
  domain?: string;
  type?: string;
  status?: string;
  noteFile?: string;
  publishedAt?: string;
  summary?: string;
}

function isPlaceholderResearchReport(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.includes('# 深度研究报告（准备中）') && trimmed.length < 400) return true;
  return trimmed.length < 100;
}

function synthesizePartialResearchReportIfNeeded(
  workspaceDir: string,
  reasonLabel: string,
  usage: AgentUsageStats,
): { synthesized: boolean; hasArtifacts: boolean; totalSources: number; fetchedCount: number } {
  const reportPath = path.join(workspaceDir, 'report.md');
  const sourcesPath = path.join(workspaceDir, 'sources.json');
  const planPath = path.join(workspaceDir, 'plan.md');

  let sources: ArchivedSourceItem[] = [];
  if (fs.existsSync(sourcesPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
      if (Array.isArray(parsed)) sources = parsed as ArchivedSourceItem[];
    } catch {
      sources = [];
    }
  }

  const existingReport = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '';
  const alreadyHasFullReport = !isPlaceholderResearchReport(existingReport);
  const fetchedSources = sources.filter((s) => s.status === 'fetched');
  const snippetSources = sources.filter((s) => s.status !== 'fetched');

  if (alreadyHasFullReport) {
    return {
      synthesized: false,
      hasArtifacts: true,
      totalSources: sources.length,
      fetchedCount: fetchedSources.length,
    };
  }

  if (sources.length === 0) {
    return { synthesized: false, hasArtifacts: false, totalSources: 0, fetchedCount: 0 };
  }

  const planText = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8').trim() : '';
  const durationSec = Math.round(usage.elapsedMs / 1000);
  const lines: string[] = [
    '# 阶段性深度调研摘要（已自动保存）',
    '',
    `> **说明**：本次深度调研因 **${reasonLabel}** 提前结束，尚未完成最终综合报告撰写。系统已自动保留全部检索与精读归档（共收录 **${sources.length}** 条信源，其中深度精读 **${fetchedSources.length}** 篇；耗时 ${durationSec}s，工具调用 ${usage.toolCalls} 次，累计 ${usage.totalTokens.toLocaleString()} tokens，估算 ¥${usage.estimatedCostCny.toFixed(4)}）。`,
    '> 你可以直接查看下方各文章摘要与右侧「参考信源」面板，或在对话框发送「请基于已收集的信源整理输出完整研究报告」继续收尾。',
    '',
  ];

  if (planText && !planText.includes('待 Agent 规划') && planText.length > 40) {
    lines.push('## 一、调研计划概览', '', planText.slice(0, 2000), '');
  }

  if (fetchedSources.length > 0) {
    lines.push(`## 二、已精读核心文章摘要（${fetchedSources.length} 篇）`, '');
    for (const s of fetchedSources) {
      const id = s.id ?? '?';
      lines.push(`### [${id}] ${s.title || s.url || '未命名文章'}`);
      lines.push(
        `- **原文链接**：${s.url || '—'}${s.domain ? `（${s.domain}）` : ''}${s.noteFile ? ` · **全文笔记**：\`${s.noteFile}\`` : ''}`,
      );
      if (s.summary) {
        lines.push(`- **核心摘要**：${s.summary}`);
      }
      lines.push('');
    }
  }

  if (snippetSources.length > 0) {
    lines.push(`## 三、已检索候选文章与摘要清单（${snippetSources.length} 篇）`, '');
    for (const s of snippetSources.slice(0, 40)) {
      const id = s.id ?? '?';
      const title = s.title || s.url || '未命名来源';
      const url = s.url || '#';
      lines.push(`- **[${id}] [${title}](${url})**${s.publishedAt ? ` (${s.publishedAt})` : ''}`);
      if (s.summary) {
        lines.push(`  - 摘要：${s.summary}`);
      }
    }
    if (snippetSources.length > 40) {
      lines.push(`- *其余 ${snippetSources.length - 40} 条检索记录已完整保存在 \`sources.json\` 与 \`sources/00-search-digest.md\` 中。*`);
    }
    lines.push('');
  }

  lines.push('## 参考信源清单（References）', '');
  for (const s of sources) {
    const id = s.id ?? '?';
    lines.push(`- [${id}] [${s.title || s.url}](${s.url || '#'}) — ${s.status === 'fetched' ? '已精读' : '检索摘要'}`);
  }
  lines.push('');

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return {
    synthesized: true,
    hasArtifacts: true,
    totalSources: sources.length,
    fetchedCount: fetchedSources.length,
  };
}

interface ActiveRun {
  projectId: string;
  workspaceId: string;
  workspaceDir: string;
  presetId: string;
  owner: string;
  runId: string;
  messageId: string;
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  lastActivityAt: number;
  lastActivityBroadcastAt: number;
  lastBudgetBroadcastAt: number;
  statusText?: string;
  lastSeq: number;
  assistantText: string;
  thinkingText: string;
  steps: AgentToolStep[];
  stepIndexById: Map<string, number>;
  aborted: boolean;
  settled: boolean;
  lastError?: string;
  stderrBuf: string;
  budget: AgentBudgetConfig;
  softWarned: boolean;
  budgetExceededReason?: string;
  committedUsage: UsageBucket;
  inflightUsage: UsageBucket;
  toolCalls: number;
  timeoutTimer: NodeJS.Timeout;
  idleTimer: NodeJS.Timeout;
  budgetTimer: NodeJS.Timeout;
  lastCheckpointAt: number;
  reqSeq: number;
  onSettled: (workspaceId: string, ok: boolean) => Promise<string | null>;
}

interface QueuedRun {
  params: StartBuildParams;
  messageId: string;
  queuedAt: number;
  lastActivityAt: number;
  statusText: string;
  lastSeq: number;
}

function summarizeActiveStep(run: ActiveRun): string {
  if (run.statusText) return run.statusText;
  const runningStep = [...run.steps].reverse().find((s) => s.status === 'running');
  if (runningStep) {
    return runningStep.argsSummary
      ? `${runningStep.toolName}: ${runningStep.argsSummary.slice(0, 60)}`
      : `执行 ${runningStep.toolName}`;
  }
  if (run.assistantText.trim()) return '正在输出构建结果...';
  if (run.thinkingText.trim()) return 'Agent 深度思考中...';
  return 'Pi Coding Agent 运行中...';
}

class PiAgentManager {
  private activeRuns = new Map<string, ActiveRun>();
  private workspaceActiveProject = new Map<string, string>();
  private workspaceQueues = new Map<string, QueuedRun[]>();
  private queuedByProject = new Map<string, QueuedRun>();
  private piCliPath: string | null = null;

  private getPiCliPath(): string {
    if (!this.piCliPath) {
      this.piCliPath = resolvePiCliPath();
    }
    return this.piCliPath;
  }

  isRunning(projectId: string): boolean {
    return this.activeRuns.has(projectId) || this.queuedByProject.has(projectId);
  }

  isWorkspaceBusy(workspaceId: string): boolean {
    return this.workspaceActiveProject.has(workspaceId);
  }

  getActiveCount(): number {
    return this.activeRuns.size;
  }

  listActiveProjectIds(owner: string): string[] {
    const ids = new Set<string>();
    for (const run of this.activeRuns.values()) {
      if (run.owner === owner) ids.add(run.projectId);
    }
    for (const queued of this.queuedByProject.values()) {
      if (queued.params.owner === owner) ids.add(queued.params.projectId);
    }
    return [...ids];
  }

  getWorkspaceBuildState(workspaceId: string): {
    activeBuildProjectId: string | null;
    activeBuildTitle: string | null;
    queuedProjectIds: string[];
  } {
    const activeProjectId = this.workspaceActiveProject.get(workspaceId) || null;
    const activeProj = activeProjectId ? dbStore.getProject(activeProjectId) : undefined;
    const queued = (this.workspaceQueues.get(workspaceId) || []).map((q) => q.params.projectId);
    return {
      activeBuildProjectId: activeProjectId,
      activeBuildTitle: activeProj?.title ?? null,
      queuedProjectIds: queued,
    };
  }

  private computeUsageStats(run: ActiveRun): AgentUsageStats {
    const inputTokens = run.committedUsage.input + run.inflightUsage.input;
    const outputTokens = run.committedUsage.output + run.inflightUsage.output;
    const cacheReadTokens = run.committedUsage.cacheRead + run.inflightUsage.cacheRead;
    const totalTokens = run.committedUsage.total + run.inflightUsage.total;
    const rawCost =
      (inputTokens * config.glmInputPricePerM +
        outputTokens * config.glmOutputPricePerM +
        cacheReadTokens * config.glmCacheReadPricePerM) /
      1_000_000;
    const estimatedCostCny = Math.round(rawCost * 10000) / 10000;
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens,
      estimatedCostCny,
      toolCalls: run.toolCalls,
      elapsedMs: Math.max(0, Date.now() - run.startedAt),
    };
  }

  private buildBudgetSnapshot(run: ActiveRun): AgentBudgetSnapshot {
    return {
      limits: { ...run.budget },
      softWarned: run.softWarned,
      exceededReason: run.budgetExceededReason,
    };
  }

  private emitBudgetUpdate(run: ActiveRun, force = false): void {
    const now = Date.now();
    if (!force && now - run.lastBudgetBroadcastAt < 3000) return;
    run.lastBudgetBroadcastAt = now;
    const usage = this.computeUsageStats(run);
    const budget = this.buildBudgetSnapshot(run);
    run.lastSeq = eventBus.emit(run.projectId, {
      type: 'agent_budget_update',
      messageId: run.messageId,
      usage,
      budget,
    });
  }

  private checkBudget(run: ActiveRun, forceEmit = false): void {
    if (run.settled || run.budgetExceededReason) return;
    const usage = this.computeUsageStats(run);
    const limits = run.budget;

    // 1. Check hard limits first (100% -> fast graceful abort)
    let exceededReason: string | null = null;
    if (usage.elapsedMs >= limits.maxDurationMs) {
      const durText =
        limits.maxDurationMs < 60_000
          ? `${Math.round(limits.maxDurationMs / 1000)} 秒`
          : `${(limits.maxDurationMs / 60_000).toFixed(limits.maxDurationMs % 60_000 === 0 ? 0 : 1)} 分钟`;
      exceededReason = `达到时间预算上限（${durText}）`;
    } else if (usage.estimatedCostCny >= limits.maxCostCny) {
      exceededReason = `达到费用预算上限（¥${usage.estimatedCostCny.toFixed(3)} / ¥${limits.maxCostCny.toFixed(2)}）`;
    } else if (usage.totalTokens >= limits.maxTokens) {
      exceededReason = `达到 Token 预算上限（${usage.totalTokens.toLocaleString()} / ${limits.maxTokens.toLocaleString()} tokens）`;
    } else if (usage.toolCalls >= limits.maxToolCalls) {
      exceededReason = `达到工具步数预算上限（${usage.toolCalls} / ${limits.maxToolCalls} 步）`;
    }

    if (exceededReason) {
      run.budgetExceededReason = exceededReason;
      run.aborted = true;
      run.lastError = exceededReason;
      const statusText = `已触发预算硬上限（${exceededReason}），正在快速终止并保存已有成果...`;
      run.statusText = statusText;
      run.lastActivityAt = Date.now();
      console.warn(
        `[pi-agent] budget_exceeded runId=${run.runId} projectId=${run.projectId} reason="${exceededReason}" elapsedMs=${usage.elapsedMs} tokens=${usage.totalTokens} costCny=${usage.estimatedCostCny} tools=${usage.toolCalls}`,
      );
      run.lastSeq = eventBus.emit(run.projectId, {
        type: 'agent_status',
        messageId: run.messageId,
        statusText,
      });
      this.emitBudgetUpdate(run, true);
      this.broadcastActivity(run, true);
      this.writeRpc(run.child, { id: `abort-budget-${++run.reqSeq}`, type: 'abort' });
      setTimeout(() => {
        if (!run.settled) {
          try {
            run.child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 4000).unref();
      return;
    }

    // 2. Check soft warning threshold (default 75% -> steer Agent to wrap up cleanly)
    const ratios = [
      { label: '时间', ratio: usage.elapsedMs / limits.maxDurationMs },
      { label: '费用', ratio: usage.estimatedCostCny / limits.maxCostCny },
      { label: 'Token', ratio: usage.totalTokens / limits.maxTokens },
      { label: '工具步数', ratio: usage.toolCalls / limits.maxToolCalls },
    ];
    const highest = ratios.reduce((a, b) => (b.ratio > a.ratio ? b : a));

    if (!run.softWarned && highest.ratio >= limits.softWarnRatio) {
      run.softWarned = true;
      const pct = Math.min(99, Math.round(highest.ratio * 100));
      const isResearch = run.presetId === 'deep-research';
      const steerMsg = isResearch
        ? `【系统预算预警】当前任务${highest.label}预算已使用约 ${pct}%（已耗时 ${Math.round(usage.elapsedMs / 1000)}s / 工具调用 ${usage.toolCalls} 次 / Token ${usage.totalTokens.toLocaleString()} / 估算 ¥${usage.estimatedCostCny.toFixed(3)}）。请立刻停止发起新的 web_search / web_fetch / web_crawl，马上基于工作区已自动归档的 sources.json 和 sources/ 撰写完整带引用的 report.md，并在对话中输出核心结论摘要！`
        : `【系统预算预警】当前任务${highest.label}预算已使用约 ${pct}%。请立刻停止继续发散探索，尽快完成核心改动、执行 npm run build 验证无报错并向用户汇报结果。`;
      this.writeRpc(run.child, {
        id: `steer-budget-${++run.reqSeq}`,
        type: 'steer',
        message: steerMsg,
      });
      const statusText = `预算已使用 ${pct}%（${highest.label}接近上限），已通知 Agent 停止继续发散并立即整理输出最终结果...`;
      run.statusText = statusText;
      console.warn(
        `[pi-agent] budget_soft_warn runId=${run.runId} projectId=${run.projectId} metric=${highest.label} pct=${pct}% elapsedMs=${usage.elapsedMs} tokens=${usage.totalTokens} costCny=${usage.estimatedCostCny} tools=${usage.toolCalls}`,
      );
      run.lastSeq = eventBus.emit(run.projectId, {
        type: 'agent_status',
        messageId: run.messageId,
        statusText,
      });
      this.emitBudgetUpdate(run, true);
      this.broadcastActivity(run, true);
      return;
    }

    if (forceEmit) {
      this.emitBudgetUpdate(run, false);
    }
  }

  getActiveRunSnapshot(projectId: string): ActiveRunSnapshot | null {
    const run = this.activeRuns.get(projectId);
    if (run) {
      return {
        runId: run.runId,
        messageId: run.messageId,
        mode: 'build',
        queued: false,
        startedAt: run.startedAt,
        lastActivityAt: run.lastActivityAt,
        statusText: run.statusText,
        thinking: run.thinkingText,
        text: run.assistantText,
        steps: run.steps.map((s) => ({ ...s })),
        usage: this.computeUsageStats(run),
        budget: this.buildBudgetSnapshot(run),
        seq: run.lastSeq,
      };
    }

    const queued = this.queuedByProject.get(projectId);
    if (queued) {
      return {
        messageId: queued.messageId,
        mode: 'build',
        queued: true,
        startedAt: queued.queuedAt,
        lastActivityAt: queued.lastActivityAt,
        statusText: queued.statusText,
        thinking: '',
        text: '',
        steps: [],
        seq: queued.lastSeq,
      };
    }

    return null;
  }

  getActiveSummary(projectId: string): {
    isBuilding: boolean;
    queued: boolean;
    activeStep: string | null;
    startedAt: number | null;
    lastActivityAt: number | null;
  } {
    const run = this.activeRuns.get(projectId);
    if (run) {
      return {
        isBuilding: true,
        queued: false,
        activeStep: summarizeActiveStep(run),
        startedAt: run.startedAt,
        lastActivityAt: run.lastActivityAt,
      };
    }
    const queued = this.queuedByProject.get(projectId);
    if (queued) {
      return {
        isBuilding: true,
        queued: true,
        activeStep: queued.statusText,
        startedAt: queued.queuedAt,
        lastActivityAt: queued.lastActivityAt,
      };
    }
    return { isBuilding: false, queued: false, activeStep: null, startedAt: null, lastActivityAt: null };
  }

  private emitWorkspaceUpdate(owner: string, workspaceId: string, previewRunning = false): void {
    const ws = dbStore.getWorkspace(workspaceId);
    if (!ws) return;
    const dto = toWorkspaceDTO(ws, previewRunning, this.getWorkspaceBuildState(workspaceId));
    eventBus.emitUser(owner, { type: 'workspace_updated', workspace: dto });
  }

  private broadcastActivity(run: ActiveRun, force = false): void {
    const now = Date.now();
    if (!force && now - run.lastActivityBroadcastAt < 1800) {
      return;
    }
    run.lastActivityBroadcastAt = now;
    eventBus.emitUser(run.owner, {
      type: 'project_activity',
      projectId: run.projectId,
      status: 'building',
      isBuilding: true,
      activeStep: summarizeActiveStep(run),
      startedAt: run.startedAt,
      lastActivityAt: run.lastActivityAt,
    });
  }

  async startOrSteer(
    params: StartBuildParams,
  ): Promise<{ mode: 'started' | 'steered' | 'queued'; runId?: string; messageId: string }> {
    // 1. Same conversation thread already actively running -> live steer
    const existing = this.activeRuns.get(params.projectId);
    if (existing) {
      if (existing.settled) {
        throw new Error('上一轮构建正在收尾启动预览服务，请稍候几秒后再发新指令。');
      }
      const cmdId = `steer-${++existing.reqSeq}`;
      this.writeRpc(existing.child, {
        id: cmdId,
        type: 'steer',
        message: params.userMessage,
      });
      const statusText = '已收到你的补充指令，将在当前步骤完成后立即调整执行方向...';
      existing.statusText = statusText;
      existing.lastActivityAt = Date.now();
      existing.lastSeq = eventBus.emit(params.projectId, {
        type: 'agent_status',
        messageId: existing.messageId,
        statusText,
      });
      this.broadcastActivity(existing, true);
      return { mode: 'steered', runId: existing.runId, messageId: existing.messageId };
    }

    // 2. Same conversation thread already queued -> merge additional note into queued prompt
    const existingQueued = this.queuedByProject.get(params.projectId);
    if (existingQueued) {
      existingQueued.params.userMessage = `${existingQueued.params.userMessage}\n\n补充要求：\n${params.userMessage}`;
      existingQueued.lastActivityAt = Date.now();
      existingQueued.lastSeq = eventBus.emit(params.projectId, {
        type: 'agent_status',
        messageId: existingQueued.messageId,
        statusText: `${existingQueued.statusText}（已合并补充指令）`,
      });
      return { mode: 'queued', messageId: existingQueued.messageId };
    }

    if (!config.glmApiKey) {
      throw new Error('服务端未配置 GLM_API_KEY，无法启动 Coding Agent。请在 .env 中配置后重试。');
    }

    // 3. Another conversation thread is currently mutating the SAME workspace -> enqueue safely (write serialization)
    const blockingProjectId = this.workspaceActiveProject.get(params.workspaceId);
    if (blockingProjectId && blockingProjectId !== params.projectId) {
      const blockingProj = dbStore.getProject(blockingProjectId);
      const blockingTitle = blockingProj?.title || '其他对话';
      const now = Date.now();
      const messageId = generateId('msg');
      dbStore.addMessage(
        params.projectId,
        'assistant',
        '',
        { mode: 'build', steps: [], thinking: '' },
        messageId,
      );

      const queue = this.workspaceQueues.get(params.workspaceId) || [];
      const position = queue.length + 1;
      const statusText = `排队中 (#${position})：等待同仓库「${blockingTitle}」完成当前修改...`;

      const updatedProj = dbStore.updateProject(params.projectId, {
        status: 'queued',
        workspaceId: params.workspaceId,
      });
      const wsRow = dbStore.getWorkspace(params.workspaceId);
      if (updatedProj) {
        const dto = {
          ...toProjectDTO(updatedProj, false, wsRow?.name),
          activeStep: statusText,
          lastActivityAt: now,
        };
        eventBus.emit(params.projectId, { type: 'project_updated', project: dto });
        eventBus.emitUser(params.owner, { type: 'project_updated', project: dto });
      }

      const seq = eventBus.emit(params.projectId, {
        type: 'agent_queued',
        messageId,
        workspaceId: params.workspaceId,
        position,
        blockingProjectId,
        blockingTitle,
      });

      const entry: QueuedRun = {
        params,
        messageId,
        queuedAt: now,
        lastActivityAt: now,
        statusText,
        lastSeq: seq,
      };
      queue.push(entry);
      this.workspaceQueues.set(params.workspaceId, queue);
      this.queuedByProject.set(params.projectId, entry);

      eventBus.emitUser(params.owner, {
        type: 'project_activity',
        projectId: params.projectId,
        status: 'queued',
        isBuilding: true,
        activeStep: statusText,
        startedAt: now,
        lastActivityAt: now,
      });
      this.emitWorkspaceUpdate(params.owner, params.workspaceId, false);

      return { mode: 'queued', messageId };
    }

    // 4. Different workspace or idle workspace -> start immediately
    return this.launchRun(params);
  }

  private launchRun(
    params: StartBuildParams,
    existingMessageId?: string,
  ): { mode: 'started'; runId: string; messageId: string } {
    if (this.activeRuns.size >= config.maxConcurrentAgents) {
      throw new Error(`当前同时构建的代码仓库数已达上限（${config.maxConcurrentAgents}），请稍候再试。`);
    }

    const bundle = pluginRegistry.prepareProjectAgentBundle({
      owner: params.owner,
      projectId: params.workspaceId,
      workspaceDir: params.workspaceDir,
      presetId: params.presetId,
    });
    // Per-thread isolated Pi session directory inside the shared workspace
    const sessionDir = path.join(params.workspaceDir, '.pi-sessions', params.projectId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const wsRow = dbStore.getWorkspace(params.workspaceId);
    const canonicalAgentId = bundle.preset.manifest.id;
    const isResearch = canonicalAgentId === 'deep-research';
    const contextMd = [
      '# Project Conversation Context',
      '',
      `- Workspace: ${wsRow?.name || params.workspaceId} (${params.workspaceId})`,
      `- Conversation Thread: ${params.projectId}`,
      `- Agent Recipe: ${bundle.preset.manifest.id} (${bundle.preset.manifest.name})`,
      `- Loaded Plugins: ${bundle.preset.plugins.map((p) => p.manifest.id).join(', ') || 'none'}`,
      bundle.runtimeEnv.ATOMS_DB_PREFIX
        ? `- Isolated DB Table Prefix: \`${bundle.runtimeEnv.ATOMS_DB_PREFIX}\` (always use logical table names; proxy prefixes automatically)`
        : '',
      '',
      ...(params.handoffContext
        ? ['## CROSS-AGENT HANDOFF CONTEXT', params.handoffContext.trim(), '']
        : []),
      ...params.history.slice(-20).map((m) => `## ${m.role.toUpperCase()}\n${m.content}\n`),
      `## LATEST REQUEST\n${params.userMessage}\n`,
    ].join('\n');
    fs.writeFileSync(path.join(params.workspaceDir, 'PROJECT_CONTEXT.md'), contextMd, 'utf8');

    const now = Date.now();
    const runId = dbStore.createAgentRun(params.projectId, params.userMessage);
    const messageId = existingMessageId || generateId('msg');
    if (!existingMessageId) {
      dbStore.addMessage(
        params.projectId,
        'assistant',
        '',
        { mode: 'build', agentId: canonicalAgentId, steps: [], thinking: '' },
        messageId,
      );
    }

    const initialStatus = isResearch
      ? '正在隔离研究空间启动 Deep Research Agent 与外网检索 MCP...'
      : '正在隔离工作区启动 Fullstack Coder Agent...';
    const updatedProj = dbStore.updateProject(params.projectId, {
      status: 'building',
      workspaceId: params.workspaceId,
      presetId: canonicalAgentId,
    });
    if (updatedProj) {
      const dto = {
        ...toProjectDTO(updatedProj, false, wsRow?.name),
        activeStep: initialStatus,
        lastActivityAt: now,
      };
      eventBus.emit(params.projectId, { type: 'project_updated', project: dto });
      eventBus.emitUser(params.owner, { type: 'project_updated', project: dto });
    }

    const startSeq = eventBus.emit(params.projectId, {
      type: 'agent_start',
      runId,
      messageId,
      startedAt: now,
    });

    const sanitizedEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG || 'en_US.UTF-8',
      NODE_ENV: 'development',
      PI_CODING_AGENT_DIR: bundle.piAgentDir,
      GLM_API_KEY: config.glmApiKey,
      ...bundle.runtimeEnv,
    };

    const piArgs = [
      this.getPiCliPath(),
      '--mode',
      'rpc',
      '--provider',
      'glm',
      '--model',
      config.glmModel,
      '--thinking',
      'high',
      '--session-dir',
      sessionDir,
    ];

    for (const skillDir of bundle.skillDirs) {
      piArgs.push('--skill', skillDir);
    }
    for (const promptAppend of bundle.systemPromptAppends) {
      piArgs.push('--append-system-prompt', promptAppend);
    }

    const child = spawn(process.execPath, piArgs, {
      cwd: params.workspaceDir,
      env: sanitizedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const abortForTimeout = (reason: 'idle' | 'max', statusText: string, errDetail: string) => {
      if (run.settled) return;
      const nowTs = Date.now();
      const idleMs = nowTs - run.lastActivityAt;
      const elapsedMs = nowTs - run.startedAt;
      run.aborted = true;
      run.lastError = errDetail;
      run.statusText = statusText;
      run.lastActivityAt = nowTs;
      console.warn(
        `[pi-agent] ${reason}_timeout runId=${run.runId} projectId=${run.projectId} workspaceId=${run.workspaceId} elapsedMs=${elapsedMs} idleMs=${idleMs}`,
      );
      run.lastSeq = eventBus.emit(params.projectId, {
        type: 'agent_status',
        messageId,
        statusText,
      });
      this.broadcastActivity(run, true);
      this.writeRpc(child, { id: `abort-${reason}-timeout`, type: 'abort' });
      setTimeout(() => {
        if (!run.settled) child.kill('SIGKILL');
      }, 4000).unref();
    };

    const scheduleIdleTimer = (): NodeJS.Timeout => {
      const t = setTimeout(() => {
        abortForTimeout(
          'idle',
          `Agent 连续 ${Math.round(config.agentIdleTimeoutMs / 60000)} 分钟无任何响应，正在终止任务...`,
          `Agent 空闲超时（超过 ${Math.round(config.agentIdleTimeoutMs / 1000)} 秒无事件输出）`,
        );
      }, config.agentIdleTimeoutMs);
      t.unref();
      return t;
    };

    const effectiveBudget = resolveEffectiveBudget(isResearch, bundle.preset.manifest.budget);

    const run: ActiveRun = {
      projectId: params.projectId,
      workspaceId: params.workspaceId,
      workspaceDir: params.workspaceDir,
      presetId: canonicalAgentId,
      owner: params.owner,
      runId,
      messageId,
      child,
      startedAt: now,
      lastActivityAt: now,
      lastActivityBroadcastAt: 0,
      lastBudgetBroadcastAt: 0,
      statusText: initialStatus,
      lastSeq: startSeq,
      assistantText: '',
      thinkingText: '',
      steps: [],
      stepIndexById: new Map(),
      aborted: false,
      settled: false,
      lastError: undefined,
      stderrBuf: '',
      budget: effectiveBudget,
      softWarned: false,
      budgetExceededReason: undefined,
      committedUsage: emptyUsageBucket(),
      inflightUsage: emptyUsageBucket(),
      toolCalls: 0,
      lastCheckpointAt: now,
      reqSeq: 0,
      onSettled: params.onSettled,
      timeoutTimer: setTimeout(() => {
        abortForTimeout(
          'max',
          `任务达到最大运行耗时上限（${Math.round(config.agentTimeoutMs / 60000)} 分钟），正在收尾终止...`,
          `任务超过最大耗时上限（${Math.round(config.agentTimeoutMs / 60000)} 分钟）`,
        );
      }, config.agentTimeoutMs),
      idleTimer: scheduleIdleTimer(),
      budgetTimer: setInterval(() => {
        this.checkBudget(run, true);
      }, 5_000),
    };
    run.timeoutTimer.unref();
    run.budgetTimer.unref();

    console.log(
      `[pi-agent] start runId=${run.runId} projectId=${run.projectId} workspaceId=${run.workspaceId} agent=${run.presetId} model=${config.glmModel} budget=(dur=${Math.round(effectiveBudget.maxDurationMs / 1000)}s cost=¥${effectiveBudget.maxCostCny} tokens=${effectiveBudget.maxTokens} tools=${effectiveBudget.maxToolCalls})`,
    );

    this.activeRuns.set(params.projectId, run);
    this.workspaceActiveProject.set(params.workspaceId, params.projectId);
    this.emitBudgetUpdate(run, true);
    this.broadcastActivity(run, true);
    this.emitWorkspaceUpdate(params.owner, params.workspaceId, false);
    this.attachSubprocessHandlers(run, scheduleIdleTimer);

    const agentPrompt = isResearch
      ? params.isInitialBuild
        ? `请先阅读工作区里的 AGENTS.md、PROJECT_CONTEXT.md 以及已加载的 deep-research Skill，然后按四阶段研究流水线完成深度调研：\n1. 先写 plan.md 明确研究维度与子问题；\n2. 执行 3–6 次聚焦的 mcp__web_research__web_search 多角度外网检索（结果会自动归档到 sources/00-search-digest.md 与 sources.json）；\n3. 挑选 4–8 篇最高价值一手网页调用 mcp__web_research__web_fetch / web_crawl 精读（每篇抓取后都会自动保存摘要与全文笔记到 sources/NN-*.md 并更新 sources.json，无需重复抄写全文）；\n4. 尽快撰写带内联引用 [1][2]、对比表格、置信度与争议分析的完整报告到 report.md。\n\n预算纪律：本任务受时间/费用/步数预算保护（约 ${Math.round(effectiveBudget.maxDurationMs / 60000)} 分钟、${effectiveBudget.maxToolCalls} 步），请避免无限发散检索；一旦收到系统预算预警请立即停搜并收口写完 report.md。\n\n用户研究需求：\n${params.userMessage}\n\n完成后请检查 sources.json 为合法 JSON、report.md 内容完整，最后在对话中输出一份精炼的核心结论摘要，并提醒用户可在右侧「研究报告」面板查看完整交互式报告。`
        : `请结合工作区已有的 plan.md、sources.json、sources/ 笔记与 report.md，根据用户的最新追问或补充需求，聚焦调用 mcp__web_research__web_search / web_fetch 检索补充信源（工具会自动归档到 sources/ 与 sources.json），更新 report.md（保持引用编号一一对应且绝不编造链接），最后用简洁中文汇报新增发现。\n\n用户最新需求：\n${params.userMessage}`
      : params.isInitialBuild
        ? `请先阅读工作区里的 AGENTS.md、PROJECT_CONTEXT.md 以及已加载的 atoms-sqlite-storage Skill 指南，然后根据用户需求完成这个全栈网站的开发（前端 React+Tailwind 写在 client/，后端 Express 接口写在 server/index.js 并使用 ./db.js 代理客户端读写数据；同时优先调用 atoms_db MCP 工具完成建表和写入示例数据）。\n\n用户最新需求：\n${params.userMessage}\n\n完成后请务必执行 npm run build 确保前端编译通过，并检查 server/index.js 无语法错误，最后用简洁中文汇报你实现的功能、创建的数据表和交互亮点。不要在后台遗留运行中的服务器进程。`
        : `请根据用户的最新修改需求，在当前工作区（遵守 AGENTS.md 与 atoms-sqlite-storage Skill 规范，保持相对路径 ./api/... 并使用 atoms_db MCP / ./db.js 代理操作数据）进行增量修改，完成后执行 npm run build 验证无报错并汇报改动内容。\n\n用户需求：\n${params.userMessage}`;

    this.writeRpc(child, {
      id: `prompt-${++run.reqSeq}`,
      type: 'prompt',
      message: agentPrompt,
    });

    return { mode: 'started', runId, messageId };
  }

  private drainWorkspaceQueue(workspaceId: string): void {
    if (this.workspaceActiveProject.has(workspaceId)) return;
    const queue = this.workspaceQueues.get(workspaceId);
    if (!queue || queue.length === 0) {
      this.workspaceQueues.delete(workspaceId);
      return;
    }

    const next = queue.shift()!;
    this.queuedByProject.delete(next.params.projectId);
    if (queue.length === 0) {
      this.workspaceQueues.delete(workspaceId);
    }

    // Refresh queue position notices for any remaining waiting threads
    const nextProj = dbStore.getProject(next.params.projectId);
    for (let i = 0; i < queue.length; i++) {
      const q = queue[i];
      q.statusText = `排队中 (#${i + 1})：等待同仓库「${nextProj?.title || '前序对话'}」完成当前修改...`;
      q.lastActivityAt = Date.now();
      q.lastSeq = eventBus.emit(q.params.projectId, {
        type: 'agent_status',
        messageId: q.messageId,
        statusText: q.statusText,
      });
    }

    // Re-read fresh history before launching
    const freshHistory = dbStore.listMessages(next.params.projectId).filter((m) => m.id !== next.messageId);
    try {
      this.launchRun({ ...next.params, history: freshHistory, isInitialBuild: false }, next.messageId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const saved =
        dbStore.updateMessage(next.messageId, `排队任务启动失败：${errMsg}`, {
          mode: 'build',
          error: errMsg,
        }) || dbStore.addMessage(next.params.projectId, 'assistant', `排队任务启动失败：${errMsg}`);
      const updated = dbStore.updateProject(next.params.projectId, { status: 'error' });
      const wsRow = dbStore.getWorkspace(workspaceId);
      if (updated) {
        const dto = toProjectDTO(updated, false, wsRow?.name);
        eventBus.emit(next.params.projectId, { type: 'project_updated', project: dto });
        eventBus.emitUser(next.params.owner, {
          type: 'project_run_finished',
          projectId: next.params.projectId,
          status: 'failed',
          project: dto,
        });
      }
      eventBus.emit(next.params.projectId, {
        type: 'agent_done',
        runId: 'queued-failed',
        message: saved,
        status: 'failed',
        error: errMsg,
      });
      this.drainWorkspaceQueue(workspaceId);
    }
  }

  abort(projectId: string): boolean {
    // 1. Cancel if waiting in workspace queue
    const queued = this.queuedByProject.get(projectId);
    if (queued) {
      this.queuedByProject.delete(projectId);
      const wsQueue = this.workspaceQueues.get(queued.params.workspaceId);
      if (wsQueue) {
        const remaining = wsQueue.filter((q) => q.params.projectId !== projectId);
        if (remaining.length === 0) this.workspaceQueues.delete(queued.params.workspaceId);
        else this.workspaceQueues.set(queued.params.workspaceId, remaining);
      }
      const savedMsg =
        dbStore.updateMessage(queued.messageId, '已取消排队中的构建任务。你可以继续输入新的需求。', {
          mode: 'build',
          aborted: true,
        }) ||
        dbStore.addMessage(projectId, 'assistant', '已取消排队中的构建任务。', {
          mode: 'build',
          aborted: true,
        });
      const updated = dbStore.updateProject(projectId, { status: 'ready' });
      const wsRow = dbStore.getWorkspace(queued.params.workspaceId);
      const dto = updated
        ? { ...toProjectDTO(updated, false, wsRow?.name), activeStep: null, lastActivityAt: null }
        : null;
      if (dto) {
        eventBus.emit(projectId, { type: 'project_updated', project: dto });
        eventBus.emitUser(queued.params.owner, {
          type: 'project_run_finished',
          projectId,
          status: 'aborted',
          project: dto,
        });
      }
      eventBus.emit(projectId, {
        type: 'agent_done',
        runId: 'queued-aborted',
        message: savedMsg,
        status: 'aborted',
      });
      this.emitWorkspaceUpdate(queued.params.owner, queued.params.workspaceId, false);
      return true;
    }

    // 2. Abort actively running agent
    const run = this.activeRuns.get(projectId);
    if (!run || run.settled) return false;
    run.aborted = true;
    const statusText = '正在停止当前构建任务...';
    run.statusText = statusText;
    run.lastActivityAt = Date.now();
    run.lastSeq = eventBus.emit(projectId, {
      type: 'agent_status',
      messageId: run.messageId,
      statusText,
    });
    this.broadcastActivity(run, true);
    this.writeRpc(run.child, { id: `abort-${++run.reqSeq}`, type: 'abort' });
    setTimeout(() => {
      if (!run.settled) {
        try {
          run.child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }, 4000).unref();
    return true;
  }

  abortWorkspace(workspaceId: string): void {
    const queue = [...(this.workspaceQueues.get(workspaceId) || [])];
    for (const q of queue) {
      this.abort(q.params.projectId);
    }
    const activeProjId = this.workspaceActiveProject.get(workspaceId);
    if (activeProjId) {
      this.abort(activeProjId);
    }
  }

  shutdownAll(): void {
    for (const run of this.activeRuns.values()) {
      clearTimeout(run.timeoutTimer);
      clearTimeout(run.idleTimer);
      clearInterval(run.budgetTimer);
      try {
        run.child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.activeRuns.clear();
    this.workspaceActiveProject.clear();
    this.workspaceQueues.clear();
    this.queuedByProject.clear();
  }

  private persistCheckpoint(run: ActiveRun, force = false): void {
    if (run.settled) return;
    const now = Date.now();
    if (!force && now - run.lastCheckpointAt < 8_000) return;
    run.lastCheckpointAt = now;
    try {
      dbStore.updateMessage(run.messageId, run.assistantText, {
        mode: 'build',
        agentId: run.presetId,
        thinking: run.thinkingText || undefined,
        steps: run.steps,
        usage: this.computeUsageStats(run),
        budget: this.buildBudgetSnapshot(run),
      });
    } catch {
      // non-fatal; final message will still be saved in finalizeRun
    }
  }

  private writeRpc(child: ChildProcessWithoutNullStreams, payload: Record<string, unknown>): void {
    if (!child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private attachSubprocessHandlers(run: ActiveRun, scheduleIdleTimer: () => NodeJS.Timeout): void {
    const touchIdleTimer = () => {
      if (run.settled) return;
      clearTimeout(run.idleTimer);
      run.idleTimer = scheduleIdleTimer();
    };

    let stdoutBuf = '';
    run.child.stdout.setEncoding('utf8');
    run.child.stdout.on('data', (chunk: string) => {
      touchIdleTimer();
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '');
        stdoutBuf = stdoutBuf.slice(nl + 1);
        nl = stdoutBuf.indexOf('\n');
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          this.handleRpcRecord(run, record);
        } catch {
          // ignore non-JSON diagnostic output
        }
      }
    });

    run.child.stderr.setEncoding('utf8');
    run.child.stderr.on('data', (chunk: string) => {
      touchIdleTimer();
      run.stderrBuf = (run.stderrBuf + chunk).slice(-4000);
    });

    run.child.on('error', (err) => {
      console.error(`[pi-agent] child_error runId=${run.runId} projectId=${run.projectId} err=${err.message}`);
      void this.finalizeRun(run, 'failed', `启动 Pi 子进程失败: ${err.message}`);
    });

    run.child.on('close', (code, signal) => {
      console.log(
        `[pi-agent] child_close runId=${run.runId} projectId=${run.projectId} code=${code} signal=${signal ?? 'none'} settled=${run.settled} aborted=${run.aborted}`,
      );
      if (!run.settled) {
        const status = run.aborted ? 'aborted' : code === 0 && !run.lastError ? 'succeeded' : 'failed';
        const errMsg =
          status === 'failed'
            ? run.lastError ||
              `Coding Agent 异常退出 (code=${code}, signal=${signal ?? 'none'})${run.stderrBuf ? `: ${run.stderrBuf.slice(-400)}` : ''}`
            : run.lastError;
        void this.finalizeRun(run, status, errMsg);
      }
    });
  }

  private handleRpcRecord(run: ActiveRun, record: Record<string, unknown>): void {
    const type = String(record.type || '');
    run.lastActivityAt = Date.now();

    if (type === 'response') {
      if (record.success === false) {
        const err = String(record.error || 'Agent command failed');
        if (record.command === 'prompt') {
          void this.finalizeRun(run, 'failed', err);
        } else {
          const statusText = `指令提示: ${err}`;
          run.statusText = statusText;
          run.lastSeq = eventBus.emit(run.projectId, {
            type: 'agent_status',
            messageId: run.messageId,
            statusText,
          });
          this.broadcastActivity(run, true);
        }
      }
      return;
    }

    if (type === 'extension_ui_request') {
      if (typeof record.id === 'string') {
        this.writeRpc(run.child, {
          type: 'extension_ui_response',
          id: record.id,
          cancelled: true,
        });
      }
      return;
    }

    if (type === 'message_update') {
      const liveUsage = parseUsageBucket(record.usage);
      if (liveUsage) {
        run.inflightUsage = liveUsage;
        this.emitBudgetUpdate(run, false);
      }
      const evt = record.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!evt) return;
      const evtType = String(evt.type || '');

      if (evtType === 'text_delta' && typeof evt.delta === 'string') {
        run.assistantText += evt.delta;
        run.statusText = undefined;
        run.lastError = undefined;
        run.lastSeq = eventBus.emit(run.projectId, {
          type: 'agent_text_delta',
          messageId: run.messageId,
          delta: evt.delta,
        });
        this.persistCheckpoint(run, false);
        this.broadcastActivity(run, false);
      } else if (evtType === 'thinking_delta' && typeof evt.delta === 'string') {
        run.thinkingText += evt.delta;
        run.statusText = undefined;
        run.lastError = undefined;
        run.lastSeq = eventBus.emit(run.projectId, {
          type: 'agent_thinking_delta',
          messageId: run.messageId,
          delta: evt.delta,
        });
        this.persistCheckpoint(run, false);
        this.broadcastActivity(run, false);
      } else if (evtType === 'toolcall_start') {
        const stepId = String(evt.id || `tc-${run.steps.length + 1}`);
        const toolName = String(evt.toolName || 'tool');
        if (!run.stepIndexById.has(stepId)) {
          const step: AgentToolStep = { id: stepId, toolName, status: 'running' };
          run.stepIndexById.set(stepId, run.steps.length);
          run.steps.push(step);
          run.statusText = undefined;
          run.lastSeq = eventBus.emit(run.projectId, {
            type: 'agent_tool_start',
            messageId: run.messageId,
            step: { ...step },
          });
          this.broadcastActivity(run, true);
        }
      } else if (evtType === 'toolcall_end') {
        const tc = evt.toolCall as Record<string, unknown> | undefined;
        const stepId = String(tc?.id || evt.id || '');
        const idx = run.stepIndexById.get(stepId);
        if (idx !== undefined && tc) {
          const toolName = String(tc.name || run.steps[idx].toolName);
          run.steps[idx].toolName = toolName;
          run.steps[idx].argsSummary = summarizeToolArgs(toolName, tc.arguments);
          run.statusText = undefined;
          run.lastSeq = eventBus.emit(run.projectId, {
            type: 'agent_tool_start',
            messageId: run.messageId,
            step: { ...run.steps[idx] },
          });
          this.broadcastActivity(run, true);
        }
      } else if (evtType === 'error') {
        // Do NOT kill Pi immediately: Pi has built-in auto-retry (auto_retry_start/end) and
        // will emit agent_settled if retries are exhausted.
        const err = typeof evt.error === 'string' ? evt.error : JSON.stringify(evt.error || 'Model stream error');
        run.lastError = err;
        const statusText = '模型流出现瞬时波动，等待 Agent 自动重试...';
        run.statusText = statusText;
        console.warn(`[pi-agent] stream_error runId=${run.runId} projectId=${run.projectId} err=${err.slice(0, 300)}`);
        run.lastSeq = eventBus.emit(run.projectId, {
          type: 'agent_status',
          messageId: run.messageId,
          statusText,
        });
        this.broadcastActivity(run, true);
      }
      return;
    }

    if (type === 'message_end') {
      const msg = record.message as Record<string, unknown> | undefined;
      if (msg && msg.role === 'assistant') {
        const finalTurnUsage = parseUsageBucket(msg.usage) || (run.inflightUsage.total > 0 ? { ...run.inflightUsage } : null);
        if (finalTurnUsage) {
          run.committedUsage.input += finalTurnUsage.input;
          run.committedUsage.output += finalTurnUsage.output;
          run.committedUsage.cacheRead += finalTurnUsage.cacheRead;
          run.committedUsage.total += finalTurnUsage.total;
        }
        run.inflightUsage = emptyUsageBucket();

        const stopReason = String(msg.stopReason || '');
        if (stopReason === 'error') {
          const errText =
            typeof msg.errorMessage === 'string' && msg.errorMessage.trim()
              ? msg.errorMessage.trim()
              : run.lastError || '模型返回错误';
          run.lastError = errText;
          console.warn(
            `[pi-agent] message_end_error runId=${run.runId} projectId=${run.projectId} err=${errText.slice(0, 300)}`,
          );
        } else if (stopReason === 'stop' || stopReason === 'toolUse') {
          run.lastError = undefined;
        }
        this.checkBudget(run, true);
      }
      this.persistCheckpoint(run, false);
      return;
    }

    if (type === 'auto_retry_start') {
      const attempt = Number(record.attempt || 1);
      const maxAttempts = Number(record.maxAttempts || 3);
      const errMsg = typeof record.errorMessage === 'string' ? record.errorMessage : '';
      const statusText = `模型服务瞬时波动，正在自动第 ${attempt}/${maxAttempts} 次重试...`;
      run.statusText = statusText;
      console.warn(
        `[pi-agent] auto_retry_start runId=${run.runId} projectId=${run.projectId} attempt=${attempt}/${maxAttempts} err=${errMsg.slice(0, 200)}`,
      );
      run.lastSeq = eventBus.emit(run.projectId, {
        type: 'agent_status',
        messageId: run.messageId,
        statusText,
      });
      this.broadcastActivity(run, true);
      return;
    }

    if (type === 'auto_retry_end') {
      const success = Boolean(record.success);
      if (success) {
        run.lastError = undefined;
        const statusText = '重试恢复成功，Agent 继续执行任务...';
        run.statusText = statusText;
        console.log(`[pi-agent] auto_retry_end runId=${run.runId} projectId=${run.projectId} success=true`);
        run.lastSeq = eventBus.emit(run.projectId, {
          type: 'agent_status',
          messageId: run.messageId,
          statusText,
        });
        this.broadcastActivity(run, true);
      } else {
        const finalError =
          typeof record.finalError === 'string' && record.finalError.trim()
            ? record.finalError.trim()
            : run.lastError || '模型自动重试均失败';
        run.lastError = finalError;
        console.error(
          `[pi-agent] auto_retry_end runId=${run.runId} projectId=${run.projectId} success=false err=${finalError.slice(0, 300)}`,
        );
      }
      return;
    }

    if (type === 'compaction_start') {
      const statusText = '对话上下文较长，正在自动压缩整理记忆后继续执行...';
      run.statusText = statusText;
      console.log(`[pi-agent] compaction_start runId=${run.runId} projectId=${run.projectId}`);
      run.lastSeq = eventBus.emit(run.projectId, {
        type: 'agent_status',
        messageId: run.messageId,
        statusText,
      });
      this.broadcastActivity(run, true);
      return;
    }

    if (type === 'compaction_end') {
      run.statusText = undefined;
      const resultObj = record.result as Record<string, unknown> | undefined;
      const compUsage = parseUsageBucket(resultObj?.usage);
      if (compUsage) {
        run.committedUsage.input += compUsage.input;
        run.committedUsage.output += compUsage.output;
        run.committedUsage.cacheRead += compUsage.cacheRead;
        run.committedUsage.total += compUsage.total;
        this.checkBudget(run, true);
      }
      console.log(`[pi-agent] compaction_end runId=${run.runId} projectId=${run.projectId} aborted=${Boolean(record.aborted)}`);
      return;
    }

    if (type === 'tool_execution_start') {
      run.toolCalls += 1;
      const stepId = String(record.toolCallId || `exec-${run.steps.length + 1}`);
      const toolName = String(record.toolName || 'tool');
      const argsSummary = summarizeToolArgs(toolName, record.args);
      const existingIdx = run.stepIndexById.get(stepId);
      run.statusText = undefined;
      if (existingIdx !== undefined) {
        run.steps[existingIdx].argsSummary = argsSummary || run.steps[existingIdx].argsSummary;
        run.steps[existingIdx].status = 'running';
        run.lastSeq = eventBus.emit(run.projectId, {
          type: 'agent_tool_start',
          messageId: run.messageId,
          step: { ...run.steps[existingIdx] },
        });
      } else {
        const step: AgentToolStep = {
          id: stepId,
          toolName,
          argsSummary,
          status: 'running',
        };
        run.stepIndexById.set(stepId, run.steps.length);
        run.steps.push(step);
        run.lastSeq = eventBus.emit(run.projectId, {
          type: 'agent_tool_start',
          messageId: run.messageId,
          step: { ...step },
        });
      }
      this.checkBudget(run, true);
      this.broadcastActivity(run, true);
      return;
    }

    if (type === 'tool_execution_update') {
      const stepId = String(record.toolCallId || '');
      const idx = run.stepIndexById.get(stepId);
      const partial = extractTextFromToolResult(record.partialResult);
      if (idx !== undefined && partial) {
        run.steps[idx].output = partial;
        run.lastSeq = eventBus.emit(run.projectId, {
          type: 'agent_tool_update',
          messageId: run.messageId,
          stepId,
          outputDelta: partial,
        });
        this.broadcastActivity(run, false);
      }
      return;
    }

    if (type === 'tool_execution_end') {
      const stepId = String(record.toolCallId || '');
      const idx = run.stepIndexById.get(stepId);
      const isError = Boolean(record.isError);
      const output = extractTextFromToolResult(record.result);
      if (idx !== undefined) {
        run.steps[idx].status = isError ? 'error' : 'done';
        if (output) run.steps[idx].output = output;
        run.lastSeq = eventBus.emit(run.projectId, {
          type: 'agent_tool_end',
          messageId: run.messageId,
          stepId,
          status: run.steps[idx].status,
          output,
        });
        this.persistCheckpoint(run, true);
        this.checkBudget(run, true);
        this.broadcastActivity(run, true);
      }
      return;
    }

    if (type === 'bash_execution_update' && typeof record.chunk === 'string') {
      const lastRunning = [...run.steps].reverse().find((s) => s.status === 'running');
      if (lastRunning) {
        lastRunning.output = `${lastRunning.output || ''}${record.chunk}`.slice(-1200);
        run.lastSeq = eventBus.emit(run.projectId, {
          type: 'agent_tool_update',
          messageId: run.messageId,
          stepId: lastRunning.id,
          outputDelta: lastRunning.output,
        });
        this.broadcastActivity(run, false);
      }
      return;
    }

    if (type === 'agent_settled') {
      const isAborted = run.aborted || Boolean(record.aborted);
      if (isAborted) {
        void this.finalizeRun(run, 'aborted', run.lastError);
      } else if (run.lastError) {
        void this.finalizeRun(run, 'failed', run.lastError);
      } else {
        void this.finalizeRun(run, 'succeeded');
      }
    }
  }

  private async finalizeRun(
    run: ActiveRun,
    status: 'succeeded' | 'aborted' | 'failed',
    error?: string,
  ): Promise<void> {
    if (run.settled) return;
    run.settled = true;
    clearTimeout(run.timeoutTimer);
    clearTimeout(run.idleTimer);
    clearInterval(run.budgetTimer);

    try {
      run.child.stdin.end();
      setTimeout(() => {
        if (!run.child.killed) run.child.kill('SIGTERM');
      }, 800).unref();
    } catch {
      // ignore
    }

    const finalUsage = this.computeUsageStats(run);
    const finalBudget = this.buildBudgetSnapshot(run);

    let previewUrl: string | null = null;
    const isResearch = run.presetId === 'deep-research';
    const workspaceStillExists = Boolean(dbStore.getWorkspace(run.workspaceId));

    // For Deep Research, guarantee we NEVER leave the user empty-handed on manual abort,
    // budget cutoff, or error: synthesize a readable partial report from auto-archived sources.
    let researchArchive = { synthesized: false, hasArtifacts: false, totalSources: 0, fetchedCount: 0 };
    if (isResearch && workspaceStillExists) {
      const reasonLabel = run.budgetExceededReason
        ? run.budgetExceededReason
        : status === 'aborted'
          ? '用户主动终止'
          : status === 'failed'
            ? `执行中断（${error || '未知错误'}）`
            : '自动整理归档';
      try {
        researchArchive = synthesizePartialResearchReportIfNeeded(
          run.workspaceDir,
          reasonLabel,
          finalUsage,
        );
      } catch (err) {
        console.warn(
          `[pi-agent] partial_report_synthesis_failed runId=${run.runId} err=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const shouldStartPreview =
      workspaceStillExists && (status === 'succeeded' || (isResearch && researchArchive.hasArtifacts));

    if (shouldStartPreview) {
      const statusText = isResearch
        ? status === 'succeeded'
          ? '研究报告已完成，正在启动交互式报告预览服务...'
          : '已自动保存阶段性调研摘要，正在刷新研究报告预览...'
        : '代码已完成，正在启动全栈应用与 SQLite 数据库预览服务...';
      run.statusText = statusText;
      run.lastActivityAt = Date.now();
      run.lastSeq = eventBus.emit(run.projectId, {
        type: 'agent_status',
        messageId: run.messageId,
        statusText,
      });
      this.broadcastActivity(run, true);
      try {
        previewUrl = await run.onSettled(run.workspaceId, true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (status === 'succeeded') {
          error = `预览服务启动失败: ${msg}`;
          status = 'failed';
        }
      }
    }

    const archiveNote =
      isResearch && researchArchive.totalSources > 0
        ? `\n\n已自动保留 **${researchArchive.totalSources}** 条检索信源（含 **${researchArchive.fetchedCount}** 篇精读全文笔记，存放在 \`sources/\` 与 \`sources.json\`），${researchArchive.synthesized ? '并已为你自动生成阶段性调研摘要报告。' : '当前报告已保留在 `report.md`。'}你可以在右侧「研究报告」面板查看，或继续发消息让我基于已收集信源整理最终完整报告。`
        : '';

    const finalContent =
      run.assistantText.trim()
        ? `${run.assistantText.trim()}${status !== 'succeeded' ? archiveNote : ''}`
        : status === 'aborted'
          ? error
            ? `任务已因预算/超时保护终止：${error}。${archiveNote || '你可以继续输入新的需求或重试。'}`
            : `已停止本次任务。${archiveNote || '你可以继续输入新的需求或修改意见。'}`
          : status === 'failed'
            ? `执行过程中遇到错误：${error || '未知错误'}${archiveNote}`
            : isResearch
              ? '深度研究报告已生成！你可以在右侧「研究报告」面板查看完整内容与参考信源。'
              : '全栈项目构建完成！你可以在右侧预览并与应用交互。';

    console.log(
      `[pi-agent] finalized runId=${run.runId} projectId=${run.projectId} workspaceId=${run.workspaceId} status=${status} durationMs=${finalUsage.elapsedMs} tokens=${finalUsage.totalTokens} costCny=${finalUsage.estimatedCostCny} tools=${finalUsage.toolCalls} steps=${run.steps.length} archivedSources=${researchArchive.totalSources} preview=${Boolean(previewUrl)}${error ? ` err=${error.slice(0, 240)}` : ''}`,
    );

    const metadata: MessageMetadata = {
      mode: 'build',
      agentId: run.presetId,
      thinking: run.thinkingText || undefined,
      steps: run.steps,
      previewUrl: previewUrl || undefined,
      aborted: status === 'aborted' || undefined,
      error,
      usage: finalUsage,
      budget: finalBudget,
    };

    // Thread may have been deleted while the agent process was winding down.
    const projectStillExists = Boolean(dbStore.getProject(run.projectId));
    let savedMsg: MessageDTO | null = null;
    let updatedProj = null;

    if (projectStillExists) {
      savedMsg =
        dbStore.updateMessage(run.messageId, finalContent, metadata) ||
        dbStore.addMessage(run.projectId, 'assistant', finalContent, metadata);

      dbStore.finishAgentRun(run.runId, status, error);

      const projectStatus = status === 'succeeded' ? 'ready' : status === 'aborted' ? 'ready' : 'error';
      updatedProj = dbStore.updateProject(run.projectId, {
        status: projectStatus,
        ...(workspaceStillExists ? { workspaceId: run.workspaceId } : {}),
      });
    }

    this.activeRuns.delete(run.projectId);
    if (this.workspaceActiveProject.get(run.workspaceId) === run.projectId) {
      this.workspaceActiveProject.delete(run.workspaceId);
    }

    const wsRow = dbStore.getWorkspace(run.workspaceId);
    const updatedDto = updatedProj
      ? {
          ...toProjectDTO(updatedProj, Boolean(previewUrl), wsRow?.name),
          activeStep: null,
          lastActivityAt: null,
        }
      : null;

    if (updatedDto) {
      eventBus.emit(run.projectId, {
        type: 'project_updated',
        project: updatedDto,
      });
    }

    if (previewUrl && projectStillExists) {
      eventBus.emit(run.projectId, {
        type: 'preview_ready',
        projectId: run.projectId,
        previewUrl,
      });
    }

    if (savedMsg) {
      eventBus.emit(run.projectId, {
        type: 'agent_done',
        runId: run.runId,
        message: savedMsg,
        status,
        error,
      });
    }

    if (updatedDto) {
      eventBus.emitUser(run.owner, {
        type: 'project_run_finished',
        projectId: run.projectId,
        status,
        project: updatedDto,
      });
    }

    if (wsRow) {
      this.emitWorkspaceUpdate(run.owner, run.workspaceId, Boolean(previewUrl));
      // Automatically launch next queued build on the same workspace (if any)
      this.drainWorkspaceQueue(run.workspaceId);
    }
  }
}

export const piManager = new PiAgentManager();
