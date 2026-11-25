import crypto from 'node:crypto';
import type { Response } from 'express';
import type { SSEEvent, SSEEventPayload, UserGlobalSSEEvent } from '@atoms/shared';

const MAX_PROJECT_BUFFER_SIZE = 200;
const HEARTBEAT_INTERVAL_MS = 15_000;

class ProjectEventBus {
  readonly bootId = crypto.randomBytes(6).toString('hex');
  private subscribers = new Map<string, Set<Response>>();
  private userSubscribers = new Map<string, Set<Response>>();
  private projectSeqs = new Map<string, number>();
  private projectBuffers = new Map<string, SSEEvent[]>();
  private heartbeatTimer: NodeJS.Timeout;

  constructor() {
    this.heartbeatTimer = setInterval(() => {
      const payload = `data: ${JSON.stringify({ type: 'heartbeat', ts: Date.now() })}\n\n`;
      for (const clients of this.subscribers.values()) {
        for (const res of clients) {
          try {
            res.write(payload);
          } catch {
            clients.delete(res);
          }
        }
      }
      for (const clients of this.userSubscribers.values()) {
        for (const res of clients) {
          try {
            res.write(payload);
          } catch {
            clients.delete(res);
          }
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  getSeq(projectId: string): number {
    return this.projectSeqs.get(projectId) || 0;
  }

  getBufferedEventsSince(projectId: string, sinceSeq: number): SSEEvent[] {
    const buf = this.projectBuffers.get(projectId);
    if (!buf || buf.length === 0) return [];
    return buf.filter((evt) => typeof evt.seq === 'number' && evt.seq > sinceSeq);
  }

  clearProject(projectId: string): void {
    this.projectSeqs.delete(projectId);
    this.projectBuffers.delete(projectId);
  }

  subscribe(projectId: string, res: Response): () => void {
    let set = this.subscribers.get(projectId);
    if (!set) {
      set = new Set();
      this.subscribers.set(projectId, set);
    }
    set.add(res);
    return () => {
      const current = this.subscribers.get(projectId);
      if (!current) return;
      current.delete(res);
      if (current.size === 0) {
        this.subscribers.delete(projectId);
      }
    };
  }

  emit(projectId: string, event: SSEEventPayload): number {
    const seq = (this.projectSeqs.get(projectId) || 0) + 1;
    this.projectSeqs.set(projectId, seq);

    const envelope: SSEEvent = {
      ...event,
      seq,
      ts: Date.now(),
    };

    let buf = this.projectBuffers.get(projectId);
    if (!buf) {
      buf = [];
      this.projectBuffers.set(projectId, buf);
    }
    buf.push(envelope);
    if (buf.length > MAX_PROJECT_BUFFER_SIZE) {
      buf.shift();
    }

    const clients = this.subscribers.get(projectId);
    if (!clients || clients.size === 0) return seq;

    const payload = `data: ${JSON.stringify(envelope)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
    return seq;
  }

  subscribeUser(username: string, res: Response): () => void {
    let set = this.userSubscribers.get(username);
    if (!set) {
      set = new Set();
      this.userSubscribers.set(username, set);
    }
    set.add(res);
    return () => {
      const current = this.userSubscribers.get(username);
      if (!current) return;
      current.delete(res);
      if (current.size === 0) {
        this.userSubscribers.delete(username);
      }
    };
  }

  emitUser(username: string, event: UserGlobalSSEEvent): void {
    const clients = this.userSubscribers.get(username);
    if (!clients || clients.size === 0) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }
}

export const eventBus = new ProjectEventBus();
