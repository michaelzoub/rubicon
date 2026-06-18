export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
  }
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error) return new CliError("COMMAND_FAILED", error.message);
  return new CliError("COMMAND_FAILED", String(error));
}
