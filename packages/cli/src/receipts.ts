import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReadReceipt } from "@rubicon-caliga/agent-sdk/agent-client";
import { CliError } from "./errors.js";

export interface StoredReceipt {
  receiptId: string;
  savedAt: string;
  receipt: ReadReceipt;
}

export function receiptsDir(): string {
  return join(homedir(), ".rubicon", "receipts");
}

export function receiptId(receipt: ReadReceipt): string {
  return `${receipt.sessionId}-${receipt.articleId}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function saveReceipt(receipt: ReadReceipt): Promise<StoredReceipt> {
  const stored = {
    receiptId: receiptId(receipt),
    savedAt: new Date().toISOString(),
    receipt,
  };
  await mkdir(receiptsDir(), { recursive: true, mode: 0o700 });
  await writeFile(join(receiptsDir(), `${stored.receiptId}.json`), `${JSON.stringify(stored, null, 2)}\n`, {
    mode: 0o600,
  });
  return stored;
}

export async function listReceipts(): Promise<StoredReceipt[]> {
  await mkdir(receiptsDir(), { recursive: true, mode: 0o700 });
  const names = await readdir(receiptsDir());
  const receipts = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => JSON.parse(await readFile(join(receiptsDir(), name), "utf8")) as StoredReceipt),
  );
  return receipts.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
}

export async function loadReceipt(id: string): Promise<StoredReceipt> {
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  try {
    return JSON.parse(await readFile(join(receiptsDir(), `${safeId}.json`), "utf8")) as StoredReceipt;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new CliError("RECEIPT_NOT_FOUND", `Receipt not found: ${id}`);
    }
    throw error;
  }
}
