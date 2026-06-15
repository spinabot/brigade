// src/ui/onboard-storage-mode.ts
//
// Step 0 of the onboard wizard — pick the storage mode.
//
// In Phase 2 Brigade can run against TWO storage backends:
//   filesystem  — all state under ~/.brigade/ (default, single-machine, zero deps)
//   convex      — relational + reactive + vector search (local backend or cloud)
//
// This module owns the UI for picking the mode, the convex sub-prompts
// (backend / URL / connectivity probe), and reports back a structured result.
// The caller (src/ui/onboarding.ts) writes the sentinel after the rest of the
// wizard completes.

import { createHash } from "node:crypto";

import { CancellableLoader, Input, type SelectItem, SelectList, Text, type TUI } from "@mariozechner/pi-tui";

import { renderBrandHeader } from "./brand.js";
import { brand, selectListTheme } from "./theme.js";
import type { StorageMode } from "../storage/runtime-context.js";
import {
	encryptionKeySource,
	encryptionStatus,
	generateMasterKeyHex,
	saveEncryptionKeyToFile,
} from "../storage/encryption.js";
import {
	classifyInstanceState,
	inspectConvexInstance,
	resetConvexInstance,
	type ConvexInstanceSummary,
} from "../storage/instance-admin.js";

export interface StorageModeResult {
	mode: StorageMode;
	/** Only set when mode === "convex". */
	convexUrl?: string;
}

export interface StorageModeStepOpts {
	/** Skip the picker entirely — used by tests + non-interactive callers. */
	preselected?: StorageModeResult;
}

/**
 * Run Step 0 of the wizard. Throws "onboarding-cancelled" if the user Escs
 * out of the mode picker (mirrors `pickProvider`'s contract).
 */
export async function pickStorageMode(
	tui: TUI,
	opts: StorageModeStepOpts = {},
): Promise<StorageModeResult> {
	if (opts.preselected) return opts.preselected;

	renderScreen(tui, "Step 0 of 5 · Storage mode");
	tui.addChild(
		new Text(
			`  ${brand.dim("Where should Brigade keep its state?")}`,
			0,
			0,
		),
	);
	tui.addChild(new Text("", 0, 0));

	const items: SelectItem[] = [
		{
			value: "filesystem",
			label: "Filesystem",
			description: "All state under ~/.brigade/ · zero deps · default",
		},
		{
			value: "convex",
			label: "Convex",
			description: "Relational + reactive + vector search · local backend or cloud",
		},
	];

	const list = new SelectList(items, items.length, selectListTheme, {
		minPrimaryColumnWidth: 12,
		maxPrimaryColumnWidth: 14,
	});
	tui.addChild(list);
	tui.setFocus(list);
	tui.requestRender();

	const chosen = await new Promise<SelectItem>((resolve, reject) => {
		list.onSelect = (item) => resolve(item);
		list.onCancel = () => reject(new Error("onboarding-cancelled"));
	});
	const mode = chosen.value as StorageMode;

	if (mode === "filesystem") {
		return { mode };
	}

	// Convex path — connection sub-prompts.
	const url = await pickConvexBackend(tui);
	return { mode: "convex", convexUrl: url };
}

/**
 * Step 0a/0b/0c — for convex mode: pick backend kind, prompt URL, probe.
 * Loops on probe failure until either a healthy URL is found or the user
 * Escs back (which switches them to filesystem mode silently — Esc here
 * is "I changed my mind" rather than "abort").
 */
