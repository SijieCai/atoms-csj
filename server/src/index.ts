import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { ActiveRunSnapshot, ProjectDTO, WorkspaceDTO } from '@atoms/shared';
import { config, ensureDataDirs } from './config.js';
import { dbStore, generateId, toProjectDTO, toWorkspaceDTO, type WorkspaceRow } from './db.js';
import { buildTablePrefix, createDbProxyRouter, dbProxy } from './db-proxy.js';
import {
  clearSessionCookie,
  requireAuth,
  setSessionCookie,
  verifyCredentials,
  verifySessionToken,
  type AuthenticatedRequest,
} from './auth.js';
import { eventBus } from './event-bus.js';
import { classifyIntent, deriveFallbackTitle, streamChatReply } from './intent.js';
import { piManager } from './pi-manager.js';
import { pluginRegistry } from './plugin-registry.js';
import { previewManager } from './preview-manager.js';
import { lspManager } from './lsp-manager.js';

ensureDataDirs();
pluginRegistry.reload();
const recoveredStale = dbStore.recoverStaleBuildingProjects();
if (recoveredStale.length > 0) {
  console.log(
    `[atoms-server] Recovered ${recoveredStale.length} stale building/queued project(s): ${recoveredStale.map((r) => r.id).join(', ')}`,
  );
}

const activeChatRuns = new Map<string, ActiveRunSnapshot>();

function getActiveRunSnapshot(projectId: string): ActiveRunSnapshot | null {
  const buildSnap = piManager.getActiveRunSnapshot(projectId);
  if (buildSnap) return buildSnap;
  const chatSnap = activeChatRuns.get(projectId);
  return chatSnap ? { ...chatSnap, steps: [] } : null;
}

const app = express();
app.set('trust proxy', 1);
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Public Preview Reverse Proxy (keyed by workspaceId; legacy projectId supported)
// ---------------------------------------------------------------------------
app.use('/preview/:targetId', (req, res) => {
  const targetId = String(req.params.targetId || '');
  const urlWithoutQuery = req.originalUrl.split('?')[0];
  if (urlWithoutQuery === `/preview/${targetId}`) {
    const qIdx = req.originalUrl.indexOf('?');
    const qs = qIdx !== -1 ? req.originalUrl.slice(qIdx) : '';
    res.redirect(302, `/preview/${targetId}/${qs}`);
    return;
  }

  let ws = dbStore.getWorkspace(targetId);
  if (!ws) {
    const proj = dbStore.getProject(targetId);
    if (proj?.workspace_id) {
      ws = dbStore.getWorkspace(proj.workspace_id);
    }
  }
  if (!ws) {
    res.status(404).send('Workspace not found.');
    return;
  }

  const subPath = req.url || '/';
  void previewManager.proxyRequest(
    req,
    res,
    ws.id,
    { owner: ws.owner, presetId: ws.preset_id },
    subPath,
  );
});

app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// Scoped DB Proxy API (authenticated via workspace-scoped Bearer token)
// ---------------------------------------------------------------------------
app.use('/api/db-proxy', createDbProxyRouter());

// ---------------------------------------------------------------------------
// Health & Auth
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model: config.glmModel,
    glmConfigured: Boolean(config.glmApiKey),
    activeAgents: piManager.getActiveCount(),
    plugins: pluginRegistry.listPlugins().map((p) => p.id),
    presets: pluginRegistry.listPresets().map((p) => p.id),
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = (req.body || {}) as { username?: string; password?: string };
  const user = (username || '').trim();
  const pass = password || '';
  if (!user || !pass || !verifyCredentials(user, pass)) {
    res.status(401).json({ error: '用户名或密码错误' });
    return;
  }
  setSessionCookie(res, user);
  res.json({ user: { username: user } });
});

app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.atoms_session as string | undefined;
  const username = verifySessionToken(token);
  if (!username) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json({
    user: { username },
    glmConfigured: Boolean(config.glmApiKey),
    model: config.glmModel,
    presets: pluginRegistry.listPresets(),
  });
});

