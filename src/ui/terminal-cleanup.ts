/**
 * Centralized terminal-state restoration on TUI exit.
 *
 * After a Brigade TUI session ends (clean exit, Ctrl+C, crash, signal,
 * `process.exit`, anything), the user's shell prompt must look like Brigade
 * was never there. The kitty keyboard protocol in particular is sticky: if
 * the push (CSI > 1 u) isn't matched by a pop (CSI < u) on the way out,
 * terminals that support it (Kitty, Ghostty, WezTerm, recent Windows
 * Terminal) keep emitting key release events into the next program — which
 * the shell then renders as visible garbage like `[57361;1:3u`.
 *
 * Why we don't rely solely on Pi-TUI's ProcessTerminal.stop():
 *   1. Its kitty pop is gated on a `_kittyProtocolActive` flag that gets
 *      set lazily after the terminal answers the capability query. If the
 *      user exits between query-write and response-read, the push happens
 *      anyway (or rather: kitty mode is left in whatever state the terminal
 *      already held) and the pop is skipped.
 *   2. It only runs on graceful `tui.stop()` paths. A crash that bypasses
 *      `tui.stop()` leaves the terminal in raw + kitty + bracketed-paste
 *      mode forever.
 *   3. It never emits the broader safety net (focus reporting, mouse
 *      tracking, synchronized output, alt-screen) which other libraries
 *      sometimes leave on.
 *
 * `restoreTerminal()` is idempotent — every escape sequence here is a
 * "disable" or "show", and terminals tolerate disable-when-disabled. Safe
 * to wire into multiple exit paths and to call repeatedly.
 *
 * IMPORTANT: writes go to stderr, never stdout. stderr is the conventional
 * channel for terminal control and is unbuffered + always-on; stdout might
 * be redirected to a file or pipe, in which case writing escape sequences
 * there would corrupt the captured output.
 */

import process from "node:process";

/**
 * Active only after a TUI command (chat/connect/onboard) explicitly enters
 * raw/alt-screen/kitty/etc. mode. Non-TUI subcommands (`channels list`,
 * `pairing approve`, …) never set this, so their exit doesn't emit cleanup
 * escapes — which would otherwise render as visible garbage on terminals
 * (notably older PowerShell hosts) that don't parse the full set.
 */
let tuiActive = false;
export function markTuiActive(): void {
  tuiActive = true;
}

/**
 * Emit every escape sequence needed to restore the terminal to a known-good
 * state. Called from every Brigade exit path (signal handlers, normal exit,
 * crash, `process.on("exit")`).
 *
 * No-op when no TUI command marked itself active — a one-shot CLI command
 * exiting has nothing to clean up, and emitting "disable" escapes pollutes
 * the operator's terminal scrollback.
 */
export function restoreTerminal(): void {
  if (!tuiActive) return;
  const out = process.stderr;
  try {
    out.write(
      // 1. Pop kitty keyboard protocol stack — THE main bug fix. Without
      //    this, key release events leak into the user's shell as visible
      //    text like `[57361;1:3u`.
      "\x1b[<u" +
        // 2. Disable any pushed kitty modes (extra safety; no-op if
        //    nothing was pushed). `>0u` clears the current flag set
        //    explicitly in case the pop above didn't drain it.
        "\x1b[>0u" +
        // 3. Disable xterm modifyOtherKeys mode (used by Pi-TUI as a
        //    tmux fallback when kitty isn't available).
        "\x1b[>4;0m" +
        // 4. Disable bracketed paste (Pi-TUI enables `?2004h` on entry).
        "\x1b[?2004l" +
        // 5. Show the cursor — Pi-TUI hides it on entry via `?25l`.
        "\x1b[?25h" +
        // 6. Disable synchronized output mode (some renderers leave
        //    this on across an unclean exit).
        "\x1b[?2026l" +
        // 7. Disable focus reporting.
        "\x1b[?1004l" +
        // 8. Disable every mouse tracking flavor anyone might have on.
        "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" +
        // 9. Reset cursor style to terminal default (DECSCUSR 0).
        "\x1b[0 q" +
        // 10. Reset color / SGR attributes so the next prompt isn't
        //     painted in whatever color we last used.
        "\x1b[0m" +
        // 11. Exit alternate screen buffer LAST — biggest visual change,
        //     and we want every other mode reset while alt screen is
        //     still active so the cleanup looks tidy if anyone ever
        //     enables it. Brigade itself doesn't use alt screen, but
        //     the sequence costs nothing on terminals that aren't in it.
        "\x1b[?1049l",
    );
  } catch {
    // Terminal may already be closed (EPIPE) — nothing to do.
  }
}

/**
 * Install a single `process.on("exit")` handler that runs `restoreTerminal()`.
 * Idempotent — registers at most once per process so callers in multiple
 * subcommand entry points don't stack listeners.
 *
 * `process.on("exit")` fires for ALL exit paths (normal return, throw,
 * signal, `process.exit`, etc.) and is synchronous, which is the right shape
 * for emitting a single string of bytes to stderr.
 */
let exitHandlerInstalled = false;
export function installTerminalCleanupHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on("exit", restoreTerminal);

  // Signals that should also flush cleanup before we exit. `process.on("exit")`
  // alone covers `process.exit()` calls but NOT signal-driven termination
  // (Node defaults to dying without firing the exit event when an uncaught
  // signal arrives). Wiring these explicitly guarantees cleanup before the
  // terminal hands control back to the shell.
  const signalHandler = (sig: NodeJS.Signals) => {
    restoreTerminal();
    // Re-raise the default behavior: exit with 128 + signal number convention.
    // SIGINT → 130, SIGTERM → 143, SIGHUP → 129, SIGQUIT → 131.
    const code =
      sig === "SIGINT"
        ? 130
        : sig === "SIGTERM"
          ? 143
          : sig === "SIGHUP"
            ? 129
            : sig === "SIGQUIT"
              ? 131
              : 1;
    // Use `process.exit` rather than re-raising so the `exit` event fires
    // (where restoreTerminal will run again, harmlessly, via idempotency).
    process.exit(code);
  };
  // We only register SIGTERM and SIGHUP here. SIGINT is owned by the
  // per-subcommand handler (which has UI state to tear down — abort an
  // in-flight turn first, etc.); that handler calls `restoreTerminal()`
  // directly before `process.exit`, and the `exit` event handler above is
  // the final safety net.
  process.on("SIGTERM", signalHandler);
  process.on("SIGHUP", signalHandler);
}
