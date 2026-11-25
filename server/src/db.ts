import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  MessageDTO,
  MessageMetadata,
  MessageRole,
  ProjectDTO,
  ProjectStatus,
  WorkspaceDTO,
} from '@atoms/shared';
import { config, ensureDataDirs } from './config.js';
import { buildTablePrefix } from './db-proxy.js';

ensureDataDirs();

const db = new DatabaseSync(config.platformDbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    preset_id TEXT NOT NULL DEFAULT 'fullstack-web',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_workspaces_owner_updated
    ON workspaces (owner, updated_at DESC);

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    title TEXT NOT NULL,
    preset_id TEXT NOT NULL DEFAULT 'fullstack-web',
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'chatting',
    has_workspace INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_projects_owner_updated
    ON projects (owner, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_project_created
    ON messages (project_id, created_at ASC);

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    error TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_agent_runs_project_started
    ON agent_runs (project_id, started_at DESC);
`);

// Safe migrations for existing platform.db
const projCols = db.prepare(`PRAGMA table_info("projects")`).all() as Array<{ name: string }>;
if (!projCols.some((c) => c.name === 'preset_id')) {
  db.exec(`ALTER TABLE projects ADD COLUMN preset_id TEXT NOT NULL DEFAULT 'fullstack-web'`);
}
if (!projCols.some((c) => c.name === 'workspace_id')) {
  db.exec(`ALTER TABLE projects ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects (workspace_id)`);

// Smooth lossless migration: promote legacy projects with has_workspace=1 to first-class workspaces
// Reusing the original project ID preserves disk directories, SQLite table prefixes, and /preview/<id>/ links.
const legacyWithWs = db
  .prepare(`
    SELECT id, owner, title, preset_id, created_at, updated_at
    FROM projects
    WHERE has_workspace = 1 AND workspace_id IS NULL
  `)
  .all() as unknown as Array<{
  id: string;
  owner: string;
  title: string;
  preset_id: string;
  created_at: number;
  updated_at: number;
}>;

for (const row of legacyWithWs) {
  db.prepare(`
    INSERT OR IGNORE INTO workspaces (id, owner, name, preset_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.id, row.owner, row.title, row.preset_id || 'fullstack-web', row.created_at, row.updated_at);
  db.prepare(`UPDATE projects SET workspace_id = ? WHERE id = ?`).run(row.id, row.id);
}

export interface WorkspaceRow {
  id: string;
  owner: string;
  name: string;
  preset_id: string;
  created_at: number;
  updated_at: number;
}

export interface ProjectRow {
  id: string;
  owner: string;
  title: string;
  preset_id: string;
  workspace_id: string | null;
  status: ProjectStatus;
  has_workspace: number;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  project_id: string;
  role: MessageRole;
  content: string;
  metadata_json: string | null;
  created_at: number;
}

export function generateId(prefix = ''): string {
  const rand = crypto.randomBytes(6).toString('hex');
  return prefix ? `${prefix}_${rand}` : rand;
}

export function toWorkspaceDTO(
  row: WorkspaceRow,
  previewRunning = false,
  buildState?: {
    activeBuildProjectId?: string | null;
    activeBuildTitle?: string | null;
    queuedProjectIds?: string[];
  },
): WorkspaceDTO {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    presetId: row.preset_id || 'fullstack-web',
    tablePrefix: buildTablePrefix(row.owner, row.id),
    previewUrl: `/preview/${row.id}/`,
    previewRunning,
    activeBuildProjectId: buildState?.activeBuildProjectId ?? null,
    activeBuildTitle: buildState?.activeBuildTitle ?? null,
    queuedProjectIds: buildState?.queuedProjectIds ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toProjectDTO(
  row: ProjectRow,
  previewRunning = false,
  workspaceName?: string | null,
): ProjectDTO {
  const workspaceId = row.workspace_id || null;
  const hasWorkspace = Boolean(workspaceId);
  return {
    id: row.id,
    owner: row.owner,
    title: row.title,
    presetId: row.preset_id || 'fullstack-web',
    workspaceId,
    workspaceName: workspaceName ?? null,
    tablePrefix: buildTablePrefix(row.owner, workspaceId || row.id),
    status: row.status,
    hasWorkspace,
    previewUrl: workspaceId ? `/preview/${workspaceId}/` : null,
    previewRunning: hasWorkspace ? previewRunning : false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessageDTO(row: MessageRow): MessageDTO {
  let metadata: MessageMetadata | undefined;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json) as MessageMetadata;
    } catch {
      metadata = undefined;
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    role: row.role,
    content: row.content,
    metadata,
    createdAt: row.created_at,
  };
}

export const dbStore = {
  // ---- Workspaces ----
  createWorkspace(owner: string, name: string, presetId = 'fullstack-web', explicitId?: string): WorkspaceRow {
    const id = explicitId || generateId('ws');
    const now = Date.now();
    db.prepare(`
      INSERT INTO workspaces (id, owner, name, preset_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, owner, name, presetId, now, now);
    return {
      id,
      owner,
      name,
      preset_id: presetId,
      created_at: now,
      updated_at: now,
    };
  },

  listWorkspaces(owner: string): WorkspaceRow[] {
    return db
      .prepare(`
        SELECT id, owner, name, preset_id, created_at, updated_at
        FROM workspaces
        WHERE owner = ?
        ORDER BY updated_at DESC
      `)
      .all(owner) as unknown as WorkspaceRow[];
  },

  getWorkspace(id: string): WorkspaceRow | undefined {
    return db
      .prepare(`
        SELECT id, owner, name, preset_id, created_at, updated_at
        FROM workspaces
        WHERE id = ?
      `)
      .get(id) as unknown as WorkspaceRow | undefined;
  },

  updateWorkspace(id: string, patch: { name?: string }): WorkspaceRow | undefined {
    const current = this.getWorkspace(id);
    if (!current) return undefined;
    const name = patch.name ?? current.name;
    const now = Date.now();
    db.prepare(`UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?`).run(name, now, id);
    return { ...current, name, updated_at: now };
  },

  touchWorkspace(id: string): void {
    db.prepare(`UPDATE workspaces SET updated_at = ? WHERE id = ?`).run(Date.now(), id);
  },

  deleteWorkspace(id: string): void {
    db.prepare(`UPDATE projects SET workspace_id = NULL, has_workspace = 0 WHERE workspace_id = ?`).run(id);
    db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
  },

  // ---- Projects (Conversation Threads) ----
  createProject(
    owner: string,
    title: string,
    presetId = 'fullstack-web',
    workspaceId: string | null = null,
  ): ProjectRow {
    const id = generateId('proj');
    const now = Date.now();
    const hasWs = workspaceId ? 1 : 0;
    db.prepare(`
      INSERT INTO projects (id, owner, title, preset_id, workspace_id, status, has_workspace, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'chatting', ?, ?, ?)
    `).run(id, owner, title, presetId, workspaceId, hasWs, now, now);
    if (workspaceId) {
      this.touchWorkspace(workspaceId);
    }
    return {
      id,
      owner,
      title,
      preset_id: presetId,
      workspace_id: workspaceId,
      status: 'chatting',
      has_workspace: hasWs,
      created_at: now,
      updated_at: now,
    };
  },

  listProjects(owner: string): ProjectRow[] {
    return db
      .prepare(`
        SELECT id, owner, title, preset_id, workspace_id, status, has_workspace, created_at, updated_at
        FROM projects
        WHERE owner = ?
        ORDER BY updated_at DESC
      `)
      .all(owner) as unknown as ProjectRow[];
  },

  listProjectsByWorkspace(workspaceId: string): ProjectRow[] {
    return db
      .prepare(`
        SELECT id, owner, title, preset_id, workspace_id, status, has_workspace, created_at, updated_at
        FROM projects
        WHERE workspace_id = ?
        ORDER BY updated_at DESC
      `)
      .all(workspaceId) as unknown as ProjectRow[];
  },

  getProject(id: string): ProjectRow | undefined {
    return db
      .prepare(`
        SELECT id, owner, title, preset_id, workspace_id, status, has_workspace, created_at, updated_at
        FROM projects
        WHERE id = ?
      `)
      .get(id) as unknown as ProjectRow | undefined;
  },

  updateProject(
    id: string,
    patch: {
      title?: string;
      presetId?: string;
      status?: ProjectStatus;
      hasWorkspace?: boolean;
      workspaceId?: string | null;
    },
  ): ProjectRow | undefined {
    const current = this.getProject(id);
    if (!current) return undefined;
    const title = patch.title ?? current.title;
    const presetId = patch.presetId ?? current.preset_id;
    const status = patch.status ?? current.status;
    const workspaceId = patch.workspaceId === undefined ? current.workspace_id : patch.workspaceId;
    const hasWorkspace =
      patch.workspaceId !== undefined
        ? workspaceId
          ? 1
          : 0
        : patch.hasWorkspace === undefined
          ? current.has_workspace
          : patch.hasWorkspace
            ? 1
            : 0;
    const now = Date.now();
    db.prepare(`
      UPDATE projects
      SET title = ?, preset_id = ?, status = ?, workspace_id = ?, has_workspace = ?, updated_at = ?
      WHERE id = ?
    `).run(title, presetId, status, workspaceId, hasWorkspace, now, id);
    if (workspaceId) {
      this.touchWorkspace(workspaceId);
    }
    return {
      ...current,
      title,
      preset_id: presetId,
      status,
      workspace_id: workspaceId,
      has_workspace: hasWorkspace,
      updated_at: now,
    };
  },

  deleteProject(id: string): void {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  },

  // ---- Messages ----
  addMessage(
    projectId: string,
    role: MessageRole,
    content: string,
    metadata?: MessageMetadata,
    explicitId?: string,
  ): MessageDTO {
    const id = explicitId || generateId('msg');
    const now = Date.now();
    const metaJson = metadata ? JSON.stringify(metadata) : null;
    db.prepare(`
      INSERT INTO messages (id, project_id, role, content, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, projectId, role, content, metaJson, now);
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
    return {
      id,
      projectId,
      role,
      content,
      metadata,
      createdAt: now,
    };
  },

  updateMessage(id: string, content: string, metadata?: MessageMetadata): MessageDTO | undefined {
    const metaJson = metadata ? JSON.stringify(metadata) : null;
    db.prepare('UPDATE messages SET content = ?, metadata_json = ? WHERE id = ?').run(
      content,
      metaJson,
      id,
    );
    const row = db
      .prepare('SELECT id, project_id, role, content, metadata_json, created_at FROM messages WHERE id = ?')
      .get(id) as unknown as MessageRow | undefined;
    return row ? toMessageDTO(row) : undefined;
  },

  listMessages(projectId: string): MessageDTO[] {
    const rows = db
      .prepare(`
        SELECT id, project_id, role, content, metadata_json, created_at
        FROM messages
        WHERE project_id = ?
        ORDER BY created_at ASC
      `)
      .all(projectId) as unknown as MessageRow[];
    return rows.map(toMessageDTO);
  },

  // ---- Agent Runs ----
  createAgentRun(projectId: string, prompt: string): string {
    const id = generateId('run');
    const now = Date.now();
    db.prepare(`
      INSERT INTO agent_runs (id, project_id, status, prompt, started_at)
      VALUES (?, ?, 'running', ?, ?)
    `).run(id, projectId, prompt, now);
    return id;
  },

  finishAgentRun(runId: string, status: 'succeeded' | 'aborted' | 'failed', error?: string): void {
    db.prepare(`
      UPDATE agent_runs
      SET status = ?, finished_at = ?, error = ?
      WHERE id = ?
    `).run(status, Date.now(), error ?? null, runId);
  },

  recoverStaleBuildingProjects(): ProjectRow[] {
    const now = Date.now();
    db.prepare(`
      UPDATE agent_runs
      SET status = 'aborted', finished_at = ?, error = '服务端重启，上次构建任务已中断'
      WHERE status = 'running'
    `).run(now);

    const stale = db
      .prepare(`
        SELECT id, owner, title, preset_id, workspace_id, status, has_workspace, created_at, updated_at
        FROM projects
        WHERE status IN ('building', 'queued')
      `)
      .all() as unknown as ProjectRow[];

    for (const row of stale) {
      const nextStatus: ProjectStatus = row.workspace_id || row.has_workspace ? 'ready' : 'error';
      db.prepare(`UPDATE projects SET status = ?, updated_at = ? WHERE id = ?`).run(nextStatus, now, row.id);
      this.addMessage(
        row.id,
        'assistant',
        '服务端已重启，上次中断的构建任务状态已自动恢复。你可以继续对话或重新发起构建。',
        { mode: 'build', aborted: true },
      );
    }

    return stale;
  },
};
