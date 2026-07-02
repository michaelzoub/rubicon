export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 1,
    public readonly recovery?: string,
  ) {
    super(message);
  }
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("fetch failed") || lower.includes("enotfound") || lower.includes("econnrefused")) {
      return new CliError(
        "CIRCLE_NETWORK_UNAVAILABLE",
        `${error.message} Retry in a network-capable shell or agent context; restricted sandboxes often block Circle auth and Gateway calls.`,
      );
    }
    if (lower.includes("otp") && (lower.includes("expired") || lower.includes("invalid") || lower.includes("request"))) {
      return new CliError(
        "CIRCLE_OTP_EXPIRED",
        `${error.message} Start a fresh Circle auth OTP flow, then rerun the Rubicon command after login completes.`,
      );
    }
    return new CliError("COMMAND_FAILED", error.message);
  }
  return new CliError("COMMAND_FAILED", String(error));
}
