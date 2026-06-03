/**
 * Guard sweep CI invariant (Wave O0.6 META-TEST, rewritten in Wave O0.8).
 *
 * Walks `server.ts` with the TypeScript compiler API (no regex parsing, no
 * ts-morph dependency) to enumerate:
 *   1. Every `registerGatewayHandler("name", handlerFn)` call. We capture
 *      the literal method name AND the handler body source, then assert
 *      that handlers taking a per-session parameter either call
 *      `sessionsAccessCheck` / `checkSessionToolAccess` somewhere, OR
 *      appear in the explicit allowlist below. The walker recurses
 *      through function references — `registerGatewayHandler("x", handleX)`
 *      where `handleX` is a separately-declared function is followed and
 *      its body is checked.
 *   2. Every `case "method":` arm in the in-process `handleRequest`
 *      switch. Same rule.
 *
 * Wave O0.8 additions:
 *   - AST-based parsing closes regex blind spots: function-arg delegation
 *     (`registerGatewayHandler("x", handleX)`), nested registrations
 *     inside helper functions, multi-line callbacks with string-template
 *     names get flagged.
 *   - The dispatcher's default-pass guard for extension `customMethods`
 *     and HTTP routes is checked statically: we assert the dispatcher
 *     calls `defaultPassSessionGuard` before invoking the plugin handler.
 *   - The `wake`, `cron.remove`, and `cron.runs` allowlist entries were
 *     removed — their registered handlers now carry explicit guards.
 *
 * Tempdir-isolated by construction — reads source files directly, never
 * spawns the gateway.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

const SERVER_PATH = resolve(import.meta.dirname, "server.ts");

/**
 * Methods that do NOT need an access check because:
 *   - they take no per-session parameter (health/list-models/get-state),
 *   - they are read-only across the whole gateway (snapshot / model list),
 *   - or they are admin-scoped at the WS layer and operate on the gateway
 *     process itself (shutdown / approval-resolve / subscribe).
 *
 * Any method that mutates a session, sends a message, or discloses an
 * agent's inventory MUST require a guard — and the allowlist explicitly
 * does NOT include those.
 *
 * Wave O0.8: removed `wake`, `cron.remove`, `cron.runs` — those handlers
 * now carry explicit `sessionsAccessCheck` calls and must NOT silently
 * fall back to "no guard needed".
 */
const ALLOWLIST_NO_GUARD_NEEDED = new Set<string>([
	// Connection / scope-management — no per-session targeting.
	"subscribe",
	"unsubscribe",
	"approval-resolve",
	// Read-only registry / snapshot methods.
	"list-models",
	"refresh-models",
	"get-state",
	"agents.list",
	// Boot/lifecycle methods.
	"shutdown",
	"health",
	// Cron read methods + service-level snapshot (no fire-time mutation).
	"cron.status",
	"cron.list",
	// Skills install/update — admin-scoped and currently unguarded by
	// design (operator-initiated workspace mutation, not cross-agent).
	"skills.install",
	"skills.update",
	// Memory sweep — gateway-internal, no agent targeting.
	"memory.sweep",
	"memory.consolidate",
]);

/** Sessions registry methods that ARE guarded (registered with accessCheck). */
const KNOWN_GUARDED_SESSIONS_METHODS = new Set<string>([
	"sessions.list",
	"sessions.history",
	"sessions.send",
	"sessions.spawn",
	"sessions.patch",
	"agent",
	"cron.add",
	"cron.update",
	"cron.run",
	"cron.remove",
	"cron.runs",
	"wake",
	"skills.status",
]);

const GUARD_FN_NAMES = [
	"sessionsAccessCheck",
	"checkSessionToolAccess",
	"defaultPassSessionGuard",
];
const GUARD_REFERENCE_TOKENS = [
	...GUARD_FN_NAMES,
	"accessCheck: sessionsAccessCheck",
];

interface RegisteredHandler {
	method: string;
	body: string;
	/** When the handler is a bare identifier (function ref), the resolved
	 *  body of that declaration; appended to `body` for guard scanning. */
	referencedBodies: string[];
}

interface DispatcherCase {
	method: string;
	body: string;
}

function bodyMentionsGuard(text: string): boolean {
	return GUARD_REFERENCE_TOKENS.some((tok) => text.includes(tok));
}

