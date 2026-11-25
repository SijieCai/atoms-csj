import React, { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Loader2,
  XCircle,
  Terminal,
  FileCode2,
  Brain,
  Wrench,
  Database,
  Gauge,
  AlertTriangle,
} from 'lucide-react';
import type { AgentBudgetSnapshot, AgentToolStep, AgentUsageStats } from '@atoms/shared';

interface AgentStepCardProps {
  thinking?: string;
  steps?: AgentToolStep[];
  statusText?: string;
  usage?: AgentUsageStats;
  budget?: AgentBudgetSnapshot;
  isRunning?: boolean;
  isQueued?: boolean;
  startedAt?: number;
  lastActivityAt?: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCny(cny: number): string {
  if (cny < 0.01) return `¥${cny.toFixed(4)}`;
  return `¥${cny.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatAgo(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec <= 2) return '刚刚活跃';
  if (sec < 60) return `${sec} 秒前活跃`;
  return `${Math.floor(sec / 60)} 分钟前活跃`;
}

function ToolIcon({ name }: { name: string }) {
  const lower = name.toLowerCase();
  if (lower.includes('atoms_db') || lower.includes('sql') || lower.includes('table')) {
    return <Database className="w-3.5 h-3.5 text-emerald-600 shrink-0" />;
  }
  if (lower.includes('bash') || lower.includes('exec') || lower.includes('shell')) {
    return <Terminal className="w-3.5 h-3.5 text-amber-600 shrink-0" />;
  }
  if (lower.includes('write') || lower.includes('edit') || lower.includes('read')) {
    return <FileCode2 className="w-3.5 h-3.5 text-indigo-600 shrink-0" />;
  }
  return <Wrench className="w-3.5 h-3.5 text-slate-500 shrink-0" />;
}

export const AgentStepCard: React.FC<AgentStepCardProps> = ({
  thinking,
  steps = [],
  statusText,
  usage,
  budget,
  isRunning,
  isQueued,
  startedAt,
  lastActivityAt,
}) => {
  const [showThinking, setShowThinking] = useState(false);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRunning) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  if (!thinking && steps.length === 0 && !statusText && !isRunning && !usage) {
    return null;
  }

  const idleMs = lastActivityAt ? Math.max(0, now - lastActivityAt) : 0;
  const elapsedMs = isRunning && startedAt ? Math.max(0, now - startedAt) : usage?.elapsedMs ?? 0;
  const isRecentlyActive = idleMs < 20_000;

  const budgetMaxRatio =
    usage && budget
      ? Math.min(
          1,
          Math.max(
            elapsedMs / budget.limits.maxDurationMs,
            usage.estimatedCostCny / budget.limits.maxCostCny,
            usage.totalTokens / budget.limits.maxTokens,
            usage.toolCalls / budget.limits.maxToolCalls,
          ),
        )
      : 0;
  const budgetPct = Math.round(budgetMaxRatio * 100);

  return (
    <div className="mb-3 space-y-2">
      {thinking && (
        <div className="rounded-xl border border-slate-200 bg-slate-50/90 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowThinking((v) => !v)}
            className="w-full px-3 py-2 flex items-center gap-2 text-xs text-slate-600 hover:bg-slate-100/80 transition cursor-pointer"
          >
            <Brain className="w-3.5 h-3.5 text-purple-600" />
            <span className="font-medium">思考过程</span>
            <span className="text-[11px] text-slate-400">({thinking.length} 字)</span>
            <span className="ml-auto">
              {showThinking ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </span>
          </button>
          {showThinking && (
            <pre className="px-3 pb-3 pt-1 text-[11px] leading-relaxed text-slate-600 whitespace-pre-wrap break-words max-h-56 overflow-y-auto border-t border-slate-200/60 font-sans">
              {thinking}
            </pre>
          )}
        </div>
      )}

      {steps.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100 overflow-hidden">
          {steps.map((step) => {
            const expanded = expandedStepId === step.id;
            return (
              <div key={step.id} className="text-xs">
                <button
                  type="button"
                  onClick={() => setExpandedStepId(expanded ? null : step.id)}
                  className="w-full px-3 py-2 flex items-center gap-2 hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  {step.status === 'running' ? (
                    <Loader2 className="w-3.5 h-3.5 text-indigo-600 animate-spin shrink-0" />
                  ) : step.status === 'error' ? (
                    <XCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                  ) : (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                  )}
                  <ToolIcon name={step.toolName} />
                  <span className="font-mono font-medium text-slate-700 shrink-0">{step.toolName}</span>
                  {step.argsSummary && (
                    <span className="text-slate-500 truncate flex-1 font-mono text-[11px]">
                      {step.argsSummary}
                    </span>
                  )}
                  {step.output && (
                    <span className="text-slate-400 shrink-0">
                      {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </span>
                  )}
                </button>
                {expanded && step.output && (
                  <pre className="px-3 py-2 bg-slate-950 text-slate-200 text-[11px] font-mono overflow-x-auto max-h-48 whitespace-pre-wrap break-all">
                    {step.output}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}

      {(statusText || isRunning) && (
        <div
          className={`flex flex-wrap items-center justify-between gap-2 text-xs rounded-lg px-3 py-1.5 border ${
            isQueued
              ? 'text-amber-800 bg-amber-50 border-amber-200'
              : 'text-indigo-700 bg-indigo-50 border-indigo-100'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {isRunning && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />}
            <span className="truncate">{statusText || 'Pi Coding Agent 正在隔离工作区开发与编译...'}</span>
          </div>
          {isRunning && (startedAt || lastActivityAt) && (
            <div
              className={`flex items-center gap-2 text-[11px] shrink-0 font-mono ${
                isQueued ? 'text-amber-700/80' : 'text-indigo-600/80'
              }`}
            >
              {startedAt && <span>{isQueued ? '已等待' : '已耗时'} {formatDuration(elapsedMs)}</span>}
              {!isQueued && lastActivityAt && (
                <span className="inline-flex items-center gap-1">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      isRecentlyActive ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
                    }`}
                  />
                  {formatAgo(idleMs)}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {usage && budget && !isQueued && (
        <div
          className={`rounded-lg px-3 py-1.5 border text-[11px] ${
            budget.exceededReason
              ? 'bg-rose-50/80 border-rose-200 text-rose-800'
              : budget.softWarned
                ? 'bg-amber-50/80 border-amber-200 text-amber-900'
                : 'bg-slate-50/80 border-slate-200/80 text-slate-600'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-medium">
              {budget.exceededReason || budget.softWarned ? (
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              ) : (
                <Gauge className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              )}
              <span>
                {budget.exceededReason
                  ? `预算保护终止：${budget.exceededReason}`
                  : budget.softWarned
                    ? '接近预算上限，已通知 Agent 收口'
                    : isRunning
                      ? '运行预算监控'
                      : '本次执行消耗'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2.5 font-mono text-[10px]">
              <span>
                耗时 {formatDuration(elapsedMs)}/{formatDuration(budget.limits.maxDurationMs)}
              </span>
              <span>
                步数 {usage.toolCalls}/{budget.limits.maxToolCalls}
              </span>
              <span>
                Tokens {formatTokens(usage.totalTokens)}/{formatTokens(budget.limits.maxTokens)}
              </span>
              <span>
                估算 {formatCny(usage.estimatedCostCny)}/{formatCny(budget.limits.maxCostCny)}
              </span>
            </div>
          </div>
          {isRunning && (
            <div className="mt-1.5 h-1 w-full rounded-full bg-slate-200/80 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  budget.exceededReason
                    ? 'bg-rose-500'
                    : budget.softWarned || budgetPct >= 75
                      ? 'bg-amber-500'
                      : 'bg-indigo-500'
                }`}
                style={{ width: `${Math.max(4, Math.min(100, budgetPct))}%` }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
