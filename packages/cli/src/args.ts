import { CliError } from "./errors.js";

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const [rawName, inlineValue] = withoutPrefix.split("=", 2);
    const name = rawName;
    if (!name) {
      throw new CliError("INVALID_ARGUMENT", `Invalid flag: ${token}`);
    }

    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }

  return { positionals, flags };
}

export function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined || typeof value === "boolean") return undefined;
  return value;
}

export function booleanFlag(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true;
}
