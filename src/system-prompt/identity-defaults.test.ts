import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	registerChannelMeta,
	resetChannelMetaRegistryForTests,
} from "../agents/channels/channel-meta-registry.js";
import type { ChannelMeta } from "../agents/channels/types.core.js";
import { resolveOutputFormattingDirective } from "./identity-defaults.js";

afterEach(() => {
	resetChannelMetaRegistryForTests();
});

function fakeMeta(id: string, markdownCapable: boolean): ChannelMeta {
	return {
		id,
		label: id,
		selectionLabel: id,
		docsPath: `channels/${id}`,
		blurb: "",
		markdownCapable,
	};
}

describe("resolveOutputFormattingDirective (FIX 9 markdown gate consumption)", () => {
	it("returns undefined for a markdown-capable channel (markdown stays on)", () => {
		// Bundled WhatsApp + Telegram declare markdownCapable: true.
		assert.equal(resolveOutputFormattingDirective("whatsapp"), undefined);
		assert.equal(resolveOutputFormattingDirective("telegram"), undefined);
	});

	it("returns undefined for an UNKNOWN channel (no regression — default markdown on)", () => {
		assert.equal(resolveOutputFormattingDirective("signal"), undefined);
	});

	it("returns undefined for the cli / tui / internal surfaces and for no channel", () => {
		assert.equal(resolveOutputFormattingDirective("cli"), undefined);
		assert.equal(resolveOutputFormattingDirective("tui"), undefined);
		assert.equal(resolveOutputFormattingDirective("internal"), undefined);
		assert.equal(resolveOutputFormattingDirective(undefined), undefined);
		assert.equal(resolveOutputFormattingDirective(null), undefined);
		assert.equal(resolveOutputFormattingDirective(""), undefined);
	});

	it("returns a plain-text directive ONLY for a channel that opted out (markdownCapable: false)", () => {
		registerChannelMeta(fakeMeta("sms", false));
		const directive = resolveOutputFormattingDirective("sms");
		assert.ok(directive, "expected a directive for a non-markdown channel");
		assert.match(directive ?? "", /## Output Formatting/);
		assert.match(directive ?? "", /PLAIN TEXT/);
		assert.match(directive ?? "", /Do not use markdown/);
	});
});