async function pickConvexBackend(tui: TUI): Promise<string> {
	let lastError: string | null = null;

	while (true) {
		renderScreen(tui, "Step 0 of 5 · Convex backend");
		if (lastError) {
			tui.addChild(new Text(`  ${brand.error("✗")} ${brand.error(lastError)}`, 0, 0));
			tui.addChild(new Text(brand.dim("  Press Enter to retry, or Esc to switch to filesystem."), 0, 0));
			tui.addChild(new Text("", 0, 0));
		}

		const backendItems: SelectItem[] = [
			{
				value: "local",
				label: "Local",
				description: "127.0.0.1:3210 · use `npm run convex:dev` in another terminal",
			},
			{
				value: "existing",
				label: "Existing",
				description: "Point at a running deployment URL (local or cloud)",
			},
		];
		const list = new SelectList(backendItems, backendItems.length, selectListTheme, {
			minPrimaryColumnWidth: 10,
			maxPrimaryColumnWidth: 12,
		});
		tui.addChild(list);
		tui.setFocus(list);
		tui.requestRender();

		let kind: "local" | "existing";
		try {
			const chosen = await new Promise<SelectItem>((resolve, reject) => {
				list.onSelect = (item) => resolve(item);
				list.onCancel = () => reject(new Error("back"));
			});
			kind = chosen.value === "existing" ? "existing" : "local";
		} catch {
			// User Escd — silently revert to filesystem mode.
			throw new Error("storage-mode-revert-to-filesystem");
		}

		const defaultUrl = kind === "local" ? "http://127.0.0.1:3210" : "";

		// URL prompt.
		renderScreen(tui, "Step 0 of 5 · Convex URL");
		if (kind === "local") {
			tui.addChild(
				new Text(
					`  ${brand.dim("Enter to accept the default, or type a different URL.")}`,
					0,
					0,
				),
			);
		} else {
			tui.addChild(
				new Text(
					`  ${brand.dim("Paste your deployment URL (https://your-name.convex.cloud or self-hosted).")}`,
					0,
					0,
				),
			);
		}
		tui.addChild(new Text(brand.dim("  Esc to go back"), 0, 0));
		tui.addChild(new Text("", 0, 0));

		const input = new Input();
		if (defaultUrl.length > 0) {
			// Pi-TUI Input doesn't expose a `setValue`, but the picker treats
			// an empty submit as "use default" — we tell the user that on the
			// prompt line above.
		}
		tui.addChild(input);
		tui.setFocus(input);
		tui.requestRender();

		let raw: string;
		try {
			raw = await new Promise<string>((resolve, reject) => {
				input.onSubmit = (value: string) => resolve(value.trim());
				input.onEscape = () => reject(new Error("back"));
			});
		} catch {
			continue; // Esc — back to backend picker
		}

		const url = raw.length > 0 ? raw : defaultUrl;
		if (url.length === 0) {
			lastError = "Please enter a deployment URL.";
			continue;
		}
		if (!/^https?:\/\//i.test(url)) {
			lastError = `URL must start with http:// or https://, got "${url}".`;
			continue;
		}

		// Connectivity probe.
		tui.addChild(new Text("", 0, 0));
		const loader = new CancellableLoader(
			tui,
			(s) => brand.amber(s),
			(s) => brand.dim(s),
			`Probing ${url}…`,
		);
		tui.addChild(loader);
		tui.requestRender();

		const probe = await probeConvexBackend(url);
		tui.removeChild(loader);

		if (!probe.ok) {
			lastError = probe.reason;
			continue;
		}

		tui.addChild(
			new Text(
				`  ${brand.amber("✓")} Convex backend reachable · instance ${brand.white(probe.instanceName ?? "(unknown)")}`,
				0,
				0,
			),
		);
		tui.requestRender();
		await delay(500);

		// Step 0d — at-rest encryption key. Auto-generate + persist on first
		// convex onboard so the customer never manages an env var; show the
		// key ONCE with recovery-code framing. Esc rewinds to the backend
		// picker.
		try {
			await ensureEncryptionKeyStep(tui);
		} catch (err) {
			if ((err as Error).message === "back") continue;
			throw err;
		}

		// Step 0e — does this backend already hold a Brigade? Offer
		// restore-or-fresh (and handle the wrong-key case) BEFORE the rest of
		// the wizard runs, so "start fresh" is an explicit choice instead of
		// an accident of which files survived.
		try {
			const decision = await detectExistingInstanceStep(tui, url);
			if (decision === "back") continue;
		} catch (err) {
			if ((err as Error).message === "back") continue;
			throw err;
		}

		return url;
	}
}

interface ProbeResult {
	ok: boolean;
	reason: string;
	instanceName?: string;
}

async function probeConvexBackend(url: string): Promise<ProbeResult> {
	const cleaned = url.replace(/\/+$/, "");
	const endpoint = `${cleaned}/instance_name`;
	try {
		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), 5_000);
		const res = await fetch(endpoint, { signal: controller.signal });
		clearTimeout(t);
		if (!res.ok) {
			return { ok: false, reason: `HTTP ${res.status} from ${endpoint}` };
		}
		const text = (await res.text()).trim();
		return { ok: true, reason: "ok", instanceName: text || undefined };
	} catch (err) {
		const msg = (err as Error)?.name === "AbortError" ? "timed out after 5s" : (err as Error).message;
		const localHint =
			cleaned.includes("127.0.0.1") || cleaned.includes("localhost")
				? "  · is `npm run convex:dev` running in another terminal?"
				: "";
		return { ok: false, reason: `Couldn't reach ${cleaned}: ${msg}${localHint}` };
	}
}

