import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import * as sdk from "./extension-sdk.js";

describe("brigade/extension-sdk public surface", () => {
	it("exports defineModule as the authoring entrypoint", () => {
		assert.equal(typeof sdk.defineModule, "function");
		const m = sdk.defineModule({ id: "x", register() {} });
		assert.equal(m.id, "x");
	});

	it("defineModule is identity (no wrapping that could surprise authors)", () => {
		const input = { id: "y", register() {} };
		assert.equal(sdk.defineModule(input), input);
	});
});
