import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageDTO, ProjectDTO, SSEEvent } from '@atoms/shared';
import { api } from './api';
import { LoginPage } from './components/LoginPage';
import { Sidebar } from './components/Sidebar';
import { ChatPanel, type LiveStreamState } from './components/ChatPanel';
import { WorkspacePanel } from './components/WorkspacePanel';

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [glmConfigured, setGlmConfigured] = useState(true);

  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [isBuilding, setIsBuilding] = useState(false);
  const [suggestBuild, setSuggestBuild] = useState(false);
  const [liveStream, setLiveStream] = useState<LiveStreamState | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  activeProjectIdRef.current = activeProjectId;

  const activeProject = projects.find((p) => p.id === activeProjectId) || null;

  const refreshProjects = useCallback(async () => {
    const res = await api.listProjects();
    setProjects(res.projects);
    return res.projects;
  }, []);

  useEffect(() => {
    api
      .me()
      .then((res) => {
        setUsername(res.user.username);
        setGlmConfigured(res.glmConfigured);
        return refreshProjects();
      })
      .catch(() => {
        setUsername(null);
      })
      .finally(() => {
        setAuthChecked(true);
      });
  }, [refreshProjects]);

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

          switch (parsed.type) {
            case 'connected':
              setIsBuilding(parsed.isBuilding);
              clearTimeout(fallbackTimer);
              done();
              break;

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
              });
              break;

            case 'chat_delta':
              setLiveStream((prev) =>
                prev && prev.messageId === parsed.messageId
                  ? { ...prev, text: prev.text + parsed.delta }
                  : prev,
              );
              break;

            case 'chat_done':
              setLiveStream(null);
              setSuggestBuild(Boolean(parsed.suggestBuild));
              setMessages((prev) => {
                const without = prev.filter((m) => m.id !== parsed.message.id);
                return [...without, parsed.message];
              });
              break;

            case 'agent_start':
              setIsBuilding(true);
              setSuggestBuild(false);
              setLiveStream({
                messageId: parsed.messageId,
                mode: 'build',
                text: '',
                thinking: '',
                steps: [],
                statusText: '正在隔离工作区启动 Pi Coding Agent...',
              });
              break;

            case 'agent_thinking_delta':
              setLiveStream((prev) =>
                prev && prev.messageId === parsed.messageId
                  ? { ...prev, thinking: prev.thinking + parsed.delta }
                  : prev,
              );
              break;

            case 'agent_text_delta':
              setLiveStream((prev) =>
                prev && prev.messageId === parsed.messageId
                  ? { ...prev, text: prev.text + parsed.delta }
                  : prev,
              );
              break;

            case 'agent_tool_start':
              setLiveStream((prev) => {
                if (!prev || prev.messageId !== parsed.messageId) return prev;
                const idx = prev.steps.findIndex((s) => s.id === parsed.step.id);
                const nextSteps =
                  idx === -1
                    ? [...prev.steps, parsed.step]
                    : prev.steps.map((s, i) => (i === idx ? parsed.step : s));
                return { ...prev, steps: nextSteps, statusText: undefined };
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
                };
              });
              break;

            case 'agent_status':
              setLiveStream((prev) =>
                prev && prev.messageId === parsed.messageId
                  ? { ...prev, statusText: parsed.statusText }
                  : prev,
              );
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
              void refreshProjects();
              break;

            case 'error':
              setIsBuilding(false);
              setLiveStream(null);
              break;
          }
        };
      });
    },
    [closeStream, refreshProjects],
  );

  useEffect(() => {
    return () => closeStream();
  }, [closeStream]);

  const handleSelectProject = async (projectId: string) => {
    setActiveProjectId(projectId);
    setLiveStream(null);
    setSuggestBuild(false);
    try {
      const detail = await api.getProject(projectId);
      setMessages(detail.messages);
      setIsBuilding(detail.isBuilding);
      setProjects((prev) => prev.map((p) => (p.id === detail.project.id ? detail.project : p)));
      await connectStream(projectId);
    } catch (err) {
      alert(err instanceof Error ? err.message : '加载项目失败');
    }
  };

  const handleNewChat = () => {
    closeStream();
    setActiveProjectId(null);
    setMessages([]);
    setIsBuilding(false);
    setSuggestBuild(false);
    setLiveStream(null);
  };

  const handleDeleteProject = async (projectId: string) => {
    if (!confirm('确认删除该项目及其所有代码和 SQLite 数据吗？')) return;
    await api.deleteProject(projectId);
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    if (activeProjectId === projectId) {
      handleNewChat();
    }
  };

  const handleSend = async (text: string, forceBuild = false) => {
    let targetProjectId = activeProjectId;
    if (!targetProjectId) {
      const created = await api.createProject(text.slice(0, 20));
      targetProjectId = created.project.id;
      activeProjectIdRef.current = targetProjectId;
      setProjects((prev) => [created.project, ...prev]);
      setActiveProjectId(targetProjectId);
      setMessages([]);
      await connectStream(targetProjectId);
    }

    try {
      const res = await api.sendMessage(targetProjectId, text, forceBuild);
      setMessages((prev) =>
        prev.some((m) => m.id === res.userMessage.id) ? prev : [...prev, res.userMessage],
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : '发送失败');
    }
  };

  const handleAbort = async () => {
    if (!activeProjectId) return;
    await api.abortAgent(activeProjectId);
  };

  const handleInitWorkspace = async () => {
    if (!activeProjectId) return;
    try {
      const res = await api.initWorkspace(activeProjectId);
      setProjects((prev) => prev.map((p) => (p.id === res.project.id ? res.project : p)));
    } catch (err) {
      alert(err instanceof Error ? err.message : '初始化工作区失败');
    }
  };

  const handleLogout = async () => {
    closeStream();
    await api.logout();
    setUsername(null);
    setProjects([]);
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
          void api.me().then((res) => setGlmConfigured(res.glmConfigured));
          void refreshProjects();
        }}
      />
    );
  }

  const showWorkspace = Boolean(activeProject && (activeProject.hasWorkspace || isBuilding));

  return (
    <div className="h-screen w-screen flex overflow-hidden bg-slate-50">
      <Sidebar
        username={username}
        projects={projects}
        activeProjectId={activeProjectId}
        onSelectProject={(id) => void handleSelectProject(id)}
        onNewChat={handleNewChat}
        onDeleteProject={(id) => void handleDeleteProject(id)}
        onLogout={() => void handleLogout()}
      />

      <ChatPanel
        project={activeProject}
        messages={messages}
        liveStream={liveStream}
        isBuilding={isBuilding}
        suggestBuild={suggestBuild}
        glmConfigured={glmConfigured}
        onSend={handleSend}
        onAbort={handleAbort}
        onOpenPreview={() => setPreviewRevision((n) => n + 1)}
        onInitWorkspace={handleInitWorkspace}
      />

      {showWorkspace && activeProject && (
        <WorkspacePanel
          project={activeProject}
          previewRevision={previewRevision}
          isBuilding={isBuilding}
        />
      )}
    </div>
  );
}