/* ──────────────── Step 0d — encryption key ──────────────── */

/**
 * Make sure an at-rest encryption key is active before any convex write:
 *   • env var set        → use it (power users / CI own their key)
 *   • key file exists    → use it silently (returning customer)
 *   • neither            → generate, persist to the key file (OUTSIDE
 *                          ~/.brigade — survives a state wipe), and show it
 *                          ONCE so the customer can save a recovery copy.
 * Throws "back" when the user Escs.
 */
async function ensureEncryptionKeyStep(tui: TUI): Promise<void> {
	const source = encryptionKeySource();
	if (source === "env") {
		renderScreen(tui, "Step 0 of 5 · Encryption");
		tui.addChild(
			new Text(`  ${brand.amber("✓")} Encryption key found in your environment — using it.`, 0, 0),
		);
		tui.requestRender();
		await delay(600);
		return;
	}
	if (source === "file") {
		renderScreen(tui, "Step 0 of 5 · Encryption");
		tui.addChild(
			new Text(`  ${brand.amber("✓")} Encryption key found on this computer — using it.`, 0, 0),
		);
		tui.requestRender();
		await delay(600);
		return;
	}

	// No key anywhere — generate + persist + show once.
	const hex = generateMasterKeyHex();
	saveEncryptionKeyToFile(hex);
	await showRecoveryKeyScreen(tui, hex, "Your data will be encrypted before it leaves this computer.");
}

/** Full-screen "save this key" moment. Resolves when the user confirms;
 *  throws "back" on Esc. */
async function showRecoveryKeyScreen(tui: TUI, hex: string, intro: string): Promise<void> {
	renderScreen(tui, "Step 0 of 5 · Your encryption key");
	tui.addChild(new Text(`  ${brand.dim(intro)}`, 0, 0));
	tui.addChild(new Text("", 0, 0));
	tui.addChild(new Text(`  ${brand.white(hex)}`, 0, 0));
	tui.addChild(new Text("", 0, 0));
	tui.addChild(
		new Text(
			`  ${brand.dim("Save this key in your password manager. It's also stored safely on this")}`,
			0,
			0,
		),
	);
	tui.addChild(
		new Text(
			`  ${brand.dim("computer so Brigade starts automatically — but if this computer is ever")}`,
			0,
			0,
		),
	);
	tui.addChild(
		new Text(`  ${brand.dim("lost, this key is the ONLY way to read your data.")}`, 0, 0),
	);
	tui.addChild(new Text("", 0, 0));

	const items: SelectItem[] = [
		{ value: "saved", label: "Continue", description: "I've saved my key somewhere safe" },
	];
	const list = new SelectList(items, items.length, selectListTheme, {
		minPrimaryColumnWidth: 10,
		maxPrimaryColumnWidth: 12,
	});
	tui.addChild(list);
	tui.setFocus(list);
	tui.requestRender();
	await new Promise<void>((resolve, reject) => {
		list.onSelect = () => resolve();
		list.onCancel = () => reject(new Error("back"));
	});
}

/* ──────────── Step 0e — existing-instance detection ──────────── */

/**
 * Look at what the backend already holds and route:
 *   fresh        → proceed silently
 *   restorable   → "Restore it / Start fresh?" (fresh = explicit erase)
 *   key-mismatch → explain + offer the saved-key entry or erase
 * Returns "proceed" or "back". Detection failures NEVER block onboarding —
 * the backend was probed reachable a moment ago, so a summary error degrades
 * to proceeding (boot will surface real problems loudly).
 */
