import React, { useEffect, useRef, useState } from 'react';
import {
  Send,
  Square,
  Sparkles,
  Hammer,
  Bot,
  User,
  Database,
  ExternalLink,
  Code2,
} from 'lucide-react';
import type { AgentToolStep, MessageDTO, ProjectDTO } from '@atoms/shared';
import { AgentStepCard } from './AgentStepCard';

export interface LiveStreamState {
  messageId: string;
  mode: 'chat' | 'build';
  text: string;
  thinking: string;
  steps: AgentToolStep[];
  statusText?: string;
}

interface ChatPanelProps {
  project: ProjectDTO | null;
  messages: MessageDTO[];
  liveStream: LiveStreamState | null;
  isBuilding: boolean;
  suggestBuild: boolean;
  glmConfigured: boolean;
  onSend: (text: string, forceBuild?: boolean) => Promise<void>;
  onAbort: () => Promise<void>;
  onOpenPreview: () => void;
  onInitWorkspace: () => Promise<void>;
}

const STARTER_PROMPTS = [
  {
    title: '个人记账本（SQLite 持久化）',
    prompt: '帮我构建一个个人记账本网站，支持新增收入/支出记录、分类筛选、月度汇总统计图表，所有数据真实持久化到 SQLite 数据库。',
  },
  {
    title: '轻量任务看板（增删改查）',
    prompt: '帮我做一个团队任务看板应用，包含待办/进行中/已完成三列，支持新建任务、切换状态、设置优先级与关键词搜索，数据存到 SQLite。',
  },
  {
    title: '在线投票与意见收集墙',
    prompt: '先聊聊：我想做一个在线投票和匿名反馈收集墙，你帮我规划一下页面和功能吧。',
  },
];

