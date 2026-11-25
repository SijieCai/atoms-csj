import type {
  ActiveRunSnapshot,
  AgentPresetSummary,
  FileTreeNode,
  MessageDTO,
  PluginSummary,
  ProjectDTO,
  TableInfoDTO,
  WorkspaceDTO,
} from '@atoms/shared';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });

  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `HTTP ${resp.status}`);
  }
  return (await resp.json()) as T;
}

export interface AuthMeResponse {
  user: { username: string };
  glmConfigured: boolean;
  model: string;
  presets?: AgentPresetSummary[];
  agents?: AgentPresetSummary[];
}

export interface SendMessageResponse {
  mode: 'chat' | 'build' | 'steered' | 'queued' | 'handoff';
  targetAgentId?: string | null;
  userMessage: MessageDTO;
  handoffMessage?: MessageDTO;
  spawnedProject?: ProjectDTO;
  spawnedWorkspace?: WorkspaceDTO;
  project?: ProjectDTO;
  workspace?: WorkspaceDTO;
  messageId?: string;
  runId?: string;
}

export const api = {
  me(): Promise<AuthMeResponse> {
    return request<AuthMeResponse>('/api/auth/me');
  },

  listAgents(): Promise<{ agents: AgentPresetSummary[]; plugins: PluginSummary[] }> {
    return request('/api/agents');
  },

  login(username: string, password: string): Promise<{ user: { username: string } }> {
    return request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  },

  logout(): Promise<{ ok: boolean }> {
    return request('/api/auth/logout', { method: 'POST' });
  },

  // ---- Workspaces (Code Repos & Research Spaces) ----
  listWorkspaces(): Promise<{ workspaces: WorkspaceDTO[] }> {
    return request('/api/workspaces');
  },

  createWorkspace(name: string, presetId?: string): Promise<{ workspace: WorkspaceDTO }> {
    return request('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name, presetId }),
    });
  },

  renameWorkspace(workspaceId: string, name: string): Promise<{ workspace: WorkspaceDTO }> {
    return request(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  },

  deleteWorkspace(workspaceId: string): Promise<{ ok: boolean }> {
    return request(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
    });
  },

  // ---- Projects (Conversation Threads) ----
  listProjects(): Promise<{ projects: ProjectDTO[] }> {
    return request('/api/projects');
  },

  createProject(
    title?: string,
    workspaceId?: string | null,
    presetId?: string,
  ): Promise<{ project: ProjectDTO }> {
    return request('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ title, workspaceId: workspaceId ?? null, presetId }),
    });
  },

  getProject(id: string): Promise<{
    project: ProjectDTO;
    messages: MessageDTO[];
    isBuilding: boolean;
    activeRun: ActiveRunSnapshot | null;
  }> {
    return request(`/api/projects/${encodeURIComponent(id)}`);
  },

  deleteProject(id: string): Promise<{ ok: boolean }> {
    return request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  bindWorkspace(
    projectId: string,
    payload: { workspaceId?: string; createNew?: boolean; name?: string; presetId?: string },
  ): Promise<{ ok: boolean; project: ProjectDTO; workspace: WorkspaceDTO }> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/bind-workspace`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  sendMessage(
    projectId: string,
    content: string,
    opts?: { forceBuild?: boolean; targetAgentId?: string },
  ): Promise<SendMessageResponse> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        forceBuild: Boolean(opts?.forceBuild),
        targetAgentId: opts?.targetAgentId,
      }),
    });
  },

  abortAgent(projectId: string): Promise<{ ok: boolean }> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/abort`, { method: 'POST' });
  },

  // ---- Workspace-Scoped Resources (Files / DB / Logs / Preview) ----
  listFiles(workspaceId: string): Promise<{ files: FileTreeNode[] }> {
    return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/files`);
  },

  readFile(workspaceId: string, filePath: string): Promise<{ path: string; content: string; binary?: boolean }> {
    return request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(filePath)}`,
    );
  },

  writeFile(
    workspaceId: string,
    filePath: string,
    content: string,
  ): Promise<{ ok: boolean; path: string; bytes: number }> {
    return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path: filePath, content }),
    });
  },

  createEntry(
    workspaceId: string,
    filePath: string,
    type: 'file' | 'dir',
  ): Promise<{ ok: boolean; path: string; type: 'file' | 'dir' }> {
    return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/files/create`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath, type }),
    });
  },

  deleteEntry(workspaceId: string, filePath: string): Promise<{ ok: boolean; path: string }> {
    return request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(filePath)}`,
      { method: 'DELETE' },
    );
  },

  getLogs(
    workspaceId: string,
  ): Promise<{ running: boolean; port: number | null; logs: string[]; hasDb: boolean; tableCount: number }> {
    return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/logs`);
  },

  getTables(
    workspaceId: string,
  ): Promise<{ prefix: string; preset?: AgentPresetSummary; tables: TableInfoDTO[] }> {
    return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/tables`);
  },

  getTableRows(
    workspaceId: string,
    table: string,
  ): Promise<{ logicalName: string; physicalName: string; rows: Record<string, unknown>[] }> {
    return request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/tables/${encodeURIComponent(table)}/rows`,
    );
  },

  restartPreview(workspaceId: string): Promise<{ ok: boolean; previewUrl: string }> {
    return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/preview/restart`, {
      method: 'POST',
    });
  },
};
