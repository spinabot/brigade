/**
 * Approval-callback codec — the wire format for inline-button approvals.
 *
 * Some channels (Telegram, Slack block-kit, Discord components) render an
 * approval prompt as native buttons instead of a "reply yes/no" text card. When
 * the operator taps a button the channel delivers a `callback_query`-style event
 * carrying an opaque payload string the BUTTON declared at send time. This codec
 * is the central, channel-neutral encode/decode for that payload: it packs the
 * pending-approval id + the chosen decision into one short string, and unpacks
 * it back on the way in.
 *
 * THE 64-BYTE BUDGET. Telegram's `callback_data` is capped at **64 bytes** (a
 * hard Bot API limit — a longer value is rejected outright). That is the
 * tightest channel constraint, so this codec treats 64 bytes as the universal
 * ceiling: {@link encodeApprovalCallback} returns `undefined` when the payload
 * would exceed it (the caller then omits / falls back to the text prompt rather
 * than ship an oversized button). The budget is measured in UTF-8 BYTES, not
 * `string.length`, so a multi-byte id can't sneak past the limit.
 *
 * WIRE FORMAT (channel-neutral, no brand tokens, printable ASCII only):
 *
 *     <tag>:<base64url(approvalId)>:<decisionCode>
 *
 *   - `tag` is the constant {@link APPROVAL_CALLBACK_TAG} = `"bv1"` (a versioned
 *     marker — `b`rigade callback `v1` — that lets the decoder reject foreign
 *     button payloads fast and lets a future format bump cleanly).
 *   - the approval id is base64url-encoded so it can carry the `:`/`-`/`_`
 *     characters real ids use without colliding with the field delimiter.
 *   - `decisionCode` is a single char: `o` = allow-once, `a` = allow-always,
 *     `d` = deny. Single chars (rather than the full `allow-always` words) keep
 *     the payload comfortably inside 64 bytes.
 *
 * No NUL / control bytes ever appear: base64url is `[A-Za-z0-9_-]`, the tag is
 * lowercase ASCII, the delimiter is a printable colon, and the decision code is
 * one of three ASCII letters.
 *
 * The decision vocabulary is the channel-approval subset of the bridge's
 * `ApprovalDecisionKind` — exactly the three an operator can choose from a
 * button (`allow-once` / `allow-always` / `deny`); the bridge's other kinds
 * (`allow-pattern`, `allow-session`) are not button-reachable.
 */

/** Decisions an inline approval button can encode. */
export type ApprovalCallbackDecision = "allow-once" | "allow-always" | "deny";

/**
 * Versioned, brand-neutral marker prefixing every approval callback payload.
 * `b`rigade callback `v1`. Bumping the version (`bv2`, …) lets a new wire
 * format coexist with old in-flight buttons.
 */
export const APPROVAL_CALLBACK_TAG = "bv1";

/**
 * Telegram's `callback_data` hard limit — the tightest channel constraint, used
 * here as the universal ceiling. Measured in UTF-8 bytes.
 */
export const APPROVAL_CALLBACK_MAX_BYTES = 64;

const DELIMITER = ":";

/** Map a full decision kind to its single-char wire code. */
function decisionToCode(decision: ApprovalCallbackDecision): "o" | "a" | "d" {
	switch (decision) {
		case "allow-once":
			return "o";
		case "allow-always":
			return "a";
		case "deny":
			return "d";
	}
}

/** Map a single-char wire code back to a decision kind (or null if unknown). */
function codeToDecision(code: string): ApprovalCallbackDecision | null {
	switch (code) {
		case "o":
			return "allow-once";
		case "a":
			return "allow-always";
		case "d":
			return "deny";
		default:
			return null;
	}
}

/** Base64url-encode (no padding) — `[A-Za-z0-9_-]`, never a NUL/control byte. */
function toBase64Url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

/** Base64url-decode back to UTF-8. Returns "" on malformed input. */
function fromBase64Url(value: string): string {
	try {
		return Buffer.from(value, "base64url").toString("utf8");
	} catch {
		return "";
	}
}