app.get('/api/presets', requireAuth, (_req, res) => {
  res.json({
    presets: pluginRegistry.listPresets(),
    plugins: pluginRegistry.listPlugins(),
  });
});

// ---------------------------------------------------------------------------
// Helpers for Enriching Workspaces & Projects (Threads)
// ---------------------------------------------------------------------------
function enrichWorkspace(row: WorkspaceRow | undefined): WorkspaceDTO | null {
  if (!row) return null;
  return toWorkspaceDTO(
    row,
    previewManager.isRunning(row.id),
    piManager.getWorkspaceBuildState(row.id),
  );
}

function enrichProject(row: ReturnType<typeof dbStore.getProject>): ProjectDTO | null {
  if (!row) return null;
  const ws = row.workspace_id ? dbStore.getWorkspace(row.workspace_id) : undefined;
  const summary = piManager.getActiveSummary(row.id);
  const chatSnap = activeChatRuns.get(row.id);
  const base = toProjectDTO(
    row,
    ws ? previewManager.isRunning(ws.id) : false,
    ws?.name ?? null,
  );
  return {
    ...base,
    status: summary.isBuilding ? (summary.queued ? 'queued' : 'building') : base.status,
    activeStep: summary.isBuilding
      ? summary.activeStep
      : chatSnap
        ? 'AI 正在回复...'
        : null,
    lastActivityAt: summary.isBuilding
      ? summary.lastActivityAt
      : chatSnap
        ? chatSnap.lastActivityAt
        : null,
  };
}

function assertOwnedWorkspace(req: AuthenticatedRequest, workspaceId: string) {
  const row = dbStore.getWorkspace(workspaceId);
  if (!row || row.owner !== req.user?.username) {
    return null;
  }
  return row;
}

function assertOwnedProject(req: AuthenticatedRequest, projectId: string) {
  const row = dbStore.getProject(projectId);
  if (!row || row.owner !== req.user?.username) {
    return null;
  }
  return row;
}

async function ensureBoundWorkspaceForProject(
  projectId: string,
  owner: string,
  preferredName?: string,
  presetId?: string,
): Promise<{ workspace: WorkspaceRow; created: boolean }> {
  const proj = dbStore.getProject(projectId);
  if (!proj) throw new Error('Project not found');
  if (proj.workspace_id) {
    const existing = dbStore.getWorkspace(proj.workspace_id);
    if (existing) {
      const { created } = await previewManager.ensureWorkspace(existing.id, existing.preset_id);
      return { workspace: existing, created };
    }
  }
  const resolvedPreset = pluginRegistry.getPreset(presetId || proj.preset_id).manifest.id;
  const wsName = (preferredName || proj.title || '新代码仓库').trim().slice(0, 40);
  const ws = dbStore.createWorkspace(owner, wsName, resolvedPreset);
  await previewManager.ensureWorkspace(ws.id, ws.preset_id);
  dbStore.updateProject(projectId, { workspaceId: ws.id });
  const wsDto = enrichWorkspace(ws)!;
  eventBus.emitUser(owner, { type: 'workspace_updated', workspace: wsDto });
  return { workspace: ws, created: true };
}

