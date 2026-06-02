/**
 * Cross-module singleton resolver.
 *
 * Every Brigade subsystem that holds process-wide state — the lane engine's
 * lane registry, the per-session pending-events queue, the subagent-run map,
 * the live session registry, the cross-session inbox — stores it via this
 * helper so:
 *
 *   1. Hot reloads in development do not duplicate the state map (multiple
 *      copies of the module would each instantiate a fresh closure-scoped
 *      Map; pinning the state to `globalThis[symbol]` survives reload).
 *   2. Tests can reach the same state the runtime sees (without exporting
 *      private closures from the module just to make them mockable).
 *   3. Multiple Brigade builds sharing a Node process (test harness, CLI +
 *      gateway in one boot) still share the one state instance for any
 *      given `symbol` — the contract is "one symbol, one state, lifetime
 *      of the JS realm".
 *
 * `key` must be `Symbol.for("brigade.<area>.<purpose>")` — the brand-scrub
 * audit (`src/shared/brand-scrub.test.ts`) AST-walks `src/` and refuses any
 * non-`brigade.*` Symbol.for() arg.
 *
 * The factory runs exactly once per key per realm. Subsequent calls with the
 * same key reuse the cached value; the factory is not re-invoked.
 */
export function resolveGlobalSingleton<T>(key: symbol, factory: () => T): T {
	const slot = globalThis as unknown as Record<symbol, unknown>;
	const cached = slot[key];
	if (cached !== undefined) return cached as T;
	const fresh = factory();
	slot[key] = fresh;
	return fresh;
}
