import { isRootHelpInvocation, isRootVersionInvocation } from "./cli/argv.js";
import { installTerminalCleanupHandler } from "./ui/terminal-cleanup.js";

// Install the process-wide terminal cleanup handler ONCE, before any subcommand
// has a chance to spawn Pi-TUI / mutate terminal modes. Each subcommand still
// installs its own SIGINT handler (because they have UI state to tear down —
// abort an in-flight turn first, save sessions, etc.), but SIGTERM / SIGHUP /
// uncaught exceptions / pi-event-handler throws would otherwise leak the kitty
// keyboard protocol push and bracketed-paste mode into the user's shell. This
// catches every exit path including crashes during chat / connect.
installTerminalCleanupHandler();

// Brigade entry point. Mirrors OpenClaw's entry.ts dispatch shape:
//
//   1. Defensive compile-cache enable (brigade.mjs already did this for
//      bin invocations, but `tsx src/entry.ts` and `node dist/entry.js`
//      direct paths bypass the shim — both are no-ops if already cached).
//   2. Fast-path for `brigade --version` / `-v`. Skips the Commander load
//      entirely; only `./version.js` (a single-string export) is imported.
//      Saves ~200ms of cold-start on a `brigade -v` round-trip.
//   3. Fast-path for `brigade --help` / `-h` / `brigade help`. Same idea —
//      Commander's full registration tree is heavy; the help-printer here
//      only loads enough to render the top-level command list.
//   4. Otherwise, hand off to run-main, which lazy-loads only the requested
//      subcommand's registrar.
//
// Brigade is a CLI tool; entry.ts always runs the program. If a library
// surface ever lands, it lives at a different export path
// (e.g. `brigade/lib`) — never routed through entry.ts.

// Defensive compile-cache enable.
try {
  const mod = await import("node:module");
  if (typeof mod.enableCompileCache === "function") {
    mod.enableCompileCache();
  }
} catch {
  // Older Node minors silently skip.
}

const argv = process.argv;

// Fast-path 1 — `brigade --version`.
if (isRootVersionInvocation(argv)) {
  const { formatVersion } = await import("./version.js");
  console.log(`Brigade ${formatVersion()}`);
  process.exit(0);
}

// Fast-path 2 — `brigade --help` / `brigade help` / `brigade -h`.
// We still defer to Commander for help rendering (Commander's help text
// includes all registered commands, options, and aliases — re-implementing
// would drift quickly), but we skip the heavy command-body imports by
// loading only the empty-program scaffold.
if (isRootHelpInvocation(argv)) {
  const { runMain } = await import("./cli/run-main.js");
  process.exit(await runMain(argv));
}

// Default — full dispatch.
const { runMain } = await import("./cli/run-main.js");
process.exit(await runMain(argv));
