export interface ReadBundleCommittedEvent {
  eventId: string;
  eventVersion: 1;
  eventType: "read_bundle_committed";
  occurredAt: string;
  bundleId: string;
  creatorId: string;
  articleId: string;
  sessionId: string;
  accessMode: "paid" | "free";
  sectionId?: string;
  startSequence: number;
  endSequence: number;
  wordsCount: number;
  grossAmountAtomic: string;
  creatorAmountAtomic: string;
  rubiconFeeAtomic: string;
  buyerAgentHash?: string;
}

export interface SettlementChangedEvent {
  eventId: string;
  eventVersion: 1;
  eventType: "settlement_changed";
  occurredAt: string;
  settlementRecordId: string;
  bundleIds: string[];
  creatorId: string;
  articleId: string;
  sessionId: string;
  providerReference: string;
  status: "pending" | "confirmed" | "completed" | "failed";
  settledCreatorAmountAtomicDelta: string;
}

export type AnalyticsEvent = ReadBundleCommittedEvent | SettlementChangedEvent;

export interface OutboxRow {
  id: string;
  eventId: string;
  eventType: AnalyticsEvent["eventType"];
  eventVersion: number;
  aggregateKey: string;
  payload: AnalyticsEvent;
  occurredAt: string;
  attempts: number;
}

export interface AnalyticsHealth {
  enabled: boolean;
  backlogSize: number;
  poisonEventCount: number;
  oldestEventAgeSeconds?: number;
  latestProcessedAt?: string;
  workerRunning: boolean;
}
