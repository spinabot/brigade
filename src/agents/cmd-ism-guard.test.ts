import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BeforeToolCallContext, BeforeToolCallResult } from "@mariozechner/pi-agent-core";

import { detectDeviceRedirect, makeCmdIsmGuard } from "./cmd-ism-guard.js";

function makeCtx(toolName: string, args: Record<string, unknown>): BeforeToolCallContext {
	return {
		toolCall: { name: toolName, arguments: args },
	} as unknown as BeforeToolCallContext;
}

async function runGuard(toolName: string, args: Record<string, unknown>): Promise<BeforeToolCallResult | undefined> {
	const guard = makeCmdIsmGuard();
	return await guard(makeCtx(toolName, args));
}

describe("cmd-ism guard — detectDeviceRedirect", () => {
	it("detects the production incident command verbatim", () => {
		assert.equal(
			detectDeviceRedirect('where magick 2>nul || where convert 2>nul || echo "none found"'),
			"nul",
		);
	});

	it("detects bare and spaced redirects, case-insensitively", () => {
		assert.equal(detectDeviceRedirect("echo hi >nul"), "nul");
		assert.equal(detectDeviceRedirect("echo hi > NUL"), "NUL");
		assert.equal(detectDeviceRedirect("echo hi >> nul"), "nul");
		assert.equal(detectDeviceRedirect("cmd 1>nul"), "nul");
		assert.equal(detectDeviceRedirect("cmd 2>>nul"), "nul");
	});

	it("detects the >nul 2>&1 combo and path-prefixed targets", () => {
		assert.equal(detectDeviceRedirect("build.bat >nul 2>&1"), "nul");
		assert.equal(detectDeviceRedirect("echo hi > tmp/nul"), "tmp/nul");
		assert.equal(detectDeviceRedirect("echo hi > sub\\con"), "sub\\con");
	});

	it("detects the other reserved device names", () => {
		for (const dev of ["con", "prn", "aux", "com1", "com9", "lpt1", "lpt9"]) {
			assert.equal(detectDeviceRedirect(`echo hi > ${dev}`), dev, dev);
		}
	});

	it("allows /dev/null redirects", () => {
		assert.equal(detectDeviceRedirect("where magick 2>/dev/null || true"), undefined);
		assert.equal(detectDeviceRedirect("echo hi > /dev/null 2>&1"), undefined);
	});

	it("allows the device names outside a redirect", () => {
		assert.equal(detectDeviceRedirect("echo nul con aux"), undefined);
		assert.equal(detectDeviceRedirect("grep -r nul src/"), undefined);
		assert.equal(detectDeviceRedirect("rm ./nul"), undefined);
	});

	it("allows filenames that merely start with a device name", () => {
		assert.equal(detectDeviceRedirect("echo hi > nullable.txt"), undefined);
		assert.equal(detectDeviceRedirect("echo hi > nul.txt"), undefined);
		assert.equal(detectDeviceRedirect("echo hi > console.log"), undefined);
		assert.equal(detectDeviceRedirect("echo hi > com10"), undefined);
	});

	it("allows quoted mentions of cmd-isms", () => {
		assert.equal(detectDeviceRedirect(`echo "on cmd.exe use 2>nul to discard" >> notes.md`), undefined);
		assert.equal(detectDeviceRedirect(`printf 'where x 2>nul' > doc.txt`), undefined);
	});

	it("ignores fd-duplication redirects", () => {
		assert.equal(detectDeviceRedirect("cmd 2>&1 | tee log.txt"), undefined);
	});
});

describe("cmd-ism guard — hook behaviour", () => {
	it("blocks a bash call with a device redirect and points at /dev/null", async () => {
		const result = await runGuard("bash", { command: "where magick 2>nul || echo none" });
		assert.ok(result?.block);
		assert.match(result?.reason ?? "", /cmd\.exe idiom/);
		assert.match(result?.reason ?? "", /\/dev\/null/);
	});

	it("blocks the exec/shell/sh aliases too", async () => {
		for (const tool of ["exec", "shell", "sh"]) {
			const result = await runGuard(tool, { command: "echo hi >nul" });
			assert.ok(result?.block, tool);
		}
	});

	it("passes clean bash commands through", async () => {
		assert.equal(await runGuard("bash", { command: "where magick 2>/dev/null || echo none" }), undefined);
		assert.equal(await runGuard("bash", { command: "ls -la" }), undefined);
	});

	it("never touches non-bash tools, even when content mentions cmd-isms", async () => {
		assert.equal(await runGuard("write", { path: "notes.md", content: "use 2>nul on cmd" }), undefined);
		assert.equal(await runGuard("edit", { file_path: "x.md", old: "a", new: "2>nul" }), undefined);
	});

	it("passes through when the command arg is missing or non-string", async () => {
		assert.equal(await runGuard("bash", {}), undefined);
		assert.equal(await runGuard("bash", { command: 42 }), undefined);
	});
});