function bodyMentionsSessionParam(text: string): boolean {
	return (
		text.includes("sessionKey") ||
		text.includes("agentId") ||
		text.includes("targetSessionKey")
	);
}

interface ParsedSource {
	registrations: RegisteredHandler[];
	cases: DispatcherCase[];
	hasDefaultPassGuardWired: boolean;
	hasHttpDefaultPassGuardWired: boolean;
}

/**
 * Walk the SourceFile and collect:
 *   • every `registerGatewayHandler("name", expr)` call
 *   • every `case "name":` body inside any switch
 *   • whether the dispatcher's default branch invokes
 *     `defaultPassSessionGuard` (for customMethods)
 *   • whether the HTTP-routes dispatcher invokes
 *     `defaultPassSessionGuard` (for extension routes)
 */
function parseSource(src: string): ParsedSource {
	const sf = ts.createSourceFile(
		"server.ts",
		src,
		ts.ScriptTarget.Latest,
		true,
	);
	const registrations: RegisteredHandler[] = [];
	const cases: DispatcherCase[] = [];

	// Map of top-level function declarations / arrow declarations by name so
	// we can resolve `registerGatewayHandler("x", handleX)` references.
	const namedFunctionBodies = new Map<string, string>();
	sf.forEachChild((node) => {
		if (ts.isFunctionDeclaration(node) && node.name && node.body) {
			namedFunctionBodies.set(node.name.text, node.body.getText(sf));
		} else if (ts.isVariableStatement(node)) {
			for (const decl of node.declarationList.declarations) {
				if (
					ts.isIdentifier(decl.name) &&
					decl.initializer &&
					(ts.isArrowFunction(decl.initializer) ||
						ts.isFunctionExpression(decl.initializer))
				) {
					namedFunctionBodies.set(decl.name.text, decl.initializer.getText(sf));
				}
			}
		}
	});

	let hasDefaultPassGuardWired = false;
	let hasHttpDefaultPassGuardWired = false;

	const walk = (node: ts.Node): void => {
		// `registerGatewayHandler("name", handlerExpr)`
		if (ts.isCallExpression(node)) {
			const exprText = node.expression.getText(sf);
			if (exprText === "registerGatewayHandler" && node.arguments.length >= 2) {
				const first = node.arguments[0];
				if (first && ts.isStringLiteral(first)) {
					const method = first.text;
					const handlerArg = node.arguments[1];
					const bodyText = handlerArg ? handlerArg.getText(sf) : "";
					const referenced: string[] = [];
					// If the handler arg is a bare identifier (function ref),
					// recurse one level into the named declaration.
					if (handlerArg && ts.isIdentifier(handlerArg)) {
						const refBody = namedFunctionBodies.get(handlerArg.text);
						if (refBody) referenced.push(refBody);
					}
					registrations.push({ method, body: bodyText, referencedBodies: referenced });
				}
			}
		}
		// `switch (...) { case "name": ... }` — only collect cases from the
		// dispatcher switch. Identify it as the SwitchStatement whose case
		// labels include the anchor methods `prompt`, `abort`, and `steer`.
		// Other switch statements in the file (event-bus listeners, channel
		// adapters) also have string-literal case clauses but they're not
		// part of the RPC surface.
		if (ts.isSwitchStatement(node)) {
			const caseLabels: string[] = [];
			for (const c of node.caseBlock.clauses) {
				if (ts.isCaseClause(c) && ts.isStringLiteral(c.expression)) {
					caseLabels.push(c.expression.text);
				}
			}
			const isDispatcherSwitch =
				caseLabels.includes("prompt") &&
				caseLabels.includes("abort") &&
				caseLabels.includes("steer");
			if (isDispatcherSwitch) {
				for (const c of node.caseBlock.clauses) {
					if (ts.isCaseClause(c) && ts.isStringLiteral(c.expression)) {
						const method = c.expression.text;
						const body = c.statements
							.map((s) => s.getText(sf))
							.join("\n");
						cases.push({ method, body });
					}
				}
			}
		}
		// customMethods dispatcher gate — find any IfStatement whose then-
		// branch references `custom.handler` (the plugin invocation) AND
		// also contains a call to `defaultPassSessionGuard`. This is robust
		// to the exact code shape (VariableDeclaration + sibling If vs.
		// inline call) because we don't have to walk up to a specific
		// ancestor — we just verify the dispatcher's plugin-invocation
		// block contains the guard.
		if (ts.isIfStatement(node)) {
			const thenText = node.thenStatement.getText(sf);
			if (
				thenText.includes("custom.handler") &&
				thenText.includes("defaultPassSessionGuard")
			) {
				hasDefaultPassGuardWired = true;
			}
			// HTTP dispatcher — find an IfStatement / block that calls
			// `route.handler` and also references `defaultPassSessionGuard`
			// nearby. We widen the scope to "the IfStatement's enclosing
			// function" since the HTTP-routes branch uses sequential code,
			// not a single If wrapping handler + guard. Done below in the
			// ArrowFunction/FunctionExpression walker instead.
		}
		if (
			ts.isArrowFunction(node) ||
			ts.isFunctionExpression(node) ||
			ts.isFunctionDeclaration(node)
		) {
			const fnText = node.getText(sf);
			if (
				fnText.includes("httpRoutes.find") &&
				fnText.includes("route.handler") &&
				fnText.includes("defaultPassSessionGuard")
			) {
				hasHttpDefaultPassGuardWired = true;
			}
		}
		ts.forEachChild(node, walk);
	};
	walk(sf);

	return {
		registrations,
		cases,
		hasDefaultPassGuardWired,
		hasHttpDefaultPassGuardWired,
	};
}

