/**
 * Config path operations — the pure logic behind `brigade config <get|set|
 * unset|list|schema|validate>` AND the `config.*` gateway RPCs.
 *
 * Extracted from `cli/commands/config-cmd.ts` so the CLI and the gateway speak
 * to ONE implementation: a remote client (web console) doing `config.set` and
 * an operator doing `brigade config set` parse paths, redact secrets, and
 * mutate brigade.json identically.
 *
 * The path helpers are pure (no I/O). The `handle*` functions are the gateway
 * handlers: they read/write through the mode-aware `loadConfig`/`saveConfig`
 * (filesystem OR Convex), so `config.*` works in both storage modes.
 *
 * Secret handling mirrors the CLI: any segment matching SENSITIVE_SEGMENT
 * renders as `__BRIGADE_REDACTED__` in get/list output. Writes are NOT
 * redacted (you can set a key you can't read back in plaintext), and the
 * on-disk `${VAR}` restoration in `saveConfig` keeps resolved secrets off disk.
 */

import JSON5 from "json5";

import { BrigadeConfigSchema, collectBrigadeConfigErrors } from "./brigade-config.js";
import { loadConfig, saveConfig } from "./config.js";

export const REDACTED_SENTINEL = "__BRIGADE_REDACTED__";
const SENSITIVE_SEGMENT = /^(key|apikey|token|secret|password|refreshtoken|accesstoken)$/i;

/* ───────────────────────── path helpers ───────────────────────── */

/**
 * Parse a config path into segments. Supports dot-notation
 * (`agents.defaults.provider`), escaped dots (`keys.foo\.bar`), bracket array
 * indices (`a.b[0]`), and bracket literal keys (`a["my.key"]`).
 */
export function parsePath(raw: string): string[] {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new Error("config path is empty");
	}
	const segments: string[] = [];
	let buf = "";
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === "\\" && trimmed[i + 1] === ".") {
			buf += ".";
			i++;
			continue;
		}
		if (ch === ".") {
			if (buf.length === 0) {
				throw new Error(`empty segment in config path "${raw}"`);
			}
			segments.push(buf);
			buf = "";
			continue;
		}
		if (ch === "[") {
			if (buf.length > 0) {
				segments.push(buf);
				buf = "";
			}
			const close = trimmed.indexOf("]", i);
			if (close === -1) {
				throw new Error(`unclosed "[" in config path "${raw}"`);
			}
			let inside = trimmed.slice(i + 1, close).trim();
			if (
				(inside.startsWith('"') && inside.endsWith('"')) ||
				(inside.startsWith("'") && inside.endsWith("'"))
			) {
				inside = inside.slice(1, -1);
			}
			if (inside.length === 0) {
				throw new Error(`empty bracket segment in config path "${raw}"`);
			}
			segments.push(inside);
			i = close;
			continue;
		}
		buf += ch;
	}
	if (buf.length > 0) segments.push(buf);
	if (segments.length === 0) {
		throw new Error(`unable to parse config path "${raw}"`);
	}
	return segments;
}

/** True iff the segment looks like a non-negative integer (array index). */
function isIndexSegment(seg: string): boolean {
	return /^[0-9]+$/.test(seg);
}

export function getNested(root: unknown, segments: string[]): unknown {
	let cur: unknown = root;
	for (const seg of segments) {
		if (cur === null || cur === undefined) return undefined;
		if (Array.isArray(cur) && isIndexSegment(seg)) {
			cur = cur[Number(seg)];
			continue;
		}
		if (typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}

export function setNested(root: Record<string, unknown>, segments: string[], value: unknown): void {
	// biome-ignore lint/suspicious/noExplicitAny: walking an untyped config tree.
	let cur: any = root;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i] ?? "";
		const nextSeg = segments[i + 1] ?? "";
		const wantArray = isIndexSegment(nextSeg);
		const existing = Array.isArray(cur) && isIndexSegment(seg) ? cur[Number(seg)] : cur[seg];
		if (existing === undefined || existing === null || typeof existing !== "object") {
			const fresh = wantArray ? [] : {};
			if (Array.isArray(cur) && isIndexSegment(seg)) {
				cur[Number(seg)] = fresh;
			} else {
				cur[seg] = fresh;
			}
			cur = fresh;
		} else {
			cur = Array.isArray(cur) && isIndexSegment(seg) ? cur[Number(seg)] : cur[seg];
		}
	}
	const tail = segments[segments.length - 1] ?? "";
	if (Array.isArray(cur) && isIndexSegment(tail)) {
		cur[Number(tail)] = value;
	} else {
		cur[tail] = value;
	}
}

