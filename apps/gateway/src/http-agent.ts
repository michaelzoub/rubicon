/**
 * Connection reuse for the gateway's outbound HTTP (notably per-word Circle
 * settlement). Node's global `fetch` already keeps connections alive, but its
 * default pool is conservative for a high-frequency settlement workload. When
 * the optional `undici` package is present we install a tuned global dispatcher
 * that widens the keep-alive window and per-origin connection count so hundreds
 * of word settlements reuse warm TLS connections instead of re-handshaking.
 *
 * If `undici` is not installed this is a no-op: Node's built-in fetch still
 * pools connections, just with default limits. It never throws.
 */
export interface KeepAliveOptions {
  keepAliveTimeoutMs?: number;
  keepAliveMaxTimeoutMs?: number;
  connections?: number;
}

interface UndiciLike {
  Agent: new (opts: {
    keepAliveTimeout?: number;
    keepAliveMaxTimeout?: number;
    connections?: number;
  }) => unknown;
  setGlobalDispatcher: (dispatcher: unknown) => void;
}

let installed = false;

export async function installKeepAliveDispatcher(options: KeepAliveOptions = {}): Promise<boolean> {
  if (installed) {
    return true;
  }
  // Indirect specifier so the build does not require `undici` to be resolvable.
  const specifier = "undici";
  const undici = (await import(specifier).catch(() => null)) as UndiciLike | null;
  if (!undici?.Agent || !undici.setGlobalDispatcher) {
    return false;
  }
  const agent = new undici.Agent({
    keepAliveTimeout: options.keepAliveTimeoutMs ?? 30_000,
    keepAliveMaxTimeout: options.keepAliveMaxTimeoutMs ?? 60_000,
    connections: options.connections ?? 128,
  });
  undici.setGlobalDispatcher(agent);
  installed = true;
  return true;
}
