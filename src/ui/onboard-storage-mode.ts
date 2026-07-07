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
import * as fs from "node:fs";
import * as path from "node:path";

import { CancellableLoader, Input, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";

import { loaderIndicator } from "./animations.js";
import { renderBrandHeader } from "./brand.js";
import { brand, selectListTheme } from "./theme.js";
import { resolveStateDir } from "../config/paths.js";
import type { StorageMode } from "../storage/runtime-context.js";
import { wipeLocalBrigadeState } from "../storage/factory-reset.js";
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

	renderScreen(tui, "Step 1 of 5 · Storage mode");
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
			description: "Cloud-backed storage with search and sync · local or hosted",
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
		// Re-onboard hygiene (mirrors the convex "Restore / Start fresh" branch):
		// if a previous local Brigade exists, offer to keep it OR wipe it so the
		// re-onboard starts VIRGIN — identical to a first-ever onboard. A first
		// onboard (no prior state) just proceeds. "Start fresh" deletes outright.
		const stateDir = resolveStateDir();
		const hasPriorState =
			fs.existsSync(path.join(stateDir, "workspace")) ||
			fs.existsSync(path.join(stateDir, "agents")) ||
			fs.existsSync(path.join(stateDir, "sessions"));
		if (!hasPriorState) return { mode };

		renderScreen(tui, "Step 1 of 5 · Found an existing Brigade");
		tui.addChild(new Text(`  ${brand.dim("Local Brigade data found on this computer")}`, 0, 0));
		tui.addChild(new Text("", 0, 0));
		const items: SelectItem[] = [
			{
				value: "restore",
				label: "Restore",
				description: "Keep your existing memories, sessions, personas, and skills",
			},
			{
				value: "fresh",
				label: "Start fresh",
				description: "Permanently erase local data and begin new — cannot be undone",
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
			return { mode }; // Esc = keep existing (the safe default)
		}
		if (choice === "fresh") {
			// Wipe the local state so the next boot re-seeds defaults (virgin). The
			// encryption key lives outside the state dir and is preserved.
			wipeLocalBrigadeState(stateDir);
		}
		return { mode };
	}

	// Convex path — connection sub-prompts.
	// Re-onboard hygiene (symmetric with the filesystem branch above): in convex
	// mode the local filesystem copy is NEVER read — convex is authoritative and
	// rebuilds the workspace on boot via restore-on-missing — and a leftover
	// agents/<id>/agent/auth-profiles.json holds the provider key in PLAINTEXT.
	// If a prior local Brigade exists, offer to clear it so the convex footprint
	// is virgin: the SAME end-state as a first-ever convex onboard (the
	// determinism invariant). The decision is captured now but executed only
	// AFTER convex is committed — an Esc inside pickConvexBackend reverts to
	// filesystem mode, and we must never wipe the data we'd fall back to.
	const stateDir = resolveStateDir();
	const clearLocal = await maybePromptClearLocalForConvex(tui, stateDir);
	const url = await pickConvexBackend(tui);
	if (clearLocal) wipeLocalBrigadeState(stateDir);
	return { mode: "convex", convexUrl: url };
}

/**
 * Convex re-onboard hygiene — the convex-mode counterpart to the filesystem
 * branch's Restore/Start-fresh prompt. Because convex never reads the local
 * filesystem copy, there's no "Restore" to offer (that's `store migrate`); the
 * only question is whether to clear the unused (and plaintext-secret-bearing)
 * leftover. Returns true ONLY when the user explicitly chooses to clear; no
 * prior state, "Keep", or Esc → false (the safe default). The caller runs the
 * wipe after convex is committed.
 */
