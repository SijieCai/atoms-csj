import React, { useEffect, useRef, useState } from 'react';
import {
  Send,
  Square,
  Sparkles,
  Hammer,
  Bot,
  User,
  ExternalLink,
  Code2,
  FolderGit2,
  FolderPlus,
  FlaskConical,
  Link2,
  ChevronDown,
  Clock,
  ArrowRight,
  GitFork,
  PanelRightOpen,
  WifiOff,
  RefreshCw,
} from 'lucide-react';
import type { AgentPresetSummary, AgentToolStep, MessageDTO, ProjectDTO, WorkspaceDTO } from '@atoms/shared';
import { AgentStepCard } from './AgentStepCard';

export interface LiveStreamState {
  messageId: string;
  mode: 'chat' | 'build';
  queued?: boolean;
  text: string;
  thinking: string;
  steps: AgentToolStep[];
  statusText?: string;
  startedAt?: number;
  lastActivityAt?: number;
  seq?: number;
}

type RoutingMode = 'auto' | string;

interface ChatPanelProps {
  agents: AgentPresetSummary[];
  project: ProjectDTO | null;
  workspace: WorkspaceDTO | null;
  workspaces: WorkspaceDTO[];
  messages: MessageDTO[];
  liveStream: LiveStreamState | null;
  isBuilding: boolean;
  suggestBuild: boolean;
  glmConfigured: boolean;
  connectionState?: 'connected' | 'reconnecting';
  onRetryConnection?: () => void;
  onSend: (text: string, opts?: { forceBuild?: boolean; targetAgentId?: string }) => Promise<void>;
  onAbort: () => Promise<void>;
  onOpenPreview: () => void;
  onOpenVsCode: () => void;
  workspaceCollapsed?: boolean;
  onExpandWorkspace?: () => void;
  onSelectProject: (id: string) => void;
  onBindWorkspace: (opts: {
    workspaceId?: string;
    createNew?: boolean;
    name?: string;
    presetId?: string;
  }) => Promise<void>;
}

const FALLBACK_STARTERS = [
  {
    agentId: 'deep-research',
    title: '🔬 Deep Research：MCP 协议生态深度调研',
    prompt:
      '请使用 Deep Research 帮我深度调研 Model Context Protocol (MCP) 的架构设计、主流开源 SDK 生态与安全局限，输出带完整信源引用的研究报告。',
  },
  {
    agentId: 'fullstack-coder',
    title: '💻 全栈建站：个人记账本（SQLite 持久化）',
    prompt:
      '帮我构建一个个人记账本网站，支持新增收入/支出记录、分类筛选、月度汇总统计图表，所有数据真实持久化到 SQLite 数据库。',
  },
  {
    agentId: 'deep-research',
    title: '🔬 Deep Research：AI Coding Agent 架构对比',
    prompt:
      '帮我深度研究当前主流开源 AI Coding Agent 的沙箱隔离与工具调用架构差异，给出对比表格、争议点与选型建议。',
  },
];

