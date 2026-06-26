/**
 * Local-command media providers — run an operator-configured CLI for OFFLINE /
 * self-hosted TTS (piper, kitten-tts, …) and STT (whisper.cpp, faster-whisper, …).
 *
 * The operator sets a command TEMPLATE — env `BRIGADE_TTS_COMMAND` /
 * `BRIGADE_STT_COMMAND`, or `cfg.tools.speech.command` /
 * `cfg.tools.transcription.command`. Placeholders are substituted and the command
 * runs via the shell. The TEXT / AUDIO always rides through a TEMP FILE (never
 * interpolated into the command string), so a malicious transcript / text can't
 * inject shell metacharacters into the operator's command.
 *
 *   TTS placeholders: {text_path} (temp file holding the text), {output} (where
 *     the command MUST write the audio), {voice}. → returns the audio bytes.
 *   STT placeholders: {input} (temp file holding the audio), {output} (where the
 *     command MAY write the transcript), {language}. → returns the transcript
 *     (read from {output} if written, else the command's stdout).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CommandRunResult {
	code: number;
	stdout: string;
	stderr: string;
}
export type CommandRunner = (command: string, timeoutMs: number) => CommandRunResult;

const defaultRunner: CommandRunner = (command, timeoutMs) => {
	const r = spawnSync(command, {
		shell: true,
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 96 * 1024 * 1024,
	});
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** Literal `{key}` → value substitution (string split/join, so values are inert). */
export function fillCommandTemplate(template: string, vars: Record<string, string>): string {
	let out = template;
	for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
	return out;
}

function scratch(prefix: string, ext: string): string {
	const rnd = Math.floor(Math.random() * 1e9).toString(36);
	return path.join(os.tmpdir(), `brigade-${prefix}-${Date.now().toString(36)}-${rnd}.${ext}`);
}

function safeUnlink(p: string): void {
	try {
		fs.unlinkSync(p);
	} catch {
		/* ignore */
	}
}

/** Run a configured local TTS command → produced audio bytes + extension. */
export function runCommandTts(
	template: string,
	args: { text: string; voice: string; outExt?: string },
	opts: { runFn?: CommandRunner; timeoutMs?: number } = {},
): { bytes: Buffer; extension: string } {
	const runFn = opts.runFn ?? defaultRunner;
	const ext = (args.outExt ?? "wav").replace(/^\./, "");
	const textPath = scratch("tts-in", "txt");
	const outPath = scratch("tts-out", ext);
	fs.writeFileSync(textPath, args.text, "utf8");
	try {
		const cmd = fillCommandTemplate(template, { text_path: textPath, output: outPath, voice: args.voice });
		const r = runFn(cmd, opts.timeoutMs ?? 120_000);
		if (r.code !== 0) throw new Error(`TTS command exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`);
		if (!fs.existsSync(outPath)) throw new Error("the TTS command did not write the {output} file");
		const bytes = fs.readFileSync(outPath);
		if (bytes.length === 0) throw new Error("the TTS command produced an empty {output} file");
		return { bytes, extension: ext };
	} finally {
		safeUnlink(textPath);
		safeUnlink(outPath);
	}
}

/** Run a configured local STT command → transcript text. */
export function runCommandStt(
	template: string,
	args: { audioBytes: Buffer; audioExt: string; language?: string },
	opts: { runFn?: CommandRunner; timeoutMs?: number } = {},
): string {
	const runFn = opts.runFn ?? defaultRunner;
	const inPath = scratch("stt-in", (args.audioExt || "wav").replace(/^\./, ""));
	const outPath = scratch("stt-out", "txt");
	fs.writeFileSync(inPath, args.audioBytes);
	try {
		const cmd = fillCommandTemplate(template, { input: inPath, output: outPath, language: args.language ?? "" });
		const r = runFn(cmd, opts.timeoutMs ?? 300_000);
		if (r.code !== 0) throw new Error(`STT command exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`);
		const fromFile = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8").trim() : "";
		return fromFile || r.stdout.trim();
	} finally {
		safeUnlink(inPath);
		safeUnlink(outPath);
	}
}