async function detectExistingInstanceStep(tui: TUI, url: string): Promise<"proceed" | "back"> {
	let summary: ConvexInstanceSummary;
	try {
		summary = await inspectConvexInstance(url);
	} catch {
		return "proceed";
	}
	const fp = encryptionStatus().primaryKeyFingerprint;
	const state = classifyInstanceState(summary, fp);
	if (state === "fresh") return "proceed";

	if (state === "restorable") {
		renderScreen(tui, "Step 0 of 5 · Found an existing Brigade");
		tui.addChild(new Text(`  ${brand.dim(describeSummary(summary))}`, 0, 0));
		tui.addChild(new Text("", 0, 0));
		const items: SelectItem[] = [
			{
				value: "restore",
				label: "Restore",
				description: "Pick up exactly where it left off (memories, sessions, channels)",
			},
			{
				value: "fresh",
				label: "Start fresh",
				description: "Permanently erase it and begin new — cannot be undone",
			},
		];
		const list = new SelectList(items, items.length, selectListTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 14,
		});
		tui.addChild(list);
		tui.setFocus(list);
		tui.requestRender();
		let choice: string;
		try {
			const chosen = await new Promise<SelectItem>((resolve, reject) => {
				list.onSelect = (item) => resolve(item);
				list.onCancel = () => reject(new Error("back"));
			});
			choice = String(chosen.value);
		} catch {
			return "back";
		}
		if (choice === "restore") return "proceed";
		return (await confirmAndErase(tui, url, summary)) ? "proceed" : "back";
	}

	// key-mismatch — the backend's data was sealed with a different key.
	renderScreen(tui, "Step 0 of 5 · This backend is locked with a different key");
	tui.addChild(new Text(`  ${brand.dim(describeSummary(summary))}`, 0, 0));
	tui.addChild(new Text("", 0, 0));
	tui.addChild(
		new Text(
			`  ${brand.dim("The data here was encrypted with a different key than the one on this")}`,
			0,
			0,
		),
	);
	tui.addChild(
		new Text(`  ${brand.dim("computer. To restore it, enter the key you saved when it was created.")}`, 0, 0),
	);
	if (encryptionKeySource() === "env") {
		tui.addChild(new Text("", 0, 0));
		tui.addChild(
			new Text(
				`  ${brand.dim("(Your key currently comes from the BRIGADE_ENCRYPTION_KEY environment")}`,
				0,
				0,
			),
		);
		tui.addChild(
			new Text(`  ${brand.dim("variable — update that variable instead of entering a key here.)")}`, 0, 0),
		);
	}
	tui.addChild(new Text("", 0, 0));

	const canEnterKey = encryptionKeySource() !== "env";
	const items: SelectItem[] = [
		...(canEnterKey
			? [
					{
						value: "enter-key",
						label: "Enter key",
						description: "Type the saved recovery key to unlock and restore",
					},
				]
			: []),
		{
			value: "fresh",
			label: "Start fresh",
			description: "Permanently erase the locked data and begin new",
		},
	];
	const list = new SelectList(items, items.length, selectListTheme, {
		minPrimaryColumnWidth: 12,
		maxPrimaryColumnWidth: 14,
	});
	tui.addChild(list);
	tui.setFocus(list);
	tui.requestRender();
	let choice: string;
	try {
		const chosen = await new Promise<SelectItem>((resolve, reject) => {
			list.onSelect = (item) => resolve(item);
			list.onCancel = () => reject(new Error("back"));
		});
		choice = String(chosen.value);
	} catch {
		return "back";
	}

	if (choice === "enter-key") {
		const ok = await promptForRecoveryKey(tui, summary.storedKeyFingerprint ?? "");
		if (!ok) return "back";
		return "proceed";
	}
	return (await confirmAndErase(tui, url, summary)) ? "proceed" : "back";
}

/** Ask for the saved recovery key; accept only when its fingerprint matches
 *  what the backend was sealed with, then persist it as the active key file
 *  (the wrong file key, if any, is set aside as a .bak — never destroyed). */
async function promptForRecoveryKey(tui: TUI, expectedFingerprint: string): Promise<boolean> {
	let lastError: string | null = null;
	while (true) {
		renderScreen(tui, "Step 0 of 5 · Enter your recovery key");
		if (lastError) {
			tui.addChild(new Text(`  ${brand.error("✗")} ${brand.error(lastError)}`, 0, 0));
			tui.addChild(new Text("", 0, 0));
		}
		tui.addChild(new Text(`  ${brand.dim("Paste the 64-character key you saved. Esc to go back.")}`, 0, 0));
		tui.addChild(new Text("", 0, 0));
		const input = new Input();
		tui.addChild(input);
		tui.setFocus(input);
		tui.requestRender();
		let raw: string;
		try {
			raw = await new Promise<string>((resolve, reject) => {
				input.onSubmit = (value: string) => resolve(value.trim());
				input.onEscape = () => reject(new Error("back"));
			});
		} catch {
			return false;
		}
		if (!/^[0-9a-f]{64}$/i.test(raw)) {
			lastError = "That doesn't look like a Brigade key (expected 64 hex characters).";
			continue;
		}
		const fp = createHash("sha256").update(Buffer.from(raw, "hex")).digest("hex").slice(0, 8);
		if (expectedFingerprint && fp !== expectedFingerprint) {
			lastError = "That key doesn't match this backend's data. Check for typos and try again.";
			continue;
		}
		saveEncryptionKeyToFile(raw, { backupExisting: true });
		return true;
	}
}