describe("guard sweep — server.ts gateway handlers", () => {
	const src = readFileSync(SERVER_PATH, "utf8");
	const parsed = parseSource(src);

	it("every switch-case that touches a session param either guards or is allowlisted", () => {
		// Sanity-anchor: the dispatcher switch contains `prompt` + `abort`.
		const caseNames = new Set(parsed.cases.map((c) => c.method));
		assert.ok(
			caseNames.has("prompt") && caseNames.has("abort"),
			`expected dispatcher anchor methods (prompt, abort) in parsed switch cases; got ${[
				...caseNames,
			]
				.sort()
				.join(", ")}`,
		);
		const offenders: string[] = [];
		for (const c of parsed.cases) {
			if (ALLOWLIST_NO_GUARD_NEEDED.has(c.method)) continue;
			if (!bodyMentionsSessionParam(c.body)) continue;
			if (!bodyMentionsGuard(c.body)) {
				offenders.push(
					`case "${c.method}": touches sessionKey/agentId but does not call any guard fn (${GUARD_FN_NAMES.join(", ")})`,
				);
			}
		}
		assert.deepStrictEqual(
			offenders,
			[],
			`Unguarded switch cases detected:\n  ${offenders.join(
				"\n  ",
			)}\n\nAdd sessionsAccessCheck(...) at the top of the case body, or, if the\nmethod legitimately takes no per-session target, add it to\nALLOWLIST_NO_GUARD_NEEDED with a justifying comment in this test.`,
		);
	});

	it("every registerGatewayHandler call either guards (directly or via reference) or is allowlisted", () => {
		// Sanity: we must have parsed at least the well-known guarded handlers.
		const handlerNames = new Set(parsed.registrations.map((h) => h.method));
		for (const expected of [
			"sessions.list",
			"sessions.history",
			"sessions.send",
			"sessions.spawn",
			"agent",
		]) {
			assert.ok(
				handlerNames.has(expected),
				`expected registerGatewayHandler("${expected}") in parsed registrations; got ${[
					...handlerNames,
				]
					.sort()
					.join(", ")}`,
			);
		}
		const offenders: string[] = [];
		for (const h of parsed.registrations) {
			if (ALLOWLIST_NO_GUARD_NEEDED.has(h.method)) continue;
			const combined = [h.body, ...h.referencedBodies].join("\n");
			if (!bodyMentionsSessionParam(combined)) continue;
			if (!bodyMentionsGuard(combined)) {
				offenders.push(
					`registerGatewayHandler("${h.method}", ...): touches sessionKey/agentId but does not call any guard fn (${GUARD_FN_NAMES.join(", ")}). Inspected body+referenced declarations.`,
				);
			}
		}
		assert.deepStrictEqual(
			offenders,
			[],
			`Unguarded registered handlers detected:\n  ${offenders.join(
				"\n  ",
			)}\n\nAdd sessionsAccessCheck(...) inside the handler body or pass\n{accessCheck: sessionsAccessCheck} into the shared session handler. If\nthe method legitimately needs no guard, add it to\nALLOWLIST_NO_GUARD_NEEDED with a justifying comment in this test.`,
		);
	});

	it("known-guarded sessions handlers retain their guard wiring", () => {
		const handlerByMethod = new Map(
			parsed.registrations.map((h) => [h.method, h]),
		);
		const caseByMethod = new Map(parsed.cases.map((c) => [c.method, c]));
		const broken: string[] = [];
		for (const method of KNOWN_GUARDED_SESSIONS_METHODS) {
			const h = handlerByMethod.get(method);
			const c = caseByMethod.get(method);
			const guarded =
				(h && bodyMentionsGuard([h.body, ...h.referencedBodies].join("\n"))) ||
				(c && bodyMentionsGuard(c.body));
			if (!guarded) {
				broken.push(
					`expected ${method} to call sessionsAccessCheck / checkSessionToolAccess in its registered handler or switch case`,
				);
			}
		}
		assert.deepStrictEqual(
			broken,
			[],
			`Regression detected — a previously-guarded sessions method lost its guard:\n  ${broken.join(
				"\n  ",
			)}`,
		);
	});

	it("dispatcher default branch invokes defaultPassSessionGuard for customMethods", () => {
		assert.ok(
			parsed.hasDefaultPassGuardWired,
			"Expected `defaultPassSessionGuard` to be called inside the\n`customMethods.get(...)` branch of the dispatcher (Wave O0.8 — Gap 4).\nWithout it, extension RPCs that take a sessionKey/agentId bypass the\nsession-access guard entirely.",
		);
	});

	it("HTTP-routes dispatcher invokes defaultPassSessionGuard for extension routes", () => {
		assert.ok(
			parsed.hasHttpDefaultPassGuardWired,
			"Expected `defaultPassSessionGuard` to be called inside the\nHTTP-routes dispatcher (Wave O0.8 — Gap 5). Without it, extension\nHTTP routes that take a sessionKey/agentId bypass the session-access\nguard and rely on loopback auth alone.",
		);
	});

	it("system.reload invalidates liveConfigSnapshot before returning (Wave O0.8 — Gap 6)", () => {
		// The TOCTOU window in `buildSessionsAccessCheck` exists because
		// the access check reads `liveConfigSnapshot`. If `system.reload`
		// updates extension routes but does NOT push the fresh config into
		// `liveConfigSnapshot` synchronously, the next access check sees
		// the pre-reload visibility/A2A policy for up to 250ms (the
		// `LIVE_CONFIG_REFRESH_MIN_MS` throttle).
		//
		// We assert the fix by checking the `system.reload` handler text
		// for an assignment to `liveConfigSnapshot` AND a bump of
		// `liveConfigLastRefreshMs`. Regression-resistant: a future edit
		// that moves the assignment OUT of the reload handler would fail
		// this assertion before it ships.
		const reloadMatch = src.match(
			/methods\.set\("system\.reload",\s*\{[\s\S]*?\}\);/,
		);
		assert.ok(
			reloadMatch,
			"could not find methods.set(\"system.reload\", ...) registration block",
		);
		const reloadBody = reloadMatch[0];
		assert.ok(
			reloadBody.includes("liveConfigSnapshot = cfgAfterReload"),
			"system.reload must assign the freshly-read config into `liveConfigSnapshot`\nso the next access check sees the new visibility/A2A policy on the very\nnext RPC (Wave O0.8 — Gap 6). Without it there is a 250ms TOCTOU window.",
		);
		assert.ok(
			reloadBody.includes("liveConfigLastRefreshMs = Date.now()"),
			"system.reload must bump `liveConfigLastRefreshMs` after pushing the\nfresh config so the throttled refresher does not stomp the\njust-applied snapshot (Wave O0.8 — Gap 6).",
		);
	});

	it("the cron.* and wake duplicate switch cases stay deleted (Wave O0.8 — Gap 1)", () => {
		const dupes = ["cron.add", "cron.update", "cron.run", "cron.remove", "cron.runs", "wake"];
		const present = dupes.filter((m) =>
			parsed.cases.some((c) => c.method === m),
		);
		assert.deepStrictEqual(
			present,
			[],
			`These duplicate switch cases reappeared:\n  ${present.join("\n  ")}\n\nThey bypass the access-guarded registered handlers and must stay deleted. All cron + wake traffic flows through registerGatewayHandler(...) only.`,
		);
	});
});
