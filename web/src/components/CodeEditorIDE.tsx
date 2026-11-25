import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import {
  FileText,
  Folder,
  FolderOpen,
  FilePlus,
  FolderPlus,
  RefreshCw,
  Save,
  Trash2,
  X,
  Play,
  AlertCircle,
  AlertTriangle,
  Wifi,
  WifiOff,
  Loader2,
} from 'lucide-react';
import type { FileTreeNode } from '@atoms/shared';
import { api } from '../api';
import {
  WorkspaceLspClient,
  fromVirtualUri,
  isLspSupportedFile,
  toMonacoLanguage,
  toVirtualUri,
  type LspDiagnostic,
  type LspStatus,
} from '../lsp-client';

// Configure self-hosted Monaco web workers (zero CDN required)
let monacoConfigured = false;
function ensureMonacoConfigured() {
  if (monacoConfigured) return;
  monacoConfigured = true;

  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      if (label === 'json') return new jsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
      return new editorWorker();
    },
  };

  // Disable Monaco's built-in client-only JS/TS checker so diagnostics come 100% from our server-side LSP
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
}

function mapLspCompletionKind(kind?: number): monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 2:
      return K.Method;
    case 3:
      return K.Function;
    case 4:
      return K.Constructor;
    case 5:
      return K.Field;
    case 6:
      return K.Variable;
    case 7:
      return K.Class;
    case 8:
      return K.Interface;
    case 9:
      return K.Module;
    case 10:
      return K.Property;
    case 14:
      return K.Keyword;
    case 15:
      return K.Snippet;
    case 21:
      return K.Constant;
    default:
      return K.Text;
  }
}

function formatHoverContents(contents: unknown): monaco.IMarkdownString[] {
  if (!contents) return [];
  if (typeof contents === 'string') return [{ value: contents }];
  if (Array.isArray(contents)) {
    return contents.flatMap((c) => formatHoverContents(c));
  }
  if (typeof contents === 'object') {
    const obj = contents as { language?: string; value?: string };
    if (obj.language && obj.value) {
      return [{ value: `\`\`\`${obj.language}\n${obj.value}\n\`\`\`` }];
    }
    if (obj.value) return [{ value: obj.value }];
  }
  return [];
}

interface OpenTab {
  path: string;
  savedContent: string;
  dirty: boolean;
  readOnly?: boolean;
}

interface CodeEditorIDEProps {
  projectId: string;
  files: FileTreeNode[];
  onRefreshFiles: () => Promise<void>;
  onRebuildPreview: () => Promise<void>;
}