// ---------------------------------------------------------------------------
// User-level Global SSE Stream (Sidebar & Cross-Workspace Realtime Sync)
// ---------------------------------------------------------------------------
app.get('/api/events', requireAuth, (req: AuthenticatedRequest, res) => {
  const username = req.user!.username;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const unsubscribe = eventBus.subscribeUser(username, res);
  res.write(`data: ${JSON.stringify({ type: 'user_connected', username })}\n\n`);

  req.on('close', () => {
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// First-Class Workspace (Code Repo) APIs
// ---------------------------------------------------------------------------
app.get('/api/workspaces', requireAuth, (req: AuthenticatedRequest, res) => {
  const rows = dbStore.listWorkspaces(req.user!.username);
  res.json({
    workspaces: rows.map((r) => enrichWorkspace(r)!),
  });
});

app.post('/api/workspaces', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { name, presetId } = (req.body || {}) as { name?: string; presetId?: string };
  const resolvedPreset = pluginRegistry.getPreset(presetId).manifest.id;
  const wsName = (name || '新代码项目').trim().slice(0, 40);
  try {
    const ws = dbStore.createWorkspace(req.user!.username, wsName, resolvedPreset);
    await previewManager.ensureWorkspace(ws.id, ws.preset_id);
    const dto = enrichWorkspace(ws)!;
    eventBus.emitUser(req.user!.username, { type: 'workspace_updated', workspace: dto });
    res.status(201).json({ workspace: dto });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch('/api/workspaces/:wsId', requireAuth, (req: AuthenticatedRequest, res) => {
  const ws = assertOwnedWorkspace(req, String(req.params.wsId));
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const { name } = (req.body || {}) as { name?: string };
  const cleanName = (name || '').trim().slice(0, 40);
  if (!cleanName) {
    res.status(400).json({ error: 'Workspace name is required' });
    return;
  }
  const updated = dbStore.updateWorkspace(ws.id, { name: cleanName })!;
  const dto = enrichWorkspace(updated)!;
  eventBus.emitUser(ws.owner, { type: 'workspace_updated', workspace: dto });
  for (const proj of dbStore.listProjectsByWorkspace(ws.id)) {
    const pdto = enrichProject(proj)!;
    eventBus.emit(proj.id, { type: 'project_updated', project: pdto });
    eventBus.emitUser(ws.owner, { type: 'project_updated', project: pdto });
  }
  res.json({ workspace: dto });
});

app.delete('/api/workspaces/:wsId', requireAuth, (req: AuthenticatedRequest, res) => {
  const ws = assertOwnedWorkspace(req, String(req.params.wsId));
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const linkedProjects = dbStore.listProjectsByWorkspace(ws.id);
  piManager.abortWorkspace(ws.id);
  previewManager.deleteWorkspace(ws.owner, ws.id);
  dbStore.deleteWorkspace(ws.id);
  eventBus.emitUser(ws.owner, { type: 'workspace_deleted', workspaceId: ws.id });
  for (const proj of linkedProjects) {
    const latest = dbStore.getProject(proj.id);
    if (latest) {
      const pdto = enrichProject(latest)!;
      eventBus.emit(proj.id, { type: 'project_updated', project: pdto });
      eventBus.emitUser(ws.owner, { type: 'project_updated', project: pdto });
    }
  }
  res.json({ ok: true });
});

app.get('/api/workspaces/:wsId/files', requireAuth, (req: AuthenticatedRequest, res) => {
  const ws = assertOwnedWorkspace(req, String(req.params.wsId));
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  res.json({ files: previewManager.listFiles(ws.id) });
});

app.get('/api/workspaces/:wsId/file', requireAuth, (req: AuthenticatedRequest, res) => {
  const ws = assertOwnedWorkspace(req, String(req.params.wsId));
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const filePath = String(req.query.path || '');
  if (!filePath) {
    res.status(400).json({ error: 'Missing path query' });
    return;
  }
  try {
    res.json(previewManager.readFile(ws.id, filePath));
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'File not found' });
  }
});

app.put('/api/workspaces/:wsId/file', requireAuth, (req: AuthenticatedRequest, res) => {
  const ws = assertOwnedWorkspace(req, String(req.params.wsId));
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const { path: filePath, content } = (req.body || {}) as { path?: string; content?: string };
  if (!filePath || typeof content !== 'string') {
    res.status(400).json({ error: 'path and content are required' });
    return;
  }
  try {
    const saved = previewManager.writeFile(ws.id, filePath, content);
    res.json({ ok: true, ...saved });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/workspaces/:wsId/files/create', requireAuth, (req: AuthenticatedRequest, res) => {
  const ws = assertOwnedWorkspace(req, String(req.params.wsId));
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const { path: filePath, type } = (req.body || {}) as { path?: string; type?: 'file' | 'dir' };
  if (!filePath || (type !== 'file' && type !== 'dir')) {
    res.status(400).json({ error: 'path and type ("file" | "dir") are required' });
    return;
  }
  try {
    const created = previewManager.createEntry(ws.id, filePath, type);
    res.status(201).json({ ok: true, ...created });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/workspaces/:wsId/file', requireAuth, (req: AuthenticatedRequest, res) => {
  const ws = assertOwnedWorkspace(req, String(req.params.wsId));
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const filePath = String(req.query.path || '');
  if (!filePath) {
    res.status(400).json({ error: 'Missing path query' });
    return;
  }
  try {
    const deleted = previewManager.deleteEntry(ws.id, filePath);
    res.json({ ok: true, ...deleted });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/workspaces/:wsId/tables', requireAuth, (req: AuthenticatedRequest, res) => {
  const ws = assertOwnedWorkspace(req, String(req.params.wsId));
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const prefix = buildTablePrefix(ws.owner, ws.id);
  const preset = pluginRegistry.listPresets().find((p) => p.id === ws.preset_id);
  const tables = dbProxy.listTables({ owner: ws.owner, projectId: ws.id, prefix });
  res.json({ prefix, preset, tables });
});

app.get('/api/workspaces/:wsId/tables/:table/rows', requireAuth, (req: AuthenticatedRequest, res) => {
  const ws = assertOwnedWorkspace(req, String(req.params.wsId));
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const prefix = buildTablePrefix(ws.owner, ws.id);
  try {
    const data = dbProxy.previewTableRows(
      { owner: ws.owner, projectId: ws.id, prefix },
      String(req.params.table || ''),
      Number(req.query.limit || 30),
    );
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/workspaces/:wsId/logs', requireAuth, (req: AuthenticatedRequest, res) => {
  const ws = assertOwnedWorkspace(req, String(req.params.wsId));
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  res.json(previewManager.getLogs(ws.owner, ws.id));
});

app.post('/api/workspaces/:wsId/preview/restart', requireAuth, async (req: AuthenticatedRequest, res) => {
  const ws = assertOwnedWorkspace(req, String(req.params.wsId));
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  try {
    const previewUrl = await previewManager.restartApp(
      ws.id,
      { owner: ws.owner, presetId: ws.preset_id },
      true,
    );
    for (const proj of dbStore.listProjectsByWorkspace(ws.id)) {
      eventBus.emit(proj.id, { type: 'preview_ready', projectId: proj.id, previewUrl });
    }
    const wsDto = enrichWorkspace(ws)!;
    eventBus.emitUser(ws.owner, { type: 'workspace_updated', workspace: wsDto });
    res.json({ ok: true, previewUrl });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// Protected Project (Conversation Thread) & Agent API Routes
// ---------------------------------------------------------------------------
app.get('/api/projects', requireAuth, (req: AuthenticatedRequest, res) => {
  const rows = dbStore.listProjects(req.user!.username);
  res.json({
    projects: rows.map((r) => enrichProject(r)!),
  });
});

app.post('/api/projects', requireAuth, (req: AuthenticatedRequest, res) => {
  const { title, presetId, workspaceId } = (req.body || {}) as {
    title?: string;
    presetId?: string;
    workspaceId?: string | null;
  };

  let boundWsId: string | null = null;
  let resolvedPreset = pluginRegistry.getPreset(presetId).manifest.id;
  if (workspaceId) {
    const ws = assertOwnedWorkspace(req, workspaceId);
    if (!ws) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    boundWsId = ws.id;
    resolvedPreset = ws.preset_id;
  }

  const row = dbStore.createProject(
    req.user!.username,
    (title || '新对话').trim().slice(0, 40),
    resolvedPreset,
    boundWsId,
  );
  const dto = enrichProject(row)!;
  eventBus.emitUser(req.user!.username, { type: 'project_updated', project: dto });
  res.status(201).json({ project: dto });
});

app.get('/api/projects/:id', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const messages = dbStore.listMessages(row.id);
  res.json({
    project: enrichProject(row),
    messages,
    isBuilding: piManager.isRunning(row.id),
    activeRun: getActiveRunSnapshot(row.id),
  });
});

app.delete('/api/projects/:id', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  activeChatRuns.delete(row.id);
  piManager.abort(row.id);
  // Deleting a conversation thread NEVER deletes the shared Workspace repo & DB tables
  dbStore.deleteProject(row.id);
  eventBus.emitUser(row.owner, { type: 'project_deleted', projectId: row.id });
  res.json({ ok: true });
});

app.post('/api/projects/:id/bind-workspace', requireAuth, async (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const { workspaceId, createNew, name } = (req.body || {}) as {
    workspaceId?: string;
    createNew?: boolean;
    name?: string;
  };

  try {
    let targetWs: WorkspaceRow;
    if (createNew || !workspaceId) {
      const wsName = (name || (row.title !== '新对话' ? row.title : '新代码项目')).trim().slice(0, 40);
      targetWs = dbStore.createWorkspace(row.owner, wsName, row.preset_id);
      await previewManager.ensureWorkspace(targetWs.id, targetWs.preset_id);
    } else {
      const found = assertOwnedWorkspace(req, workspaceId);
      if (!found) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }
      targetWs = found;
      await previewManager.ensureWorkspace(targetWs.id, targetWs.preset_id);
    }

    const updated = dbStore.updateProject(row.id, { workspaceId: targetWs.id })!;
    const projDto = enrichProject(updated)!;
    const wsDto = enrichWorkspace(targetWs)!;
    eventBus.emit(row.id, { type: 'project_updated', project: projDto });
    eventBus.emitUser(row.owner, { type: 'workspace_updated', workspace: wsDto });
    eventBus.emitUser(row.owner, { type: 'project_updated', project: projDto });
    res.json({ ok: true, project: projDto, workspace: wsDto });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/projects/:id/events', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const unsubscribe = eventBus.subscribe(row.id, res);
  res.write(
    `data: ${JSON.stringify({
      type: 'connected',
      projectId: row.id,
      isBuilding: piManager.isRunning(row.id),
      activeRun: getActiveRunSnapshot(row.id),
      seq: eventBus.getSeq(row.id),
      ts: Date.now(),
    })}\n\n`,
  );

  req.on('close', () => {
    unsubscribe();
  });
});

app.post('/api/projects/:id/messages', requireAuth, async (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const { content, forceBuild } = (req.body || {}) as { content?: string; forceBuild?: boolean };
  const text = (content || '').trim();
  if (!text) {
    res.status(400).json({ error: 'Message content is required' });
    return;
  }

  const historyBefore = dbStore.listMessages(row.id);
  const userMsg = dbStore.addMessage(row.id, 'user', text);
  eventBus.emit(row.id, { type: 'message_created', message: userMsg });

  const isFirstTurn = historyBefore.length === 0;

  // If this thread is already running or queued, steer / append directly
  if (piManager.isRunning(row.id) && row.workspace_id) {
    const ws = dbStore.getWorkspace(row.workspace_id);
    if (ws) {
      try {
        const workspaceDir = previewManager.getWorkspaceDir(ws.id);
        const appCtx = { owner: ws.owner, presetId: ws.preset_id };
        const result = await piManager.startOrSteer({
          owner: row.owner,
          projectId: row.id,
          workspaceId: ws.id,
          presetId: ws.preset_id,
          workspaceDir,
          userMessage: text,
          history: historyBefore,
          isInitialBuild: false,
          onSettled: async (wsId) => previewManager.restartApp(wsId, appCtx, true),
        });
        res.json({ mode: result.mode, userMessage: userMsg, runId: result.runId, messageId: result.messageId });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
  }

  const hasWs = Boolean(row.workspace_id);

  const decision = forceBuild
    ? { intent: 'build' as const, title: undefined, reason: 'explicit_button' }
    : await classifyIntent(historyBefore, text, hasWs);

  let currentTitle = row.title;
  if (isFirstTurn || row.title === '新对话') {
    const newTitle = decision.title || deriveFallbackTitle(text);
    currentTitle = newTitle;
    const updated = dbStore.updateProject(row.id, { title: newTitle });
    if (updated) {
      const dto = enrichProject(updated)!;
      eventBus.emit(row.id, { type: 'project_updated', project: dto });
      eventBus.emitUser(row.owner, { type: 'project_updated', project: dto });
    }
  }

  if (decision.intent === 'build') {
    try {
      const { workspace, created } = await ensureBoundWorkspaceForProject(
        row.id,
        row.owner,
        currentTitle,
        row.preset_id,
      );
      const workspaceDir = previewManager.getWorkspaceDir(workspace.id);
      const appCtx = { owner: workspace.owner, presetId: workspace.preset_id };
      const result = await piManager.startOrSteer({
        owner: row.owner,
        projectId: row.id,
        workspaceId: workspace.id,
        presetId: workspace.preset_id,
        workspaceDir,
        userMessage: text,
        history: historyBefore,
        isInitialBuild: created || !hasWs,
        onSettled: async (wsId) => previewManager.restartApp(wsId, appCtx, true),
      });
      res.json({
        mode: result.mode === 'queued' ? 'queued' : 'build',
        userMessage: userMsg,
        runId: result.runId,
        messageId: result.messageId,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const failMsg = dbStore.addMessage(row.id, 'assistant', `无法启动构建 Agent：${errMsg}`, {
        mode: 'build',
        error: errMsg,
      });
      eventBus.emit(row.id, { type: 'message_created', message: failMsg });
      res.status(400).json({ error: errMsg });
    }
    return;
  }

  const assistantMsgId = generateId('msg');
  res.json({ mode: 'chat', userMessage: userMsg, messageId: assistantMsgId });

  void (async () => {
    const startedAt = Date.now();
    const startSeq = eventBus.emit(row.id, { type: 'chat_start', messageId: assistantMsgId, startedAt });
    const chatRun: ActiveRunSnapshot = {
      messageId: assistantMsgId,
      mode: 'chat',
      startedAt,
      lastActivityAt: startedAt,
      thinking: '',
      text: '',
      steps: [],
      seq: startSeq,
    };
    activeChatRuns.set(row.id, chatRun);
    eventBus.emitUser(row.owner, {
      type: 'project_activity',
      projectId: row.id,
      status: row.status,
      isBuilding: false,
      activeStep: 'AI 正在回复...',
      startedAt,
      lastActivityAt: startedAt,
    });
    try {
      const { text: replyText, suggestBuild } = await streamChatReply(historyBefore, text, (delta) => {
        chatRun.text += delta;
        chatRun.lastActivityAt = Date.now();
        chatRun.seq = eventBus.emit(row.id, { type: 'chat_delta', messageId: assistantMsgId, delta });
      });
      const saved = dbStore.addMessage(row.id, 'assistant', replyText, { mode: 'chat' }, assistantMsgId);
      activeChatRuns.delete(row.id);
      eventBus.emit(row.id, { type: 'chat_done', message: saved, suggestBuild });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const saved = dbStore.addMessage(
        row.id,
        'assistant',
        `对话请求失败：${errMsg}`,
        { mode: 'chat', error: errMsg },
        assistantMsgId,
      );
      activeChatRuns.delete(row.id);
      eventBus.emit(row.id, { type: 'chat_done', message: saved, suggestBuild: false });
    } finally {
      activeChatRuns.delete(row.id);
      const latest = dbStore.getProject(row.id);
      if (latest) {
        eventBus.emitUser(row.owner, { type: 'project_updated', project: enrichProject(latest)! });
      }
    }
  })();
});

app.post('/api/projects/:id/abort', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const aborted = piManager.abort(row.id);
  res.json({ ok: aborted });
});

// Backwards-compatible project-scoped workspace endpoints (delegate to bound workspaceId)
app.post('/api/projects/:id/workspace/init', requireAuth, async (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  try {
    const { workspace } = await ensureBoundWorkspaceForProject(row.id, row.owner, row.title, row.preset_id);
    const updated = dbStore.getProject(row.id)!;
    const dto = enrichProject(updated)!;
    const wsDto = enrichWorkspace(workspace)!;
    eventBus.emit(row.id, { type: 'project_updated', project: dto });
    eventBus.emitUser(row.owner, { type: 'project_updated', project: dto });
    res.json({ ok: true, project: dto, workspace: wsDto });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/projects/:id/files', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  if (!row.workspace_id) {
    res.json({ files: [] });
    return;
  }
  res.json({ files: previewManager.listFiles(row.workspace_id) });
});

app.get('/api/projects/:id/file', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row || !row.workspace_id) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const filePath = String(req.query.path || '');
  if (!filePath) {
    res.status(400).json({ error: 'Missing path query' });
    return;
  }
  try {
    res.json(previewManager.readFile(row.workspace_id, filePath));
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'File not found' });
  }
});

app.put('/api/projects/:id/file', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row || !row.workspace_id) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const { path: filePath, content } = (req.body || {}) as { path?: string; content?: string };
  if (!filePath || typeof content !== 'string') {
    res.status(400).json({ error: 'path and content are required' });
    return;
  }
  try {
    const saved = previewManager.writeFile(row.workspace_id, filePath, content);
    res.json({ ok: true, ...saved });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/projects/:id/files/create', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row || !row.workspace_id) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const { path: filePath, type } = (req.body || {}) as { path?: string; type?: 'file' | 'dir' };
  if (!filePath || (type !== 'file' && type !== 'dir')) {
    res.status(400).json({ error: 'path and type ("file" | "dir") are required' });
    return;
  }
  try {
    const created = previewManager.createEntry(row.workspace_id, filePath, type);
    res.status(201).json({ ok: true, ...created });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/projects/:id/file', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row || !row.workspace_id) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const filePath = String(req.query.path || '');
  if (!filePath) {
    res.status(400).json({ error: 'Missing path query' });
    return;
  }
  try {
    const deleted = previewManager.deleteEntry(row.workspace_id, filePath);
    res.json({ ok: true, ...deleted });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/projects/:id/tables', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const targetId = row.workspace_id || row.id;
  const prefix = buildTablePrefix(row.owner, targetId);
  const preset = pluginRegistry.listPresets().find((p) => p.id === row.preset_id);
  const tables = dbProxy.listTables({ owner: row.owner, projectId: targetId, prefix });
  res.json({ prefix, preset, tables });
});

app.get('/api/projects/:id/tables/:table/rows', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const targetId = row.workspace_id || row.id;
  const prefix = buildTablePrefix(row.owner, targetId);
  try {
    const data = dbProxy.previewTableRows(
      { owner: row.owner, projectId: targetId, prefix },
      String(req.params.table || ''),
      Number(req.query.limit || 30),
    );
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/projects/:id/logs', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const targetId = row.workspace_id || row.id;
  res.json(previewManager.getLogs(row.owner, targetId));
});

app.post('/api/projects/:id/preview/restart', requireAuth, async (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row || !row.workspace_id) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  const ws = dbStore.getWorkspace(row.workspace_id);
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  try {
    const previewUrl = await previewManager.restartApp(
      ws.id,
      { owner: ws.owner, presetId: ws.preset_id },
      true,
    );
    for (const proj of dbStore.listProjectsByWorkspace(ws.id)) {
      eventBus.emit(proj.id, { type: 'preview_ready', projectId: proj.id, previewUrl });
    }
    res.json({ ok: true, previewUrl });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// Production Static Web UI
// ---------------------------------------------------------------------------
if (fs.existsSync(config.webDistDir)) {
  app.use(express.static(config.webDistDir));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/preview/')) {
      return next();
    }
    res.sendFile(path.join(config.webDistDir, 'index.html'));
  });
}

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[atoms-server] listening on http://0.0.0.0:${config.port}`);
  console.log(
    `[atoms-server] GLM endpoint=${config.glmBaseUrl} model=${config.glmModel} keyConfigured=${Boolean(config.glmApiKey)}`,
  );
  console.log(
    `[atoms-server] Loaded presets=${pluginRegistry.listPresets().map((p) => p.id).join(', ')} plugins=${pluginRegistry.listPlugins().map((p) => p.id).join(', ')}`,
  );
  console.log(`[atoms-server] Demo users loaded: ${[...config.demoUsers.keys()].join(', ')}`);
});

lspManager.attach(server);

function gracefulShutdown(signal: string): void {
  console.log(`[atoms-server] received ${signal}, shutting down...`);
  lspManager.shutdownAll();
  piManager.shutdownAll();
  previewManager.shutdownAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
