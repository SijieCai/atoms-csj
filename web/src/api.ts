import type {
  AgentPresetSummary,
  FileTreeNode,
  MessageDTO,
  ProjectDTO,
  TableInfoDTO,
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
}

export const api = {
  me(): Promise<AuthMeResponse> {
    return request<AuthMeResponse>('/api/auth/me');
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

  listProjects(): Promise<{ projects: ProjectDTO[] }> {
    return request('/api/projects');
  },

  createProject(title?: string): Promise<{ project: ProjectDTO }> {
    return request('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
  },

  getProject(id: string): Promise<{ project: ProjectDTO; messages: MessageDTO[]; isBuilding: boolean }> {
    return request(`/api/projects/${encodeURIComponent(id)}`);
  },

  deleteProject(id: string): Promise<{ ok: boolean }> {
    return request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  sendMessage(
    projectId: string,
    content: string,
    forceBuild = false,
  ): Promise<{ mode: 'chat' | 'build' | 'steered'; userMessage: MessageDTO; messageId?: string; runId?: string }> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, forceBuild }),
    });
  },

  abortAgent(projectId: string): Promise<{ ok: boolean }> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/abort`, { method: 'POST' });
  },

  listFiles(projectId: string): Promise<{ files: FileTreeNode[] }> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/files`);
  },

  initWorkspace(projectId: string): Promise<{ ok: boolean; project: ProjectDTO }> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/workspace/init`, {
      method: 'POST',
    });
  },

  readFile(projectId: string, filePath: string): Promise<{ path: string; content: string; binary?: boolean }> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(filePath)}`,
    );
  },

  writeFile(projectId: string, filePath: string, content: string): Promise<{ ok: boolean; path: string; bytes: number }> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path: filePath, content }),
    });
  },

  createEntry(
    projectId: string,
    filePath: string,
    type: 'file' | 'dir',
  ): Promise<{ ok: boolean; path: string; type: 'file' | 'dir' }> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/files/create`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath, type }),
    });
  },

  deleteEntry(projectId: string, filePath: string): Promise<{ ok: boolean; path: string }> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(filePath)}`,
      { method: 'DELETE' },
    );
  },

  getLogs(
    projectId: string,
  ): Promise<{ running: boolean; port: number | null; logs: string[]; hasDb: boolean; tableCount: number }> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/logs`);
  },

  getTables(
    projectId: string,
  ): Promise<{ prefix: string; preset?: AgentPresetSummary; tables: TableInfoDTO[] }> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/tables`);
  },

  getTableRows(
    projectId: string,
    table: string,
  ): Promise<{ logicalName: string; physicalName: string; rows: Record<string, unknown>[] }> {
    return request(
      `/api/projects/${encodeURIComponent(projectId)}/tables/${encodeURIComponent(table)}/rows`,
    );
  },

  restartPreview(projectId: string): Promise<{ ok: boolean; previewUrl: string }> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/preview/restart`, { method: 'POST' });
  },
};
