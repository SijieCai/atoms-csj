import type { Response } from 'express';
import type { SSEEvent, SSEEventPayload, UserGlobalSSEEvent } from '@atoms/shared';

class ProjectEventBus {
  private subscribers = new Map<string, Set<Response>>();
  private userSubscribers = new Map<string, Set<Response>>();
  private projectSeqs = new Map<string, number>();
  private heartbeatTimer: NodeJS.Timeout;

  constructor() {
    this.heartbeatTimer = setInterval(() => {
      for (const clients of this.subscribers.values()) {
        for (const res of clients) {
          try {
            res.write(': ping\n\n');
          } catch {
            clients.delete(res);
          }
        }
      }
      for (const clients of this.userSubscribers.values()) {
        for (const res of clients) {
          try {
            res.write(': ping\n\n');
          } catch {
            clients.delete(res);
          }
        }
      }
    }, 20_000);
    this.heartbeatTimer.unref();
  }

  getSeq(projectId: string): number {
    return this.projectSeqs.get(projectId) || 0;
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

    const clients = this.subscribers.get(projectId);
    if (!clients || clients.size === 0) return seq;

    const envelope: SSEEvent = {
      ...event,
      seq,
      ts: Date.now(),
    };
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