export const ChatPanel: React.FC<ChatPanelProps> = ({
  agents,
  project,
  workspace,
  workspaces,
  messages,
  liveStream,
  isBuilding,
  suggestBuild,
  glmConfigured,
  connectionState = 'connected',
  onRetryConnection,
  onSend,
  onAbort,
  onOpenPreview,
  onOpenVsCode,
  workspaceCollapsed = false,
  onExpandWorkspace,
  onSelectProject,
  onBindWorkspace,
}) => {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [routingMode, setRoutingMode] = useState<RoutingMode>('auto');
  const [bindMenuOpen, setBindMenuOpen] = useState(false);
  const [binding, setBinding] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, liveStream?.text, liveStream?.steps.length, liveStream?.statusText]);

  useEffect(() => {
    setBindMenuOpen(false);
    setRoutingMode('auto');
  }, [project?.id, workspace?.id]);

  useEffect(() => {
    if (!bindMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setBindMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [bindMenuOpen]);

  const submit = async (
    overrideText?: string,
    opts?: { forceBuild?: boolean; targetAgentId?: string },
  ) => {
    const content = (overrideText ?? input).trim();
    if (!content || sending) return;
    if (!overrideText) setInput('');
    const resolvedTarget = opts?.targetAgentId ?? (routingMode !== 'auto' ? routingMode : undefined);
    setSending(true);
    try {
      await onSend(content, {
        forceBuild: opts?.forceBuild,
        targetAgentId: resolvedTarget,
      });
    } finally {
      setSending(false);
    }
  };

  const handleBind = async (opts: {
    workspaceId?: string;
    createNew?: boolean;
    name?: string;
    presetId?: string;
  }) => {
    setBinding(true);
    setBindMenuOpen(false);
    try {
      await onBindWorkspace(opts);
    } finally {
      setBinding(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const isEmpty = messages.length === 0 && !liveStream;
  const isQueued = Boolean(liveStream?.queued || project?.status === 'queued');
  const isResearchWs = workspace?.presetId === 'deep-research';
  const willForkOnSend = Boolean(
    workspace && routingMode !== 'auto' && routingMode !== workspace.presetId,
  );

  // Aggregate starter prompts across loaded Agent recipes (put Deep Research prominently alongside Coder)
  const starterPrompts =
    agents.length > 0
      ? [
          ...agents
            .filter((a) => a.id === 'deep-research')
            .flatMap((a) =>
              (a.ui?.starterPrompts || []).map((s) => ({ ...s, agentId: a.id })),
            ),
          ...agents
            .filter((a) => a.id !== 'deep-research')
            .flatMap((a) =>
              (a.ui?.starterPrompts || []).slice(0, 2).map((s) => ({ ...s, agentId: a.id })),
            ),
        ]
      : FALLBACK_STARTERS;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-white">
      {/* Header */}
      <div className="h-13 px-5 border-b border-slate-200 flex items-center justify-between gap-3 shrink-0">
        <div className="min-w-0 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900 truncate">
            {project ? project.title : '新对话'}
          </h2>

          {workspace && (
            <button
              type="button"
              onClick={onOpenVsCode}
              title={`当前对话绑定工作区：${workspace.name} (${workspace.id})，点击打开 VS Code`}
              className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full border transition cursor-pointer shrink-0 max-w-[200px] ${
                isResearchWs
                  ? 'bg-teal-50 hover:bg-teal-100 text-teal-800 border-teal-200'
                  : 'bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 border-slate-200'
              }`}
            >
              {isResearchWs ? (
                <FlaskConical className="w-3 h-3 text-teal-600 shrink-0" />
              ) : (
                <FolderGit2 className="w-3 h-3 text-indigo-600 shrink-0" />
              )}
              <span className="truncate">{workspace.name}</span>
            </button>
          )}

          {isQueued ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 shrink-0">
              <Clock className="w-3 h-3" />
              排队等待同工作区
            </span>
          ) : project?.status === 'building' || isBuilding ? (
            <span
              className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full border shrink-0 ${
                isResearchWs
                  ? 'bg-teal-50 text-teal-700 border-teal-200'
                  : 'bg-indigo-50 text-indigo-700 border-indigo-200'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full animate-ping ${
                  isResearchWs ? 'bg-teal-600' : 'bg-indigo-600'
                }`}
              />
              {isResearchWs ? 'Deep Research 研究中' : 'Agent 开发中'}
            </span>
          ) : null}
        </div>

        {/* Right Header Actions */}
        {workspace && workspaceCollapsed && onExpandWorkspace && (
          <button
            type="button"
            onClick={onExpandWorkspace}
            title={`展开右侧${isResearchWs ? '研究空间' : '代码仓库'}面板`}
            className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border transition cursor-pointer shrink-0 ${
              isResearchWs
                ? 'bg-teal-50 hover:bg-teal-100 text-teal-800 border-teal-200'
                : 'bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border-indigo-200'
            }`}
          >
            <PanelRightOpen className="w-3.5 h-3.5" />
            展开{isResearchWs ? '研究报告' : '工作区'}
          </button>
        )}

        {project && !workspace && !isBuilding && (
          <div className="flex items-center gap-2 shrink-0">
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                disabled={binding}
                onClick={() => setBindMenuOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition cursor-pointer"
              >
                <Code2 className="w-3.5 h-3.5" />
                {binding ? '挂载中...' : '打开 VS Code / 关联空间'}
                <ChevronDown className="w-3 h-3 text-slate-500" />
              </button>

              {bindMenuOpen && (
                <div className="absolute right-0 mt-1.5 w-64 rounded-xl bg-white border border-slate-200 shadow-xl py-1.5 z-30">
                  <button
                    type="button"
                    onClick={() => {
                      const defaultName = project.title !== '新对话' ? project.title : '新代码项目';
                      const inputName = window.prompt('输入新代码仓库名称：', defaultName);
                      if (inputName === null) return;
                      void handleBind({
                        createNew: true,
                        name: inputName.trim() || defaultName,
                        presetId: 'fullstack-coder',
                      });
                    }}
                    className="w-full px-3 py-2 text-left text-xs hover:bg-indigo-50 text-slate-800 flex items-center gap-2 cursor-pointer"
                  >
                    <FolderPlus className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                    <div>
                      <div className="font-medium">新建独立代码仓库</div>
                      <div className="text-[10px] text-slate-500">React + Express + SQLite 空间</div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const defaultName = project.title !== '新对话' ? project.title : '新研究课题';
                      const inputName = window.prompt('输入新研究空间名称：', defaultName);
                      if (inputName === null) return;
                      void handleBind({
                        createNew: true,
                        name: inputName.trim() || defaultName,
                        presetId: 'deep-research',
                      });
                    }}
                    className="w-full px-3 py-2 text-left text-xs hover:bg-teal-50 text-slate-800 flex items-center gap-2 cursor-pointer"
                  >
                    <FlaskConical className="w-3.5 h-3.5 text-teal-600 shrink-0" />
                    <div>
                      <div className="font-medium">新建 Deep Research 空间</div>
                      <div className="text-[10px] text-slate-500">外网检索 MCP + 交互式报告模板</div>
                    </div>
                  </button>

                  {workspaces.length > 0 && (
                    <>
                      <div className="my-1 border-t border-slate-100" />
                      <div className="px-3 py-1 text-[10px] font-medium text-slate-400 uppercase tracking-wider">
                        或关联到已有工作区
                      </div>
                      <div className="max-h-48 overflow-y-auto">
                        {workspaces.map((ws) => (
                          <button
                            key={ws.id}
                            type="button"
                            onClick={() => void handleBind({ workspaceId: ws.id })}
                            className="w-full px-3 py-1.5 text-left text-xs hover:bg-slate-50 text-slate-700 flex items-center gap-2 cursor-pointer"
                          >
                            <Link2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">{ws.name}</div>
                              <div className="text-[10px] font-mono text-slate-400 truncate">
                                {ws.presetId === 'deep-research' ? '研究空间' : '代码仓库'} · {ws.id}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {messages.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  void submit('请根据我们刚才讨论的需求，立刻开始构建这个全栈网站（含 SQLite 数据持久化）。', {
                    targetAgentId: 'fullstack-coder',
                  })
                }
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition cursor-pointer"
              >
                <Hammer className="w-3.5 h-3.5" />
                立即构建
              </button>
            )}
          </div>
        )}
      </div>

      {!glmConfigured && (
        <div className="mx-5 mt-3 px-3.5 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">
          提示：后端尚未配置 <code className="font-mono font-semibold">GLM_API_KEY</code>，请在{' '}
          <code className="font-mono">.env</code> 填入智谱 API Key 并重启服务。
        </div>
      )}

      {connectionState === 'reconnecting' && (
        <div className="mx-5 mt-3 px-3.5 py-2 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <WifiOff className="w-3.5 h-3.5 text-amber-600 shrink-0" />
            <span className="truncate">
              与服务器实时连接暂时中断，正在自动重连并同步状态（服务端 Agent 仍在后台独立运行，不会因此停止）...
            </span>
          </div>
          {onRetryConnection && (
            <button
              type="button"
              onClick={onRetryConnection}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-900 font-medium transition cursor-pointer shrink-0"
            >
              <RefreshCw className="w-3 h-3 animate-spin" />
              立即重连
            </button>
          )}
        </div>
      )}

      {/* Messages / Empty Welcome */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {isEmpty ? (
          <div className="h-full flex flex-col items-center justify-center max-w-2xl mx-auto text-center">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-600 to-teal-600 text-white flex items-center justify-center shadow-lg shadow-indigo-600/20 mb-4">
              <Sparkles className="w-6 h-6" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
              {workspace
                ? `在${isResearchWs ? '研究空间' : '仓库'}「${workspace.name}」中开始新任务`
                : '今天想做深度研究，还是构建全栈应用？'}
            </h1>
            <p className="mt-2 text-sm text-slate-500 leading-relaxed max-w-xl">
              {workspace
                ? isResearchWs
                  ? '此对话已绑定右侧 Deep Research 研究空间。你可以继续追问补充信源或更新报告；若提出「基于报告建站」，系统会自动新建独立全栈开发对话并传递报告摘要。'
                  : '此对话已绑定右侧代码仓库与 SQLite 空间。可直接提出功能迭代或修复指令；若提出深度调研需求，系统会自动新建 Deep Research 对话，不污染当前代码仓。'
                : '对话内置多 Agent 意图路由：既可直接发起 Deep Research（联网多源检索 + 网页爬虫 MCP + 带引用交互式报告），也可构建全栈 Web 应用。同一对话中切换不同 Agent 会自动开启新对话并传递上下文。'}
            </p>

            {/* Dual Agent Capability Banner */}
            {!workspace && (
              <div className="mt-5 w-full grid sm:grid-cols-2 gap-3 text-left">
                <button
                  type="button"
                  onClick={() => setRoutingMode('deep-research')}
                  className={`p-3.5 rounded-xl border transition cursor-pointer ${
                    routingMode === 'deep-research'
                      ? 'border-teal-500 bg-teal-50/70 ring-2 ring-teal-500/20'
                      : 'border-teal-200/80 bg-teal-50/30 hover:border-teal-400'
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs font-semibold text-teal-800">
                    <FlaskConical className="w-4 h-4 text-teal-600" />
                    Deep Research Agent（新能力）
                  </div>
                  <p className="mt-1 text-[11px] text-slate-600 leading-relaxed">
                    搭载开源 deep-research Skill 与外网爬虫 MCP，自动多源检索、抓取正文、交叉核验并生成可交互引用报告。
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setRoutingMode('fullstack-coder')}
                  className={`p-3.5 rounded-xl border transition cursor-pointer ${
                    routingMode === 'fullstack-coder'
                      ? 'border-indigo-500 bg-indigo-50/70 ring-2 ring-indigo-500/20'
                      : 'border-indigo-200/80 bg-indigo-50/30 hover:border-indigo-400'
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs font-semibold text-indigo-800">
                    <Code2 className="w-4 h-4 text-indigo-600" />
                    Fullstack Coder Agent
                  </div>
                  <p className="mt-1 text-[11px] text-slate-600 leading-relaxed">
                    React + Express + 用户隔离 SQLite 插件配方，自动开发并生成实时预览应用与在线 VS Code / LSP 环境。
                  </p>
                </button>
              </div>
            )}

            {!workspace && (
              <div className="mt-5 w-full grid gap-2 text-left">
                {starterPrompts.map((item) => {
                  const isDr = item.agentId === 'deep-research';
                  return (
                    <button
                      key={item.title}
                      type="button"
                      onClick={() => void submit(item.prompt)}
                      className={`p-3 rounded-xl border transition group cursor-pointer ${
                        isDr
                          ? 'border-slate-200 hover:border-teal-300 hover:bg-teal-50/40'
                          : 'border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/40'
                      }`}
                    >
                      <div
                        className={`text-xs font-semibold ${
                          isDr
                            ? 'text-slate-800 group-hover:text-teal-700'
                            : 'text-slate-800 group-hover:text-indigo-700'
                        }`}
                      >
                        {item.title}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500 line-clamp-2">{item.prompt}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-5">
            {messages
              .filter((m) => !(liveStream && m.id === liveStream.messageId))
              .map((msg) => {
                const handoff = msg.metadata?.handoff;
                const isMsgResearch = msg.metadata?.agentId === 'deep-research';
                return (
                  <div
                    key={msg.id}
                    className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    {msg.role !== 'user' && (
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                          handoff
                            ? 'bg-amber-100 text-amber-700'
                            : isMsgResearch
                              ? 'bg-teal-100 text-teal-700'
                              : 'bg-indigo-100 text-indigo-700'
                        }`}
                      >
                        {handoff ? (
                          <GitFork className="w-4 h-4" />
                        ) : isMsgResearch ? (
                          <FlaskConical className="w-4 h-4" />
                        ) : (
                          <Bot className="w-4 h-4" />
                        )}
                      </div>
                    )}
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-indigo-600 text-white rounded-br-md'
                          : handoff
                            ? 'bg-amber-50/70 border border-amber-200 text-slate-800 rounded-bl-md'
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

                      {handoff && (
                        <div className="mt-3 pt-2.5 border-t border-amber-200/80 flex items-center justify-between gap-3">
                          <div className="min-w-0 text-xs text-slate-600">
                            <span className="font-semibold text-slate-800">{handoff.targetAgentName}</span>
                            <span className="mx-1.5 text-slate-400">·</span>
                            <span className="truncate">{handoff.targetTitle}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => onSelectProject(handoff.targetProjectId)}
                            className="inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white transition cursor-pointer shrink-0"
                          >
                            前往新对话
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}

                      {msg.metadata?.previewUrl && (
                        <div className="mt-3 pt-2.5 border-t border-slate-200 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={onOpenPreview}
                            className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition cursor-pointer ${
                              isMsgResearch
                                ? 'text-teal-700 bg-teal-50 hover:bg-teal-100'
                                : 'text-indigo-700 bg-indigo-50 hover:bg-indigo-100'
                            }`}
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            {isMsgResearch ? '查看交互式研究报告' : '查看在线预览'}
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
                );
              })}

            {liveStream && (
              <div className="flex gap-3 justify-start">
                <div
                  className={`w-7 h-7 rounded-lg text-white flex items-center justify-center shrink-0 mt-0.5 ${
                    liveStream.queued
                      ? 'bg-amber-500'
                      : isResearchWs
                        ? 'bg-teal-600'
                        : 'bg-indigo-600'
                  }`}
                >
                  {isResearchWs ? <FlaskConical className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                </div>
                <div className="max-w-[85%] flex-1 rounded-2xl rounded-bl-md px-4 py-3 text-sm leading-relaxed bg-slate-50 border border-indigo-200/80 text-slate-800">
                  {liveStream.mode === 'build' && (
                    <AgentStepCard
                      thinking={liveStream.thinking}
                      steps={liveStream.steps}
                      statusText={liveStream.statusText}
                      isRunning={true}
                      isQueued={liveStream.queued}
                      startedAt={liveStream.startedAt}
                      lastActivityAt={liveStream.lastActivityAt}
                    />
                  )}
                  <div className="whitespace-pre-wrap break-words">
                    {liveStream.text || (liveStream.mode === 'chat' ? '思考中...' : '')}
                  </div>
                </div>
              </div>
            )}

            {suggestBuild && !isBuilding && project && !workspace && (
              <div className="flex flex-wrap gap-2 justify-start pl-10">
                <button
                  type="button"
                  onClick={() =>
                    void submit('方案没问题，立刻开始构建这个全栈网站吧！', {
                      targetAgentId: 'fullstack-coder',
                    })
                  }
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-sm transition cursor-pointer"
                >
                  <Hammer className="w-3.5 h-3.5" />
                  启动 Fullstack Coder 构建
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void submit('请针对刚才讨论的主题，启动 Deep Research 深度调研并输出带引用的研究报告。', {
                      targetAgentId: 'deep-research',
                    })
                  }
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium shadow-sm transition cursor-pointer"
                >
                  <FlaskConical className="w-3.5 h-3.5" />
                  启动 Deep Research 调研
                </button>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="px-4 pt-2.5 pb-4 border-t border-slate-200 bg-white shrink-0">
        <div className="max-w-3xl mx-auto">
          {/* Lightweight Agent Routing Selector */}
          <div className="mb-2 flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => setRoutingMode('auto')}
                className={`inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full border transition cursor-pointer ${
                  routingMode === 'auto'
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <Sparkles className="w-3 h-3" />
                自动意图路由
              </button>
              <button
                type="button"
                onClick={() => setRoutingMode('deep-research')}
                className={`inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full border transition cursor-pointer ${
                  routingMode === 'deep-research'
                    ? 'bg-teal-600 text-white border-teal-600'
                    : 'bg-teal-50/50 text-teal-700 border-teal-200 hover:bg-teal-100/70'
                }`}
              >
                <FlaskConical className="w-3 h-3" />
                Deep Research
              </button>
              <button
                type="button"
                onClick={() => setRoutingMode('fullstack-coder')}
                className={`inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full border transition cursor-pointer ${
                  routingMode === 'fullstack-coder'
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-indigo-50/50 text-indigo-700 border-indigo-200 hover:bg-indigo-100/70'
                }`}
              >
                <Code2 className="w-3 h-3" />
                Fullstack Coder
              </button>
            </div>
            {willForkOnSend && (
              <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                <GitFork className="w-3 h-3" />
                跨 Agent 将自动新建独立对话并传递上下文
              </span>
            )}
          </div>

          <div className="flex items-end gap-2 bg-slate-50 border border-slate-200 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-500/15 rounded-2xl p-2 transition">
            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                routingMode === 'deep-research'
                  ? '输入你想深度调研的主题、技术选型或竞品对比（Enter 启动 Deep Research）...'
                  : routingMode === 'fullstack-coder'
                    ? '描述你想构建或修改的全栈应用功能（Enter 启动 Fullstack Coder）...'
                    : isQueued
                      ? '任务正在排队等待同工作区前序任务完成，可输入补充要求合并进队列（Enter 发送）...'
                      : isBuilding
                        ? 'Agent 正在执行中，输入补充要求可实时插话调整（Enter 发送）...'
                        : workspace
                          ? isResearchWs
                            ? `向研究空间「${workspace.name}」追问补充信源，或直接说「基于报告做一个网站」（自动新开建站对话）...`
                            : `向仓库「${workspace.name}」发送开发指令，或直接发起深度调研（自动新开研究对话）...`
                          : '输入任何想法：可直接发起 Deep Research 深度研究、构建全栈网站，或先聊聊需求（Enter 发送）...'
              }
              className="flex-1 bg-transparent resize-none outline-none text-sm text-slate-800 placeholder:text-slate-400 px-2 py-1 max-h-36"
            />
            {isBuilding && (
              <button
                type="button"
                onClick={() => void onAbort()}
                title={isQueued ? '取消排队' : '停止当前任务'}
                className="px-3 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 text-xs font-medium flex items-center gap-1.5 transition cursor-pointer shrink-0"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                {isQueued ? '取消排队' : '停止'}
              </button>
            )}
            <button
              type="button"
              disabled={!input.trim() || sending}
              onClick={() => void submit()}
              className={`p-2.5 rounded-xl disabled:opacity-40 text-white transition cursor-pointer shrink-0 ${
                routingMode === 'deep-research'
                  ? 'bg-teal-600 hover:bg-teal-700'
                  : 'bg-indigo-600 hover:bg-indigo-700'
              }`}
              title={isBuilding ? '发送补充指令' : '发送'}
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
