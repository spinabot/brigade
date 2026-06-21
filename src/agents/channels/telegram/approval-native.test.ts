import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { decodeApprovalCallback } from "../approval-callback-codec.js";
import {
	buildTelegramApprovalKeyboard,
	buildTelegramApprovalText,
	sanitizeTelegramCallbackData,
	TELEGRAM_CALLBACK_DATA_MAX_BYTES,
} from "./approval-native.js";

describe("buildTelegramApprovalKeyboard", () => {
	it("builds Allow once / Allow always / Deny buttons whose data decodes back", () => {
		const kb = buildTelegramApprovalKeyboard({ approvalId: "exec-abc-123" });
		assert.ok(kb, "keyboard must be built for a normal approval id");
		const flat = kb!.inline_keyboard.flat();
		assert.equal(flat.length, 3);
		assert.deepEqual(
			flat.map((b) => b.text),
			["Allow once", "Allow always", "Deny"],
		);
		// Each callback_data round-trips through the central codec to the SAME id.
		const decisions = flat.map((b) => decodeApprovalCallback(b.callback_data));
		assert.equal(decisions[0]?.approvalId, "exec-abc-123");
		assert.equal(decisions[0]?.decision, "allow-once");
		assert.equal(decisions[1]?.decision, "allow-always");
		assert.equal(decisions[2]?.decision, "deny");
	});

	it("drops the Allow always button when allowAlways=false", () => {
		const kb = buildTelegramApprovalKeyboard({ approvalId: "x", allowAlways: false });
		assert.ok(kb);
		const labels = kb!.inline_keyboard.flat().map((b) => b.text);
		assert.deepEqual(labels, ["Allow once", "Deny"]);
	});

	it("returns null when the approval id is too long for byte-safe buttons", () => {
		// A pathologically long id whose encoded payload blows the 64-byte budget.
		const kb = buildTelegramApprovalKeyboard({ approvalId: "z".repeat(200) });
		assert.equal(kb, null, "caller falls back to the text prompt");
	});

	it("every callback_data stays within Telegram's 64-byte budget", () => {
		const kb = buildTelegramApprovalKeyboard({ approvalId: "exec-1234567890" });
		for (const b of kb!.inline_keyboard.flat()) {
			assert.ok(Buffer.byteLength(b.callback_data, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES);
		}
	});
});

describe("sanitizeTelegramCallbackData", () => {
	it("strips control bytes and clamps to the byte budget", () => {
		// Build a payload with embedded control bytes (NUL, BEL, DEL) via char codes
		// so the test source stays pure printable ASCII.
		const withControls = `bv1${String.fromCharCode(0)}:abc${String.fromCharCode(7)}:o${String.fromCharCode(127)}`;
		const cleaned = sanitizeTelegramCallbackData(withControls);
		// oxlint-disable-next-line no-control-regex
		assert.ok(!/[\x00-\x1f\x7f]/.test(cleaned), "no control bytes survive");
		assert.equal(cleaned, "bv1:abc:o");
		assert.ok(Buffer.byteLength(cleaned, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES);
	});
});

describe("buildTelegramApprovalText", () => {
	it("includes the command preview + a brand mark, control-char scrubbed", () => {
		const text = buildTelegramApprovalText({
			command: "rm -rf /tmp/x\nthen more",
			approvalKind: "exec",
		});
		assert.match(text, /Brigade/);
		assert.match(text, /rm -rf/);
		// Newlines in the command are flattened (the prompt has its own line breaks).
		assert.ok(!text.includes("x\nthen"), "command newlines must be collapsed");
	});

	it("labels a plugin approval differently from an exec one", () => {
		const plugin = buildTelegramApprovalText({ command: "do thing", approvalKind: "plugin" });
		assert.match(plugin, /plugin action/);
	});
});