/** True iff `value` fits the universal callback-data byte budget. */
export function fitsApprovalCallback(value: string): boolean {
	return Buffer.byteLength(value, "utf8") <= APPROVAL_CALLBACK_MAX_BYTES;
}

/** One inline button in an approval prompt: a label + its encoded payload. */
export interface ApprovalCallbackButton {
	/** Operator-facing button label. */
	label: string;
	/** The decision this button encodes. */
	decision: ApprovalCallbackDecision;
	/** Codec-encoded callback payload (<= 64 bytes), suitable for `callback_data`. */
	data: string;
}

/**
 * Build the standard three approval buttons (Allow once / Allow always / Deny)
 * for an approval id, each carrying its codec-encoded payload. A channel's
 * `sendApprovalPrompt` calls this to get a ready-made, byte-safe button spec
 * instead of re-deriving the encoding by hand, then maps each `{ label, data }`
 * onto its own native button type.
 *
 * `allowAlways: false` drops the "Allow always" button (for approvals where
 * persisting an allowlist entry doesn't apply). Any button whose payload would
 * exceed the 64-byte budget is OMITTED (never shipped oversized) — in practice
 * that only happens for pathologically long approval ids, and the caller should
 * fall back to the text prompt when fewer than two buttons come back.
 */
export function buildApprovalCallbackButtons(args: {
	approvalId: string;
	allowAlways?: boolean;
}): ApprovalCallbackButton[] {
	const specs: Array<{ label: string; decision: ApprovalCallbackDecision }> = [
		{ label: "Allow once", decision: "allow-once" },
		...(args.allowAlways === false
			? []
			: [{ label: "Allow always", decision: "allow-always" as const }]),
		{ label: "Deny", decision: "deny" },
	];
	const buttons: ApprovalCallbackButton[] = [];
	for (const spec of specs) {
		const data = encodeApprovalCallback({ approvalId: args.approvalId, decision: spec.decision });
		if (!data) continue; // oversized payload → omit this button
		buttons.push({ label: spec.label, decision: spec.decision, data });
	}
	return buttons;
}

/**
 * Encode an approval id + decision into a callback payload string.
 *
 * Returns `undefined` when the result would exceed {@link APPROVAL_CALLBACK_MAX_BYTES}
 * (64 UTF-8 bytes) OR when the approval id is empty — in either case the caller
 * must NOT render that button (fall back to the text prompt). A non-undefined
 * return is always a wire-safe, printable-ASCII string under the limit.
 */
export function encodeApprovalCallback(args: {
	approvalId: string;
	decision: ApprovalCallbackDecision;
}): string | undefined {
	const id = args.approvalId.trim();
	if (!id) return undefined;
	const payload = `${APPROVAL_CALLBACK_TAG}${DELIMITER}${toBase64Url(id)}${DELIMITER}${decisionToCode(args.decision)}`;
	if (!fitsApprovalCallback(payload)) return undefined;
	return payload;
}

/**
 * Decode a callback payload string back into `{ approvalId, decision }`.
 *
 * Returns `null` for anything that isn't a well-formed approval callback — a
 * foreign button payload, a truncated/garbled string, an unknown decision code,
 * or an oversized value. A `null` return means "not an approval callback; let
 * the caller fall through" exactly like the text decoder's `null`.
 */
export function decodeApprovalCallback(
	data: string,
): { approvalId: string; decision: ApprovalCallbackDecision } | null {
	if (typeof data !== "string" || data.length === 0) return null;
	// Reject oversized payloads up front — anything over the budget could not
	// have been minted by our encoder, so it isn't ours to decode.
	if (!fitsApprovalCallback(data)) return null;
	const parts = data.split(DELIMITER);
	if (parts.length !== 3) return null;
	const [tag, idB64, code] = parts;
	if (tag !== APPROVAL_CALLBACK_TAG) return null;
	if (!idB64) return null;
	const approvalId = fromBase64Url(idB64).trim();
	if (!approvalId) return null;
	const decision = codeToDecision(code ?? "");
	if (decision === null) return null;
	return { approvalId, decision };
}
