/**
 * iMessage send-effect (balloon / screen) id resolution.
 *
 * The Private-API `message/text` endpoint accepts an `effectId` — Apple's bundle
 * identifier for a bubble or screen effect (`com.apple.MobileSMS.expressivesend.*`
 * / `com.apple.messages.effect.*`). `resolveEffectId` maps a friendly short name
 * (`"confetti"`, `"slam"`, `"invisible ink"`) onto that id; an already-qualified
 * Apple id passes through.
 */

/** Friendly name → Apple effect bundle id. */
const EFFECT_MAP: Record<string, string> = {
	// Bubble effects
	slam: "com.apple.MobileSMS.expressivesend.impact",
	impact: "com.apple.MobileSMS.expressivesend.impact",
	loud: "com.apple.MobileSMS.expressivesend.loud",
	gentle: "com.apple.MobileSMS.expressivesend.gentle",
	invisible: "com.apple.MobileSMS.expressivesend.invisibleink",
	"invisible-ink": "com.apple.MobileSMS.expressivesend.invisibleink",
	"invisible ink": "com.apple.MobileSMS.expressivesend.invisibleink",
	invisibleink: "com.apple.MobileSMS.expressivesend.invisibleink",
	// Screen effects
	echo: "com.apple.messages.effect.CKEchoEffect",
	spotlight: "com.apple.messages.effect.CKSpotlightEffect",
	balloons: "com.apple.messages.effect.CKHappyBirthdayEffect",
	confetti: "com.apple.messages.effect.CKConfettiEffect",
	love: "com.apple.messages.effect.CKHeartEffect",
	heart: "com.apple.messages.effect.CKHeartEffect",
	hearts: "com.apple.messages.effect.CKHeartEffect",
	lasers: "com.apple.messages.effect.CKLasersEffect",
	fireworks: "com.apple.messages.effect.CKFireworksEffect",
	celebration: "com.apple.messages.effect.CKSparklesEffect",
	sparkles: "com.apple.messages.effect.CKSparklesEffect",
};

/**
 * Resolve an effect name to an Apple effect id. Tries the literal name, then a
 * `[\s_]`→`-` variant, then a separator-stripped compact form; an already-fully-
 * qualified `com.apple.*` id passes through. Returns undefined for an unknown
 * name (the caller then sends with no effect).
 */
export function resolveEffectId(raw: string): string | undefined {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return undefined;
	if (/^com\.apple\./i.test(trimmed)) return trimmed;
	const lower = trimmed.toLowerCase();
	if (EFFECT_MAP[lower]) return EFFECT_MAP[lower];
	const dashed = lower.replace(/[\s_]+/g, "-");
	if (EFFECT_MAP[dashed]) return EFFECT_MAP[dashed];
	const compact = lower.replace(/[\s_-]+/g, "");
	if (EFFECT_MAP[compact]) return EFFECT_MAP[compact];
	return undefined;
}
