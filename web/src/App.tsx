import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Code2,
  Database,
  FlaskConical,
  FolderGit2,
  Globe,
  Loader2,
  PanelRightOpen,
} from 'lucide-react';
import type {
  ActiveRunSnapshot,
  AgentPresetSummary,
  MessageDTO,
  ProjectDTO,
  SSEEvent,
  UserGlobalSSEEvent,
  WorkspaceDTO,
} from '@atoms/shared';
import { api } from './api';
import { LoginPage } from './components/LoginPage';
import { Sidebar } from './components/Sidebar';
import { ChatPanel, type LiveStreamState } from './components/ChatPanel';
import { WorkspacePanel, type WorkspaceTabKey } from './components/WorkspacePanel';

function snapshotToLiveStream(snapshot: ActiveRunSnapshot | null | undefined): LiveStreamState | null {
  if (!snapshot) return null;
  return {
    messageId: snapshot.messageId,
    mode: snapshot.mode,
    queued: snapshot.queued,
    text: snapshot.text,
    thinking: snapshot.thinking,
    steps: snapshot.steps.map((s) => ({ ...s })),
    statusText: snapshot.statusText,
    startedAt: snapshot.startedAt,
    lastActivityAt: snapshot.lastActivityAt,
    seq: snapshot.seq,
  };
}

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [glmConfigured, setGlmConfigured] = useState(true);
  const [agents, setAgents] = useState<AgentPresetSummary[]>([]);

  const [workspaces, setWorkspaces] = useState<WorkspaceDTO[]>([]);
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [isBuilding, setIsBuilding] = useState(false);
  const [suggestBuild, setSuggestBuild] = useState(false);
  const [liveStream, setLiveStream] = useState<LiveStreamState | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [requestedTab, setRequestedTab] = useState<{ tab: WorkspaceTabKey; nonce: number } | null>(null);
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(false);
  const [unreadCompletions, setUnreadCompletions] = useState<
    Record<string, 'succeeded' | 'aborted' | 'failed'>
  >({});

  const eventSourceRef = useRef<EventSource | null>(null);
  const userEventSourceRef = useRef<EventSource | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const selectSeqRef = useRef(0);
  const lastStreamSeqRef = useRef(0);
  const liveStreamRef = useRef<LiveStreamState | null>(null);

  activeProjectIdRef.current = activeProjectId;
  liveStreamRef.current = liveStream;

  const activeProject = projects.find((p) => p.id === activeProjectId) || null;
  const activeWorkspace = activeProject?.workspaceId
    ? workspaces.find((w) => w.id === activeProject.workspaceId) || null
    : null;
  const activeAgent = activeWorkspace
    ? agents.find((a) => a.id === activeWorkspace.presetId) || null
    : null;

  const refreshAll = useCallback(async () => {
    const [wsRes, projRes] = await Promise.all([api.listWorkspaces(), api.listProjects()]);
    setWorkspaces(wsRes.workspaces);
    setProjects(projRes.projects);
    return { workspaces: wsRes.workspaces, projects: projRes.projects };
  }, []);

  useEffect(() => {
    api
      .me()
      .then((res) => {
        setUsername(res.user.username);
        setGlmConfigured(res.glmConfigured);
        setAgents(res.agents || res.presets || []);
        return refreshAll();
      })
      .catch(() => {
        setUsername(null);
      })
      .finally(() => {
        setAuthChecked(true);
      });
  }, [refreshAll]);

  // Persistent user-level SSE for real-time sidebar sync across ALL workspaces & threads
  useEffect(() => {
    if (!username) {
      if (userEventSourceRef.current) {
        userEventSourceRef.current.close();
        userEventSourceRef.current = null;
      }
      return;
    }

    const es = new EventSource('/api/events', { withCredentials: true });
    userEventSourceRef.current = es;

    es.onmessage = (evt) => {
      let parsed: UserGlobalSSEEvent;
      try {
        parsed = JSON.parse(evt.data) as UserGlobalSSEEvent;
      } catch {
        return;
      }

      switch (parsed.type) {
        case 'workspace_updated':
          setWorkspaces((prev) => {
            const exists = prev.some((w) => w.id === parsed.workspace.id);
            if (!exists) return [parsed.workspace, ...prev];
            return prev.map((w) => (w.id === parsed.workspace.id ? parsed.workspace : w));
          });
          break;

        case 'workspace_deleted':
          setWorkspaces((prev) => prev.filter((w) => w.id !== parsed.workspaceId));
          break;

        case 'project_updated':
          setProjects((prev) => {
            const exists = prev.some((p) => p.id === parsed.project.id);
            if (!exists) return [parsed.project, ...prev];
            return prev.map((p) => (p.id === parsed.project.id ? parsed.project : p));
          });
          break;

        case 'project_activity':
          setProjects((prev) =>
            prev.map((p) =>
              p.id === parsed.projectId
                ? {
                    ...p,
                    status: parsed.status,
                    activeStep: parsed.activeStep ?? null,
                    lastActivityAt: parsed.lastActivityAt ?? p.lastActivityAt,
                  }
                : p,
            ),
          );
          break;

        case 'project_run_finished':
          setProjects((prev) => {
            const exists = prev.some((p) => p.id === parsed.project.id);
            if (!exists) return [parsed.project, ...prev];
            return prev.map((p) => (p.id === parsed.project.id ? parsed.project : p));
          });
          if (parsed.projectId !== activeProjectIdRef.current) {
            setUnreadCompletions((prev) => ({ ...prev, [parsed.projectId]: parsed.status }));
          }
          break;

        case 'project_deleted':
          setProjects((prev) => prev.filter((p) => p.id !== parsed.projectId));
          setUnreadCompletions((prev) => {
            if (!(parsed.projectId in prev)) return prev;
            const next = { ...prev };
            delete next[parsed.projectId];
            return next;
          });
          break;
      }
    };

    return () => {
      es.close();
      if (userEventSourceRef.current === es) {
        userEventSourceRef.current = null;
      }
    };
  }, [username]);

  const closeStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const connectStream = useCallback(
    (projectId: string): Promise<void> => {
      closeStream();
      return new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const fallbackTimer = setTimeout(done, 1200);

        const es = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`, {
          withCredentials: true,
        });
        eventSourceRef.current = es;

        es.onopen = () => {
          clearTimeout(fallbackTimer);
          done();
        };

        es.onmessage = (evt) => {
          if (activeProjectIdRef.current !== projectId) return;
          let parsed: SSEEvent;
          try {
            parsed = JSON.parse(evt.data) as SSEEvent;
          } catch {
            return;
          }

          if (parsed.type === 'connected') {
            setIsBuilding(parsed.isBuilding);
            if (parsed.activeRun) {
              const snap = snapshotToLiveStream(parsed.activeRun);
              lastStreamSeqRef.current = Math.max(lastStreamSeqRef.current, parsed.activeRun.seq);
              setLiveStream((prev) => {
                if (!snap) return prev;
                if (!prev || prev.messageId !== snap.messageId || (snap.seq ?? 0) >= (prev.seq ?? 0)) {
                  return snap;
                }
                return prev;
              });
            } else if (liveStreamRef.current) {
              setLiveStream(null);
              void api
                .getProject(projectId)
                .then((detail) => {
                  if (activeProjectIdRef.current !== projectId) return;
                  setMessages(detail.messages);
                  setIsBuilding(detail.isBuilding);
                  setProjects((prev) =>
                    prev.map((p) => (p.id === detail.project.id ? detail.project : p)),
                  );
                })
                .catch(() => {});
            }
            clearTimeout(fallbackTimer);
            done();
            return;
          }

          if (typeof parsed.seq === 'number') {
            if (parsed.seq <= lastStreamSeqRef.current) {
              return;
            }
            lastStreamSeqRef.current = parsed.seq;
          }

          const nowTs = parsed.ts || Date.now();
          const seq = parsed.seq;

          switch (parsed.type) {
            case 'project_updated':
              setProjects((prev) => {
                const exists = prev.some((p) => p.id === parsed.project.id);
                if (!exists) return [parsed.project, ...prev];
                return prev.map((p) => (p.id === parsed.project.id ? parsed.project : p));
              });
              break;

            case 'message_created':
              setMessages((prev) =>
                prev.some((m) => m.id === parsed.message.id) ? prev : [...prev, parsed.message],
              );
              break;

            case 'chat_start':
              setSuggestBuild(false);
              setLiveStream({
                messageId: parsed.messageId,
                mode: 'chat',
                text: '',
                thinking: '',
                steps: [],
                startedAt: parsed.startedAt || nowTs,
                lastActivityAt: nowTs,
                seq,
              });
              break;

            case 'chat_delta':
              setLiveStream((prev) => {
                if (!prev || prev.messageId !== parsed.messageId) {
                  return {
                    messageId: parsed.messageId,
                    mode: 'chat',
                    text: parsed.delta,
                    thinking: '',
                    steps: [],
                    startedAt: nowTs,
                    lastActivityAt: nowTs,
                    seq,
                  };
                }
                return {
                  ...prev,
                  text: prev.text + parsed.delta,
                  lastActivityAt: nowTs,
                  seq,
                };
              });
              break;

            case 'chat_done':
              setLiveStream(null);
              setSuggestBuild(Boolean(parsed.suggestBuild));
              setMessages((prev) => {
                const without = prev.filter((m) => m.id !== parsed.message.id);
                return [...without, parsed.message];
              });
              break;

            case 'agent_queued':
              setIsBuilding(true);
              setSuggestBuild(false);
              setLiveStream({
                messageId: parsed.messageId,
                mode: 'build',
                queued: true,
                text: '',
                thinking: '',
                steps: [],
                statusText: `排队中 (#${parsed.position})：等待同仓库「${parsed.blockingTitle || '前序对话'}」完成当前修改...`,
                startedAt: nowTs,
                lastActivityAt: nowTs,
                seq,
              });
              break;

            case 'agent_start':
              setIsBuilding(true);
              setSuggestBuild(false);
              setLiveStream({
                messageId: parsed.messageId,
                mode: 'build',
                queued: false,
                text: '',
                thinking: '',
                steps: [],
                statusText: '正在隔离工作区启动 Pi Coding Agent...',
                startedAt: parsed.startedAt || nowTs,
                lastActivityAt: nowTs,
                seq,
              });
              break;

            case 'agent_thinking_delta':
              setIsBuilding(true);
              setLiveStream((prev) => {
                if (!prev || prev.messageId !== parsed.messageId) {
                  return {
                    messageId: parsed.messageId,
                    mode: 'build',
                    queued: false,
                    text: '',
                    thinking: parsed.delta,
                    steps: [],
                    startedAt: nowTs,
                    lastActivityAt: nowTs,
                    seq,
                  };
                }
                return {
                  ...prev,
                  queued: false,
                  thinking: prev.thinking + parsed.delta,
                  statusText: undefined,
                  lastActivityAt: nowTs,
                  seq,
                };
              });
              break;

            case 'agent_text_delta':
              setIsBuilding(true);
              setLiveStream((prev) => {
                if (!prev || prev.messageId !== parsed.messageId) {
                  return {
                    messageId: parsed.messageId,
                    mode: 'build',
                    queued: false,
                    text: parsed.delta,
                    thinking: '',
                    steps: [],
                    startedAt: nowTs,
                    lastActivityAt: nowTs,
                    seq,
                  };
                }
                return {
                  ...prev,
                  queued: false,
                  text: prev.text + parsed.delta,
                  statusText: undefined,
                  lastActivityAt: nowTs,
                  seq,
                };
              });
              break;

            case 'agent_tool_start':
              setIsBuilding(true);
              setLiveStream((prev) => {
                const base: LiveStreamState =
                  prev && prev.messageId === parsed.messageId
                    ? { ...prev, queued: false }
                    : {
                        messageId: parsed.messageId,
                        mode: 'build',
                        queued: false,
                        text: '',
                        thinking: '',
                        steps: [],
                        startedAt: nowTs,
                      };
                const idx = base.steps.findIndex((s) => s.id === parsed.step.id);
                const nextSteps =
                  idx === -1
                    ? [...base.steps, parsed.step]
                    : base.steps.map((s, i) => (i === idx ? parsed.step : s));
                return {
                  ...base,
                  steps: nextSteps,
                  statusText: undefined,
                  lastActivityAt: nowTs,
                  seq,
                };
              });
              break;

            case 'agent_tool_update':
              setLiveStream((prev) => {
                if (!prev || prev.messageId !== parsed.messageId) return prev;
                return {
                  ...prev,
                  steps: prev.steps.map((s) =>
                    s.id === parsed.stepId ? { ...s, output: parsed.outputDelta } : s,
                  ),
                  lastActivityAt: nowTs,
                  seq,
                };
              });
              break;

            case 'agent_tool_end':
              setLiveStream((prev) => {
                if (!prev || prev.messageId !== parsed.messageId) return prev;
                return {
                  ...prev,
                  steps: prev.steps.map((s) =>
                    s.id === parsed.stepId
                      ? { ...s, status: parsed.status, output: parsed.output ?? s.output }
                      : s,
                  ),
                  lastActivityAt: nowTs,
                  seq,
                };
              });
              break;

            case 'agent_status':
              setIsBuilding(true);
              setLiveStream((prev) => {
                if (!prev || prev.messageId !== parsed.messageId) {
                  return {
                    messageId: parsed.messageId,
                    mode: 'build',
                    text: '',
                    thinking: '',
                    steps: [],
                    statusText: parsed.statusText,
                    startedAt: nowTs,
                    lastActivityAt: nowTs,
                    seq,
                  };
                }
                return {
                  ...prev,
                  statusText: parsed.statusText,
                  lastActivityAt: nowTs,
                  seq,
                };
              });
              break;

            case 'preview_ready':
              setPreviewRevision((n) => n + 1);
              break;

            case 'agent_done':
              setIsBuilding(false);
              setLiveStream(null);
              setMessages((prev) => {
                const without = prev.filter((m) => m.id !== parsed.message.id);
                return [...without, parsed.message];
              });
              void refreshAll();
              break;

            case 'error':
              setIsBuilding(false);
              setLiveStream(null);
              break;
          }
        };
      });
    },
    [closeStream, refreshAll],
  );

  useEffect(() => {
    return () => closeStream();
  }, [closeStream]);

  const handleSelectProject = async (projectId: string) => {
    const reqSeq = ++selectSeqRef.current;
    closeStream();
    lastStreamSeqRef.current = 0;
    setActiveProjectId(projectId);
    setLiveStream(null);
    setSuggestBuild(false);
    setUnreadCompletions((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });

    try {
      const detail = await api.getProject(projectId);
      if (selectSeqRef.current !== reqSeq || activeProjectIdRef.current !== projectId) {
        return;
      }
      setMessages(detail.messages);
      setIsBuilding(detail.isBuilding);
      if (detail.activeRun) {
        lastStreamSeqRef.current = detail.activeRun.seq;
        setLiveStream(snapshotToLiveStream(detail.activeRun));
      } else {
        setLiveStream(null);
      }
      setProjects((prev) => prev.map((p) => (p.id === detail.project.id ? detail.project : p)));
      await connectStream(projectId);
    } catch (err) {
      if (selectSeqRef.current === reqSeq) {
        alert(err instanceof Error ? err.message : '加载对话失败');
      }
    }
  };

  const handleNewChat = () => {
    selectSeqRef.current++;
    closeStream();
    lastStreamSeqRef.current = 0;
    setActiveProjectId(null);
    setMessages([]);
    setIsBuilding(false);
    setSuggestBuild(false);
    setLiveStream(null);
  };

  const handleNewWorkspace = async (presetId?: string) => {
    const isResearch = presetId === 'deep-research';
    const defaultName = isResearch ? '新深度研究课题' : '新全栈项目';
    const name = window.prompt(
      isResearch ? '输入新研究空间名称：' : '输入新代码仓库名称：',
      defaultName,
    );
    if (name === null) return;
    const clean = name.trim() || defaultName;
    try {
      const wsRes = await api.createWorkspace(clean, presetId);
      setWorkspaces((prev) =>
        prev.some((w) => w.id === wsRes.workspace.id) ? prev : [wsRes.workspace, ...prev],
      );
      const projRes = await api.createProject(
        `${clean} - 主对话`,
        wsRes.workspace.id,
        wsRes.workspace.presetId,
      );
      setProjects((prev) =>
        prev.some((p) => p.id === projRes.project.id) ? prev : [projRes.project, ...prev],
      );
      setWorkspaceCollapsed(false);
      setRequestedTab({ tab: isResearch ? 'preview' : 'code', nonce: Date.now() });
      await handleSelectProject(projRes.project.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : '创建工作区失败');
    }
  };

  const handleNewThreadInWorkspace = async (workspaceId: string) => {
    const ws = workspaces.find((w) => w.id === workspaceId);
    try {
      const projRes = await api.createProject(
        ws ? `${ws.name} - 新任务` : '新对话',
        workspaceId,
      );
      setProjects((prev) =>
        prev.some((p) => p.id === projRes.project.id) ? prev : [projRes.project, ...prev],
      );
      await handleSelectProject(projRes.project.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : '新建对话失败');
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    if (!confirm('确认删除此对话记录吗？（关联的代码仓库与数据表不会被删除）')) return;
    await api.deleteProject(projectId);
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    if (activeProjectId === projectId) {
      handleNewChat();
    }
  };

  const handleDeleteWorkspace = async (workspaceId: string) => {
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (
      !confirm(
        `确认删除代码仓库「${ws?.name || workspaceId}」及其磁盘代码和 SQLite 数据表吗？（历史对话记录会保留为未绑定对话）`,
      )
    ) {
      return;
    }
    await api.deleteWorkspace(workspaceId);
    setWorkspaces((prev) => prev.filter((w) => w.id !== workspaceId));
    setProjects((prev) =>
      prev.map((p) =>
        p.workspaceId === workspaceId
          ? { ...p, workspaceId: null, workspaceName: null, hasWorkspace: false, previewUrl: null }
          : p,
      ),
    );
  };

  const handleBindWorkspace = async (opts: {
    workspaceId?: string;
    createNew?: boolean;
    name?: string;
    presetId?: string;
  }) => {
    if (!activeProjectId) return;
    try {
      const res = await api.bindWorkspace(activeProjectId, opts);
      setWorkspaces((prev) => {
        const exists = prev.some((w) => w.id === res.workspace.id);
        return exists
          ? prev.map((w) => (w.id === res.workspace.id ? res.workspace : w))
          : [res.workspace, ...prev];
      });
      setProjects((prev) => prev.map((p) => (p.id === res.project.id ? res.project : p)));
      setWorkspaceCollapsed(false);
      setRequestedTab({
        tab: res.workspace.presetId === 'deep-research' ? 'preview' : 'code',
        nonce: Date.now(),
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : '关联工作区失败');
    }
  };

  const handleSend = async (
    text: string,
    opts?: { forceBuild?: boolean; targetAgentId?: string },
  ) => {
    let targetProjectId = activeProjectId;
    if (!targetProjectId) {
      const created = await api.createProject(text.slice(0, 20), null, opts?.targetAgentId);
      targetProjectId = created.project.id;
      activeProjectIdRef.current = targetProjectId;
      lastStreamSeqRef.current = 0;
      setProjects((prev) => [created.project, ...prev]);
      setActiveProjectId(targetProjectId);
      setMessages([]);
      await connectStream(targetProjectId);
    }

    try {
      const res = await api.sendMessage(targetProjectId, text, opts);
      setMessages((prev) => {
        let next = prev.some((m) => m.id === res.userMessage.id) ? prev : [...prev, res.userMessage];
        if (res.handoffMessage && !next.some((m) => m.id === res.handoffMessage!.id)) {
          next = [...next, res.handoffMessage];
        }
        return next;
      });

      if (res.workspace) {
        setWorkspaces((prev) =>
          prev.some((w) => w.id === res.workspace!.id)
            ? prev.map((w) => (w.id === res.workspace!.id ? res.workspace! : w))
            : [res.workspace!, ...prev],
        );
      }
      if (res.project) {
        setProjects((prev) =>
          prev.some((p) => p.id === res.project!.id)
            ? prev.map((p) => (p.id === res.project!.id ? res.project! : p))
            : [res.project!, ...prev],
        );
      }

      // Cross-Agent auto-fork: immediately register spawned Workspace & Thread and focus the new Thread!
      if (res.mode === 'handoff' && res.spawnedProject) {
        if (res.spawnedWorkspace) {
          setWorkspaces((prev) =>
            prev.some((w) => w.id === res.spawnedWorkspace!.id)
              ? prev.map((w) => (w.id === res.spawnedWorkspace!.id ? res.spawnedWorkspace! : w))
              : [res.spawnedWorkspace!, ...prev],
          );
        }
        setProjects((prev) =>
          prev.some((p) => p.id === res.spawnedProject!.id)
            ? prev.map((p) => (p.id === res.spawnedProject!.id ? res.spawnedProject! : p))
            : [res.spawnedProject!, ...prev],
        );
        setWorkspaceCollapsed(false);
        setRequestedTab({ tab: 'preview', nonce: Date.now() });
        await handleSelectProject(res.spawnedProject.id);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : '发送失败');
    }
  };

  const handleAbort = async () => {
    if (!activeProjectId) return;
    await api.abortAgent(activeProjectId);
  };

  const handleLogout = async () => {
    selectSeqRef.current++;
    closeStream();
    if (userEventSourceRef.current) {
      userEventSourceRef.current.close();
      userEventSourceRef.current = null;
    }
    await api.logout();
    setUsername(null);
    setWorkspaces([]);
    setProjects([]);
    setUnreadCompletions({});
    setActiveProjectId(null);
    setMessages([]);
  };

  if (!authChecked) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50 text-sm text-slate-500">
        正在加载 Atoms 工作台...
      </div>
    );
  }

  if (!username) {
    return (
      <LoginPage
        onSuccess={(u) => {
          setUsername(u);
          void api.me().then((res) => {
            setGlmConfigured(res.glmConfigured);
            setAgents(res.agents || res.presets || []);
          });
          void refreshAll();
        }}
      />
    );
  }

  return (
    <div className="h-screen w-screen flex overflow-hidden bg-slate-50">
      <Sidebar
        username={username}
        agents={agents}
        workspaces={workspaces}
        projects={projects}
        activeProjectId={activeProjectId}
        unreadCompletions={unreadCompletions}
        onSelectProject={(id) => void handleSelectProject(id)}
        onNewChat={handleNewChat}
        onNewWorkspace={(presetId) => void handleNewWorkspace(presetId)}
        onNewThreadInWorkspace={(wsId) => void handleNewThreadInWorkspace(wsId)}
        onDeleteProject={(id) => void handleDeleteProject(id)}
        onDeleteWorkspace={(wsId) => void handleDeleteWorkspace(wsId)}
        onLogout={() => void handleLogout()}
      />

      <ChatPanel
        agents={agents}
        project={activeProject}
        workspace={activeWorkspace}
        workspaces={workspaces}
        messages={messages}
        liveStream={liveStream}
        isBuilding={isBuilding}
        suggestBuild={suggestBuild}
        glmConfigured={glmConfigured}
        onSend={handleSend}
        onAbort={handleAbort}
        onOpenPreview={() => {
          setWorkspaceCollapsed(false);
          setRequestedTab({ tab: 'preview', nonce: Date.now() });
          setPreviewRevision((n) => n + 1);
        }}
        onOpenVsCode={() => {
          setWorkspaceCollapsed(false);
          setRequestedTab({ tab: 'code', nonce: Date.now() });
        }}
        workspaceCollapsed={workspaceCollapsed}
        onExpandWorkspace={() => setWorkspaceCollapsed(false)}
        onSelectProject={(id) => void handleSelectProject(id)}
        onBindWorkspace={handleBindWorkspace}
      />

      {/* P0: Strictly keyed by activeWorkspace.id so switching workspaces never leaks stale editor/tree/LSP state */}
      {activeWorkspace && (
        <>
          <WorkspacePanel
            key={activeWorkspace.id}
            workspace={activeWorkspace}
            agent={activeAgent}
            previewRevision={previewRevision}
            isBuilding={isBuilding}
            requestedTab={requestedTab}
            collapsed={workspaceCollapsed}
            onCollapse={() => setWorkspaceCollapsed(true)}
          />

          {workspaceCollapsed && (
            <aside className="w-11 border-l border-slate-200 bg-white flex flex-col items-center py-2.5 gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setWorkspaceCollapsed(false)}
                title={`展开右侧${activeWorkspace.presetId === 'deep-research' ? '研究空间' : '代码仓库'}面板`}
                className="p-2 rounded-lg text-slate-600 hover:text-indigo-700 hover:bg-indigo-50 transition cursor-pointer"
              >
                <PanelRightOpen className="w-4 h-4" />
              </button>

              <div className="w-6 h-px bg-slate-200" />

              {/* Quick direct-expand buttons */}
              <button
                type="button"
                onClick={() => {
                  setWorkspaceCollapsed(false);
                  setRequestedTab({ tab: 'preview', nonce: Date.now() });
                }}
                title={activeWorkspace.presetId === 'deep-research' ? '展开查看研究报告' : '展开查看应用预览'}
                className={`p-2 rounded-lg transition cursor-pointer ${
                  activeWorkspace.presetId === 'deep-research'
                    ? 'text-teal-600 hover:bg-teal-50'
                    : 'text-slate-600 hover:text-indigo-700 hover:bg-indigo-50'
                }`}
              >
                {activeWorkspace.presetId === 'deep-research' ? (
                  <BookOpen className="w-4 h-4" />
                ) : (
                  <Globe className="w-4 h-4" />
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  setWorkspaceCollapsed(false);
                  setRequestedTab({ tab: 'code', nonce: Date.now() });
                }}
                title="展开 VS Code 编辑器"
                className="p-2 rounded-lg text-slate-600 hover:text-indigo-700 hover:bg-indigo-50 transition cursor-pointer"
              >
                <Code2 className="w-4 h-4" />
              </button>

              {activeWorkspace.presetId !== 'deep-research' && (
                <button
                  type="button"
                  onClick={() => {
                    setWorkspaceCollapsed(false);
                    setRequestedTab({ tab: 'database', nonce: Date.now() });
                  }}
                  title="展开 SQLite 数据表"
                  className="p-2 rounded-lg text-slate-600 hover:text-indigo-700 hover:bg-indigo-50 transition cursor-pointer"
                >
                  <Database className="w-4 h-4" />
                </button>
              )}

              <div className="flex-1" />

              {/* Docked workspace identity & running indicator */}
              <button
                type="button"
                onClick={() => setWorkspaceCollapsed(false)}
                title={`${activeWorkspace.name} (${activeWorkspace.id}) — 点击展开`}
                className="flex flex-col items-center gap-1.5 py-2 px-1 rounded-lg hover:bg-slate-100 transition cursor-pointer"
              >
                {activeWorkspace.activeBuildProjectId || isBuilding ? (
                  <Loader2
                    className={`w-3.5 h-3.5 animate-spin ${
                      activeWorkspace.presetId === 'deep-research' ? 'text-teal-600' : 'text-indigo-600'
                    }`}
                  />
                ) : activeWorkspace.presetId === 'deep-research' ? (
                  <FlaskConical className="w-3.5 h-3.5 text-teal-600" />
                ) : (
                  <FolderGit2 className="w-3.5 h-3.5 text-indigo-600" />
                )}
                <span
                  className="text-[11px] font-medium text-slate-500 max-h-28 overflow-hidden truncate"
                  style={{ writingMode: 'vertical-rl' }}
                >
                  {activeWorkspace.name}
                </span>
              </button>
            </aside>
          )}
        </>
      )}
    </div>
  );
}
