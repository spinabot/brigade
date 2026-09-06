/**
 * Custom (catalog-defined) provider registration.
 *
 * Some providers ship a key + a known Anthropic-compatible (or OpenAI-
 * compatible) endpoint we already know from the catalog — GLM, Kimi, Qwen,
 * MiniMax, DeepSeek. Pi-AI doesn't bundle these as built-in providers, so we
 * register them dynamically via the `~/.brigade/models.json` mechanism, the
 * same way Ollama is registered. Each catalog model id becomes a Pi model
 * routed through the provider's `baseUrl` + `api`.
 *
 * We MERGE rather than overwrite — the user (or other providers) may have
 * existing entries in the file we shouldn't clobber.
 */

import * as fs from "node:fs/promises";
import path from "node:path";

import { tryGetRuntimeContext } from "../storage/runtime-context.js";

/** Drop absent optional fields so the emitted entry carries no `undefined`s. */
function compactModel(m: CustomProviderModel): Record<string, unknown> {
	return {
		id: m.id,
		name: m.name ?? m.id,
		...(m.api ? { api: m.api } : {}),
		...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
		...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
		...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
		...(m.cost ? { cost: m.cost } : {}),
		...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
	};
}

/**
 * A model entry richer than a bare id, for providers whose own API reports real
 * cost / limits / per-model endpoints — discarding those would leave Pi guessing
 * context windows and billing. Everything past `id` is optional, so callers that
 * know only ids keep passing `string[]`.
 *
 * `api` and `baseUrl` are per-model because one credential can front several API
 * shapes (OpenCode serves Claude from an Anthropic-compatible surface, Gemini
 * from a Google one, the rest OpenAI-compatible). Pi resolves them per model and
 * falls back to the provider level.
 */
export interface CustomProviderModel {
	id: string;
	name?: string;
	api?: "openai-completions" | "anthropic-messages" | "google-generative-ai";
	baseUrl?: string;
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	reasoning?: boolean;
}

export async function writeCustomProviderToModelsJson(
	modelsJsonPath: string,
	p: {
		id: string;
		baseUrl: string;
		api: "openai-completions" | "anthropic-messages";
		apiKey: string;
		models: (string | CustomProviderModel)[];
		/**
		 * Static headers Pi sends on every request to this provider (values support
		 * `${ENV_VAR}` templates). Needed where a provider scopes requests with a
		 * header rather than the URL — OpenCode 403s without `x-opencode-org-id`.
		 */
		headers?: Record<string, string>;
	},
): Promise<void> {
	let existing: { providers?: Record<string, any> } = { providers: {} };
	try {
		const raw = await fs.readFile(modelsJsonPath, "utf8");
		// Validate into a LOCAL before adopting it. Assigning straight to `existing`
		// meant a file parsing to `null`/a scalar/an array escaped this catch —
		// the throw then came from the write below, outside the "start fresh"
		// promise, and `ensureCustomProvider` has no try/catch of its own.
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			existing = parsed as { providers?: Record<string, any> };
		}
		if (!existing.providers) existing.providers = {};
	} catch {
		// File missing or unparseable — start fresh. Pi treats an absent file as no config.
	}

	existing.providers![p.id] = {
		baseUrl: p.baseUrl,
		api: p.api,
		apiKey: p.apiKey,
		...(p.headers && Object.keys(p.headers).length > 0 ? { headers: p.headers } : {}),
		// Emit only the fields the caller actually knows. Pi's models.json schema
		// validates what's present and defaults the rest, so writing explicit
		// `undefined`s would fail validation for the plain string[] callers.
		models: p.models.map((m) => (typeof m === "string" ? { id: m, name: m } : compactModel(m))),
	};

	// In convex mode resolveModelsPath routes to the OS cache dir, which may
	// not exist yet on a fresh machine — a bare write would ENOENT. Filesystem
	// mode: ~/.brigade always exists by this point, so the mkdir is a no-op.
	await fs.mkdir(path.dirname(modelsJsonPath), { recursive: true });
	await fs.writeFile(modelsJsonPath, JSON.stringify(existing, null, 2), "utf8");

	// The coding-plan apiKey is written PLAINTEXT into models.json. Lock the
	// file down to owner-only on POSIX so a shared-host neighbour can't read the
	// key (mirrors the `chmodIfPosix` pattern in src/auth/profiles.ts). No-op on
	// Windows (NTFS perms model differs) and best-effort on filesystems that
	// don't support chmod (e.g. mounted FAT32).
	if (process.platform !== "win32") {
		try {
			await fs.chmod(modelsJsonPath, 0o600);
		} catch {
			// Filesystem may not support chmod — non-fatal.
		}
	}

	// Convex mode — the file just written lives in the OS cache (resolveModelsPath
	// routed it there) and is a regenerable mirror; the durable copy is the
	// sealed "models" blob. Push it so a fresh machine re-materialises the
	// catalog at boot.
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode === "convex") {
		await rctx.store.auth
			.writeAuthFileBlob("main", "models" as never, existing as Record<string, unknown>)
			.catch((err: Error) => {
				console.error(`brigade: models catalog write to convex failed — ${err.message}`);
			});
	}
}
