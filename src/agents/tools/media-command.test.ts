import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { fillCommandTemplate, runCommandTts, runCommandStt } from "./media-command.js";

test("fillCommandTemplate substitutes {key} literally (values are inert)", () => {
	assert.equal(
		fillCommandTemplate("tts {text_path} -o {output} -v {voice}", {
			text_path: "/tmp/a.txt",
			output: "/tmp/b.wav",
			voice: "v1",
		}),
		"tts /tmp/a.txt -o /tmp/b.wav -v v1",
	);
});

test("runCommandTts writes text to {text_path}, runs the command, reads the {output} bytes", () => {
	let ranCmd = "";
	const res = runCommandTts(
		"piper --output_file {output} --voice {voice} < {text_path}",
		{ text: "hello world", voice: "lessac", outExt: "wav" },
		{
			runFn: (cmd) => {
				ranCmd = cmd;
				// The text file must already exist (written before the command runs).
				const textPath = /< (\S+\.txt)/.exec(cmd)?.[1] ?? "";
				assert.ok(existsSync(textPath), "text temp file should exist");
				assert.equal(readFileSync(textPath, "utf8"), "hello world");
				// Simulate the TTS binary writing audio to {output}.
				const out = /--output_file (\S+\.wav)/.exec(cmd)?.[1] ?? "";
				writeFileSync(out, Buffer.from([0xff, 0xfb, 0x90]));
				return { code: 0, stdout: "", stderr: "" };
			},
		},
	);
	assert.equal(res.extension, "wav");
	assert.equal(res.bytes.length, 3);
	assert.ok(ranCmd.includes("--voice lessac"));
});

test("runCommandTts throws cleanly when the command writes no output", () => {
	assert.throws(
		() => runCommandTts("noop {output}", { text: "x", voice: "v" }, { runFn: () => ({ code: 0, stdout: "", stderr: "" }) }),
		/did not write/i,
	);
});

test("runCommandTts surfaces a non-zero exit", () => {
	assert.throws(
		() => runCommandTts("fail {output}", { text: "x", voice: "v" }, { runFn: () => ({ code: 1, stdout: "", stderr: "boom" }) }),
		/exited 1.*boom/i,
	);
});

test("runCommandStt writes audio to {input}, returns transcript from {output} file", () => {
	const out = runCommandStt(
		"whisper {input} --output {output} --language {language}",
		{ audioBytes: Buffer.from([1, 2, 3]), audioExt: "wav", language: "en" },
		{
			runFn: (cmd) => {
				const input = /whisper (\S+\.wav)/.exec(cmd)?.[1] ?? "";
				assert.ok(existsSync(input), "audio temp file should exist");
				assert.equal(readFileSync(input).length, 3);
				assert.ok(cmd.includes("--language en"));
				const o = /--output (\S+\.txt)/.exec(cmd)?.[1] ?? "";
				writeFileSync(o, "the transcript\n");
				return { code: 0, stdout: "", stderr: "" };
			},
		},
	);
	assert.equal(out, "the transcript");
});

test("runCommandStt falls back to stdout when the command writes no {output}", () => {
	const out = runCommandStt(
		"whisper {input}",
		{ audioBytes: Buffer.from([1]), audioExt: "mp3" },
		{ runFn: () => ({ code: 0, stdout: "  hello from stdout  ", stderr: "" }) },
	);
	assert.equal(out, "hello from stdout");
});
