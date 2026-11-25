import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { MessageDTO, MessageMetadata, MessageRole, ProjectDTO, ProjectStatus } from '@atoms/shared';
import { config, ensureDataDirs } from './config.js';
import { buildTablePrefix } from './db-proxy.js';

ensureDataDirs();

const db = new DatabaseSync(config.platformDbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    title TEXT NOT NULL,
    preset_id TEXT NOT NULL DEFAULT 'fullstack-web',
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

// Safe migration for existing platform.db created before preset_id was added
const projCols = db.prepare(`PRAGMA table_info("projects")`).all() as Array<{ name: string }>;
if (!projCols.some((c) => c.name === 'preset_id')) {
  db.exec(`ALTER TABLE projects ADD COLUMN preset_id TEXT NOT NULL DEFAULT 'fullstack-web'`);
}

export interface ProjectRow {
  id: string;
  owner: string;
  title: string;
  preset_id: string;
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

export function toProjectDTO(row: ProjectRow, previewRunning = false): ProjectDTO {
  const hasWorkspace = Boolean(row.has_workspace);
  return {
    id: row.id,
    owner: row.owner,
    title: row.title,
    presetId: row.preset_id || 'fullstack-web',
    tablePrefix: buildTablePrefix(row.owner, row.id),
    status: row.status,
    hasWorkspace,
    previewUrl: hasWorkspace ? `/preview/${row.id}/` : null,
    previewRunning,
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
  createProject(owner: string, title: string, presetId = 'fullstack-web'): ProjectRow {
    const id = generateId('proj');
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO projects (id, owner, title, preset_id, status, has_workspace, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'chatting', 0, ?, ?)
    `);
    stmt.run(id, owner, title, presetId, now, now);
    return {
      id,
      owner,
      title,
      preset_id: presetId,
      status: 'chatting',
      has_workspace: 0,
      created_at: now,
      updated_at: now,
    };
  },

  listProjects(owner: string): ProjectRow[] {
    const stmt = db.prepare(`
      SELECT id, owner, title, preset_id, status, has_workspace, created_at, updated_at
      FROM projects
      WHERE owner = ?
      ORDER BY updated_at DESC
    `);
    return stmt.all(owner) as unknown as ProjectRow[];
  },

  getProject(id: string): ProjectRow | undefined {
    const stmt = db.prepare(`
      SELECT id, owner, title, preset_id, status, has_workspace, created_at, updated_at
      FROM projects
      WHERE id = ?
    `);
    return stmt.get(id) as unknown as ProjectRow | undefined;
  },

  updateProject(
    id: string,
    patch: { title?: string; status?: ProjectStatus; hasWorkspace?: boolean },
  ): ProjectRow | undefined {
    const current = this.getProject(id);
    if (!current) return undefined;
    const title = patch.title ?? current.title;
    const status = patch.status ?? current.status;
    const hasWorkspace = patch.hasWorkspace === undefined ? current.has_workspace : patch.hasWorkspace ? 1 : 0;
    const now = Date.now();
    db.prepare(`
      UPDATE projects
      SET title = ?, status = ?, has_workspace = ?, updated_at = ?
      WHERE id = ?
    `).run(title, status, hasWorkspace, now, id);
    return {
      ...current,
      title,
      status,
      has_workspace: hasWorkspace,
      updated_at: now,
    };
  },

  deleteProject(id: string): void {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  },

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
};
