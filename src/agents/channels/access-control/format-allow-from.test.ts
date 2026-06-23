/**
 * Tests for the shared `formatAllowFrom` display helper (Item #8).
 *
 * Covers id-only rendering, `{ id, name }` rendering (`name (id)`), the empty
 * case (default + custom), header/label handling, the `omitHeader` variant, and
 * the defensive coercions (numbers, blank ids, nullish input).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { formatAllowFrom } from "./format-allow-from.js";

describe("formatAllowFrom — empty", () => {
	it("returns the default empty line for an empty list", () => {
		assert.equal(formatAllowFrom([]), "Allow-from list is empty.");
	});

	it("returns the default empty line for nullish input", () => {
		assert.equal(formatAllowFrom(null), "Allow-from list is empty.");
		assert.equal(formatAllowFrom(undefined), "Allow-from list is empty.");
	});

	it("honors a custom emptyText", () => {
		assert.equal(
			formatAllowFrom([], { emptyText: "No senders are on whatsapp's allow-from list yet." }),
			"No senders are on whatsapp's allow-from list yet.",
		);
	});

	it("treats a list of only blank ids as empty", () => {
		assert.equal(formatAllowFrom(["", "   "]), "Allow-from list is empty.");
	});
});

describe("formatAllowFrom — ids", () => {
	it("renders bare ids under the default header", () => {
		assert.equal(
			formatAllowFrom(["15551234567", "15559876543"]),
			"Allow-from (2):\n  15551234567\n  15559876543",
		);
	});

	it("renders a label header when channelLabel is given", () => {
		assert.equal(
			formatAllowFrom(["15551234567"], { channelLabel: "WhatsApp" }),
			"WhatsApp allow-from (1):\n  15551234567",
		);
	});

	it("coerces numeric ids to strings", () => {
		assert.equal(formatAllowFrom([123, 456]), "Allow-from (2):\n  123\n  456");
	});

	it("drops blank entries but keeps the rest (count reflects kept)", () => {
		assert.equal(
			formatAllowFrom(["alex", "", "  ", "bob"]),
			"Allow-from (2):\n  alex\n  bob",
		);
	});

	it("omitHeader emits only the indented id lines", () => {
		assert.equal(formatAllowFrom(["a", "b"], { omitHeader: true }), "  a\n  b");
	});

	it("honors a custom indent", () => {
		assert.equal(
			formatAllowFrom(["a"], { indent: "    " }),
			"Allow-from (1):\n    a",
		);
	});
});

describe("formatAllowFrom — names", () => {
	it("renders `name (id)` for entries carrying a name", () => {
		assert.equal(
			formatAllowFrom([{ id: "U123", name: "Alex" }, { id: "U456", name: "Bob" }], {
				channelLabel: "Slack",
			}),
			"Slack allow-from (2):\n  Alex (U123)\n  Bob (U456)",
		);
	});

	it("falls back to the bare id when an entry has no (or a blank) name", () => {
		assert.equal(
			formatAllowFrom([{ id: "U123", name: "  " }, { id: "U456" }]),
			"Allow-from (2):\n  U123\n  U456",
		);
	});

	it("mixes bare ids and { id, name } entries", () => {
		assert.equal(
			formatAllowFrom(["15551234567", { id: "U999", name: "Carol" }]),
			"Allow-from (2):\n  15551234567\n  Carol (U999)",
		);
	});

	it("drops an entry whose id is blank even when a name is present", () => {
		assert.equal(
			formatAllowFrom([{ id: "  ", name: "Ghost" }, { id: "real" }]),
			"Allow-from (1):\n  real",
		);
	});
});