/** Double-confirm, then erase the backend instance with progress. After a
 *  file-sourced key, a FRESH key is generated (old file kept as .bak). */
async function confirmAndErase(
	tui: TUI,
	url: string,
	summary: ConvexInstanceSummary,
): Promise<boolean> {
	renderScreen(tui, "Step 0 of 5 · Erase this Brigade?");
	tui.addChild(new Text(`  ${brand.error("This permanently deletes:")} ${describeSummary(summary)}`, 0, 0));
	tui.addChild(new Text(`  ${brand.dim("There is no undo.")}`, 0, 0));
	tui.addChild(new Text("", 0, 0));
	const items: SelectItem[] = [
		{ value: "no", label: "Go back", description: "Keep the existing data" },
		{ value: "yes", label: "Erase everything", description: "Delete it all and start new" },
	];
	const list = new SelectList(items, items.length, selectListTheme, {
		minPrimaryColumnWidth: 16,
		maxPrimaryColumnWidth: 18,
	});
	tui.addChild(list);
	tui.setFocus(list);
	tui.requestRender();
	let choice: string;
	try {
		const chosen = await new Promise<SelectItem>((resolve, reject) => {
			list.onSelect = (item) => resolve(item);
			list.onCancel = () => reject(new Error("back"));
		});
		choice = String(chosen.value);
	} catch {
		return false;
	}
	if (choice !== "yes") return false;

	renderScreen(tui, "Step 0 of 5 · Erasing…");
	const loader = new CancellableLoader(
		tui,
		(s) => brand.amber(s),
		(s) => brand.dim(s),
		"Erasing the previous Brigade…",
	);
	tui.addChild(loader);
	tui.requestRender();
	let deletedTotal = 0;
	try {
		const perTable = new Map<string, number>();
		const result = await resetConvexInstance(url, {
			onProgress: (table, deletedSoFar) => {
				perTable.set(table, deletedSoFar);
				let total = 0;
				for (const v of perTable.values()) total += v;
				loader.setMessage(
					`Erasing the previous Brigade… ${total.toLocaleString()} records cleared · ${table}`,
				);
				tui.requestRender();
			},
		});
		deletedTotal = result.deletedTotal;
	} finally {
		tui.removeChild(loader);
	}
	tui.addChild(new Text(`  ${brand.amber("✓")} Erased ${deletedTotal} records.`, 0, 0));
	tui.requestRender();
	await delay(400);

	// Fresh start hygiene: when the key lives in the key file, mint a new one
	// (the old key may exist in old backups of the erased data). The previous
	// key file is renamed aside, never deleted.
	if (encryptionKeySource() === "file") {
		const hex = generateMasterKeyHex();
		saveEncryptionKeyToFile(hex, { backupExisting: true });
		await showRecoveryKeyScreen(tui, hex, "A new encryption key was created for your fresh start.");
	}
	return true;
}

function describeSummary(s: ConvexInstanceSummary): string {
	const parts: string[] = [];
	const n = (v: number): string => (v >= 1000 ? "1000+" : String(v));
	parts.push(`${n(s.counts.memories)} memories`);
	parts.push(`${n(s.counts.sessions)} sessions`);
	parts.push(`${n(s.counts.cronJobs)} scheduled jobs`);
	if (s.hasActivity) parts.push("session & log history");
	if (s.whatsappLinked) parts.push("WhatsApp linked");
	const created = s.createdAtMs ? new Date(s.createdAtMs).toLocaleDateString() : undefined;
	return `${parts.join(" · ")}${created ? ` · created ${created}` : ""}`;
}

/* ────────────────────────── helpers ────────────────────────── */

function renderScreen(tui: TUI, subheader: string): void {
	for (const child of [...tui.children]) tui.removeChild(child);
	renderBrandHeader(tui);
	if (subheader) {
		tui.addChild(new Text(brand.dim("  " + "─".repeat(54)), 0, 0));
		tui.addChild(new Text("", 0, 0));
		tui.addChild(new Text(`  ${brand.amber(subheader)}`, 0, 0));
		tui.addChild(new Text("", 0, 0));
		tui.requestRender();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
