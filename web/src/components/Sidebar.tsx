import React, { useEffect, useRef, useState } from 'react';
import {
  Plus,
  MessageSquare,
  Globe,
  Loader2,
  AlertCircle,
  Trash2,
  LogOut,
  Sparkles,
  FolderGit2,
  FolderPlus,
  FlaskConical,
  ChevronDown,
  ChevronRight,
  Clock,
} from 'lucide-react';
import type { AgentPresetSummary, ProjectDTO, WorkspaceDTO } from '@atoms/shared';

interface SidebarProps {
  username: string;
  agents: AgentPresetSummary[];
  workspaces: WorkspaceDTO[];
  projects: ProjectDTO[];
  activeProjectId: string | null;
  unreadCompletions: Record<string, 'succeeded' | 'aborted' | 'failed'>;
  onSelectProject: (id: string) => void;
  onNewChat: () => void;
  onNewWorkspace: (presetId?: string) => void;
  onNewThreadInWorkspace: (workspaceId: string) => void;
  onDeleteProject: (id: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onLogout: () => void;
}

function StatusDot({ status, isResearch }: { status: ProjectDTO['status']; isResearch?: boolean }) {
  if (status === 'building') {
    return (
      <Loader2
        className={`w-3.5 h-3.5 animate-spin shrink-0 ${
          isResearch ? 'text-teal-400' : 'text-indigo-400'
        }`}
      />
    );
  }
  if (status === 'queued') {
    return <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
  }
  if (status === 'ready') {
    return isResearch ? (
      <FlaskConical className="w-3.5 h-3.5 text-teal-400 shrink-0" />
    ) : (
      <Globe className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
    );
  }
  if (status === 'error') {
    return <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />;
  }
  return <MessageSquare className="w-3.5 h-3.5 text-slate-400 shrink-0" />;
}

export const Sidebar: React.FC<SidebarProps> = ({
  username,
  agents,
  workspaces,
  projects,
  activeProjectId,
  unreadCompletions,
  onSelectProject,
  onNewChat,
  onNewWorkspace,
  onNewThreadInWorkspace,
  onDeleteProject,
  onDeleteWorkspace,
  onLogout,
}) => {
  const [collapsedWs, setCollapsedWs] = useState<Record<string, boolean>>({});
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!createMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) {
        setCreateMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [createMenuOpen]);

  const toggleWs = (wsId: string) => {
    setCollapsedWs((prev) => ({ ...prev, [wsId]: !prev[wsId] }));
  };

  const projectsByWorkspace = new Map<string, ProjectDTO[]>();
  const standaloneProjects: ProjectDTO[] = [];
  for (const p of projects) {
    if (p.workspaceId) {
      const list = projectsByWorkspace.get(p.workspaceId) || [];
      list.push(p);
      projectsByWorkspace.set(p.workspaceId, list);
    } else {
      standaloneProjects.push(p);
    }
  }

