import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isUnknownCommandAttempt, nearestSlashCommand } from "./slash-suggest.js";

// A representative slice of the real registry, including the deliberately
// confusable neighbours (`session`/`sessions`, `search`/`switch`).
const CMDS = [
	"help", "exit", "quit", "abort", "copy", "expand", "steer", "flush", "new",
	"clear", "reset", "switch", "cancel", "clip", "agent", "agents", "session", "sessions",
	"rename", "delete", "mute", "org", "model", "provider", "thinking",
	"reasoning", "compact", "export", "search", "rewind", "usage", "context",
	"update",
];

describe("nearestSlashCommand", () => {
	it("catches a transposition — the most common typo of all", () => {
		assert.equal(nearestSlashCommand("hlep", CMDS), "help");
		assert.equal(nearestSlashCommand("comapct", CMDS), "compact");
	});

	it("completes an unambiguous prefix", () => {
		// Edit distance alone would not reach `session` from `sess` (3 edits).
		assert.equal(nearestSlashCommand("sess", CMDS), "session");
		assert.equal(nearestSlashCommand("rew", CMDS), "rewind");
	});

	it("says nothing when a prefix is ambiguous", () => {
		// `se` matches session, sessions, search. Picking one is a coin flip
		// presented as advice.
		assert.equal(nearestSlashCommand("se", CMDS), undefined);
		assert.equal(nearestSlashCommand("c", CMDS), undefined);
	});

	it("says nothing when nothing is close", () => {
		assert.equal(nearestSlashCommand("deploy", CMDS), undefined);
		assert.equal(nearestSlashCommand("xyzzy", CMDS), undefined);
		assert.equal(nearestSlashCommand("", CMDS), undefined);
	});

	it("does not suggest across a different first letter", () => {
		// `mew` is one edit from BOTH `new` and `mute`-ish neighbours; requiring
		// a shared first letter keeps the answer from reading as a non-sequitur.
		const r = nearestSlashCommand("mew", CMDS);
		assert.notEqual(r, "new");
	});

	it("refuses to guess on a tie", () => {
		// Equidistant candidates mean there is no right answer to give.
		assert.equal(nearestSlashCommand("se_rch", ["search", "se-rch"]), undefined);
	});

	it("is case-insensitive", () => {
		assert.equal(nearestSlashCommand("HLEP", CMDS), "help");
	});

	it("allows a second edit only for longer words", () => {
		// Two edits on a 4-letter word would suggest almost anything.
		assert.equal(nearestSlashCommand("reasonin", CMDS), "reasoning");
		assert.equal(nearestSlashCommand("nwe", CMDS), "new");
		// Two edits on a 4-letter word must stay out of budget.
		assert.equal(nearestSlashCommand("hxxp", CMDS), undefined);
	});
});

// The guard decides between "unknown command" and "send this to the model".
// It must be conservative in ONE direction: refusing real input is far worse
// than forwarding a typo, because the operator loses what they typed.
describe("isUnknownCommandAttempt", () => {
	const known = (w: string) => CMDS.includes(w);

	it("refuses a plausible command word that is not registered", () => {
		assert.equal(isUnknownCommandAttempt("/hlep", known), true);
		assert.equal(isUnknownCommandAttempt("/deploy", known), true);
		assert.equal(isUnknownCommandAttempt("/hlep me please", known), true);
	});

	it("lets registered commands through untouched", () => {
		assert.equal(isUnknownCommandAttempt("/help", known), false);
		assert.equal(isUnknownCommandAttempt("/model gpt-5", known), false);
		assert.equal(isUnknownCommandAttempt("/CLEAR", known), false);
	});

	it("never eats a path", () => {
		// The single most likely false positive: someone pasting a path.
		assert.equal(isUnknownCommandAttempt("/usr/local/bin", known), false);
		assert.equal(isUnknownCommandAttempt("/etc/hosts is the file", known), false);
		assert.equal(isUnknownCommandAttempt("/Users/me/dev", known), false);
	});

	it("never eats a regex or a date", () => {
		assert.equal(isUnknownCommandAttempt("/^foo$/", known), false);
		assert.equal(isUnknownCommandAttempt("/2026/09/01", known), false);
	});

	it("never eats a bare slash or ordinary prose", () => {
		assert.equal(isUnknownCommandAttempt("/", known), false);
		assert.equal(isUnknownCommandAttempt("and/or", known), false);
		assert.equal(isUnknownCommandAttempt("what is 6/2?", known), false);
		assert.equal(isUnknownCommandAttempt("", known), false);
	});
});

// `/clear`, `/new` and `/reset` are one command with three names, matching the
// reference harness (its docs list `/reset` and `/new` as aliases of `/clear`).
// A typo of any of them should land on a real one.
describe("the clear/new/reset family", () => {
	const known = (w: string) => CMDS.includes(w);

	it("all three are registered, so none is refused as unknown", () => {
		for (const c of ["clear", "new", "reset"]) {
			assert.equal(isUnknownCommandAttempt(`/${c}`, known), false, `/${c} must be known`);
		}
	});

	it("a typo of one lands on it", () => {
		assert.equal(nearestSlashCommand("clera", CMDS), "clear");
		assert.equal(nearestSlashCommand("rest", CMDS), "reset");
	});

	it("a name argument does not make it unknown", () => {
		assert.equal(isUnknownCommandAttempt("/clear before the refactor", known), false);
	});
});
