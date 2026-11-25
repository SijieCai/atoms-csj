import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from './config.js';
import { verifySessionToken } from './auth.js';
import { dbStore } from './db.js';
import { previewManager } from './preview-manager.js';

const VIRTUAL_ROOT_URI = 'file:///workspace';
const LSP_PATH_RE = /^\/api\/projects\/([a-zA-Z0-9_-]{3,64})\/lsp(?:\?.*)?$/;

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function resolveTsLspPaths(): { lspCli: string; tsserverPath: string } {
  const roots = [config.repoRoot, path.join(config.repoRoot, 'server')];
  let lspCli = '';
  let tsserverPath = '';

  for (const root of roots) {
    const candLsp = path.join(root, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs');
    if (!lspCli && fs.existsSync(candLsp)) lspCli = candLsp;
    const candTs = path.join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js');
    if (!tsserverPath && fs.existsSync(candTs)) tsserverPath = candTs;
  }

  if (!lspCli || !tsserverPath) {
    throw new Error('typescript-language-server 或 typescript 未安装，请先执行 npm install');
  }
  return { lspCli, tsserverPath };
}

function rewriteInboundUris(value: unknown, realRootUrl: string, realRootDir: string): unknown {
  if (typeof value === 'string') {
    if (value === VIRTUAL_ROOT_URI || value === `${VIRTUAL_ROOT_URI}/`) {
      return realRootUrl;
    }
    if (value.startsWith(`${VIRTUAL_ROOT_URI}/`)) {
      const relEncoded = value.slice(VIRTUAL_ROOT_URI.length + 1);
      const relDecoded = decodeURIComponent(relEncoded).replace(/\\/g, '/');
      const resolved = path.resolve(realRootDir, relDecoded);
      if (resolved !== realRootDir && !resolved.startsWith(`${realRootDir}${path.sep}`)) {
        throw new Error(`Forbidden LSP URI outside workspace: ${value}`);
      }
      return pathToFileURL(resolved).href;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteInboundUris(item, realRootUrl, realRootDir));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteInboundUris(v, realRootUrl, realRootDir);
    }
    return out;
  }
  return value;
}

function rewriteOutboundUris(value: unknown, realRootUrl: string, realRootDir: string): unknown {
  if (typeof value === 'string') {
    if (value === realRootUrl || value === `${realRootUrl}/`) {
      return VIRTUAL_ROOT_URI;
    }
    if (value.startsWith(`${realRootUrl}/`)) {
      const suffix = value.slice(realRootUrl.length);
      return `${VIRTUAL_ROOT_URI}${suffix}`;
    }
    if (value.startsWith('file://')) {
      try {
        const fsPath = fileURLToPath(value);
        if (fsPath === realRootDir || fsPath.startsWith(`${realRootDir}${path.sep}`)) {
          const rel = path.relative(realRootDir, fsPath).split(path.sep).join('/');
          return rel ? `${VIRTUAL_ROOT_URI}/${rel.split('/').map(encodeURIComponent).join('/')}` : VIRTUAL_ROOT_URI;
        }
      } catch {
        // ignore unparseable URI
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteOutboundUris(item, realRootUrl, realRootDir));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteOutboundUris(v, realRootUrl, realRootDir);
    }
    return out;
  }
  return value;
}

function writeLspFrame(child: ChildProcessWithoutNullStreams, payload: unknown): void {
  if (!child.stdin.writable) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  child.stdin.write(Buffer.concat([header, body]));
}

interface LspSession {
  projectId: string;
  ws: WebSocket;
  child: ChildProcessWithoutNullStreams;
}

