import React, { useCallback, useEffect, useState } from 'react';
import {
  Globe,
  Code2,
  TerminalSquare,
  RefreshCw,
  ExternalLink,
  Copy,
  Check,
  RotateCcw,
  Database,
  Loader2,
  Puzzle,
  Table2,
  FolderGit2,
  FlaskConical,
  BookOpen,
  Clock,
  PanelRightClose,
} from 'lucide-react';
import type { AgentPresetSummary, FileTreeNode, TableInfoDTO, WorkspaceDTO } from '@atoms/shared';
import { api } from '../api';
import { getPublicOrigin } from '../env';
import { CodeEditorIDE } from './CodeEditorIDE';

export type WorkspaceTabKey = 'preview' | 'code' | 'database' | 'logs';

interface WorkspacePanelProps {
  workspace: WorkspaceDTO;
  agent?: AgentPresetSummary | null;
  previewRevision: number;
  isBuilding: boolean;
  requestedTab?: { tab: WorkspaceTabKey; nonce: number } | null;
  collapsed?: boolean;
  onCollapse?: () => void;
}

export const WorkspacePanel: React.FC<WorkspacePanelProps> = ({
  workspace,
  agent,
  previewRevision,
  isBuilding,
  requestedTab,
  collapsed = false,
  onCollapse,
}) => {
  const isResearch = workspace.presetId === 'deep-research' || agent?.icon === 'research';
  const visibleTabs: WorkspaceTabKey[] = agent?.ui?.tabs?.length
    ? agent.ui.tabs
    : isResearch
      ? ['preview', 'code', 'logs']
      : ['preview', 'code', 'database', 'logs'];
  const previewTabLabel = agent?.ui?.previewTabLabel || (isResearch ? '研究报告' : '应用预览');
  const workspaceLabel = agent?.ui?.workspaceLabel || (isResearch ? '研究空间' : '代码仓库');

  const [tab, setTab] = useState<WorkspaceTabKey>(
    requestedTab && visibleTabs.includes(requestedTab.tab) ? requestedTab.tab : 'preview',
  );
  const [iframeNonce, setIframeNonce] = useState(0);
  const [copied, setCopied] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const [files, setFiles] = useState<FileTreeNode[]>([]);

  const [tablesInfo, setTablesInfo] = useState<{
    prefix: string;
    preset?: AgentPresetSummary;
    tables: TableInfoDTO[];
  } | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableRows, setTableRows] = useState<Record<string, unknown>[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);

  const [logsInfo, setLogsInfo] = useState<{
    running: boolean;
    port: number | null;
    logs: string[];
    hasDb: boolean;
    tableCount: number;
  } | null>(null);

  const shareUrl = `${getPublicOrigin()}${workspace.previewUrl}`;
  const workspaceBusy = Boolean(workspace.activeBuildProjectId) || isBuilding;

  useEffect(() => {
    if (requestedTab && visibleTabs.includes(requestedTab.tab)) {
      setTab(requestedTab.tab);
    }
  }, [requestedTab, visibleTabs]);

  const loadFiles = useCallback(async () => {
    try {
      const res = await api.listFiles(workspace.id);
      setFiles(res.files);
    } catch {
      // ignore
    }
  }, [workspace.id]);

  const loadTables = useCallback(async () => {
    try {
      const res = await api.getTables(workspace.id);
      setTablesInfo(res);
    } catch {
      // ignore
    }
  }, [workspace.id]);

  const loadLogs = useCallback(async () => {
    try {
      const res = await api.getLogs(workspace.id);
      setLogsInfo(res);
    } catch {
      // ignore
    }
  }, [workspace.id]);

  useEffect(() => {
    setSelectedTable(null);
    setTableRows([]);
    setIframeNonce((n) => n + 1);
    void loadFiles();
    void loadTables();
    void loadLogs();
  }, [workspace.id, previewRevision, loadFiles, loadTables, loadLogs]);

  useEffect(() => {
    if (tab === 'code') void loadFiles();
    if (tab === 'database') void loadTables();
    if (tab === 'logs') void loadLogs();
  }, [tab, loadFiles, loadTables, loadLogs]);

  const handleInspectTable = async (logicalName: string) => {
    setSelectedTable(logicalName);
    setLoadingRows(true);
    try {
      const res = await api.getTableRows(workspace.id, logicalName);
      setTableRows(res.rows);
    } catch {
      setTableRows([]);
    } finally {
      setLoadingRows(false);
    }
  };

  const handleCopyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await api.restartPreview(workspace.id);
      setIframeNonce((n) => n + 1);
      await Promise.all([loadLogs(), loadTables(), loadFiles()]);
    } catch (err) {
      alert(err instanceof Error ? err.message : '重启预览失败');
    } finally {
      setRestarting(false);
    }
  };

  return (
    <section
      className={`${
        collapsed
          ? 'hidden'
          : tab === 'code'
            ? 'w-[58%] max-w-[1040px] flex'
            : 'w-[48%] max-w-[840px] flex'
      } min-w-[460px] border-l border-slate-200 bg-slate-50 flex-col shrink-0 transition-[width] duration-150`}
    >
      {/* Tab Bar */}
      <div className="h-13 px-3 border-b border-slate-200 bg-white flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1">
          {visibleTabs.includes('preview') && (
            <button
              type="button"
              onClick={() => setTab('preview')}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
                tab === 'preview'
                  ? isResearch
                    ? 'bg-teal-50 text-teal-700'
                    : 'bg-indigo-50 text-indigo-700'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {isResearch ? <BookOpen className="w-3.5 h-3.5" /> : <Globe className="w-3.5 h-3.5" />}
              {previewTabLabel}
            </button>
          )}
          {visibleTabs.includes('code') && (
            <button
              type="button"
              onClick={() => setTab('code')}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
                tab === 'code' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" />
              VS Code
            </button>
          )}
          {visibleTabs.includes('database') && (
            <button
              type="button"
              onClick={() => setTab('database')}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
                tab === 'database' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <Database className="w-3.5 h-3.5" />
              数据表
              {tablesInfo && tablesInfo.tables.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-emerald-100 text-emerald-700 text-[10px]">
                  {tablesInfo.tables.length}
                </span>
              )}
            </button>
          )}
          {visibleTabs.includes('logs') && (
            <button
              type="button"
              onClick={() => setTab('logs')}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
                tab === 'logs' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <TerminalSquare className="w-3.5 h-3.5" />
              日志
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={restarting || workspaceBusy}
            onClick={() => void handleRestart()}
            title={isResearch ? '刷新并重启报告预览服务' : '重新编译并重启应用预览'}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 disabled:opacity-40 transition cursor-pointer"
          >
            <RotateCcw className={`w-3.5 h-3.5 ${restarting ? 'animate-spin' : ''}`} />
          </button>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              title="向右折叠工作区面板，扩大对话空间"
              className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition cursor-pointer"
            >
              <PanelRightClose className="w-4 h-4" />
              <span className="hidden xl:inline">折叠</span>
            </button>
          )}
        </div>
      </div>

      {/* Explicit Workspace Context Bar (P0: never confuse which workspace is open!) */}
      <div className="px-3 py-1.5 bg-slate-900 text-slate-200 border-b border-slate-800 flex items-center justify-between gap-2 text-[11px] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {isResearch ? (
            <FlaskConical className="w-3.5 h-3.5 text-teal-400 shrink-0" />
          ) : (
            <FolderGit2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
          )}
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
              isResearch
                ? 'bg-teal-500/20 text-teal-300 border border-teal-500/30'
                : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
            }`}
          >
            {workspaceLabel}
          </span>
          <span className="font-medium text-white truncate">{workspace.name}</span>
          <span className="font-mono text-[10px] text-slate-400 shrink-0">{workspace.id}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {workspace.activeBuildProjectId && (
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${
                isResearch
                  ? 'bg-teal-500/20 text-teal-300 border-teal-500/30'
                  : 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30'
              }`}
            >
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              <span className="truncate max-w-[140px]">
                {isResearch ? '研究中' : '构建中'}: {workspace.activeBuildTitle || workspace.activeBuildProjectId}
              </span>
            </span>
          )}
          {workspace.queuedProjectIds && workspace.queuedProjectIds.length > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
              <Clock className="w-2.5 h-2.5" />
              排队 {workspace.queuedProjectIds.length}
            </span>
          )}
        </div>
      </div>

      {/* Preview Tab */}
      {tab === 'preview' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-3 py-2 bg-slate-100/80 border-b border-slate-200 flex items-center gap-2">
            <div className="flex-1 bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-600 font-mono truncate">
              {shareUrl}
            </div>
            <button
              type="button"
              onClick={() => setIframeNonce((n) => n + 1)}
              title="刷新预览"
              className="p-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void handleCopyShare()}
              title="复制免登录分享链接"
              className="px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs flex items-center gap-1 cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? '已复制' : '分享'}
            </button>
            <a
              href={workspace.previewUrl}
              target="_blank"
              rel="noreferrer"
              title="在新标签页打开"
              className="p-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          <div className="flex-1 relative bg-white min-h-0">
            {workspaceBusy ? (
              <div className="h-full flex flex-col items-center justify-center p-8 text-center">
                <Loader2 className="w-8 h-8 text-indigo-600 animate-spin mb-3" />
                <div className="text-sm font-medium text-slate-800">
                  云端 Coding Agent 正在更新代码仓库「{workspace.name}」...
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  已挂载 SQLite 隔离代理插件（Skill + MCP），完成后自动重启预览
                </p>
              </div>
            ) : (
              <iframe
                key={`${workspace.id}-${previewRevision}-${iframeNonce}`}
                src={`${workspace.previewUrl}?_r=${previewRevision}_${iframeNonce}`}
                title={`Preview ${workspace.name}`}
                className="w-full h-full border-0"
              />
            )}
          </div>
        </div>
      )}

      {/* VS Code (Monaco + Server LSP) Tab — strictly keyed by workspace.id */}
      {tab === 'code' && (
        <CodeEditorIDE
          key={workspace.id}
          workspaceId={workspace.id}
          files={files}
          onRefreshFiles={loadFiles}
          onRebuildPreview={handleRestart}
        />
      )}

      {/* Database & Plugin Isolation Tab */}
      {tab === 'database' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="px-3.5 py-2.5 bg-white border-b border-slate-200 space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-1.5 text-slate-700 font-medium">
                <Puzzle className="w-3.5 h-3.5 text-indigo-600" />
                <span>{tablesInfo?.preset?.name || '全栈网站 Agent'}</span>
              </div>
              <button
                type="button"
                onClick={() => void loadTables()}
                className="text-indigo-600 hover:underline cursor-pointer"
              >
                刷新表结构
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-mono">
                隔离前缀: {tablesInfo?.prefix || workspace.tablePrefix}
              </span>
              {tablesInfo?.preset?.plugins.map((pl) => (
                <span
                  key={pl.id}
                  className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200"
                >
                  插件: {pl.id}
                  {pl.hasSkill ? ' · Skill' : ''}
                  {pl.mcpServerName ? ` · MCP(${pl.mcpServerName})` : ''}
                </span>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {!tablesInfo || tablesInfo.tables.length === 0 ? (
              <div className="bg-white rounded-xl border border-slate-200 p-6 text-center text-xs text-slate-500">
                仓库「{workspace.name}」尚未建表。Agent 构建时会自动通过{' '}
                <code className="font-mono">atoms_db</code> 代理建表，所有物理表名均自动带有隔离前缀{' '}
                <code className="font-mono text-indigo-700">{workspace.tablePrefix}</code>。
              </div>
            ) : (
              tablesInfo.tables.map((tbl) => {
                const isSelected = selectedTable === tbl.logicalName;
                return (
                  <div
                    key={tbl.physicalName}
                    className="bg-white rounded-xl border border-slate-200 overflow-hidden"
                  >
                    <div className="px-3.5 py-2.5 flex items-center justify-between gap-2 border-b border-slate-100">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <Table2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          <span className="text-xs font-semibold text-slate-900 font-mono">
                            {tbl.logicalName}
                          </span>
                          <span className="text-[11px] text-slate-400">({tbl.rowCount} 行)</span>
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono truncate mt-0.5">
                          物理表名: {tbl.physicalName}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleInspectTable(tbl.logicalName)}
                        className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-indigo-50 hover:text-indigo-700 text-slate-700 text-[11px] font-medium transition cursor-pointer shrink-0"
                      >
                        {isSelected ? '刷新数据' : '查看数据'}
                      </button>
                    </div>

                    <div className="px-3.5 py-2 flex flex-wrap gap-1.5 bg-slate-50/70">
                      {tbl.columns.map((c) => (
                        <span
                          key={c.name}
                          className="text-[11px] font-mono px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700"
                        >
                          {c.name}
                          <span className="text-slate-400 ml-1">{c.type}</span>
                          {c.primaryKey && <span className="text-amber-600 ml-1">PK</span>}
                        </span>
                      ))}
                    </div>

                    {isSelected && (
                      <div className="border-t border-slate-200 bg-slate-950 text-slate-200 p-2.5 overflow-x-auto max-h-56">
                        {loadingRows ? (
                          <div className="text-[11px] text-slate-400">查询中...</div>
                        ) : tableRows.length === 0 ? (
                          <div className="text-[11px] text-slate-400">表内暂无记录</div>
                        ) : (
                          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all">
                            {JSON.stringify(tableRows, null, 2)}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Logs Tab */}
      {tab === 'logs' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-slate-200 bg-white flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-slate-600">
              <span
                className={`w-2 h-2 rounded-full ${logsInfo?.running ? 'bg-emerald-500' : 'bg-slate-300'}`}
              />
              <span>
                {logsInfo?.running
                  ? `运行中 (内部端口 ${logsInfo.port})`
                  : '未运行（访问预览时按需自动启动）'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void loadLogs()}
              className="text-indigo-600 hover:underline cursor-pointer"
            >
              刷新日志
            </button>
          </div>
          <pre className="flex-1 bg-slate-950 text-slate-200 p-3 text-[11px] font-mono overflow-auto whitespace-pre-wrap break-all">
            {logsInfo?.logs.length ? logsInfo.logs.join('\n') : '暂无运行日志'}
          </pre>
        </div>
      )}
    </section>
  );
};
