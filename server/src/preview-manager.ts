import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Request, Response } from 'express';
import type { FileTreeNode } from '@atoms/shared';
import { config, ensureDataDirs } from './config.js';
import { dbProxy } from './db-proxy.js';
import { pluginRegistry } from './plugin-registry.js';

const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{3,64}$/;
const IGNORED_DIRS = new Set(['node_modules', '.git', '.pi-sessions', '.pi-agent', 'dist']);

interface RunningApp {
  projectId: string;
  port: number;
  child: ChildProcess;
  logs: string[];
  lastAccessedAt: number;
  startedAt: number;
}

export interface PreviewAppContext {
  owner: string;
  presetId?: string;
}

function assertValidProjectId(projectId: string): void {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error('Invalid projectId');
  }
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-8000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Command timed out: ${cmd} ${args.join(' ')}`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, '127.0.0.1');
  });
}

async function waitForHealth(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (resp.ok) return;
      lastErr = `HTTP ${resp.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error(`应用健康检查超时 (${lastErr})`);
}

class PreviewManager {
  private running = new Map<string, RunningApp>();
  private starting = new Map<string, Promise<RunningApp>>();
  private usedPorts = new Set<number>();
  private lastBuildLogs = new Map<string, string[]>();
  private sweeperTimer: NodeJS.Timeout;

  constructor() {
    this.sweeperTimer = setInterval(() => {
      const now = Date.now();
      for (const [projectId, app] of this.running.entries()) {
        if (now - app.lastAccessedAt > config.previewIdleTtlMs) {
          this.stopApp(projectId);
        }
      }
    }, 120_000);
    this.sweeperTimer.unref();
  }

  getWorkspaceDir(projectId: string): string {
    assertValidProjectId(projectId);
    ensureDataDirs();
    return path.join(config.workspacesDir, projectId);
  }

  hasWorkspace(projectId: string): boolean {
    if (!PROJECT_ID_RE.test(projectId)) return false;
    const dir = path.join(config.workspacesDir, projectId);
    return fs.existsSync(path.join(dir, 'package.json'));
  }

  isRunning(projectId: string): boolean {
    return this.running.has(projectId);
  }

