export const VIRTUAL_ROOT_URI = 'file:///workspace';

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind?: string; value: string };
  insertText?: string;
  sortText?: string;
  filterText?: string;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspHoverResult {
  contents:
    | string
    | { kind?: string; value: string }
    | Array<string | { language?: string; value: string }>;
  range?: LspRange;
}

export type LspStatus = 'connecting' | 'connected' | 'disconnected';

export function toVirtualUri(relPath: string): string {
  const cleaned = relPath.replace(/^\/+/, '');
  return `${VIRTUAL_ROOT_URI}/${cleaned.split('/').map(encodeURIComponent).join('/')}`;
}

export function fromVirtualUri(uri: string): string | null {
  if (!uri.startsWith(`${VIRTUAL_ROOT_URI}/`)) return null;
  const rel = uri.slice(VIRTUAL_ROOT_URI.length + 1);
  return rel.split('/').map(decodeURIComponent).join('/');
}

export function detectLanguageId(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) return 'typescriptreact';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'typescript';
  if (lower.endsWith('.jsx')) return 'javascriptreact';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.md')) return 'markdown';
  if (lower.endsWith('.sql')) return 'sql';
  return 'plaintext';
}

export function toMonacoLanguage(filePath: string): string {
  const id = detectLanguageId(filePath);
  if (id === 'typescriptreact') return 'typescript';
  if (id === 'javascriptreact') return 'javascript';
  return id;
}

export function isLspSupportedFile(filePath: string): boolean {
  const id = detectLanguageId(filePath);
  return (
    id === 'javascript' ||
    id === 'javascriptreact' ||
    id === 'typescript' ||
    id === 'typescriptreact'
  );
}

interface PendingReq {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkspaceLspClient {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private pending = new Map<number, PendingReq>();
  private openVersions = new Map<string, number>();
  private initialized = false;
  private disposed = false;

  constructor(
    private workspaceId: string,
    private onStatus: (status: LspStatus) => void,
    private onDiagnostics: (relPath: string, diagnostics: LspDiagnostic[]) => void,
  ) {}

  connect(): void {
    if (this.disposed) return;
    this.onStatus('connecting');
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/api/workspaces/${encodeURIComponent(this.workspaceId)}/lsp`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      void this.performInitialize();
    };

    ws.onmessage = (evt) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(evt.data)) as Record<string, unknown>;
      } catch {
        return;
      }

      if (typeof msg.id === 'number' && !msg.method) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) {
            const errObj = msg.error as { message?: string };
            p.reject(new Error(errObj.message || 'LSP error'));
          } else {
            p.resolve(msg.result);
          }
        }
        return;
      }

      if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
        const params = msg.params as { uri?: string; diagnostics?: LspDiagnostic[] };
        if (params.uri) {
          const rel = fromVirtualUri(params.uri);
          if (rel) {
            this.onDiagnostics(rel, params.diagnostics || []);
          }
        }
      }
    };

    ws.onclose = () => {
      this.initialized = false;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('LSP disconnected'));
      }
      this.pending.clear();
      if (!this.disposed) {
        this.onStatus('disconnected');
      }
    };

    ws.onerror = () => {
      if (!this.disposed) {
        this.onStatus('disconnected');
      }
    };
  }

  private async performInitialize(): Promise<void> {
    try {
      await this.sendRequest('initialize', {
        processId: null,
        rootUri: VIRTUAL_ROOT_URI,
        workspaceFolders: [{ uri: VIRTUAL_ROOT_URI, name: 'workspace' }],
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              didSave: true,
            },
            completion: {
              completionItem: {
                snippetSupport: false,
                documentationFormat: ['markdown', 'plaintext'],
              },
            },
            hover: {
              contentFormat: ['markdown', 'plaintext'],
            },
            definition: {
              linkSupport: false,
            },
            publishDiagnostics: {},
          },
        },
      });
      this.sendNotification('initialized', {});
      this.initialized = true;
      this.onStatus('connected');
    } catch {
      this.onStatus('disconnected');
    }
  }

  isReady(): boolean {
    return this.initialized && this.ws?.readyState === WebSocket.OPEN;
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  private sendRequest<T>(method: string, params: unknown, timeoutMs = 8000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('LSP WebSocket not open'));
        return;
      }
      const id = ++this.reqId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  didOpen(relPath: string, text: string): void {
    if (!this.isReady() || !isLspSupportedFile(relPath)) return;
    const uri = toVirtualUri(relPath);
    if (this.openVersions.has(uri)) {
      this.didChange(relPath, text);
      return;
    }
    this.openVersions.set(uri, 1);
    this.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: detectLanguageId(relPath),
        version: 1,
        text,
      },
    });
  }

  didChange(relPath: string, text: string): void {
    if (!this.isReady() || !isLspSupportedFile(relPath)) return;
    const uri = toVirtualUri(relPath);
    const prev = this.openVersions.get(uri);
    if (!prev) {
      this.didOpen(relPath, text);
      return;
    }
    const nextVersion = prev + 1;
    this.openVersions.set(uri, nextVersion);
    this.sendNotification('textDocument/didChange', {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text }],
    });
  }

  didSave(relPath: string, text: string): void {
    if (!this.isReady() || !isLspSupportedFile(relPath)) return;
    const uri = toVirtualUri(relPath);
    this.sendNotification('textDocument/didSave', {
      textDocument: { uri },
      text,
    });
  }

  didClose(relPath: string): void {
    const uri = toVirtualUri(relPath);
    if (!this.openVersions.has(uri)) return;
    this.openVersions.delete(uri);
    if (!this.isReady()) return;
    this.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    });
  }

  async completion(relPath: string, line: number, character: number): Promise<LspCompletionItem[]> {
    if (!this.isReady() || !isLspSupportedFile(relPath)) return [];
    const result = await this.sendRequest<LspCompletionItem[] | { items?: LspCompletionItem[] } | null>(
      'textDocument/completion',
      {
        textDocument: { uri: toVirtualUri(relPath) },
        position: { line, character },
      },
    );
    if (!result) return [];
    return Array.isArray(result) ? result : result.items || [];
  }

  async hover(relPath: string, line: number, character: number): Promise<LspHoverResult | null> {
    if (!this.isReady() || !isLspSupportedFile(relPath)) return null;
    return this.sendRequest<LspHoverResult | null>('textDocument/hover', {
      textDocument: { uri: toVirtualUri(relPath) },
      position: { line, character },
    });
  }

  async definition(
    relPath: string,
    line: number,
    character: number,
  ): Promise<LspLocation[]> {
    if (!this.isReady() || !isLspSupportedFile(relPath)) return [];
    const res = await this.sendRequest<LspLocation | LspLocation[] | null>('textDocument/definition', {
      textDocument: { uri: toVirtualUri(relPath) },
      position: { line, character },
    });
    if (!res) return [];
    return Array.isArray(res) ? res : [res];
  }

  dispose(): void {
    this.disposed = true;
    this.initialized = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
    }
    this.pending.clear();
    this.openVersions.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
