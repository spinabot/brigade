import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import ts from "typescript";

import { EVENT_NAMES, REQUEST_METHODS } from "../protocol.js";
import { PROTOCOL_CAPABILITIES } from "../protocol/handshake.js";
import { buildGatewayFeatures } from "./gateway-features.js";
import { createInProcessGatewayCaller, registerGatewayHandler, resetGatewayHandlersForTests } from "./gateway-caller-impl.js";

let stateDir: string;
let previousStateDir: string | undefined;
beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-gateway-features-"));
	previousStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
	resetGatewayHandlersForTests();
});
afterEach(() => {
	resetGatewayHandlersForTests();
	if (previousStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = previousStateDir;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("gateway hello feature construction", () => {
	it("advertises registry-only callable memory methods and preserves existing wire/extension order", async () => {
		registerGatewayHandler("memory.write", () => ({ stored: true }));
		registerGatewayHandler("memory.manage", () => ({ inspected: true }));
		registerGatewayHandler("status", () => ({})); // overlaps the static surface
		const customMethods = new Map([["custom.first", {}], ["memory.write", {}], ["custom.last", {}], ["status", {}]]);
		const features = buildGatewayFeatures(customMethods.keys());
		const existing = [...new Set([...REQUEST_METHODS, ...customMethods.keys()])];
		assert.deepEqual(features.methods, [...existing, "memory.manage"]);
		assert.equal(features.methods.filter((method) => method === "memory.write").length, 1);
		assert.equal(features.methods.filter((method) => method === "status").length, 1);
		assert.deepEqual(features.events, EVENT_NAMES);
		assert.deepEqual(features.capabilities, PROTOCOL_CAPABILITIES);
		// The discovery source is the actual callable registry, not a second list.
		const caller = createInProcessGatewayCaller();
		assert.deepEqual(await caller.call({ method: "memory.write" }), { stored: true });
		assert.deepEqual(await caller.call({ method: "memory.manage" }), { inspected: true });
	});

	it("takes fresh snapshots after registration, disposal and extension-map replacement", () => {
		const before = buildGatewayFeatures(["custom.old"]);
		const dispose = registerGatewayHandler("memory.write", () => ({}));
		const afterRegistration = buildGatewayFeatures(["custom.new"]);
		assert.ok(!before.methods.includes("memory.write"));
		assert.ok(afterRegistration.methods.includes("memory.write"));
		assert.ok(!afterRegistration.methods.includes("custom.old"));
		assert.ok(afterRegistration.methods.includes("custom.new"));
		dispose();
		assert.ok(!buildGatewayFeatures([]).methods.includes("memory.write"));
		assert.ok(afterRegistration.methods.includes("memory.write"), "prior connection snapshot stays immutable by registry changes");
	});

	it("advertises a replaced handler only once and ignores a stale disposer", async () => {
		const disposeOld = registerGatewayHandler("memory.manage", () => "old");
		const disposeNew = registerGatewayHandler("memory.manage", () => "new");
		disposeOld();
		assert.equal(buildGatewayFeatures(["memory.manage", "memory.manage"]).methods.filter((method) => method === "memory.manage").length, 1);
		assert.equal(await createInProcessGatewayCaller().call({ method: "memory.manage" }), "new");
		disposeNew();
		assert.ok(!buildGatewayFeatures([]).methods.includes("memory.manage"));
	});

	it("server hello uses the production builder with the current extension map", () => {
		const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
		let featureCall: ts.CallExpression | undefined;
		function visit(node: ts.Node): void {
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "helloOk" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
				for (const property of node.initializer.properties) {
					if (ts.isPropertyAssignment(property) && property.name.getText(source) === "features" && ts.isCallExpression(property.initializer)) {
						featureCall = property.initializer;
					}
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
		assert.ok(featureCall, "hello-ok must construct features through the tested live-registry path");
		assert.equal(featureCall.expression.getText(source), "buildGatewayFeatures");
		assert.equal(featureCall.arguments[0]?.getText(source), "customMethods.keys()");
	});
});