  async ensureWorkspace(
    projectId: string,
    presetId?: string,
  ): Promise<{ workspaceDir: string; created: boolean }> {
    const workspaceDir = this.getWorkspaceDir(projectId);
    if (fs.existsSync(path.join(workspaceDir, 'package.json'))) {
      return { workspaceDir, created: false };
    }

    const preset = pluginRegistry.getPreset(presetId);
    const templateDir = preset.templateDirAbs;

    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.cpSync(templateDir, workspaceDir, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(templateDir, src);
        if (!rel) return true;
        if (rel === 'dist' || rel.startsWith(`dist${path.sep}`)) return false;
        if (rel === 'data' || rel.startsWith(`data${path.sep}`)) return false;
        return true;
      },
    });

    if (!fs.existsSync(path.join(workspaceDir, 'node_modules'))) {
      const res = await runCommand('npm', ['install', '--no-audit', '--no-fund'], workspaceDir, 180_000);
      if (res.code !== 0) {
        throw new Error(`工作区依赖安装失败:\n${res.output.slice(-800)}`);
      }
    }

    return { workspaceDir, created: true };
  }

  private async allocatePort(): Promise<number> {
    for (let port = config.previewPortStart; port <= config.previewPortEnd; port++) {
      if (!this.usedPorts.has(port) && (await isPortFree(port))) {
        this.usedPorts.add(port);
        return port;
      }
    }
    let oldest: RunningApp | null = null;
    for (const app of this.running.values()) {
      if (!oldest || app.lastAccessedAt < oldest.lastAccessedAt) {
        oldest = app;
      }
    }
    if (oldest) {
      const reclaimed = oldest.port;
      this.stopApp(oldest.projectId);
      this.usedPorts.add(reclaimed);
      return reclaimed;
    }
    throw new Error('预览端口池已耗尽');
  }

  stopApp(projectId: string): void {
    const app = this.running.get(projectId);
    if (!app) return;
    this.running.delete(projectId);
    this.usedPorts.delete(app.port);
    try {
      app.child.kill('SIGTERM');
      setTimeout(() => {
        if (!app.child.killed) app.child.kill('SIGKILL');
      }, 2000).unref();
    } catch {
      // ignore
    }
  }

  deleteWorkspace(owner: string, projectId: string): void {
    this.stopApp(projectId);
    this.lastBuildLogs.delete(projectId);
    dbProxy.dropProjectTables(owner, projectId);
    if (!PROJECT_ID_RE.test(projectId)) return;
    const dir = path.join(config.workspacesDir, projectId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async restartApp(projectId: string, ctx: PreviewAppContext, forceBuild = true): Promise<string> {
    this.stopApp(projectId);
    const app = await this.ensureAppRunning(projectId, ctx, forceBuild);
    return `/preview/${app.projectId}/`;
  }

  async ensureAppRunning(
    projectId: string,
    ctx: PreviewAppContext,
    forceBuild = false,
  ): Promise<RunningApp> {
    assertValidProjectId(projectId);
    const existing = this.running.get(projectId);
    if (existing && !forceBuild) {
      existing.lastAccessedAt = Date.now();
      return existing;
    }

    const inflight = this.starting.get(projectId);
    if (inflight && !forceBuild) {
      return inflight;
    }

    const promise = this.startInternal(projectId, ctx, forceBuild).finally(() => {
      this.starting.delete(projectId);
    });
    this.starting.set(projectId, promise);
    return promise;
  }

  private async startInternal(
    projectId: string,
    ctx: PreviewAppContext,
    forceBuild: boolean,
  ): Promise<RunningApp> {
    const workspaceDir = this.getWorkspaceDir(projectId);
    if (!fs.existsSync(path.join(workspaceDir, 'package.json'))) {
      throw new Error('项目尚未构建代码');
    }

    const logs: string[] = [];
    const pushLog = (line: string) => {
      for (const l of line.split(/\r?\n/)) {
        if (!l.trim()) continue;
        logs.push(l);
        if (logs.length > 250) logs.shift();
      }
    };

    if (!fs.existsSync(path.join(workspaceDir, 'node_modules'))) {
      pushLog('[platform] installing dependencies...');
      const inst = await runCommand('npm', ['install', '--no-audit', '--no-fund'], workspaceDir, 180_000);
      pushLog(inst.output);
      if (inst.code !== 0) {
        this.lastBuildLogs.set(projectId, logs);
        throw new Error(`npm install 失败:\n${inst.output.slice(-600)}`);
      }
    }

    const distIndex = path.join(workspaceDir, 'dist', 'index.html');
    if (forceBuild || !fs.existsSync(distIndex)) {
      pushLog('[platform] running npm run build...');
      const buildRes = await runCommand('npm', ['run', 'build'], workspaceDir, 120_000);
      pushLog(buildRes.output);
      if (buildRes.code !== 0) {
        this.lastBuildLogs.set(projectId, logs);
        throw new Error(`前端构建失败 (npm run build):\n${buildRes.output.slice(-600)}`);
      }
    }

    const serverEntry = path.join(workspaceDir, 'server', 'index.js');
    if (!fs.existsSync(serverEntry)) {
      this.lastBuildLogs.set(projectId, logs);
      throw new Error('缺少后端入口文件 server/index.js');
    }

    const port = await this.allocatePort();
    const pluginRuntimeEnv = pluginRegistry.buildProjectRuntimeEnv(
      ctx.owner,
      projectId,
      ctx.presetId,
    );

    pushLog(
      `[platform] starting app server on 127.0.0.1:${port} (db-proxy prefix: ${pluginRuntimeEnv.ATOMS_DB_PREFIX || 'none'})`,
    );

    const child = spawn(process.execPath, [serverEntry], {
      cwd: workspaceDir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: 'production',
        PORT: String(port),
        ...pluginRuntimeEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const app: RunningApp = {
      projectId,
      port,
      child,
      logs,
      startedAt: Date.now(),
      lastAccessedAt: Date.now(),
    };

    child.stdout?.on('data', (d: Buffer) => pushLog(d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => pushLog(d.toString('utf8')));

    child.on('exit', (code, signal) => {
      pushLog(`[platform] app process exited (code=${code}, signal=${signal})`);
      this.lastBuildLogs.set(projectId, [...logs]);
      if (this.running.get(projectId) === app) {
        this.running.delete(projectId);
        this.usedPorts.delete(port);
      }
    });

    this.running.set(projectId, app);

    try {
      await waitForHealth(port, 15_000);
      this.lastBuildLogs.set(projectId, logs);
      return app;
    } catch (err) {
      this.lastBuildLogs.set(projectId, [...logs]);
      this.stopApp(projectId);
      const tail = logs.slice(-15).join('\n');
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${reason}${tail ? `\n--- App Logs ---\n${tail}` : ''}`);
    }
  }

  getLogs(
    owner: string,
    projectId: string,
  ): { running: boolean; port: number | null; logs: string[]; hasDb: boolean; tableCount: number } {
    assertValidProjectId(projectId);
    const app = this.running.get(projectId);
    const tables = dbProxy.listTables({
      owner,
      projectId,
      prefix: pluginRegistry.buildProjectRuntimeEnv(owner, projectId).ATOMS_DB_PREFIX || '',
    });
    return {
      running: Boolean(app),
      port: app?.port ?? null,
      logs: app ? app.logs : this.lastBuildLogs.get(projectId) || [],
      hasDb: tables.length > 0,
      tableCount: tables.length,
    };
  }

  listFiles(projectId: string): FileTreeNode[] {
    const root = this.getWorkspaceDir(projectId);
    if (!fs.existsSync(root)) return [];

    const walk = (dir: string, relBase: string): FileTreeNode[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const nodes: FileTreeNode[] = [];
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (entry.name.endsWith('.db-shm') || entry.name.endsWith('.db-wal')) continue;
        const full = path.join(dir, entry.name);
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          nodes.push({
            name: entry.name,
            path: rel,
            type: 'dir',
            children: walk(full, rel),
          });
        } else {
          nodes.push({
            name: entry.name,
            path: rel,
            type: 'file',
          });
        }
      }
      nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return nodes;
    };

    return walk(root, '');
  }

  private resolveEditablePath(projectId: string, relPath: string): { root: string; cleaned: string; full: string } {
    const root = this.getWorkspaceDir(projectId);
    const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!cleaned || cleaned === '.' || cleaned.includes('\0')) {
      throw new Error('无效的文件路径');
    }
    const firstSeg = cleaned.split('/')[0];
    if (
      firstSeg === '.pi-agent' ||
      firstSeg === '.pi-sessions' ||
      firstSeg === 'node_modules' ||
      firstSeg === '.git'
    ) {
      throw new Error('不允许访问或修改受保护的目录');
    }
    const full = path.resolve(root, cleaned);
    if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
      throw new Error('非法路径：禁止越界访问工作区以外的文件');
    }
    if (full === root) {
      throw new Error('不能直接操作工作区根目录');
    }
    return { root, cleaned, full };
  }

  readFile(projectId: string, relPath: string): { path: string; content: string; binary?: boolean } {
    const { cleaned, full } = this.resolveEditablePath(projectId, relPath);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      throw new Error('File not found');
    }
    const stat = fs.statSync(full);
    if (stat.size > 512 * 1024) {
      return {
        path: cleaned,
        content: `[File too large to preview: ${stat.size} bytes]`,
        binary: true,
      };
    }
    return {
      path: cleaned,
      content: fs.readFileSync(full, 'utf8'),
    };
  }

  writeFile(projectId: string, relPath: string, content: string): { path: string; bytes: number } {
    const { cleaned, full } = this.resolveEditablePath(projectId, relPath);
    if (typeof content !== 'string') {
      throw new Error('文件内容必须为字符串');
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > 2 * 1024 * 1024) {
      throw new Error('文件体积超过 2MB 限制');
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return { path: cleaned, bytes };
  }

  createEntry(projectId: string, relPath: string, type: 'file' | 'dir'): { path: string; type: 'file' | 'dir' } {
    const { cleaned, full } = this.resolveEditablePath(projectId, relPath);
    if (fs.existsSync(full)) {
      throw new Error(`路径已存在: ${cleaned}`);
    }
    if (type === 'dir') {
      fs.mkdirSync(full, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '', 'utf8');
    }
    return { path: cleaned, type };
  }

  deleteEntry(projectId: string, relPath: string): { path: string } {
    const { cleaned, full } = this.resolveEditablePath(projectId, relPath);
    if (cleaned === 'package.json') {
      throw new Error('不允许删除 package.json');
    }
    if (!fs.existsSync(full)) {
      throw new Error(`路径不存在: ${cleaned}`);
    }
    fs.rmSync(full, { recursive: true, force: true });
    return { path: cleaned };
  }

  async proxyRequest(
    req: Request,
    res: Response,
    projectId: string,
    ctx: PreviewAppContext,
    subPath: string,
  ): Promise<void> {
    if (!PROJECT_ID_RE.test(projectId)) {
      res.status(400).send('Invalid project ID');
      return;
    }

    if (!this.hasWorkspace(projectId)) {
      res.status(404).send('Project preview is not ready yet.');
      return;
    }

    let app: RunningApp;
    try {
      app = await this.ensureAppRunning(projectId, ctx, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).type('text/plain; charset=utf-8').send(`Preview failed to start:\n${msg}`);
      return;
    }

    const queryIdx = req.originalUrl.indexOf('?');
    const queryStr = queryIdx !== -1 ? req.originalUrl.slice(queryIdx) : '';
    const targetPath = `${subPath.startsWith('/') ? subPath : `/${subPath}`}${queryStr}`;

    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    headers.host = `127.0.0.1:${app.port}`;
    delete headers['accept-encoding'];

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: app.port,
        path: targetPath,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.status(proxyRes.statusCode || 502);
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (v !== undefined && k.toLowerCase() !== 'transfer-encoding') {
            res.setHeader(k, v);
          }
        }
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).send(`Preview proxy error: ${err.message}`);
      } else {
        res.end();
      }
    });

    req.pipe(proxyReq);
  }

  shutdownAll(): void {
    clearInterval(this.sweeperTimer);
    for (const projectId of [...this.running.keys()]) {
      this.stopApp(projectId);
    }
  }
}

export const previewManager = new PreviewManager();