async function maybePromptClearLocalForConvex(tui: TUI, stateDir: string): Promise<boolean> {
	const hasPriorState =
		fs.existsSync(path.join(stateDir, "workspace")) ||
		fs.existsSync(path.join(stateDir, "agents")) ||
		fs.existsSync(path.join(stateDir, "sessions"));
	if (!hasPriorState) return false;

	renderScreen(tui, "Step 1 of 5 · Found data from a previous setup");
	tui.addChild(new Text(`  ${brand.dim("Local data found on this computer")}`, 0, 0));
	tui.addChild(
		new Text(
			`  ${brand.dim("Convex keeps everything in the backend, so this local copy won't be used.")}`,
			0,
			0,
		),
	);
	tui.addChild(new Text("", 0, 0));
	const items: SelectItem[] = [
		{
			value: "clear",
			label: "Clear it",
			description: "Remove the unused local copy for a clean start — recommended",
		},
		{
			value: "keep",
			label: "Keep it",
			description: "Leave it on disk (it stays unused while you're in Convex mode)",
		},
	];
	const list = new SelectList(items, items.length, selectListTheme, {
		minPrimaryColumnWidth: 10,
		maxPrimaryColumnWidth: 12,
	});
	tui.addChild(list);
	tui.setFocus(list);
	tui.requestRender();
	try {
		const chosen = await new Promise<SelectItem>((resolve, reject) => {
			list.onSelect = (item) => resolve(item);
			list.onCancel = () => reject(new Error("back"));
		});
		return String(chosen.value) === "clear";
	} catch {
		return false; // Esc = keep (the safe default)
	}
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
		renderScreen(tui, "Step 1 of 5 · Convex backend");
		if (lastError) {
			tui.addChild(new Text(`  ${brand.error("✗")} ${brand.error(lastError)}`, 0, 0));
			tui.addChild(new Text(brand.dim("  Press Enter to retry, or Esc to switch to filesystem."), 0, 0));
			tui.addChild(new Text("", 0, 0));
		}

		const backendItems: SelectItem[] = [
			{
				value: "local",
				label: "Local",
				description: "Local backend · start it before continuing",
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
		renderScreen(tui, "Step 1 of 5 · Convex URL");
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
			loaderIndicator(),
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
		if (isConvexCloudUrl(url)) {
			// A fresh cloud deployment has no functions yet — deploy them with a
			// deploy key, otherwise boot fails with "functions aren't deployed".
			tui.addChild(
				new Text(`  ${brand.dim("Cloud deployment — deploy Brigade's functions with your deploy key:")}`, 0, 0),
			);
			tui.addChild(
				new Text(
					`  ${brand.dim("set CONVEX_DEPLOY_KEY (Convex dashboard → Settings → Deploy key), then run: npm run convex:push")}`,
					0,
					0,
				),
			);
		}
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

function isConvexCloudUrl(url: string): boolean {
	try {
		return /(^|\.)convex\.cloud$/i.test(new URL(url).hostname);
	} catch {
		return /\.convex\.cloud\b/i.test(url);
	}
}

async function probeConvexBackend(url: string): Promise<ProbeResult> {
	const cleaned = url.replace(/\/+$/, "");
	// `/instance_name` is a SELF-HOSTED backend route — it 200s on a local backend
	// but 404s on a Convex Cloud deployment (a valid, reachable deployment that
	// just doesn't expose that route). Treat cloud specially: a reachable cloud
	// host is accepted here; its Brigade functions are deployed separately with a
	// deploy key (npm run convex:push), and boot verifies health:ping after that.
	const cloud = isConvexCloudUrl(cleaned);
	const endpoint = cloud ? cleaned : `${cleaned}/instance_name`;
	try {
		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), 5_000);
		const res = await fetch(endpoint, { signal: controller.signal, redirect: "manual" });
		clearTimeout(t);
		if (cloud) {
			// Any HTTP response from the deployment host = reachable Convex Cloud.
			return { ok: true, reason: "ok", instanceName: "Convex Cloud" };
		}
		if (!res.ok) {
			return {
				ok: false,
				reason: "That backend responded but didn't look like a self-hosted Brigade backend. Double-check the URL.",
			};
		}
		const text = (await res.text()).trim();
		return { ok: true, reason: "ok", instanceName: text || undefined };
	} catch (err) {
		const msg = (err as Error)?.name === "AbortError" ? "timed out after 5s" : (err as Error).message;
		const localHint =
			cleaned.includes("127.0.0.1") || cleaned.includes("localhost")
				? "  · make sure your local backend is running before continuing."
				: cloud
					? "  · check the deployment URL from your Convex dashboard."
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
		renderScreen(tui, "Step 1 of 5 · Encryption");
		tui.addChild(
			new Text(`  ${brand.amber("✓")} Encryption key found in your environment — using it.`, 0, 0),
		);
		tui.requestRender();
		await delay(600);
		return;
	}
	if (source === "file") {
		renderScreen(tui, "Step 1 of 5 · Encryption");
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
	renderScreen(tui, "Step 1 of 5 · Your encryption key");
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
		renderScreen(tui, "Step 1 of 5 · Found an existing Brigade");
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
	renderScreen(tui, "Step 1 of 5 · This backend is locked with a different key");
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
				`  ${brand.dim("(Your key currently comes from your environment configuration —")}`,
				0,
				0,
			),
		);
		tui.addChild(
			new Text(`  ${brand.dim("update it there instead of entering a key here.)")}`, 0, 0),
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
		renderScreen(tui, "Step 1 of 5 · Enter your recovery key");
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
	renderScreen(tui, "Step 1 of 5 · Erase this Brigade?");
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

	renderScreen(tui, "Step 1 of 5 · Erasing…");
	const loader = new CancellableLoader(
		tui,
		(s) => brand.amber(s),
		(s) => brand.dim(s),
		"Erasing the previous Brigade…",
		loaderIndicator(),
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

	// Also wipe the LOCAL state so the fresh start is truly VIRGIN. Otherwise the
	// surviving ~/.brigade workspace/skills/sessions/facts get re-mirrored back
	// into the just-erased backend on the next boot (and a stale local persona can
	// clobber the new copy). The encryption key lives OUTSIDE the state dir, so the
	// wipe can't touch it — it's re-minted just below.
	wipeLocalBrigadeState();

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