  const renderProjectRow = (p: ProjectDTO, indented: boolean, isResearch = false) => {
    const active = p.id === activeProjectId;
    const unread = unreadCompletions[p.id];
    const isWorking = p.status === 'building' || p.status === 'queued' || Boolean(p.activeStep);
    return (
      <div
        key={p.id}
        onClick={() => onSelectProject(p.id)}
        className={`group flex items-start gap-2 ${
          indented ? 'pl-5 pr-2 py-1.5' : 'px-2.5 py-2'
        } rounded-lg text-xs cursor-pointer transition ${
          active
            ? 'bg-slate-800 text-white font-medium'
            : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
        }`}
      >
        <div className="mt-0.5">
          <StatusDot status={p.status} isResearch={isResearch} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="flex-1 truncate">{p.title}</span>
            {!active && unread === 'succeeded' && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-medium">
                已完成
              </span>
            )}
            {!active && unread === 'failed' && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 font-medium">
                出错
              </span>
            )}
          </div>
          {isWorking && (
            <div
              className={`mt-0.5 flex items-center gap-1.5 text-[10px] truncate ${
                p.status === 'queued'
                  ? 'text-amber-300'
                  : isResearch
                    ? 'text-teal-300'
                    : 'text-indigo-300'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  p.status === 'queued'
                    ? 'bg-amber-400'
                    : isResearch
                      ? 'bg-teal-400 animate-pulse'
                      : 'bg-indigo-400 animate-pulse'
                }`}
              />
              <span className="truncate">{p.activeStep || 'Agent 运行中...'}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          title="删除此对话（不删除工作区文件）"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteProject(p.id);
          }}
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-rose-400 transition cursor-pointer shrink-0"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    );
  };

  return (
    <aside className="w-68 bg-slate-900 text-slate-200 flex flex-col border-r border-slate-800 shrink-0">
      <div className="px-4 py-3.5 border-b border-slate-800 flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center">
          <Sparkles className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white truncate">Atoms Mini</div>
          <div className="text-[11px] text-slate-400 truncate">Multi-Agent Workspaces</div>
        </div>
      </div>

      {/* Primary Actions */}
      <div className="p-3 grid grid-cols-2 gap-1.5">
        <button
          onClick={onNewChat}
          className="flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          新建对话
        </button>
        <div className="relative" ref={createMenuRef}>
          <button
            type="button"
            onClick={() => setCreateMenuOpen((v) => !v)}
            className="w-full flex items-center justify-center gap-1 py-2 px-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium transition cursor-pointer"
          >
            <FolderPlus className="w-3.5 h-3.5 text-indigo-400" />
            新建空间
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>

          {createMenuOpen && (
            <div className="absolute right-0 mt-1.5 w-52 rounded-xl bg-slate-800 border border-slate-700 shadow-2xl py-1 z-30">
              {(agents.length > 0
                ? agents
                : [
                    {
                      id: 'fullstack-coder',
                      name: 'Fullstack Coder',
                      shortName: '代码仓库',
                      icon: 'code' as const,
                      description: 'React + Express + SQLite',
                      templateId: 'fullstack-app',
                      plugins: [],
                      ui: {
                        workspaceLabel: '代码仓库',
                        previewTabLabel: '应用预览',
                        tabs: ['preview', 'code', 'database', 'logs'] as const,
                        starterPrompts: [],
                      },
                    },
                    {
                      id: 'deep-research',
                      name: 'Deep Research',
                      shortName: '研究空间',
                      icon: 'research' as const,
                      description: '外网检索与引用报告',
                      templateId: 'deep-research',
                      plugins: [],
                      ui: {
                        workspaceLabel: '研究空间',
                        previewTabLabel: '研究报告',
                        tabs: ['preview', 'code', 'logs'] as const,
                        starterPrompts: [],
                      },
                    },
                  ]
              ).map((agent) => {
                const isResearch = agent.id === 'deep-research' || agent.icon === 'research';
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      onNewWorkspace(agent.id);
                    }}
                    className="w-full px-3 py-2 text-left text-xs hover:bg-slate-700/80 text-slate-100 flex items-start gap-2 cursor-pointer"
                  >
                    {isResearch ? (
                      <FlaskConical className="w-3.5 h-3.5 text-teal-400 shrink-0 mt-0.5" />
                    ) : (
                      <FolderGit2 className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0">
                      <div className="font-medium">新建{agent.ui?.workspaceLabel || agent.shortName}</div>
                      <div className="text-[10px] text-slate-400 truncate">{agent.name}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-3">
        {/* Section 1: Workspaces (Code Repos & Research Spaces) */}
        <div>
          <div className="px-2 py-1 text-[11px] font-medium text-slate-500 uppercase tracking-wider flex items-center justify-between">
            <span>工作区 ({workspaces.length})</span>
          </div>
          {workspaces.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-slate-500 text-center">
              发起深度研究 / 全栈构建即可自动创建工作区
            </div>
          ) : (
            <div className="space-y-1.5">
              {workspaces.map((ws) => {
                const wsThreads = projectsByWorkspace.get(ws.id) || [];
                const collapsed = Boolean(collapsedWs[ws.id]);
                const wsBusy = Boolean(ws.activeBuildProjectId);
                const isResearch = ws.presetId === 'deep-research';
                return (
                  <div
                    key={ws.id}
                    className="rounded-lg bg-slate-950/40 border border-slate-800/80 overflow-hidden"
                  >
                    <div
                      onClick={() => toggleWs(ws.id)}
                      className="group flex items-center gap-1.5 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                    >
                      <span className="text-slate-500 shrink-0">
                        {collapsed ? (
                          <ChevronRight className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                      </span>
                      {wsBusy ? (
                        <Loader2
                          className={`w-3.5 h-3.5 animate-spin shrink-0 ${
                            isResearch ? 'text-teal-400' : 'text-indigo-400'
                          }`}
                        />
                      ) : isResearch ? (
                        <FlaskConical className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                      ) : (
                        <FolderGit2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                      )}
                      <span className="flex-1 font-medium truncate" title={`${ws.name} (${ws.id})`}>
                        {ws.name}
                      </span>
                      <span
                        className={`text-[9px] px-1 py-0.2 rounded shrink-0 ${
                          isResearch
                            ? 'bg-teal-500/15 text-teal-300 border border-teal-500/25'
                            : 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/25'
                        }`}
                      >
                        {isResearch ? '研究' : '代码'}
                      </span>
                      <button
                        type="button"
                        title={`在「${ws.name}」下新建并行对话`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewThreadInWorkspace(ws.id);
                        }}
                        className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-indigo-300 transition cursor-pointer shrink-0"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        title={`删除工作区「${ws.name}」及其文件`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteWorkspace(ws.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-rose-400 transition cursor-pointer shrink-0"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>

                    {!collapsed && (
                      <div className="px-1 pb-1 space-y-0.5">
                        {wsThreads.length === 0 ? (
                          <button
                            type="button"
                            onClick={() => onNewThreadInWorkspace(ws.id)}
                            className="w-full text-left pl-6 pr-2 py-1.5 text-[11px] text-slate-500 hover:text-indigo-300 transition cursor-pointer"
                          >
                            + 点击在此空间开启对话
                          </button>
                        ) : (
                          wsThreads.map((p) => renderProjectRow(p, true, isResearch))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Section 2: Standalone (Unbound) Chats */}
        <div>
          <div className="px-2 py-1 text-[11px] font-medium text-slate-500 uppercase tracking-wider">
            未绑定对话 ({standaloneProjects.length})
          </div>
          {standaloneProjects.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-slate-600 text-center">暂无未绑定对话</div>
          ) : (
            <div className="space-y-0.5">{standaloneProjects.map((p) => renderProjectRow(p, false))}</div>
          )}
        </div>
      </div>

      <div className="p-3 border-t border-slate-800 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-full bg-slate-700 text-xs font-semibold flex items-center justify-center uppercase text-white shrink-0">
            {username.slice(0, 1)}
          </div>
          <span className="text-xs text-slate-300 truncate">{username}</span>
        </div>
        <button
          onClick={onLogout}
          title="退出登录"
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
};
