/**
 * Tests for arXiv provider — keyless identity + Atom XML parser.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createArxivSearchProvider, parseArxivAtom } from "./arxiv.js";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <published>2024-01-15T00:00:00Z</published>
    <title>A Study of Transformer Attention</title>
    <summary>We investigate how attention heads specialize during training.</summary>
    <author><name>Alice Researcher</name></author>
    <author><name>Bob Scholar</name></author>
    <link href="http://arxiv.org/abs/2401.12345v1" rel="alternate" type="text/html"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2402.99999v2</id>
    <published>2024-02-01T00:00:00Z</published>
    <title>Diffusion Models Revisited</title>
    <summary>A new perspective on noise schedules.</summary>
    <author><name>Carol Author</name></author>
    <link href="http://arxiv.org/abs/2402.99999v2" rel="alternate" type="text/html"/>
  </entry>
</feed>`;

describe("createArxivSearchProvider", () => {
	const p = createArxivSearchProvider();
	it("keyless + identity", () => {
		assert.equal(p.id, "arxiv");
		assert.equal(p.requiresCredential, false);
	});
});

describe("parseArxivAtom", () => {
	it("extracts title + url + summary + authors + published", () => {
		const r = parseArxivAtom(SAMPLE, 10);
		assert.equal(r.length, 2);
		assert.equal(r[0]?.title, "A Study of Transformer Attention");
		assert.equal(r[0]?.url, "http://arxiv.org/abs/2401.12345v1");
		assert.match(r[0]?.snippet ?? "", /attention heads/);
		assert.equal(r[0]?.authors, "Alice Researcher, Bob Scholar");
		assert.equal(r[0]?.published, "2024-01-15T00:00:00Z");
	});
	it("respects max-result cap", () => {
		const r = parseArxivAtom(SAMPLE, 1);
		assert.equal(r.length, 1);
	});
	it("returns empty for non-Atom input", () => {
		assert.deepEqual(parseArxivAtom("not xml", 10), []);
	});
});