export function deleteNested(root: Record<string, unknown>, segments: string[]): boolean {
	// biome-ignore lint/suspicious/noExplicitAny: walking an untyped config tree.
	let cur: any = root;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i] ?? "";
		const next = Array.isArray(cur) && isIndexSegment(seg) ? cur[Number(seg)] : cur?.[seg];
		if (next === undefined || next === null || typeof next !== "object") return false;
		cur = next;
	}
	const tail = segments[segments.length - 1] ?? "";
	if (Array.isArray(cur) && isIndexSegment(tail)) {
		const idx = Number(tail);
		if (idx < cur.length) {
			cur.splice(idx, 1);
			return true;
		}
		return false;
	}
	if (cur && typeof cur === "object" && tail in cur) {
		delete cur[tail];
		return true;
	}
	return false;
}

/** JSON5-parse a CLI string value, falling back to the raw string. */
export function parseConfigValue(raw: string, opts: { strictJson?: boolean } = {}): unknown {
	if (opts.strictJson) {
		return JSON.parse(raw);
	}
	try {
		return JSON5.parse(raw);
	} catch {
		return raw;
	}
}

/** Deep-redact any string value whose key looks secret. */
export function redactDeep(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((v) => redactDeep(v));
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		if (SENSITIVE_SEGMENT.test(k) && typeof v === "string" && v.length > 0) {
			out[k] = REDACTED_SENTINEL;
		} else {
			out[k] = redactDeep(v);
		}
	}
	return out;
}

/* ───────────────────── structured operations ──────────────────── */

/** Read a redacted value at `rawPath`. `found:false` when the key is absent. */
export function configGetValue(cfg: unknown, rawPath: string): { found: boolean; value?: unknown } {
	const value = getNested(cfg, parsePath(rawPath));
	if (value === undefined) return { found: false };
	return { found: true, value: redactDeep(value) };
}

/** Mutate `cfg` in place: set `rawPath` to `value`. */
export function configSetValue(cfg: Record<string, unknown>, rawPath: string, value: unknown): void {
	setNested(cfg, parsePath(rawPath), value);
}

/** Mutate `cfg` in place: remove `rawPath`. Returns whether anything was removed. */
export function configUnsetValue(cfg: Record<string, unknown>, rawPath: string): boolean {
	return deleteNested(cfg, parsePath(rawPath));
}

/* ─────────────────────── gateway handlers ─────────────────────── */
//
// These back the `config.*` gateway RPCs. They read/write through the
// mode-aware loadConfig/saveConfig, so they work in filesystem AND Convex
// mode. They take a `path`/`value`/`redact` shape — never a sessionKey or
// agentId — so they are operator-level config ops, not session-targeted (the
// guard-sweep correctly treats them as needing no per-session access check).

export interface ConfigGetResult {
	found: boolean;
	value?: unknown;
}
export interface ConfigSetResult {
	ok: boolean;
	path: string;
	value: unknown;
}
export interface ConfigUnsetResult {
	ok: boolean;
	path: string;
	removed: boolean;
}
export interface ConfigListResult {
	config: unknown;
}
export interface ConfigSchemaResult {
	schema: unknown;
}
export interface ConfigValidateResult {
	valid: boolean;
	issues: Array<{ path: string; message: string }>;
}

export function handleConfigGet(params: unknown): ConfigGetResult {
	const p = (params ?? {}) as { path?: string };
	const rawPath = (p.path ?? "").trim();
	if (!rawPath) throw new Error("config.get: missing 'path'");
	return configGetValue(loadConfig() as Record<string, unknown>, rawPath);
}

export function handleConfigSet(params: unknown): ConfigSetResult {
	const p = (params ?? {}) as { path?: string; value?: unknown };
	const rawPath = (p.path ?? "").trim();
	if (!rawPath) throw new Error("config.set: missing 'path'");
	const cfg = loadConfig() as Record<string, unknown>;
	configSetValue(cfg, rawPath, p.value);
	saveConfig(cfg as never);
	return { ok: true, path: rawPath, value: redactDeep(p.value) };
}

export function handleConfigUnset(params: unknown): ConfigUnsetResult {
	const p = (params ?? {}) as { path?: string };
	const rawPath = (p.path ?? "").trim();
	if (!rawPath) throw new Error("config.unset: missing 'path'");
	const cfg = loadConfig() as Record<string, unknown>;
	const removed = configUnsetValue(cfg, rawPath);
	if (removed) saveConfig(cfg as never);
	return { ok: removed, path: rawPath, removed };
}

export function handleConfigList(params: unknown): ConfigListResult {
	const p = (params ?? {}) as { redact?: boolean };
	const cfg = loadConfig() as Record<string, unknown>;
	return { config: p.redact === false ? cfg : redactDeep(cfg) };
}

export function handleConfigSchema(_params?: unknown): ConfigSchemaResult {
	return { schema: BrigadeConfigSchema };
}

export function handleConfigValidate(_params?: unknown): ConfigValidateResult {
	const issues = collectBrigadeConfigErrors(loadConfig());
	return { valid: issues.length === 0, issues };
}