export const CodeEditorIDE: React.FC<CodeEditorIDEProps> = ({
  projectId,
  files,
  onRefreshFiles,
  onRebuildPreview,
}) => {
  ensureMonacoConfigured();

  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [lspStatus, setLspStatus] = useState<LspStatus>('connecting');
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const [diagCounts, setDiagCounts] = useState({ errors: 0, warnings: 0 });
  const [saveToast, setSaveToast] = useState<string | null>(null);

  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  const lspRef = useRef<WorkspaceLspClient | null>(null);
  const activePathRef = useRef<string | null>(null);
  const tabsRef = useRef<OpenTab[]>([]);
  const diagMapRef = useRef<Map<string, LspDiagnostic[]>>(new Map());
  const changeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  activePathRef.current = activePath;
  tabsRef.current = tabs;

  const recomputeDiagCounts = useCallback(() => {
    let errors = 0;
    let warnings = 0;
    for (const list of diagMapRef.current.values()) {
      for (const d of list) {
        if (d.severity === 1) errors++;
        else if (d.severity === 2) warnings++;
      }
    }
    setDiagCounts({ errors, warnings });
  }, []);

  const applyDiagnosticsToModel = useCallback(
    (relPath: string, diagnostics: LspDiagnostic[]) => {
      diagMapRef.current.set(relPath, diagnostics);
      recomputeDiagCounts();
      const model = modelsRef.current.get(relPath);
      if (!model || model.isDisposed()) return;
      const markers: monaco.editor.IMarkerData[] = diagnostics.map((d) => ({
        startLineNumber: d.range.start.line + 1,
        startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1,
        endColumn: Math.max(d.range.end.character + 1, d.range.start.character + 2),
        message: d.message,
        source: d.source || 'ts-lsp',
        severity:
          d.severity === 1
            ? monaco.MarkerSeverity.Error
            : d.severity === 2
              ? monaco.MarkerSeverity.Warning
              : d.severity === 3
                ? monaco.MarkerSeverity.Info
                : monaco.MarkerSeverity.Hint,
      }));
      monaco.editor.setModelMarkers(model, 'atoms-lsp', markers);
    },
    [recomputeDiagCounts],
  );

  const openFile = useCallback(
    async (filePath: string, reveal?: { line: number; col: number }) => {
      const existingModel = modelsRef.current.get(filePath);
      if (existingModel && !existingModel.isDisposed()) {
        setActivePath(filePath);
        if (editorRef.current) {
          editorRef.current.setModel(existingModel);
          if (reveal) {
            editorRef.current.revealLineInCenter(reveal.line);
            editorRef.current.setPosition({ lineNumber: reveal.line, column: reveal.col });
          }
          editorRef.current.focus();
        }
        return;
      }

      try {
        const res = await api.readFile(projectId, filePath);
        const uri = monaco.Uri.parse(toVirtualUri(filePath));
        const lang = toMonacoLanguage(filePath);
        const old = monaco.editor.getModel(uri);
        if (old) old.dispose();

        const model = monaco.editor.createModel(res.content, lang, uri);
        modelsRef.current.set(filePath, model);

        model.onDidChangeContent(() => {
          const val = model.getValue();
          setTabs((prev) =>
            prev.map((t) => (t.path === filePath ? { ...t, dirty: val !== t.savedContent } : t)),
          );
          const prevTimer = changeTimersRef.current.get(filePath);
          if (prevTimer) clearTimeout(prevTimer);
          const timer = setTimeout(() => {
            lspRef.current?.didChange(filePath, model.getValue());
          }, 160);
          changeTimersRef.current.set(filePath, timer);
        });

        setTabs((prev) =>
          prev.some((t) => t.path === filePath)
            ? prev
            : [...prev, { path: filePath, savedContent: res.content, dirty: false, readOnly: res.binary }],
        );
        setActivePath(filePath);

        if (editorRef.current) {
          editorRef.current.setModel(model);
          editorRef.current.updateOptions({ readOnly: Boolean(res.binary) });
          if (reveal) {
            editorRef.current.revealLineInCenter(reveal.line);
            editorRef.current.setPosition({ lineNumber: reveal.line, column: reveal.col });
          }
          editorRef.current.focus();
        }

        lspRef.current?.didOpen(filePath, res.content);
        const cachedDiags = diagMapRef.current.get(filePath);
        if (cachedDiags) {
          applyDiagnosticsToModel(filePath, cachedDiags);
        }
      } catch (err) {
        alert(err instanceof Error ? err.message : '打开文件失败');
      }
    },
    [projectId, applyDiagnosticsToModel],
  );

  const saveFile = useCallback(
    async (targetPath?: string) => {
      const filePath = targetPath ?? activePathRef.current;
      if (!filePath) return;
      const model = modelsRef.current.get(filePath);
      if (!model || model.isDisposed()) return;
      const tab = tabsRef.current.find((t) => t.path === filePath);
      if (tab?.readOnly) return;

      const content = model.getValue();
      setSaving(true);
      try {
        await api.writeFile(projectId, filePath, content);
        lspRef.current?.didChange(filePath, content);
        lspRef.current?.didSave(filePath, content);
        setTabs((prev) =>
          prev.map((t) => (t.path === filePath ? { ...t, savedContent: content, dirty: false } : t)),
        );
        setSaveToast(`已保存 ${filePath}`);
        setTimeout(() => setSaveToast(null), 1600);
      } catch (err) {
        alert(err instanceof Error ? err.message : '保存失败');
      } finally {
        setSaving(false);
      }
    },
    [projectId],
  );

  const saveAllAndRebuild = async () => {
    setRebuilding(true);
    try {
      for (const tab of tabsRef.current) {
        if (tab.dirty && !tab.readOnly) {
          await saveFile(tab.path);
        }
      }
      await onRebuildPreview();
      setSaveToast('已保存并重建预览');
      setTimeout(() => setSaveToast(null), 2000);
    } finally {
      setRebuilding(false);
    }
  };

  // Mount Monaco Editor + LSP WebSocket + Language Providers per project
  useEffect(() => {
    // Reset per-project editor state
    setTabs([]);
    setActivePath(null);
    diagMapRef.current.clear();
    setDiagCounts({ errors: 0, warnings: 0 });

    const client = new WorkspaceLspClient(
      projectId,
      (status) => {
        setLspStatus(status);
        if (status === 'connected') {
          // Sync any already-open models when LSP finishes handshake
          for (const [relPath, model] of modelsRef.current.entries()) {
            if (!model.isDisposed()) {
              client.didOpen(relPath, model.getValue());
            }
          }
        }
      },
      applyDiagnosticsToModel,
    );
    lspRef.current = client;
    client.connect();

    const editor = monaco.editor.create(editorHostRef.current!, {
      value: '',
      language: 'javascript',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      tabSize: 2,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: 'selection',
      padding: { top: 10 },
    });
    editorRef.current = editor;

    editor.onDidChangeCursorPosition((e) => {
      setCursorPos({ line: e.position.lineNumber, col: e.position.column });
    });

    // Cmd/Ctrl+S saves current file to server workspace
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveFile();
    });

    // Register real Server-Side LSP Providers for JS/TS
    const langs = ['javascript', 'typescript'];
    const disposables: monaco.IDisposable[] = [];

    for (const lang of langs) {
      disposables.push(
        monaco.languages.registerCompletionItemProvider(lang, {
          triggerCharacters: ['.', '/', '"', "'", '<'],
          async provideCompletionItems(model, position) {
            const relPath = fromVirtualUri(model.uri.toString());
            if (!relPath || !isLspSupportedFile(relPath)) return { suggestions: [] };
            try {
              const items = await client.completion(
                relPath,
                position.lineNumber - 1,
                position.column - 1,
              );
              const word = model.getWordUntilPosition(position);
              const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
              };
              return {
                suggestions: items.slice(0, 80).map((item) => ({
                  label: item.label,
                  kind: mapLspCompletionKind(item.kind),
                  detail: item.detail,
                  documentation:
                    typeof item.documentation === 'string'
                      ? item.documentation
                      : item.documentation?.value,
                  insertText: item.insertText || item.label,
                  sortText: item.sortText,
                  filterText: item.filterText,
                  range,
                })),
              };
            } catch {
              return { suggestions: [] };
            }
          },
        }),
      );

      disposables.push(
        monaco.languages.registerHoverProvider(lang, {
          async provideHover(model, position) {
            const relPath = fromVirtualUri(model.uri.toString());
            if (!relPath || !isLspSupportedFile(relPath)) return null;
            try {
              const res = await client.hover(
                relPath,
                position.lineNumber - 1,
                position.column - 1,
              );
              if (!res) return null;
              const contents = formatHoverContents(res.contents);
              if (contents.length === 0) return null;
              return { contents };
            } catch {
              return null;
            }
          },
        }),
      );

      disposables.push(
        monaco.languages.registerDefinitionProvider(lang, {
          async provideDefinition(model, position) {
            const relPath = fromVirtualUri(model.uri.toString());
            if (!relPath || !isLspSupportedFile(relPath)) return null;
            try {
              const locs = await client.definition(
                relPath,
                position.lineNumber - 1,
                position.column - 1,
              );
              const results: monaco.languages.Location[] = [];
              for (const loc of locs) {
                const targetRel = fromVirtualUri(loc.uri);
                if (!targetRel) continue;
                // Pre-load target file if it's in the workspace so Ctrl+Click opens it smoothly
                if (!modelsRef.current.has(targetRel)) {
                  void openFile(targetRel, {
                    line: loc.range.start.line + 1,
                    col: loc.range.start.character + 1,
                  });
                }
                results.push({
                  uri: monaco.Uri.parse(loc.uri),
                  range: new monaco.Range(
                    loc.range.start.line + 1,
                    loc.range.start.character + 1,
                    loc.range.end.line + 1,
                    loc.range.end.character + 1,
                  ),
                });
              }
              return results;
            } catch {
              return null;
            }
          },
        }),
      );
    }

    return () => {
      for (const timer of changeTimersRef.current.values()) clearTimeout(timer);
      changeTimersRef.current.clear();
      for (const d of disposables) d.dispose();
      editor.dispose();
      editorRef.current = null;
      for (const model of modelsRef.current.values()) {
        if (!model.isDisposed()) model.dispose();
      }
      modelsRef.current.clear();
      client.dispose();
      lspRef.current = null;
    };
  }, [projectId, applyDiagnosticsToModel, openFile, saveFile]);

  // Auto-open entry file when workspace files load and nothing is open yet
  useEffect(() => {
    if (tabs.length > 0 || files.length === 0) return;
    const flatPaths: string[] = [];
    const walk = (nodes: FileTreeNode[]) => {
      for (const n of nodes) {
        if (n.type === 'file') flatPaths.push(n.path);
        else if (n.children) walk(n.children);
      }
    };
    walk(files);
    const preferred =
      flatPaths.find((p) => p === 'client/App.jsx' || p === 'client/App.tsx') ||
      flatPaths.find((p) => p === 'server/index.js') ||
      flatPaths[0];
    if (preferred) {
      void openFile(preferred);
    }
  }, [files, tabs.length, openFile]);

  const closeTab = (filePath: string) => {
    const tab = tabs.find((t) => t.path === filePath);
    if (tab?.dirty && !confirm(`${filePath} 有未保存修改，确认关闭？`)) return;
    lspRef.current?.didClose(filePath);
    const model = modelsRef.current.get(filePath);
    if (model && !model.isDisposed()) model.dispose();
    modelsRef.current.delete(filePath);

    const remaining = tabs.filter((t) => t.path !== filePath);
    setTabs(remaining);
    if (activePath === filePath) {
      const next = remaining[remaining.length - 1];
      if (next) {
        setActivePath(next.path);
        const nextModel = modelsRef.current.get(next.path);
        if (nextModel && editorRef.current) editorRef.current.setModel(nextModel);
      } else {
        setActivePath(null);
      }
    }
  };

  const handleCreateEntry = async (type: 'file' | 'dir') => {
    const label = type === 'file' ? '新建文件路径（例如 client/components/Card.jsx）' : '新建文件夹路径（例如 client/components）';
    const relPath = window.prompt(label);
    if (!relPath || !relPath.trim()) return;
    try {
      const created = await api.createEntry(projectId, relPath.trim(), type);
      await onRefreshFiles();
      if (type === 'file') {
        await openFile(created.path);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : '创建失败');
    }
  };

  const handleDeleteEntry = async (relPath: string) => {
    if (!confirm(`确认从服务器工作区删除 "${relPath}" 吗？`)) return;
    try {
      await api.deleteEntry(projectId, relPath);
      if (tabs.some((t) => t.path === relPath)) {
        lspRef.current?.didClose(relPath);
        modelsRef.current.get(relPath)?.dispose();
        modelsRef.current.delete(relPath);
        setTabs((prev) => prev.filter((t) => t.path !== relPath));
        if (activePath === relPath) setActivePath(null);
      }
      await onRefreshFiles();
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除失败');
    }
  };

  const activeTab = tabs.find((t) => t.path === activePath) || null;
  const hasAnyDirty = tabs.some((t) => t.dirty);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#1e1e1e] text-slate-200">
      <div className="flex-1 flex min-h-0">
        {/* Left VS Code Explorer */}
        <div className="w-52 bg-[#252526] border-r border-[#333333] flex flex-col shrink-0">
          <div className="h-9 px-2.5 border-b border-[#333333] flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <span>Explorer</span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                title="新建文件"
                onClick={() => void handleCreateEntry('file')}
                className="p-1 rounded hover:bg-[#37373d] text-slate-300 cursor-pointer"
              >
                <FilePlus className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                title="新建文件夹"
                onClick={() => void handleCreateEntry('dir')}
                className="p-1 rounded hover:bg-[#37373d] text-slate-300 cursor-pointer"
              >
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                title="刷新目录"
                onClick={() => void onRefreshFiles()}
                className="p-1 rounded hover:bg-[#37373d] text-slate-300 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto py-1.5 px-1">
            {files.length === 0 ? (
              <div className="text-xs text-slate-500 p-3 text-center">暂无工作区文件</div>
            ) : (
              <DarkFileTree
                nodes={files}
                activePath={activePath}
                dirtyPaths={new Set(tabs.filter((t) => t.dirty).map((t) => t.path))}
                onSelect={(p) => void openFile(p)}
                onDelete={(p) => void handleDeleteEntry(p)}
              />
            )}
          </div>
        </div>

        {/* Right Editor Area */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* VS Code Tab Bar + Action Bar */}
          <div className="h-9 bg-[#252526] border-b border-[#333333] flex items-center justify-between shrink-0">
            <div className="flex items-center overflow-x-auto h-full">
              {tabs.map((tab) => {
                const active = tab.path === activePath;
                const fileName = tab.path.split('/').pop() || tab.path;
                return (
                  <div
                    key={tab.path}
                    onClick={() => void openFile(tab.path)}
                    title={tab.path}
                    className={`group h-full px-3 flex items-center gap-1.5 text-xs border-r border-[#333333] cursor-pointer shrink-0 ${
                      active
                        ? 'bg-[#1e1e1e] text-white border-t-2 border-t-[#007acc]'
                        : 'bg-[#2d2d2d] text-slate-400 hover:bg-[#2a2d2e]'
                    }`}
                  >
                    <span className="truncate max-w-[130px]">{fileName}</span>
                    {tab.dirty && <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(tab.path);
                      }}
                      className="p-0.5 rounded hover:bg-[#3c3c3c] opacity-60 group-hover:opacity-100 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5 px-2 shrink-0">
              {saveToast && <span className="text-[11px] text-emerald-400">{saveToast}</span>}
              <button
                type="button"
                disabled={!activeTab?.dirty || saving}
                onClick={() => void saveFile()}
                title="保存当前文件 (Ctrl/Cmd + S)"
                className="px-2 py-1 rounded bg-[#0e639c] hover:bg-[#1177bb] disabled:opacity-40 text-white text-[11px] flex items-center gap-1 cursor-pointer"
              >
                <Save className="w-3 h-3" />
                保存
              </button>
              <button
                type="button"
                disabled={rebuilding}
                onClick={() => void saveAllAndRebuild()}
                title="保存全部修改并重建预览应用"
                className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-[11px] flex items-center gap-1 cursor-pointer"
              >
                {rebuilding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                {hasAnyDirty ? '保存并预览' : '重建预览'}
              </button>
            </div>
          </div>

          {/* Monaco Canvas */}
          <div className="flex-1 relative min-h-0">
            <div ref={editorHostRef} className="w-full h-full" />
            {!activeTab && (
              <div className="absolute inset-0 bg-[#1e1e1e] flex items-center justify-center text-xs text-slate-500">
                在左侧文件树选择文件即可通过 VS Code + 服务端 LSP 进行编辑
              </div>
            )}
          </div>
        </div>
      </div>

      {/* VS Code Status Bar */}
      <div className="h-6 px-3 bg-[#007acc] text-white text-[11px] flex items-center justify-between gap-3 shrink-0 select-none">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            {lspStatus === 'connected' ? (
              <>
                <Wifi className="w-3 h-3 text-emerald-200" />
                LSP 已连接 (tsserver)
              </>
            ) : lspStatus === 'connecting' ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                LSP 连接中...
              </>
            ) : (
              <>
                <WifiOff className="w-3 h-3 text-rose-200" />
                LSP 未连接
              </>
            )}
          </span>
          <span className="flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            {diagCounts.errors}
            <AlertTriangle className="w-3 h-3 ml-1" />
            {diagCounts.warnings}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {activeTab && (
            <>
              <span>
                Ln {cursorPos.line}, Col {cursorPos.col}
              </span>
              <span className="uppercase">{toMonacoLanguage(activeTab.path)}</span>
            </>
          )}
          <span>UTF-8</span>
        </div>
      </div>
    </div>
  );
};

const DarkFileTree: React.FC<{
  nodes: FileTreeNode[];
  activePath: string | null;
  dirtyPaths: Set<string>;
  onSelect: (path: string) => void;
  onDelete: (path: string) => void;
  depth?: number;
}> = ({ nodes, activePath, dirtyPaths, onSelect, onDelete, depth = 0 }) => {
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({
    client: true,
    server: true,
  });

  return (
    <div className="space-y-0.5">
      {nodes.map((node) => {
        if (node.type === 'dir') {
          const isOpen = Boolean(openDirs[node.path]);
          return (
            <div key={node.path}>
              <div
                style={{ paddingLeft: `${depth * 12 + 6}px` }}
                className="group flex items-center gap-1 pr-1 py-0.5 rounded hover:bg-[#2a2d2e] text-xs text-slate-300 cursor-pointer"
                onClick={() => setOpenDirs((prev) => ({ ...prev, [node.path]: !isOpen }))}
              >
                {isOpen ? (
                  <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                ) : (
                  <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                )}
                <span className="flex-1 truncate">{node.name}</span>
                <button
                  type="button"
                  title="删除文件夹"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(node.path);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[#3c3c3c] text-slate-400 hover:text-rose-400 cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
              {isOpen && node.children && (
                <DarkFileTree
                  nodes={node.children}
                  activePath={activePath}
                  dirtyPaths={dirtyPaths}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  depth={depth + 1}
                />
              )}
            </div>
          );
        }

        const active = activePath === node.path;
        const dirty = dirtyPaths.has(node.path);
        return (
          <div
            key={node.path}
            style={{ paddingLeft: `${depth * 12 + 6}px` }}
            onClick={() => onSelect(node.path)}
            className={`group flex items-center gap-1.5 pr-1 py-0.5 rounded text-xs cursor-pointer ${
              active ? 'bg-[#094771] text-white' : 'text-slate-300 hover:bg-[#2a2d2e]'
            }`}
          >
            <FileText className="w-3.5 h-3.5 text-sky-400 shrink-0" />
            <span className="flex-1 truncate">{node.name}</span>
            {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />}
            {node.path !== 'package.json' && (
              <button
                type="button"
                title="删除文件"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(node.path);
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[#3c3c3c] text-slate-400 hover:text-rose-400 cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