class LspManager {
  private wss: WebSocketServer;
  private sessions = new Set<LspSession>();

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
  }

  attach(httpServer: http.Server): void {
    httpServer.on('upgrade', (req, socket, head) => {
      const urlStr = req.url || '';
      const match = urlStr.match(LSP_PATH_RE);
      if (!match) {
        return;
      }

      const projectId = match[1];
      const cookies = parseCookieHeader(req.headers.cookie);
      const username = verifySessionToken(cookies.atoms_session);
      if (!username) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const project = dbStore.getProject(projectId);
      if (!project || project.owner !== username) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      if (!previewManager.hasWorkspace(projectId)) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.startSession(projectId, ws);
      });
    });
  }

  private startSession(projectId: string, ws: WebSocket): void {
    let lspCli: string;
    let tsserverPath: string;
    try {
      const resolved = resolveTsLspPaths();
      lspCli = resolved.lspCli;
      tsserverPath = resolved.tsserverPath;
    } catch (err) {
      ws.close(1011, err instanceof Error ? err.message : 'LSP unavailable');
      return;
    }

    const workspaceDir = fs.realpathSync(previewManager.getWorkspaceDir(projectId));
    const realRootUrl = pathToFileURL(workspaceDir).href.replace(/\/+$/, '');

    const child = spawn(process.execPath, [lspCli, '--stdio'], {
      cwd: workspaceDir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: 'development',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const session: LspSession = { projectId, ws, child };
    this.sessions.add(session);

    // Byte-accurate LSP Content-Length framing parser (handles UTF-8 safely)
    let rxBuf = Buffer.alloc(0);
    const HEADER_SEP = Buffer.from('\r\n\r\n', 'ascii');

    child.stdout.on('data', (chunk: Buffer) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      while (true) {
        const sepIdx = rxBuf.indexOf(HEADER_SEP);
        if (sepIdx === -1) break;
        const headerText = rxBuf.subarray(0, sepIdx).toString('ascii');
        const lenMatch = headerText.match(/Content-Length:\s*(\d+)/i);
        if (!lenMatch) {
          rxBuf = rxBuf.subarray(sepIdx + 4);
          continue;
        }
        const contentLength = Number(lenMatch[1]);
        const bodyStart = sepIdx + 4;
        const bodyEnd = bodyStart + contentLength;
        if (rxBuf.length < bodyEnd) break;

        const jsonStr = rxBuf.subarray(bodyStart, bodyEnd).toString('utf8');
        rxBuf = rxBuf.subarray(bodyEnd);

        if (ws.readyState === ws.OPEN) {
          try {
            const parsed = JSON.parse(jsonStr);
            const rewritten = rewriteOutboundUris(parsed, realRootUrl, workspaceDir);
            ws.send(JSON.stringify(rewritten));
          } catch {
            // ignore malformed LSP frame
          }
        }
      }
    });

    child.stderr.on('data', () => {
      // suppress verbose tsserver stderr diagnostics
    });

    const cleanup = () => {
      if (!this.sessions.has(session)) return;
      this.sessions.delete(session);
      try {
        child.stdin.end();
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 1500).unref();
      } catch {
        // ignore
      }
      if (ws.readyState === ws.OPEN) {
        ws.close();
      }
    };

    ws.on('message', (data) => {
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const rewritten = rewriteInboundUris(parsed, realRootUrl, workspaceDir) as Record<string, unknown>;
        if (rewritten.method === 'initialize' && rewritten.params && typeof rewritten.params === 'object') {
          const p = rewritten.params as Record<string, unknown>;
          const initOpts = (p.initializationOptions && typeof p.initializationOptions === 'object'
            ? p.initializationOptions
            : {}) as Record<string, unknown>;
          p.initializationOptions = {
            ...initOpts,
            tsserver: {
              ...(initOpts.tsserver && typeof initOpts.tsserver === 'object'
                ? (initOpts.tsserver as Record<string, unknown>)
                : {}),
              path: tsserverPath,
            },
          };
        }
        writeLspFrame(child, rewritten);
      } catch (err) {
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32602, message: err instanceof Error ? err.message : 'Invalid LSP message' },
            }),
          );
        }
      }
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
    child.on('exit', cleanup);
    child.on('error', cleanup);
  }

  shutdownAll(): void {
    for (const s of [...this.sessions]) {
      try {
        s.child.kill('SIGTERM');
      } catch {
        // ignore
      }
      try {
        s.ws.close();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
  }
}

export const lspManager = new LspManager();
