import { randomBytes } from 'node:crypto';
import type { User } from '../domain/types.js';

export type EventType = 'panel.updated' | 'item.updated';

export interface StreamEvent {
  id: number;
  type: EventType;
  data: unknown;
}

interface Subscriber {
  projectId: string;
  userId: string;
  send: (event: StreamEvent) => void;
}

/**
 * Routes events to open SSE streams. Panel updates go to one user (they carry that user's prices);
 * item updates go to everyone viewing the project and never carry prices.
 * Production uses Redis pub/sub so an event reaches the replica that holds the user's stream.
 */
export class EventHub {
  private nextId = 1;
  private readonly subscribers = new Set<Subscriber>();

  subscribe(projectId: string, userId: string, send: (event: StreamEvent) => void): () => void {
    const subscriber = { projectId, userId, send };
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publishToUser(projectId: string, userId: string, type: EventType, data: unknown): void {
    this.publish(type, data, (subscriber) => subscriber.projectId === projectId && subscriber.userId === userId);
  }

  publishToProject(projectId: string, type: EventType, data: unknown): void {
    this.publish(type, data, (subscriber) => subscriber.projectId === projectId);
  }

  private publish(type: EventType, data: unknown, matches: (subscriber: Subscriber) => boolean): void {
    const event = { id: this.nextId++, type, data };
    for (const subscriber of this.subscribers) if (matches(subscriber)) subscriber.send(event);
  }
}

/**
 * EventSource cannot send an Authorization header, and a token in the URL would end up in logs.
 * The browser exchanges its token for a ticket that is valid for one project, once, for a minute.
 */
export class StreamTicketStore {
  private readonly tickets = new Map<string, { user: User; projectId: string; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  issue(user: User, projectId: string): string {
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, { user, projectId, expiresAt: this.now() + this.ttlMs });
    return ticket;
  }

  redeem(ticket: string, projectId: string): User | undefined {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!entry || entry.projectId !== projectId || this.now() >= entry.expiresAt) return undefined;
    return entry.user;
  }
}
