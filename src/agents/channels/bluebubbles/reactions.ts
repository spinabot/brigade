/**
 * BlueBubbles tapback / reaction maps.
 *
 * iMessage "tapbacks" are the six canonical reactions. They cross the wire two
 * different ways:
 *
 *   OUTBOUND — the Private-API `message/react` endpoint takes a TYPE NAME string
 *   (`"love"`, `"like"`, …), with a leading `-` to REMOVE
 *   (`"-love"`). `normalizeBlueBubblesReaction` resolves any input — a type name,
 *   a common alias, or an emoji glyph — to that wire string.
 *
 *   INBOUND — a tapback arrives as a MESSAGE whose `associatedMessageType` is a
 *   numeric code: `2000-2005` = ADD, `3000-3005` = REMOVE, in the canonical order
 *   love/like/dislike/laugh/emphasize/question. `decodeTapbackType` maps that
 *   code to `{ emoji, action }` so the inbound path can DROP the tapback as a
 *   normal message and (optionally) surface it as a reaction note.
 */

/** The six canonical iMessage tapback types. */
export type BlueBubblesReactionType = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

/** Ordered tapback types — index N maps to the `200N` (add) / `300N` (remove) code. */
const REACTION_ORDER: readonly BlueBubblesReactionType[] = [
	"love",
	"like",
	"dislike",
	"laugh",
	"emphasize",
	"question",
];

/** Tapback type → its representative emoji (for inbound surfacing). */
const REACTION_EMOJI: Record<BlueBubblesReactionType, string> = {
	love: "❤️",
	like: "👍",
	dislike: "👎",
	laugh: "😂",
	emphasize: "‼️",
	question: "❓",
};

/**
 * Text/name aliases → canonical type. Covers the canonical names, the
 * Apple/Messages past-tense forms, and a broad colloquial set (`fire`, `wow`,
 * `lmao`, `xd`, `ok`, `boo`, `heart_eyes`, `important`, `bang`, `ask`, …) so the
 * agent can name a tapback however it likes.
 */
const REACTION_ALIASES: Record<string, BlueBubblesReactionType> = {
	// love
	love: "love",
	heart: "love",
	loved: "love",
	red_heart: "love",
	heart_eyes: "love",
	fire: "love",
	// like
	like: "like",
	liked: "like",
	thumbsup: "like",
	thumb: "like",
	"thumbs-up": "like",
	"thumbs up": "like",
	thumbs_up: "like",
	ok: "like",
	// dislike
	dislike: "dislike",
	disliked: "dislike",
	thumbsdown: "dislike",
	"thumbs-down": "dislike",
	"thumbs down": "dislike",
	thumbs_down: "dislike",
	boo: "dislike",
	no: "dislike",
	// laugh
	laugh: "laugh",
	laughed: "laugh",
	haha: "laugh",
	lol: "laugh",
	lmao: "laugh",
	rofl: "laugh",
	xd: "laugh",
	smile: "laugh",
	smiley: "laugh",
	happy: "laugh",
	joy: "laugh",
	// emphasize / exclaim
	emphasize: "emphasize",
	emphasized: "emphasize",
	emphasis: "emphasize",
	exclaim: "emphasize",
	important: "emphasize",
	bang: "emphasize",
	wow: "emphasize",
	"!!": "emphasize",
	"!": "emphasize",
	// question
	question: "question",
	questioned: "question",
	ask: "question",
	"?": "question",
};

/** Emoji glyph → canonical type (resolves the common variants + the broadened set). */
const REACTION_EMOJIS: Record<string, BlueBubblesReactionType> = {
	// love
	"❤️": "love",
	"❤": "love",
	"♥️": "love",
	"♥": "love",
	"🩷": "love",
	"😍": "love",
	"💕": "love",
	"🔥": "love",
	// like
	"👍": "like",
	"👍🏻": "like",
	"👌": "like",
	// dislike
	"👎": "dislike",
	"👎🏻": "dislike",
	"🙅": "dislike",
	// laugh
	"😂": "laugh",
	"🤣": "laugh",
	"😆": "laugh",
	"😁": "laugh",
	"😹": "laugh",
	// emphasize
	"‼️": "emphasize",
	"‼": "emphasize",
	"❗": "emphasize",
	"❕": "emphasize",
	// question
	"❓": "question",
	"❔": "question",
};

/**
 * Resolve any reaction input to the BlueBubbles wire string for `message/react`.
 * A leading `-` (e.g. `"-love"`) or the words `remove`/`removed` mark a REMOVAL.
 * Returns null when the input doesn't map to a known tapback.
 */
export function normalizeBlueBubblesReaction(raw: string): string | null {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return null;
	let remove = false;
	let body = trimmed;
	if (body.startsWith("-")) {
		remove = true;
		body = body.slice(1).trim();
	}
	const lower = body.toLowerCase();
	if (lower.startsWith("remove ") || lower.startsWith("removed ")) {
		remove = true;
		body = body.replace(/^removed?\s+/i, "").trim();
	}
	const type = resolveReactionType(body);
	if (!type) return null;
	return remove ? `-${type}` : type;
}

/** Resolve a name/alias/emoji to a canonical reaction type (null when unknown). */
export function resolveReactionType(raw: string): BlueBubblesReactionType | null {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return null;
	const lower = trimmed.toLowerCase();
	if (REACTION_ALIASES[lower]) return REACTION_ALIASES[lower];
	if (REACTION_EMOJIS[trimmed]) return REACTION_EMOJIS[trimmed];
	// Bare canonical type passes through.
	if ((REACTION_ORDER as readonly string[]).includes(lower)) return lower as BlueBubblesReactionType;
	return null;
}

/** The decoded inbound tapback: which emoji, and add vs remove. */
export interface DecodedTapback {
	type: BlueBubblesReactionType;
	emoji: string;
	action: "added" | "removed";
}

/**
 * Decode an inbound `associatedMessageType` numeric code into a tapback. Codes
 * `2000-2005` are ADD; `3000-3005` are REMOVE; the low digit selects the type in
 * canonical order. Returns null for any non-tapback type.
 */
export function decodeTapbackType(associatedMessageType: number | undefined): DecodedTapback | null {
	if (typeof associatedMessageType !== "number" || !Number.isFinite(associatedMessageType)) return null;
	let action: "added" | "removed";
	let index: number;
	if (associatedMessageType >= 2000 && associatedMessageType <= 2005) {
		action = "added";
		index = associatedMessageType - 2000;
	} else if (associatedMessageType >= 3000 && associatedMessageType <= 3005) {
		action = "removed";
		index = associatedMessageType - 3000;
	} else {
		return null;
	}
	const type = REACTION_ORDER[index];
	if (!type) return null;
	return { type, emoji: REACTION_EMOJI[type], action };
}

/**
 * True iff an `associatedMessageType` is in the tapback range at all (2000-3999).
 * Used to DROP a tapback-as-message so it isn't replied to as normal text and so
 * a reaction-association isn't mistaken for a reply target.
 */
export function isTapbackAssociatedType(associatedMessageType: number | undefined): boolean {
	return (
		typeof associatedMessageType === "number" &&
		Number.isFinite(associatedMessageType) &&
		associatedMessageType >= 2000 &&
		associatedMessageType < 4000
	);
}
