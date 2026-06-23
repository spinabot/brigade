import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { classifyProbeFailure, probeGateway } from "./gateway-probe.js";

describe("probeGateway — teardown safety", () => {
	it("resolves to unreachable (does not crash) when the connection times out mid-handshake", async () => {
		// 192.0.2.1 is TEST-NET-1 (RFC 5737) — guaranteed unroutable, so the TCP
		// connect stalls and the probe hits its own timeout while the socket is
		// still CONNECTING. Closing a still-connecting `ws` emits an 'error'
		// event; before the fix the probe had removed its listeners first, so
		// that error was unhandled and crashed the whole process (the reported
		// `brigade tui` crash). It must now resolve cleanly instead of throwing.
		const result = await probeGateway({ host: "192.0.2.1", port: 7777, timeoutMs: 400 });
		assert.equal(result.reachable, false);
		assert.ok(result.error, "a human-readable failure reason should be set");
	});

	it("never rejects on a refused connection", async () => {
		// Nothing listening on this loopback port → fast ECONNREFUSED, handled
		// by the error path (not the timeout path). Still resolves, never throws.
		const result = await probeGateway({ host: "127.0.0.1", port: 1, timeoutMs: 400 });
		assert.equal(result.reachable, false);
	});

	it("classifies failure messages into recovery-friendly kinds", () => {
		assert.equal(classifyProbeFailure(new Error("connect ECONNREFUSED 127.0.0.1:7777")), "refused");
		assert.equal(classifyProbeFailure("getaddrinfo ENOTFOUND nope"), "dns");
		assert.equal(classifyProbeFailure("timed out after 1500ms"), "timeout");
	});
});
