import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore } from "../store/records.js";
import { Tideline } from "./tideline.js";

describe("Tideline factory receiver compatibility", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "tideline-factory-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("a detached open factory preserves filesystem persistence and explicit adapters", () => {
		const { open } = Tideline;
		const memory = open(dir, { threatScan: { scan: () => ["factory-fixture"] } });
		assert.ok(memory instanceof Tideline);
		const record = memory.add({ content: "Deployment target is staging.", segment: "knowledge" });
		assert.equal(new FactStore(dir).readAll()[0]?.memoryId, record.memoryId);
		assert.match(memory.context("deployment staging") ?? "", /factory-fixture/);
	});

	it("a detached over factory keeps the provided store and explicit adapters", () => {
		const store = new FactStore(dir);
		const { over } = Tideline;
		const memory = over(store, { threatScan: { scan: () => ["over-fixture"] } });
		assert.ok(memory instanceof Tideline);
		const record = memory.add({ content: "Shared deployment target is staging.", segment: "knowledge" });
		assert.equal(store.readAll()[0]?.memoryId, record.memoryId);
		assert.match(memory.context("shared deployment") ?? "", /over-fixture/);
	});

	it("factories placed on an unrelated object retain their original facade defaults", () => {
		class MetadataPrototype extends Tideline {}
		const registry = { open: Tideline.open, over: Tideline.over, prototype: MetadataPrototype.prototype };
		const opened = registry.open(path.join(dir, "registry-open"));
		const store = new FactStore(path.join(dir, "registry-over"));
		const wrapped = registry.over(store);
		assert.ok(opened instanceof Tideline);
		assert.ok(wrapped instanceof Tideline);
		const record = wrapped.add({ content: "Registry factory preserves deployment evidence.", segment: "knowledge" });
		assert.equal(store.readAll()[0]?.memoryId, record.memoryId);
	});

	it("bound factories retain subclass identity", () => {
		class CustomTideline extends Tideline {}
		const opened = CustomTideline.open(path.join(dir, "opened"));
		const wrapped = CustomTideline.over(new FactStore(path.join(dir, "wrapped")));
		assert.ok(opened instanceof CustomTideline);
		assert.ok(wrapped instanceof CustomTideline);
		assert.ok(opened instanceof Tideline);
		assert.ok(wrapped instanceof Tideline);
	});
});
