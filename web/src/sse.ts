export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ResilientEventSourceOptions<T> {
  url: string;
  heartbeatTimeoutMs?: number;
  minRetryMs?: number;
  maxRetryMs?: number;
  onMessage: (data: T, meta: { isReconnect: boolean }) => void;
  onOpen?: (meta: { isReconnect: boolean }) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  onAuthExpired?: () => void;
}

/**
 * Self-healing SSE wrapper over native EventSource:
 * - Detects half-open / zombie TCP connections via server heartbeat watchdog
 * - Explicitly closes broken connections and reconnects with exponential backoff
 *   (prevents Chrome/Safari from getting stuck permanently in EventSource.CLOSED on 502/503)
 * - Detects expired sessions (HTTP 401) and notifies caller instead of spinning forever
 * - Exposes reconnectNow() for instant recovery on visibilitychange / focus / online
 */
export class ResilientEventSource<T> {
  private readonly url: string;
  private readonly heartbeatTimeoutMs: number;
  private readonly minRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly onMessage: (data: T, meta: { isReconnect: boolean }) => void;
  private readonly onOpen?: (meta: { isReconnect: boolean }) => void;
  private readonly onStatusChange?: (status: ConnectionStatus) => void;
  private readonly onAuthExpired?: () => void;

  private es: EventSource | null = null;
  private watchdogTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private status: ConnectionStatus = 'connecting';
  private disposed = false;
  private hasEverConnected = false;
  private currentAttemptIsReconnect = false;
  private retryDelayMs: number;
  private consecutiveErrors = 0;
  private lastMessageAt = 0;

  constructor(options: ResilientEventSourceOptions<T>) {
    this.url = options.url;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 35_000;
    this.minRetryMs = options.minRetryMs ?? 1_000;
    this.maxRetryMs = options.maxRetryMs ?? 15_000;
    this.retryDelayMs = this.minRetryMs;
    this.onMessage = options.onMessage;
    this.onOpen = options.onOpen;
    this.onStatusChange = options.onStatusChange;
    this.onAuthExpired = options.onAuthExpired;

    this.connect();
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  isStale(thresholdMs = 25_000): boolean {
    if (this.status !== 'open') return true;
    if (!this.es || this.es.readyState !== EventSource.OPEN) return true;
    return Date.now() - this.lastMessageAt > thresholdMs;
  }

  reconnectNow(): void {
    if (this.disposed) return;
    this.clearReconnectTimer();
    this.closeSocket();
    this.retryDelayMs = this.minRetryMs;
    this.setStatus(this.hasEverConnected ? 'reconnecting' : 'connecting');
    this.connect();
  }

  close(): void {
    this.disposed = true;
    this.clearWatchdog();
    this.clearReconnectTimer();
    this.closeSocket();
    this.setStatus('closed');
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.onStatusChange?.(next);
  }

  private closeSocket(): void {
    if (this.es) {
      this.es.onopen = null;
      this.es.onmessage = null;
      this.es.onerror = null;
      try {
        this.es.close();
      } catch {
        // ignore
      }
      this.es = null;
    }
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      window.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private resetWatchdog(): void {
    this.clearWatchdog();
    if (this.disposed) return;
    this.watchdogTimer = window.setTimeout(() => {
      if (this.disposed) return;
      // No message or heartbeat arrived within heartbeatTimeoutMs -> half-open zombie socket
      this.closeSocket();
      this.setStatus('reconnecting');
      this.scheduleReconnect(200);
    }, this.heartbeatTimeoutMs);
  }

  private connect(): void {
    if (this.disposed) return;
    this.clearReconnectTimer();
    this.closeSocket();

    this.currentAttemptIsReconnect = this.hasEverConnected;
    this.setStatus(this.hasEverConnected ? 'reconnecting' : 'connecting');

    const es = new EventSource(this.url, { withCredentials: true });
    this.es = es;
    this.resetWatchdog();

    es.onopen = () => {
      if (this.disposed || this.es !== es) return;
      this.consecutiveErrors = 0;
      this.retryDelayMs = this.minRetryMs;
      this.lastMessageAt = Date.now();
      this.resetWatchdog();
      this.setStatus('open');
      const isReconnect = this.currentAttemptIsReconnect;
      this.hasEverConnected = true;
      this.onOpen?.({ isReconnect });
    };

    es.onmessage = (evt) => {
      if (this.disposed || this.es !== es) return;
      this.consecutiveErrors = 0;
      this.retryDelayMs = this.minRetryMs;
      this.lastMessageAt = Date.now();
      this.resetWatchdog();
      if (this.status !== 'open') {
        this.setStatus('open');
      }
      const isReconnect = this.currentAttemptIsReconnect;
      this.hasEverConnected = true;

      let parsed: T;
      try {
        parsed = JSON.parse(evt.data) as T;
      } catch {
        return;
      }
      this.onMessage(parsed, { isReconnect });
    };

    es.onerror = () => {
      if (this.disposed || this.es !== es) return;
      this.clearWatchdog();
      this.closeSocket();
      this.consecutiveErrors += 1;
      this.setStatus('reconnecting');

      if (this.consecutiveErrors === 2) {
        void this.checkAuthStatus();
      }

      const jitter = Math.floor(Math.random() * 400);
      const delay = this.retryDelayMs + jitter;
      this.retryDelayMs = Math.min(this.maxRetryMs, Math.round(this.retryDelayMs * 1.8));
      this.scheduleReconnect(delay);
    };
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.disposed) return;
    this.clearReconnectTimer();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) {
        this.connect();
      }
    }, delayMs);
  }

  private async checkAuthStatus(): Promise<void> {
    try {
      const resp = await fetch('/api/auth/me', { credentials: 'include' });
      if (resp.status === 401 && !this.disposed) {
        this.close();
        this.onAuthExpired?.();
      }
    } catch {
      // network offline; keep exponential retry running
    }
  }
}
