/**
 * Redactor tests — Google `AQ.` / `AIza` key handling across BOTH redactors:
 * the cron-summary redactor (`redact.ts`) and the sessions/history redactor
 * (`agents/tools/sessions/shared.ts`) — plus the false-positive guard that
 * keeps dotted identifiers (`com.AQ.<name>`) out of the redaction.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { redactSensitiveText as redactSession } from "../agents/tools/sessions/shared.js";
import { redactSensitiveText as redactLog } from "./redact.js";

// A realistic-shaped Google AQ. key (base64url body, ≥30 chars).
const AQ_KEY = "AQ.Ab8RN6K7pQ2wXyZ0aB1cD2eF3gH4iJ5kL6mN7oP";
// A legit dotted identifier a naive `AQ.\w{30,}` would wrongly redact: AQ is
// preceded by a dot (the tightened lookbehind must skip it), and its tail is
// <40 chars so the standalone-base64 rule doesn't grab it either.
const DOTTED_IDENT = "com.AQ.serviceRegistryFactoryBeanConfig12";

describe("redact.ts (cron summariser) — Google keys", () => {
	it("redacts a standalone AQ. key", () => {
		assert.match(redactLog(AQ_KEY), /<redacted:provider-key>/);
		assert.doesNotMatch(redactLog(AQ_KEY), /Ab8RN6/);
	});
	it("redacts a key in an assignment (VAR=AQ.…)", () => {
		assert.match(redactLog(`GEMINI=${AQ_KEY}`), /<redacted:provider-key>/);
	});
	it("does NOT redact a dotted identifier like com.AQ.<name> (false-positive guard)", () => {
		assert.strictEqual(redactLog(DOTTED_IDENT), DOTTED_IDENT);
	});
});

// An OpenCode key: "sk-" + 64 [A-Za-z0-9]. Synthetic. No dedicated pattern exists
// for it — these pin that the generic `sk-` rules cover it in both redactors.
const OPENCODE_KEY = `sk-${"Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3Wx4Yz5Ab6Cd7Ef8Gh9Ij0Kl1Mn2Op3"}`;

describe("both redactors — OpenCode keys are covered by the existing sk- rules", () => {
	it("redacts an OpenCode key from a cron summary", () => {
		assert.match(redactLog(`OPENCODE_API_KEY=${OPENCODE_KEY}`), /<redacted:/);
		assert.doesNotMatch(redactLog(OPENCODE_KEY), /Ab3Cd4/);
	});
	it("redacts an OpenCode key from transcript history", () => {
		assert.match(redactSession(`key: ${OPENCODE_KEY}`), /\[redacted\]/);
		assert.doesNotMatch(redactSession(`key: ${OPENCODE_KEY}`), /Ab3Cd4/);
	});
});

describe("sessions/shared.ts (history redactor) — Google keys now caught (#65)", () => {
	it("redacts an AQ. key in transcript text — the leak the fix targeted", () => {
		assert.match(redactSession(`answer: ${AQ_KEY}`), /\[redacted\]/);
		assert.doesNotMatch(redactSession(`answer: ${AQ_KEY}`), /Ab8RN6/);
	});
	it("redacts a legacy AIza key too", () => {
		assert.match(redactSession(`AIza${"C".repeat(35)}`), /\[redacted\]/);
	});
	it("leaves a dotted identifier alone (false-positive guard)", () => {
		assert.strictEqual(redactSession(DOTTED_IDENT), DOTTED_IDENT);
	});
});
