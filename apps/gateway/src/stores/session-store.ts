import type { SessionRecord } from "@rubicon-caliga/core";

export class InMemorySessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  set(session: SessionRecord): void {
    session.updatedAt = new Date();
    this.sessions.set(session.id, session);
  }
}
