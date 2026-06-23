import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	isChannelVisibleInConfiguredLists,
	isChannelVisibleInDocs,
	isChannelVisibleInSetup,
	resolveChannelExposure,
} from "./exposure.js";

describe("resolveChannelExposure", () => {
	it("defaults every surface to visible when nothing is declared", () => {
		assert.deepEqual(resolveChannelExposure({}), {
			configured: true,
			setup: true,
			docs: true,
		});
	});

	it("treats undefined / null meta as fully visible", () => {
		assert.deepEqual(resolveChannelExposure(undefined), {
			configured: true,
			setup: true,
			docs: true,
		});
		assert.deepEqual(resolveChannelExposure(null), {
			configured: true,
			setup: true,
			docs: true,
		});
	});

	it("honors explicit exposure object overrides per surface", () => {
		assert.deepEqual(
			resolveChannelExposure({ exposure: { configured: false, setup: false, docs: true } }),
			{ configured: false, setup: false, docs: true },
		);
	});

	it("falls back to the legacy showConfigured flag when exposure.configured is absent", () => {
		assert.equal(resolveChannelExposure({ showConfigured: false }).configured, false);
		// exposure.configured wins over the legacy flag when both are present.
		assert.equal(
			resolveChannelExposure({ showConfigured: false, exposure: { configured: true } }).configured,
			true,
		);
	});

	it("falls back to the legacy showInSetup flag when exposure.setup is absent", () => {
		assert.equal(resolveChannelExposure({ showInSetup: false }).setup, false);
		assert.equal(
			resolveChannelExposure({ showInSetup: false, exposure: { setup: true } }).setup,
			true,
		);
	});

	it("docs defaults true and is only flipped by exposure.docs (no legacy flag)", () => {
		assert.equal(resolveChannelExposure({}).docs, true);
		assert.equal(resolveChannelExposure({ exposure: { docs: false } }).docs, false);
	});

	it("resolves a partial exposure object — unset keys still default true", () => {
		assert.deepEqual(resolveChannelExposure({ exposure: { setup: false } }), {
			configured: true,
			setup: false,
			docs: true,
		});
	});
});

describe("exposure surface predicates", () => {
	it("isChannelVisibleInConfiguredLists reads the configured verdict", () => {
		assert.equal(isChannelVisibleInConfiguredLists({}), true);
		assert.equal(isChannelVisibleInConfiguredLists({ exposure: { configured: false } }), false);
		assert.equal(isChannelVisibleInConfiguredLists({ showConfigured: false }), false);
	});

	it("isChannelVisibleInSetup reads the setup verdict", () => {
		assert.equal(isChannelVisibleInSetup({}), true);
		assert.equal(isChannelVisibleInSetup({ exposure: { setup: false } }), false);
		assert.equal(isChannelVisibleInSetup({ showInSetup: false }), false);
	});

	it("isChannelVisibleInDocs reads the docs verdict", () => {
		assert.equal(isChannelVisibleInDocs({}), true);
		assert.equal(isChannelVisibleInDocs({ exposure: { docs: false } }), false);
	});
});
