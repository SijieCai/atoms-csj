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
  onSelectProject: (id: string) => void;
  onNewChat: () => void;
  onDeleteProject: (id: string) => void;
  onLogout: () => void;
}

function StatusDot({ status }: { status: ProjectDTO['status'] }) {
  if (status === 'building') {
    return <Loader2 className="w-3.5 h-3.5 text-indigo-500 animate-spin shrink-0" />;
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
            return (
              <div
                key={p.id}
                onClick={() => onSelectProject(p.id)}
                className={`group flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs cursor-pointer transition ${
                  active
                    ? 'bg-slate-800 text-white font-medium'
                    : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
                }`}
              >
                <StatusDot status={p.status} />
                <span className="flex-1 truncate">{p.title}</span>
                <button
                  type="button"
                  title="删除项目"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteProject(p.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-rose-400 transition cursor-pointer"
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
