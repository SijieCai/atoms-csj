import React, { useState } from 'react';
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
} from 'lucide-react';
import type { AgentToolStep } from '@atoms/shared';

interface AgentStepCardProps {
  thinking?: string;
  steps?: AgentToolStep[];
  statusText?: string;
  isRunning?: boolean;
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
  isRunning,
}) => {
  const [showThinking, setShowThinking] = useState(false);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);

  if (!thinking && steps.length === 0 && !statusText && !isRunning) {
    return null;
  }

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
        <div className="flex items-center gap-2 text-xs text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-1.5">
          {isRunning && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />}
          <span>{statusText || 'Pi Coding Agent 正在隔离工作区开发与编译...'}</span>
        </div>
      )}
    </div>
  );
};
