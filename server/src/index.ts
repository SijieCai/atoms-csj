import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { ActiveRunSnapshot, ProjectDTO } from '@atoms/shared';
import { config, ensureDataDirs } from './config.js';
import { dbStore, generateId, toProjectDTO } from './db.js';
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
    `[atoms-server] Recovered ${recoveredStale.length} stale building project(s): ${recoveredStale.map((r) => r.id).join(', ')}`,
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
// Public Preview Reverse Proxy (placed BEFORE express.json so raw bodies pipe)
// ---------------------------------------------------------------------------
app.use('/preview/:projectId', (req, res) => {
  const projectId = String(req.params.projectId || '');
  const urlWithoutQuery = req.originalUrl.split('?')[0];
  if (urlWithoutQuery === `/preview/${projectId}`) {
    const qIdx = req.originalUrl.indexOf('?');
    const qs = qIdx !== -1 ? req.originalUrl.slice(qIdx) : '';
    res.redirect(302, `/preview/${projectId}/${qs}`);
    return;
  }
  const project = dbStore.getProject(projectId);
  if (!project) {
    res.status(404).send('Project not found.');
    return;
  }
  const subPath = req.url || '/';
  void previewManager.proxyRequest(
    req,
    res,
    projectId,
    { owner: project.owner, presetId: project.preset_id },
    subPath,
  );
});

