import type { GatewayEvent } from "@rubicon-caliga/core";

type Listener = (event: GatewayEvent) => void;

export class InMemoryEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly history = new Map<string, GatewayEvent[]>();

  publish(event: GatewayEvent): void {
    const history = this.history.get(event.sessionId) ?? [];
    history.push(event);
    this.history.set(event.sessionId, history.slice(-100));
    for (const listener of this.listeners.get(event.sessionId) ?? []) {
      listener(event);
    }
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    for (const event of this.history.get(sessionId) ?? []) {
      listener(event);
    }
    return () => listeners.delete(listener);
  }
}
