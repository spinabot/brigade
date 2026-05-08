/**
 * Argv classification helpers — mirrors OpenClaw's `src/cli/argv.ts` shape.
 *
 * Used by entry.ts to decide if a request can short-circuit the heavy
 * Commander load. `--version` / `-v` and `--help` / `-h` at the root level
 * are answered by tiny fast-path handlers that import only what they need;
 * everything else falls through to the full CLI dispatch.
 */

const VERSION_FLAGS = new Set(["--version", "-v"]);
const HELP_FLAGS = new Set(["--help", "-h"]);

/** True iff argv invokes `brigade --version` (no subcommand or other flags). */
export function isRootVersionInvocation(argv: string[]): boolean {
  const tokens = argv.slice(2);
  if (tokens.length === 0) return false;
  // Allow ONLY a version flag — no subcommand, no extra flags.
  if (tokens.length !== 1) return false;
  return VERSION_FLAGS.has(tokens[0] ?? "");
}

/** True iff argv invokes `brigade --help` / `brigade -h` (no subcommand). */
export function isRootHelpInvocation(argv: string[]): boolean {
  const tokens = argv.slice(2);
  // `brigade help` (no subcommand) also fast-paths to root help.
  if (tokens.length === 1 && tokens[0] === "help") return true;
  // `brigade --help` / `brigade -h`
  if (tokens.length === 1 && HELP_FLAGS.has(tokens[0] ?? "")) return true;
  return false;
}

/**
 * Resolve the first non-flag positional token as the requested command name.
 * Returns undefined when argv is bare (no subcommand) or when the first
 * positional is unrecognised. Used by run-main to lazy-load only the
 * requested command's module instead of registering everything eagerly.
 */
export function resolveRequestedCommand(argv: string[]): string | undefined {
  const tokens = argv.slice(2);
  for (const token of tokens) {
    if (!token || token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}
