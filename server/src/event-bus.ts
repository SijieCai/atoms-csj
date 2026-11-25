import type { Response } from 'express';
import type { SSEEvent } from '@atoms/shared';

class ProjectEventBus {
  private subscribers = new Map<string, Set<Response>>();
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
    }, 20_000);
    this.heartbeatTimer.unref();
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

  emit(projectId: string, event: SSEEvent): void {
    const clients = this.subscribers.get(projectId);
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