app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// Scoped DB Proxy API (authenticated via project-scoped Bearer token)
// Used by Pi's atoms_db MCP server AND generated app's server/db.js runtime SDK
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
// Protected Project & Agent API Routes
// ---------------------------------------------------------------------------
function enrichProject(row: ReturnType<typeof dbStore.getProject>): ProjectDTO | null {
  if (!row) return null;
  const hasWs = Boolean(row.has_workspace) || previewManager.hasWorkspace(row.id);
  const effectiveRow = hasWs !== Boolean(row.has_workspace) ? { ...row, has_workspace: 1 } : row;
  const summary = piManager.getActiveSummary(row.id);
  const chatSnap = activeChatRuns.get(row.id);
  const base = toProjectDTO(effectiveRow, previewManager.isRunning(row.id));
  return {
    ...base,
    status: summary.isBuilding ? 'building' : base.status,
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

function assertOwnedProject(req: AuthenticatedRequest, projectId: string) {
  const row = dbStore.getProject(projectId);
  if (!row || row.owner !== req.user?.username) {
    return null;
  }
  return row;
}

// User-level global SSE stream for real-time cross-project sidebar status & notifications
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

app.get('/api/projects', requireAuth, (req: AuthenticatedRequest, res) => {
  const rows = dbStore.listProjects(req.user!.username);
  res.json({
    projects: rows.map((r) => enrichProject(r)!),
  });
});

app.post('/api/projects', requireAuth, (req: AuthenticatedRequest, res) => {
  const { title, presetId } = (req.body || {}) as { title?: string; presetId?: string };
  const resolvedPreset = pluginRegistry.getPreset(presetId).manifest.id;
  const row = dbStore.createProject(
    req.user!.username,
    (title || '新对话').trim().slice(0, 40),
    resolvedPreset,
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
  previewManager.deleteWorkspace(row.owner, row.id);
  dbStore.deleteProject(row.id);
  eventBus.emitUser(row.owner, { type: 'project_deleted', projectId: row.id });
  res.json({ ok: true });
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
  const appCtx = { owner: row.owner, presetId: row.preset_id };

  if (piManager.isRunning(row.id)) {
    try {
      const workspaceDir = previewManager.getWorkspaceDir(row.id);
      const result = await piManager.startOrSteer({
        owner: row.owner,
        projectId: row.id,
        presetId: row.preset_id,
        workspaceDir,
        userMessage: text,
        history: historyBefore,
        isInitialBuild: false,
        onSettled: async (pid) => previewManager.restartApp(pid, appCtx, true),
      });
      res.json({ mode: 'steered', userMessage: userMsg, runId: result.runId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  const hasWs = Boolean(row.has_workspace) || previewManager.hasWorkspace(row.id);

  const decision = forceBuild
    ? { intent: 'build' as const, title: undefined, reason: 'explicit_button' }
    : await classifyIntent(historyBefore, text, hasWs);

  if (isFirstTurn || row.title === '新对话') {
    const newTitle = decision.title || deriveFallbackTitle(text);
    const updated = dbStore.updateProject(row.id, { title: newTitle });
    if (updated) {
      const dto = enrichProject(updated)!;
      eventBus.emit(row.id, { type: 'project_updated', project: dto });
      eventBus.emitUser(row.owner, { type: 'project_updated', project: dto });
    }
  }

  if (decision.intent === 'build') {
    try {
      const { workspaceDir, created } = await previewManager.ensureWorkspace(row.id, row.preset_id);
      const result = await piManager.startOrSteer({
        owner: row.owner,
        projectId: row.id,
        presetId: row.preset_id,
        workspaceDir,
        userMessage: text,
        history: historyBefore,
        isInitialBuild: created || !hasWs,
        onSettled: async (pid) => previewManager.restartApp(pid, appCtx, true),
      });
      res.json({
        mode: 'build',
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

app.post('/api/projects/:id/workspace/init', requireAuth, async (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  try {
    await previewManager.ensureWorkspace(row.id, row.preset_id);
    const updated = dbStore.updateProject(row.id, { hasWorkspace: true });
    const dto = enrichProject(updated || row)!;
    eventBus.emit(row.id, { type: 'project_updated', project: dto });
    eventBus.emitUser(row.owner, { type: 'project_updated', project: dto });
    res.json({ ok: true, project: dto });
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
  res.json({ files: previewManager.listFiles(row.id) });
});

app.get('/api/projects/:id/file', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const filePath = String(req.query.path || '');
  if (!filePath) {
    res.status(400).json({ error: 'Missing path query' });
    return;
  }
  try {
    res.json(previewManager.readFile(row.id, filePath));
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'File not found' });
  }
});

app.put('/api/projects/:id/file', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const { path: filePath, content } = (req.body || {}) as { path?: string; content?: string };
  if (!filePath || typeof content !== 'string') {
    res.status(400).json({ error: 'path and content are required' });
    return;
  }
  try {
    const saved = previewManager.writeFile(row.id, filePath, content);
    res.json({ ok: true, ...saved });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/projects/:id/files/create', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const { path: filePath, type } = (req.body || {}) as { path?: string; type?: 'file' | 'dir' };
  if (!filePath || (type !== 'file' && type !== 'dir')) {
    res.status(400).json({ error: 'path and type ("file" | "dir") are required' });
    return;
  }
  try {
    const created = previewManager.createEntry(row.id, filePath, type);
    res.status(201).json({ ok: true, ...created });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/projects/:id/file', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const filePath = String(req.query.path || '');
  if (!filePath) {
    res.status(400).json({ error: 'Missing path query' });
    return;
  }
  try {
    const deleted = previewManager.deleteEntry(row.id, filePath);
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
  const prefix = buildTablePrefix(row.owner, row.id);
  const preset = pluginRegistry.listPresets().find((p) => p.id === row.preset_id);
  const tables = dbProxy.listTables({ owner: row.owner, projectId: row.id, prefix });
  res.json({ prefix, preset, tables });
});

app.get('/api/projects/:id/tables/:table/rows', requireAuth, (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const prefix = buildTablePrefix(row.owner, row.id);
  try {
    const data = dbProxy.previewTableRows(
      { owner: row.owner, projectId: row.id, prefix },
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
  res.json(previewManager.getLogs(row.owner, row.id));
});

app.post('/api/projects/:id/preview/restart', requireAuth, async (req: AuthenticatedRequest, res) => {
  const row = assertOwnedProject(req, String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  try {
    const previewUrl = await previewManager.restartApp(
      row.id,
      { owner: row.owner, presetId: row.preset_id },
      true,
    );
    eventBus.emit(row.id, { type: 'preview_ready', projectId: row.id, previewUrl });
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
