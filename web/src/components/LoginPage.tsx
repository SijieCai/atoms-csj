import React, { useState } from 'react';
import { Sparkles, Lock, User, ArrowRight, Database, Terminal } from 'lucide-react';
import { api } from '../api';

interface LoginPageProps {
  onSuccess: (username: string) => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.login(username.trim(), password);
      onSuccess(res.user.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white/95 backdrop-blur rounded-2xl shadow-2xl border border-slate-200/80 p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-11 h-11 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-lg shadow-indigo-600/30">
            <Sparkles className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Atoms Mini</h1>
            <p className="text-xs text-slate-500">AI 全栈应用构建与在线预览 Demo</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 mb-6 text-xs text-slate-600">
          <div className="flex items-center gap-2 bg-slate-50 border border-slate-200/70 rounded-lg px-3 py-2">
            <Terminal className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
            <span>隔离 Coding Agent</span>
          </div>
          <div className="flex items-center gap-2 bg-slate-50 border border-slate-200/70 rounded-lg px-3 py-2">
            <Database className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
            <span>SQLite 真实持久化</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">用户名</label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="输入预置体验账号"
                autoComplete="username"
                className="w-full pl-9 pr-3 py-2.5 text-sm rounded-xl border border-slate-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 outline-none transition"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">密码</label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="输入密码"
                autoComplete="current-password"
                className="w-full pl-9 pr-3 py-2.5 text-sm rounded-xl border border-slate-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 outline-none transition"
                required
              />
            </div>
          </div>

          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-medium transition shadow-sm cursor-pointer"
          >
            {loading ? '正在登录...' : '进入工作台'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <p className="mt-5 text-[11px] text-slate-400 text-center">
          Demo 环境无需注册，请联系管理员获取体验账号。
        </p>
      </div>
    </div>
  );
};
