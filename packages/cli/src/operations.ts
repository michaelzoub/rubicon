import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type OperationStatus = "started" | "completed" | "ambiguous";

export interface StoredOperation {
  operationId: string;
  status: OperationStatus;
  articleId: string;
  sectionId: string;
  goal: string;
  budgetAtomic: string;
  sessionCapAtomic?: string;
  receiptId?: string;
  sessionId?: string;
  amountPaidAtomic?: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export function operationsDir(): string {
  return join(homedir(), ".rubicon", "operations");
}

/**
 * Deterministic idempotency key for one section purchase inside a buy. The
 * same goal, article, section, budget, and gateway always map to the same id,
 * so a rerun after an ambiguous transient failure finds the earlier attempt
 * instead of paying again.
 */
export function deriveOperationId(input: {
  gatewayUrl: string;
  articleId: string;
  sectionId: string;
  goal: string;
  budgetAtomic: string;
}): string {
  const digest = createHash("sha256")
    .update([input.gatewayUrl, input.articleId, input.sectionId, input.goal, input.budgetAtomic].join("\u0000"))
    .digest("hex");
  return `op_${digest.slice(0, 24)}`;
}

export async function saveOperation(operation: StoredOperation): Promise<StoredOperation> {
  await mkdir(operationsDir(), { recursive: true, mode: 0o700 });
  await writeFile(join(operationsDir(), `${safeId(operation.operationId)}.json`), `${JSON.stringify(operation, null, 2)}\n`, {
    mode: 0o600,
  });
  return operation;
}

export async function loadOperation(operationId: string): Promise<StoredOperation | undefined> {
  try {
    return JSON.parse(await readFile(join(operationsDir(), `${safeId(operationId)}.json`), "utf8")) as StoredOperation;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
