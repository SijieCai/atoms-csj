import React from 'react';
import {
  Plus,
  MessageSquare,
  Globe,
  Loader2,
  AlertCircle,
  Trash2,
  LogOut,
  Sparkles,
} from 'lucide-react';
import type { ProjectDTO } from '@atoms/shared';

interface SidebarProps {
  username: string;
  projects: ProjectDTO[];
  activeProjectId: string | null;
  unreadCompletions: Record<string, 'succeeded' | 'aborted' | 'failed'>;
  onSelectProject: (id: string) => void;
  onNewChat: () => void;
  onDeleteProject: (id: string) => void;
  onLogout: () => void;
}

function StatusDot({ status }: { status: ProjectDTO['status'] }) {
  if (status === 'building') {
    return <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin shrink-0" />;
  }
  if (status === 'ready') {
    return <Globe className="w-3.5 h-3.5 text-emerald-500 shrink-0" />;
  }
  if (status === 'error') {
    return <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />;
  }
  return <MessageSquare className="w-3.5 h-3.5 text-slate-400 shrink-0" />;
}

export const Sidebar: React.FC<SidebarProps> = ({
  username,
  projects,
  activeProjectId,
  unreadCompletions,
  onSelectProject,
  onNewChat,
  onDeleteProject,
  onLogout,
}) => {
  return (
    <aside className="w-64 bg-slate-900 text-slate-200 flex flex-col border-r border-slate-800 shrink-0">
      <div className="px-4 py-3.5 border-b border-slate-800 flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center">
          <Sparkles className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white truncate">Atoms Mini</div>
          <div className="text-[11px] text-slate-400 truncate">Full-Stack AI Builder</div>
        </div>
      </div>

      <div className="p-3">
        <button
          onClick={onNewChat}
          className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          新建对话 / 项目
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-1">
        <div className="px-2 py-1 text-[11px] font-medium text-slate-500 uppercase tracking-wider">
          我的项目 ({projects.length})
        </div>
        {projects.length === 0 ? (
          <div className="px-2 py-6 text-xs text-slate-500 text-center">
            在右侧发消息即可自动创建项目
          </div>
        ) : (
          projects.map((p) => {
            const active = p.id === activeProjectId;
            const unread = unreadCompletions[p.id];
            const isWorking = p.status === 'building' || Boolean(p.activeStep);
            return (
              <div
                key={p.id}
                onClick={() => onSelectProject(p.id)}
                className={`group flex items-start gap-2 px-2.5 py-2 rounded-lg text-xs cursor-pointer transition ${
                  active
                    ? 'bg-slate-800 text-white font-medium'
                    : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
                }`}
              >
                <div className="mt-0.5">
                  <StatusDot status={p.status} />
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
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-indigo-300 truncate">
                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse shrink-0" />
                      <span className="truncate">{p.activeStep || 'Agent 运行中...'}</span>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  title="删除项目"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteProject(p.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-rose-400 transition cursor-pointer shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })
        )}
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
