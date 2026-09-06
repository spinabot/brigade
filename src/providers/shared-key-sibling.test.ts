/**
 * `findSharedKeySibling` against the REAL credential store and the REAL reader.
 *
 * `catalog.test.ts` covers the pairing logic with an INJECTED reader, so it says
 * nothing about the reader the wizard actually uses. This file injects
 * `readStoredProviderKey` — the very function onboarding delegates to — rather
 * than a local re-implementation, because a test that reimplements the reader
 * would go green even if the real one stopped resolving anything. It lives in
 * `core/auth-bridge.ts` (not the TUI module) precisely so it can be imported
 * here; the reader onboarding previously carried was unreachable, and swapping
 * in the shared one also removed a divergence on legacy string `keyRef`s.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { writeProfiles } from "../auth/profiles.js";
import { readStoredProviderKey } from "../core/auth-bridge.js";
import { findProvider, findSharedKeySibling } from "./catalog.js";

let prevStateDir: string | undefined;
beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "brigade-shared-key-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = dir;
});
afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
});

/** Exactly what `ensureApiKey` injects — same function, same agent id. */
const readStoredKey = (providerId: string): string => readStoredProviderKey(providerId, "main");

describe("findSharedKeySibling — against the real profile store", () => {
	it("offers Zen's stored key when onboarding Go", () => {
		writeProfiles("main", {
			version: 1,
			profiles: { "opencode:default": { provider: "opencode", type: "api_key", key: "sk-zen-real" } },
		});
		assert.deepEqual(findSharedKeySibling(findProvider("opencode-go")!, readStoredKey), {
			providerId: "opencode",
			name: "OpenCode Zen",
			value: "sk-zen-real",
		});
	});

	it("offers Go's stored key when onboarding Zen", () => {
		writeProfiles("main", {
			version: 1,
			profiles: { "opencode-go:default": { provider: "opencode-go", type: "api_key", key: "sk-go-real" } },
		});
		assert.equal(findSharedKeySibling(findProvider("opencode")!, readStoredKey)?.value, "sk-go-real");
	});

	it("offers nothing when the store holds no OpenCode key", () => {
		writeProfiles("main", {
			version: 1,
			profiles: { "anthropic:default": { provider: "anthropic", type: "api_key", key: "sk-ant-x" } },
		});
		assert.equal(findSharedKeySibling(findProvider("opencode")!, readStoredKey), undefined);
	});

	it("offers nothing when no profiles file exists at all", () => {
		assert.equal(findSharedKeySibling(findProvider("opencode")!, readStoredKey), undefined);
	});

	it("resolves a keyRef sibling, not just a plaintext one", () => {
		// `--secret-input-mode ref` stores the env var NAME, never the secret. The
		// wizard's old private reader claimed to handle this and could not; the
		// offer has to fire for ref-mode operators too.
		process.env.OPENCODE_ZEN_API_KEY = "sk-zen-from-ref";
		writeProfiles("main", {
			version: 1,
			profiles: {
				"opencode:default": {
					provider: "opencode",
					type: "api_key",
					keyRef: { source: "env", provider: "default", id: "OPENCODE_ZEN_API_KEY" },
				},
			},
		} as never);
		try {
			assert.equal(
				findSharedKeySibling(findProvider("opencode-go")!, readStoredKey)?.value,
				"sk-zen-from-ref",
			);
		} finally {
			delete process.env.OPENCODE_ZEN_API_KEY;
		}
	});

	it("offers nothing when a ref points at an unset env var", () => {
		delete process.env.OPENCODE_ZEN_API_KEY;
		writeProfiles("main", {
			version: 1,
			profiles: {
				"opencode:default": {
					provider: "opencode",
					type: "api_key",
					keyRef: { source: "env", provider: "default", id: "OPENCODE_ZEN_API_KEY" },
				},
			},
		} as never);
		assert.equal(findSharedKeySibling(findProvider("opencode-go")!, readStoredKey), undefined);
	});
});
