export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 1,
    public readonly recovery?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function circleDetails(error: Error): Record<string, unknown> | undefined {
  const diagnostics = (error as Error & { circleDiagnostics?: unknown }).circleDiagnostics;
  return typeof diagnostics === "object" && diagnostics !== null ? { circle: diagnostics as Record<string, unknown> } : undefined;
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("fetch failed") || lower.includes("enotfound") || lower.includes("econnrefused")) {
      return new CliError(
        "CIRCLE_NETWORK_UNAVAILABLE",
        `${error.message} Retry in a network-capable shell or agent context; restricted sandboxes often block Circle auth and Gateway calls.`,
        1,
        undefined,
        circleDetails(error),
      );
    }
    if (lower.includes("otp") && (lower.includes("expired") || lower.includes("invalid") || lower.includes("request"))) {
      return new CliError(
        "CIRCLE_OTP_EXPIRED",
        `${error.message} Start a fresh Circle auth OTP flow, then rerun the Rubicon command after login completes.`,
        1,
        undefined,
        circleDetails(error),
      );
    }
    return new CliError("COMMAND_FAILED", error.message, 1, undefined, circleDetails(error));
  }
  return new CliError("COMMAND_FAILED", String(error));
}
