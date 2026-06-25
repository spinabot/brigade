/**
 * Per-account BlueBubbles adapter registry — the cross-module bridge that lets
 * the webhook routes (registered at module `register()` time in `module.ts`) find
 * the per-account adapters that are STARTED later by `createBlueBubblesPlugin`
 * (`plugin.ts`).
 *
 * Why this exists. In a multi-account install each account has its OWN inbound
 * webhook path (`/bluebubbles/webhook/<accountId>`). The gateway only accepts
 * `b.httpRoute(...)` during a module's `register()`, but the per-account adapters
 * those routes must feed are owned by the plugin's `startAccount` lifecycle,
 * which runs AFTER `register()`. So the module registers one route per configured
 * account up front, each route resolving its account's started adapter through
 * THIS registry at request time, and the plugin populates / clears the registry
 * on start / stop. Same shape + rationale as Slack's `account-registry.ts`.
 *
 * Pinned via `resolveGlobalSingleton` so a hot reload / dual-build run shares one
 * map.
 */

import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { BLUEBUBBLES_DEFAULT_ACCOUNT_ID } from "./account-config.js";

/** The minimal adapter surface a webhook route needs to feed inbound events. */
export interface BlueBubblesAccountSink {
	feedWebhookEvent(eventType: string | undefined, payload: unknown): void;
}

const BLUEBUBBLES_ACCOUNT_SINKS_KEY = Symbol.for("brigade.bluebubbles.accountSinks");

const sinks = resolveGlobalSingleton<Map<string, BlueBubblesAccountSink>>(
	BLUEBUBBLES_ACCOUNT_SINKS_KEY,
	() => new Map<string, BlueBubblesAccountSink>(),
);

function normalizeAccountId(accountId: string | null | undefined): string {
	return accountId && accountId.trim() ? accountId.trim() : BLUEBUBBLES_DEFAULT_ACCOUNT_ID;
}

/** Register a started per-account adapter so its webhook route can feed it. Idempotent. */
export function registerBlueBubblesAccountSink(accountId: string, sink: BlueBubblesAccountSink): void {
	sinks.set(normalizeAccountId(accountId), sink);
}

/** Drop a per-account adapter (called on `stopAccount`) so a dead adapter isn't fed. */
export function removeBlueBubblesAccountSink(accountId: string): void {
	sinks.delete(normalizeAccountId(accountId));
}

/** Look up a started per-account adapter (or undefined when not started). */
export function getBlueBubblesAccountSink(accountId: string): BlueBubblesAccountSink | undefined {
	return sinks.get(normalizeAccountId(accountId));
}

/** Diagnostic — the account ids with a live sink. */
export function listBlueBubblesAccountSinks(): string[] {
	return [...sinks.keys()];
}

/** Test-only — clear every registered sink. */
export function resetBlueBubblesAccountSinksForTests(): void {
	sinks.clear();
}
