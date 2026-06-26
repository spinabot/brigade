import assert from "node:assert/strict";
import { test } from "node:test";

import { secMsGec, configFrame, ssmlFrame, escapeXml } from "./edge-tts.js";

test("secMsGec is 64-char uppercase hex, stable within a 5-min bucket, changes across buckets", () => {
	const a = secMsGec(1_700_000_000_000);
	assert.match(a, /^[0-9A-F]{64}$/);
	// 10s apart → same 5-minute bucket → identical token.
	assert.equal(secMsGec(1_700_000_000_000), secMsGec(1_700_000_010_000));
	// 400s apart → different bucket → different token.
	assert.notEqual(secMsGec(1_700_000_000_000), secMsGec(1_700_000_400_000));
});

test("ssmlFrame embeds the voice + escaped text + Path:ssml", () => {
	const frame = ssmlFrame("a & b <c>", "en-US-AvaNeural");
	assert.ok(frame.includes("Path:ssml"));
	assert.ok(frame.includes("name='en-US-AvaNeural'"));
	assert.ok(frame.includes("a &amp; b &lt;c&gt;"));
});

test("configFrame carries the output format + Path:speech.config", () => {
	const frame = configFrame("audio-24khz-48kbitrate-mono-mp3");
	assert.ok(frame.includes("Path:speech.config"));
	assert.ok(frame.includes("audio-24khz-48kbitrate-mono-mp3"));
});

test("escapeXml escapes the five XML metacharacters", () => {
	assert.equal(escapeXml(`& < > ' "`), "&amp; &lt; &gt; &apos; &quot;");
});
