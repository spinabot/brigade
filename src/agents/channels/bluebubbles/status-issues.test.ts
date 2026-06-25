import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	collectBlueBubblesStatusIssues,
	statusAccountFromSnapshot,
	toChannelStatusIssues,
} from "./status-issues.js";

describe("collectBlueBubblesStatusIssues", () => {
	it("surfaces a structured unreachable issue with a fix hint", () => {
		const issues = collectBlueBubblesStatusIssues([{ accountId: "home", configured: true, reachable: false }]);
		assert.equal(issues.length, 1);
		assert.equal(issues[0]!.channel, "bluebubbles");
		assert.equal(issues[0]!.accountId, "home");
		assert.equal(issues[0]!.kind, "unreachable");
		assert.match(issues[0]!.message, /unreachable/i);
		assert.match(issues[0]!.fix, /BlueBubbles Server app is running/i);
	});

	it("surfaces not-configured (and nothing else) for an unconfigured account", () => {
		const issues = collectBlueBubblesStatusIssues([{ accountId: "home", configured: false, reachable: false, privateApi: false }]);
		assert.equal(issues.length, 1);
		assert.equal(issues[0]!.kind, "not-configured");
		assert.match(issues[0]!.fix, /serverUrl \+ password|channels add bluebubbles/);
	});

	it("surfaces private-api-off when reachable but the Private API is disabled", () => {
		const issues = collectBlueBubblesStatusIssues([{ accountId: "home", configured: true, reachable: true, privateApi: false }]);
		assert.equal(issues.length, 1);
		assert.equal(issues[0]!.kind, "private-api-off");
		assert.match(issues[0]!.fix, /Enable the Private API/i);
	});

	it("contributes nothing for a healthy account", () => {
		const issues = collectBlueBubblesStatusIssues([{ accountId: "home", configured: true, reachable: true, privateApi: true }]);
		assert.deepEqual(issues, []);
	});

	it("does not flag the Private API when the account is unreachable", () => {
		const issues = collectBlueBubblesStatusIssues([{ accountId: "home", configured: true, reachable: false, privateApi: false }]);
		assert.equal(issues.length, 1);
		assert.equal(issues[0]!.kind, "unreachable");
	});
});

describe("toChannelStatusIssues", () => {
	it("maps kinds to central severities + folds the fix into the message", () => {
		const rich = collectBlueBubblesStatusIssues([
			{ accountId: "a", configured: true, reachable: false },
			{ accountId: "b", configured: true, reachable: true, privateApi: false },
		]);
		const rows = toChannelStatusIssues(rich);
		assert.equal(rows.length, 2);
		assert.equal(rows[0]!.severity, "error"); // unreachable
		assert.equal(rows[1]!.severity, "warn"); // private-api-off
		assert.match(rows[0]!.message, /unreachable.*BlueBubbles Server app is running/i);
	});
});

describe("statusAccountFromSnapshot", () => {
	it("reads stamped diagnostics off an open-shaped snapshot", () => {
		const acc = statusAccountFromSnapshot({ id: "home", configured: true, reachable: false, privateApi: null });
		assert.deepEqual(acc, { accountId: "home", configured: true, reachable: false, privateApi: null });
	});

	it("treats a snapshot without flags as not-configured", () => {
		const acc = statusAccountFromSnapshot({ id: "home" });
		assert.equal(acc.configured, false);
		assert.equal(acc.reachable, undefined);
	});
});