export const ChatPanel: React.FC<ChatPanelProps> = ({
  project,
  messages,
  liveStream,
  isBuilding,
  suggestBuild,
  glmConfigured,
  onSend,
  onAbort,
  onOpenPreview,
  onInitWorkspace,
}) => {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, liveStream?.text, liveStream?.steps.length, liveStream?.statusText]);

  const submit = async (overrideText?: string, forceBuild = false) => {
    const content = (overrideText ?? input).trim();
    if (!content || sending) return;
    if (!overrideText) setInput('');
    setSending(true);
    try {
      await onSend(content, forceBuild);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const isEmpty = messages.length === 0 && !liveStream;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-white">
      {/* Header */}
      <div className="h-13 px-5 border-b border-slate-200 flex items-center justify-between gap-3 shrink-0">
        <div className="min-w-0 flex items-center gap-2.5">
          <h2 className="text-sm font-semibold text-slate-900 truncate">
            {project ? project.title : '新对话'}
          </h2>
          {project?.status === 'building' && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
              Agent 开发中
            </span>
          )}
          {project?.hasWorkspace && project.status !== 'building' && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
              <Database className="w-3 h-3" />
              全栈已就绪
            </span>
          )}
        </div>

        {project && !project.hasWorkspace && !isBuilding && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void onInitWorkspace()}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition cursor-pointer"
            >
              <Code2 className="w-3.5 h-3.5" />
              打开 VS Code
            </button>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  void submit('请根据我们刚才讨论的需求，立刻开始构建这个全栈网站（含 SQLite 数据持久化）。', true)
                }
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition cursor-pointer"
              >
                <Hammer className="w-3.5 h-3.5" />
                立即开始构建
              </button>
            )}
          </div>
        )}
      </div>

      {!glmConfigured && (
        <div className="mx-5 mt-3 px-3.5 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">
          提示：后端尚未配置 <code className="font-mono font-semibold">GLM_API_KEY</code>，请在 <code className="font-mono">.env</code> 填入智谱 API Key 并重启服务。
        </div>
      )}

      {/* Messages / Empty Welcome */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {isEmpty ? (
          <div className="h-full flex flex-col items-center justify-center max-w-xl mx-auto text-center">
            <div className="w-12 h-12 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-lg shadow-indigo-600/20 mb-4">
              <Sparkles className="w-6 h-6" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
              告诉我你想构建什么网站？
            </h1>
            <p className="mt-2 text-sm text-slate-500 leading-relaxed">
              先聊想法或直接下达构建指令——我会自动创建项目上下文，并在识别到全栈构建需求时，启动云端隔离 Coding Agent 自动写代码、配 SQLite 持久化数据库并生成可交互预览。
            </p>

            <div className="mt-7 w-full grid gap-2.5 text-left">
              {STARTER_PROMPTS.map((item) => (
                <button
                  key={item.title}
                  type="button"
                  onClick={() => void submit(item.prompt)}
                  className="p-3.5 rounded-xl border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/40 transition group cursor-pointer"
                >
                  <div className="text-xs font-semibold text-slate-800 group-hover:text-indigo-700">
                    {item.title}
                  </div>
                  <div className="mt-1 text-xs text-slate-500 line-clamp-2">{item.prompt}</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-5">
            {messages
              .filter((m) => !(liveStream && m.id === liveStream.messageId))
              .map((msg) => (
                <div
                  key={msg.id}
                  className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  {msg.role !== 'user' && (
                    <div className="w-7 h-7 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0 mt-0.5">
                      <Bot className="w-4 h-4" />
                    </div>
                  )}
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-indigo-600 text-white rounded-br-md'
                        : 'bg-slate-50 border border-slate-200/80 text-slate-800 rounded-bl-md'
                    }`}
                  >
                    {msg.role === 'assistant' && msg.metadata?.mode === 'build' && (
                      <AgentStepCard
                        thinking={msg.metadata.thinking}
                        steps={msg.metadata.steps}
                        isRunning={false}
                      />
                    )}
                    <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                    {msg.metadata?.previewUrl && (
                      <div className="mt-3 pt-2.5 border-t border-slate-200 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={onOpenPreview}
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg transition cursor-pointer"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          查看在线预览
                        </button>
                      </div>
                    )}
                  </div>
                  {msg.role === 'user' && (
                    <div className="w-7 h-7 rounded-lg bg-slate-200 text-slate-700 flex items-center justify-center shrink-0 mt-0.5">
                      <User className="w-4 h-4" />
                    </div>
                  )}
                </div>
              ))}

            {liveStream && (
              <div className="flex gap-3 justify-start">
                <div className="w-7 h-7 rounded-lg bg-indigo-600 text-white flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-4 h-4" />
                </div>
                <div className="max-w-[85%] flex-1 rounded-2xl rounded-bl-md px-4 py-3 text-sm leading-relaxed bg-slate-50 border border-indigo-200/80 text-slate-800">
                  {liveStream.mode === 'build' && (
                    <AgentStepCard
                      thinking={liveStream.thinking}
                      steps={liveStream.steps}
                      statusText={liveStream.statusText}
                      isRunning={true}
                    />
                  )}
                  <div className="whitespace-pre-wrap break-words">
                    {liveStream.text || (liveStream.mode === 'chat' ? '思考中...' : '')}
                  </div>
                </div>
              </div>
            )}

            {suggestBuild && !isBuilding && project && !project.hasWorkspace && (
              <div className="flex justify-start pl-10">
                <button
                  type="button"
                  onClick={() => void submit('方案没问题，立刻开始构建这个全栈网站吧！', true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-sm transition cursor-pointer"
                >
                  <Hammer className="w-3.5 h-3.5" />
                  确认方案，启动云端 Coding Agent 开始构建
                </button>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="p-4 border-t border-slate-200 bg-white shrink-0">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-end gap-2 bg-slate-50 border border-slate-200 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-500/15 rounded-2xl p-2 transition">
            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isBuilding
                  ? 'Agent 正在开发中，输入补充要求可实时插话调整（Enter 发送）...'
                  : project?.hasWorkspace
                    ? '继续描述你想新增的功能、修改的样式或修复的问题（Enter 发送）...'
                    : '描述你想构建的网站或先聊聊需求，支持前端交互 + SQLite 持久化（Enter 发送）...'
              }
              className="flex-1 bg-transparent resize-none outline-none text-sm text-slate-800 placeholder:text-slate-400 px-2 py-1 max-h-36"
            />
            {isBuilding && (
              <button
                type="button"
                onClick={() => void onAbort()}
                title="停止当前构建"
                className="px-3 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 text-xs font-medium flex items-center gap-1.5 transition cursor-pointer shrink-0"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                停止
              </button>
            )}
            <button
              type="button"
              disabled={!input.trim() || sending}
              onClick={() => void submit()}
              className="p-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white transition cursor-pointer shrink-0"
              title={isBuilding ? '发送插话指令' : '发送'}
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
