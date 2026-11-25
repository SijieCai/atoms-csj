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
import { ResilientEventSource, type ConnectionStatus } from './sse';
import { LoginPage } from './components/LoginPage';
import { Sidebar } from './components/Sidebar';
import { ChatPanel, type LiveStreamState } from './components/ChatPanel';
import { WorkspacePanel, type WorkspaceTabKey } from './components/WorkspacePanel';

const LAST_PROJECT_STORAGE_KEY = 'atoms:lastActiveProjectId';

function readThreadFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('thread');
  } catch {
    return null;
  }
}

function readStoredThread(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistActiveThread(projectId: string | null): void {
  try {
    if (projectId) {
      window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
    } else {
      window.localStorage.removeItem(LAST_PROJECT_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
  try {
    const url = new URL(window.location.href);
    if (projectId) {
      url.searchParams.set('thread', projectId);
    } else {
      url.searchParams.delete('thread');
    }
    window.history.replaceState(null, '', url.toString());
  } catch {
    // ignore history errors
  }
}

function pickInitialProjectId(projectList: ProjectDTO[]): string | null {
  if (projectList.length === 0) return null;
  const fromUrl = readThreadFromUrl();
  if (fromUrl && projectList.some((p) => p.id === fromUrl)) {
    return fromUrl;
  }
  const fromStorage = readStoredThread();
  if (fromStorage && projectList.some((p) => p.id === fromStorage)) {
    return fromStorage;
  }
  // If no explicit saved thread (e.g., new browser/incognito), auto-resume any active running thread
  const running = projectList.find((p) => p.status === 'building' || p.status === 'queued');
  return running ? running.id : null;
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const exists = list.some((x) => x.id === item.id);
  return exists ? list.map((x) => (x.id === item.id ? item : x)) : [item, ...list];
}

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
  const [userStreamStatus, setUserStreamStatus] = useState<ConnectionStatus>('closed');
  const [projectStreamStatus, setProjectStreamStatus] = useState<ConnectionStatus>('closed');

  const eventSourceRef = useRef<ResilientEventSource<SSEEvent> | null>(null);
  const userEventSourceRef = useRef<ResilientEventSource<UserGlobalSSEEvent> | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const selectSeqRef = useRef(0);
  const lastStreamSeqRef = useRef(0);
  const serverBootIdRef = useRef<string | null>(null);
  const liveStreamRef = useRef<LiveStreamState | null>(null);
  const isBuildingRef = useRef(false);
  const messagesRef = useRef<MessageDTO[]>([]);
  const creatingProjectRef = useRef<Promise<string> | null>(null);
  const reconcilingRef = useRef(false);
  const lastVisibilitySyncRef = useRef(0);

  activeProjectIdRef.current = activeProjectId;
  liveStreamRef.current = liveStream;
  isBuildingRef.current = isBuilding;
  messagesRef.current = messages;

  const isReconnecting =
    userStreamStatus === 'reconnecting' ||
    (Boolean(activeProjectId) && projectStreamStatus === 'reconnecting');

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

  const reconcileActiveProject = useCallback(
    async (
      projectId: string,
      opts?: { refreshLists?: boolean; bumpPreviewIfReady?: boolean },
    ) => {
      if (reconcilingRef.current) return;
      reconcilingRef.current = true;
      try {
        const [detail] = await Promise.all([
          api.getProject(projectId),
          opts?.refreshLists ? refreshAll().catch(() => null) : Promise.resolve(null),
        ]);
        if (activeProjectIdRef.current !== projectId) return;

        setMessages(detail.messages);
        setIsBuilding(detail.isBuilding);
        setProjects((prev) => upsertById(prev, detail.project));

        if (detail.activeRun) {
          const snap = snapshotToLiveStream(detail.activeRun);
          lastStreamSeqRef.current = Math.max(lastStreamSeqRef.current, detail.activeRun.seq);
          setLiveStream((prev) => {
            if (!snap) return prev;
            if (!prev || prev.messageId !== snap.messageId || (snap.seq ?? 0) >= (prev.seq ?? 0)) {
              return snap;
            }
            return prev;
          });
        } else {
          setLiveStream(null);
          if (opts?.bumpPreviewIfReady && detail.project.previewRunning) {
            setPreviewRevision((n) => n + 1);
          }
        }
      } catch {
        // ignore transient network errors; SSE / next poll will retry
      } finally {
        reconcilingRef.current = false;
      }
    },
    [refreshAll],
  );

  const closeStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setProjectStreamStatus('closed');
  }, []);

  const handleAuthExpired = useCallback(() => {
    closeStream();
    if (userEventSourceRef.current) {
      userEventSourceRef.current.close();
      userEventSourceRef.current = null;
    }
    setUserStreamStatus('closed');
    setUsername(null);
  }, [closeStream]);

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
        const fallbackTimer = setTimeout(done, 1500);

        const es = new ResilientEventSource<SSEEvent>({
          url: `/api/projects/${encodeURIComponent(projectId)}/events`,
          onStatusChange: (status) => {
            if (activeProjectIdRef.current === projectId) {
              setProjectStreamStatus(status);
            }
          },
          onAuthExpired: handleAuthExpired,
          onOpen: () => {
            clearTimeout(fallbackTimer);
            done();
          },
          onMessage: (parsed, meta) => {
            if (activeProjectIdRef.current !== projectId) return;

            if (parsed.type === 'heartbeat') {
              return;
            }

            if (parsed.type === 'connected') {
              const bootChanged =
                Boolean(serverBootIdRef.current) &&
                Boolean(parsed.serverBootId) &&
                serverBootIdRef.current !== parsed.serverBootId;
              if (parsed.serverBootId) {
                serverBootIdRef.current = parsed.serverBootId;
              }

              // Trust server's authoritative seq at handshake (prevents seq deadlock after server restart)
              lastStreamSeqRef.current = typeof parsed.seq === 'number' ? parsed.seq : 0;

              const wasWorking = Boolean(liveStreamRef.current || isBuildingRef.current);
              setIsBuilding(parsed.isBuilding);

              if (parsed.activeRun) {
                const snap = snapshotToLiveStream(parsed.activeRun);
                if (snap) {
                  setLiveStream(snap);
                }
              } else {
                setLiveStream(null);
              }

              const localMsgs = messagesRef.current;
              const localLatestId = localMsgs.length > 0 ? localMsgs[localMsgs.length - 1].id : null;
              const messagesDiverged =
                (parsed.latestMessageId !== undefined && parsed.latestMessageId !== localLatestId) ||
                (parsed.messageCount !== undefined && parsed.messageCount !== localMsgs.length);
              const finishedWhileAway = wasWorking && !parsed.activeRun && !parsed.isBuilding;

              if (meta.isReconnect || bootChanged || messagesDiverged || finishedWhileAway) {
                void reconcileActiveProject(projectId, {
                  refreshLists: meta.isReconnect || bootChanged || finishedWhileAway,
                  bumpPreviewIfReady: finishedWhileAway,
                });
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
          },
        });
        eventSourceRef.current = es;
      });
    },
    [closeStream, handleAuthExpired, reconcileActiveProject, refreshAll],
  );

  useEffect(() => {
    return () => closeStream();
  }, [closeStream]);

  const handleSelectProject = useCallback(
    async (projectId: string) => {
      const reqSeq = ++selectSeqRef.current;
      closeStream();
      lastStreamSeqRef.current = 0;
      setActiveProjectId(projectId);
      persistActiveThread(projectId);
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
        messagesRef.current = detail.messages;
        isBuildingRef.current = detail.isBuilding;
        setMessages(detail.messages);
        setIsBuilding(detail.isBuilding);
        if (detail.activeRun) {
          const snap = snapshotToLiveStream(detail.activeRun);
          lastStreamSeqRef.current = detail.activeRun.seq;
          liveStreamRef.current = snap;
          setLiveStream(snap);
        } else {
          liveStreamRef.current = null;
          setLiveStream(null);
        }
        setProjects((prev) => upsertById(prev, detail.project));
        await connectStream(projectId);
      } catch (err) {
        if (selectSeqRef.current === reqSeq) {
          alert(err instanceof Error ? err.message : '加载对话失败');
        }
      }
    },
    [closeStream, connectStream],
  );

  // Initial auth check + auto-restore last/running thread after page reload or reopen
  useEffect(() => {
    api
      .me()
      .then(async (res) => {
        setUsername(res.user.username);
        setGlmConfigured(res.glmConfigured);
        setAgents(res.agents || res.presets || []);
        const { projects: loadedProjects } = await refreshAll();
        const initialId = pickInitialProjectId(loadedProjects);
        if (initialId) {
          void handleSelectProject(initialId);
        }
      })
      .catch(() => {
        setUsername(null);
      })
      .finally(() => {
        setAuthChecked(true);
      });
  }, [refreshAll, handleSelectProject]);

  // Persistent self-healing user-level SSE for real-time sidebar sync across ALL workspaces & threads
  useEffect(() => {
    if (!username) {
      if (userEventSourceRef.current) {
        userEventSourceRef.current.close();
        userEventSourceRef.current = null;
      }
      setUserStreamStatus('closed');
      return;
    }

    const es = new ResilientEventSource<UserGlobalSSEEvent>({
      url: '/api/events',
      onStatusChange: (status) => setUserStreamStatus(status),
      onAuthExpired: handleAuthExpired,
      onMessage: (parsed, meta) => {
        if (parsed.type === 'heartbeat') return;

        if (parsed.type === 'user_connected') {
          const bootChanged =
            Boolean(serverBootIdRef.current) &&
            Boolean(parsed.serverBootId) &&
            serverBootIdRef.current !== parsed.serverBootId;
          if (parsed.serverBootId) {
            serverBootIdRef.current = parsed.serverBootId;
          }
          if (meta.isReconnect || bootChanged) {
            void refreshAll().catch(() => {});
            const currentId = activeProjectIdRef.current;
            if (currentId) {
              void reconcileActiveProject(currentId, { bumpPreviewIfReady: true });
            }
          }
          return;
        }

        switch (parsed.type) {
          case 'workspace_updated':
            setWorkspaces((prev) => upsertById(prev, parsed.workspace));
            break;

          case 'workspace_deleted':
            setWorkspaces((prev) => prev.filter((w) => w.id !== parsed.workspaceId));
            break;

          case 'project_updated':
            setProjects((prev) => upsertById(prev, parsed.project));
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
            setProjects((prev) => upsertById(prev, parsed.project));
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
      },
    });
    userEventSourceRef.current = es;

    return () => {
      es.close();
      if (userEventSourceRef.current === es) {
        userEventSourceRef.current = null;
      }
      setUserStreamStatus('closed');
    };
  }, [username, handleAuthExpired, reconcileActiveProject, refreshAll]);

  // Recover immediately when tab returns from background, laptop wakes from sleep, or network returns
  useEffect(() => {
    if (!username) return;

    const syncOnResume = (forceReconnect = false) => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (!forceReconnect && now - lastVisibilitySyncRef.current < 1500) return;
      lastVisibilitySyncRef.current = now;

      if (userEventSourceRef.current && (forceReconnect || userEventSourceRef.current.isStale(20_000))) {
        userEventSourceRef.current.reconnectNow();
      }
      if (eventSourceRef.current && (forceReconnect || eventSourceRef.current.isStale(20_000))) {
        eventSourceRef.current.reconnectNow();
      }

      void refreshAll().catch(() => {});
      const currentId = activeProjectIdRef.current;
      if (currentId) {
        void reconcileActiveProject(currentId, { bumpPreviewIfReady: true });
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') syncOnResume(false);
    };
    const onFocus = () => syncOnResume(false);
    const onOnline = () => syncOnResume(true);

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
    };
  }, [username, reconcileActiveProject, refreshAll]);

  // Fallback HTTP polling ONLY while SSE is unhealthy and an active run is in progress
  const hasLiveStream = Boolean(liveStream);
  useEffect(() => {
    if (!activeProjectId || !isReconnecting || (!isBuilding && !hasLiveStream)) return;
    const timer = window.setInterval(() => {
      void reconcileActiveProject(activeProjectId, {
        refreshLists: true,
        bumpPreviewIfReady: true,
      });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [activeProjectId, isReconnecting, isBuilding, hasLiveStream, reconcileActiveProject]);

  const handleRetryConnection = useCallback(() => {
    userEventSourceRef.current?.reconnectNow();
    eventSourceRef.current?.reconnectNow();
    void refreshAll().catch(() => {});
    if (activeProjectIdRef.current) {
      void reconcileActiveProject(activeProjectIdRef.current, { bumpPreviewIfReady: true });
    }
  }, [reconcileActiveProject, refreshAll]);

  const handleNewChat = () => {
    selectSeqRef.current++;
    closeStream();
    lastStreamSeqRef.current = 0;
    setActiveProjectId(null);
    persistActiveThread(null);
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
    let targetProjectId = activeProjectIdRef.current;
    if (!targetProjectId) {
      if (creatingProjectRef.current) {
        targetProjectId = await creatingProjectRef.current;
      } else {
        const createPromise = (async () => {
          const created = await api.createProject(text.slice(0, 20), null, opts?.targetAgentId);
          const id = created.project.id;
          activeProjectIdRef.current = id;
          lastStreamSeqRef.current = 0;
          setProjects((prev) => upsertById(prev, created.project));
          setActiveProjectId(id);
          persistActiveThread(id);
          setMessages([]);
          await connectStream(id);
          return id;
        })();
        creatingProjectRef.current = createPromise;
        try {
          targetProjectId = await createPromise;
        } finally {
          creatingProjectRef.current = null;
        }
      }
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
        setWorkspaces((prev) => upsertById(prev, res.workspace!));
      }
      if (res.project) {
        setProjects((prev) => upsertById(prev, res.project!));
      }

      // Cross-Agent auto-fork: immediately register spawned Workspace & Thread and focus the new Thread!
      if (res.mode === 'handoff' && res.spawnedProject) {
        if (res.spawnedWorkspace) {
          setWorkspaces((prev) => upsertById(prev, res.spawnedWorkspace!));
        }
        setProjects((prev) => upsertById(prev, res.spawnedProject!));
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
    persistActiveThread(null);
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
          void refreshAll().then(({ projects: loadedProjects }) => {
            const initialId = pickInitialProjectId(loadedProjects);
            if (initialId) {
              void handleSelectProject(initialId);
            }
          });
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
        connectionState={isReconnecting ? 'reconnecting' : 'connected'}
        onRetryConnection={handleRetryConnection}
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
