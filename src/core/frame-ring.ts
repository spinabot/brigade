/**
 * A bounded, per-session ring of ordered frames — the thing that makes
 * `resume(sinceSeq)` able to replay what a client actually missed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY IT IS NOT "JUST STAMP EVERYTHING WITH A SEQ"
 * ─────────────────────────────────────────────────────────────────────────
 * Brigade's ordered stream is gap-DETECTABLE but only partly gap-REPAIRABLE.
 * A client tracks the last seq it saw per session; a jump means it missed a
 * frame and it calls `resume`. Resume then rebuilds from the JSONL transcript,
 * which is the single source of truth — for anything the transcript contains.
 *
 * The frames it does NOT contain are SYNTHETIC ones — the tool events Brigade
 * mints for a `claude-cli` turn, whose tools run inside the binary's own loop
 * via the MCP route. They are real work the operator watched happen and they
 * are in no transcript at all, but they carry the ROUTING session key, so
 * `resume` can find them again.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY SUB-AGENT FRAMES ARE *NOT* HERE, HAVING BRIEFLY BEEN
 * ─────────────────────────────────────────────────────────────────────────
 * They look like the same case and they are not, for one reason: a sub-agent
 * frame is tagged with the CHILD's Pi session UUID, while `resume` is called
 * with an `agent:…` session KEY. Retaining under one namespace and replaying
 * from the other means the replay can never fire — so sequencing them would
 * rest on a guarantee that does not exist, which is exactly the mistake the
 * original "do not sequence what you cannot replay" rule forbids.
 *
 * Sequencing them also had costs the promise was supposed to justify: every
 * `spawn_agent` minted a new entry in the gateway's per-session counter map,
 * which evicts in CREATION order — so the operator's own long-lived session,
 * created first, was evicted first, restarting its counter and triggering a
 * full transcript repaint on every connected client. And a terminal `agent_end`
 * frame carries the child's entire transcript, which the oversize carve-out
 * below would retain permanently on a session that never receives another
 * frame.
 *
 * Making sub-agent replay real means teaching `resume` the child namespace and
 * having a client that actually sends a cursor. Until both exist, retaining
 * them is pure cost, so they stay unsequenced and unretained as before.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY *NOT* BUFFERED
 * ─────────────────────────────────────────────────────────────────────────
 * Top-level `message_update` frames. They are cumulative — each carries the
 * whole message so far — so buffering a long reply costs O(n²) memory to
 * redeliver something `resume` already returns from the transcript, better.
 * The transcript is the right recovery path for anything it holds; this ring
 * exists strictly for what it does not.
 *
 * That means a replay can be PARTIAL: the ring may hold frames 7 and 9 while 8
 * was a `message_update` recoverable from the transcript instead.
 *
 * `complete` answers exactly one question — "is the oldest frame I still hold
 * the next one this cursor expects?" — and deliberately NOT "are there interior
 * gaps?". Interior gaps are expected by design here, because the frames that
 * create them are the ones the transcript rebuilds better. A caller must apply
 * the transcript FIRST and treat these frames as an overlay; `complete: true`
 * means "nothing has aged out from under your cursor", never "this is every
 * frame in that range".
 */

/** One retained frame: its sequence, and the exact bytes that were broadcast. */
export interface RetainedFrame {
	seq: number;
	/** The serialized frame, byte-identical to what subscribers received. */
	json: string;
}

export interface FrameRingLimits {
	/** Frames retained per session. */
	maxFrames: number;
	/** Bytes retained per session. Whichever bound trips first wins. */
	maxBytes: number;
	/** Distinct sessions retained before the coldest are dropped. */
	maxSessions: number;
}

export const DEFAULT_FRAME_RING_LIMITS: FrameRingLimits = {
	// A sub-agent fan-out is bursty but short. 256 frames covers a deep nested
	// run; past that the transcript-projection fallback takes over, which is a
	// degraded-but-correct recovery rather than a wrong one.
	maxFrames: 256,
	// Hard ceiling regardless of count, because one frame can be large. 512 KiB
	// per session bounds the worst case at a few hundred MiB across the session
	// cap — and the session cap is what actually holds the line.
	maxBytes: 512 * 1024,
	// Matches the gateway's existing RECOVERY_SESSION_MAX so recovery state ages
	// out together rather than in two different rhythms.
	maxSessions: 512,
};

interface SessionRing {
	frames: RetainedFrame[];
	bytes: number;
}

/**
 * Per-session retention of replayable frames.
 *
 * Insertion-ordered `Map`, re-inserted on write, so the first key is always the
 * least-recently-written session — the same LRU discipline the gateway's other
 * recovery maps use.
 */
export class FrameRing {
	private readonly sessions = new Map<string, SessionRing>();
	private readonly limits: FrameRingLimits;

	constructor(limits: Partial<FrameRingLimits> = {}) {
		this.limits = { ...DEFAULT_FRAME_RING_LIMITS, ...limits };
	}

	/**
	 * Retain one frame for a session.
	 *
	 * Callers pass the already-serialized JSON so the ring stores exactly what
	 * went out — a re-serialization could differ in key order and defeat the
	 * point of replaying "the same bytes".
	 */
	retain(sessionId: string | undefined, seq: number, json: string): void {
		if (!sessionId || !Number.isFinite(seq)) return;
		const ring = this.sessions.get(sessionId) ?? { frames: [], bytes: 0 };
		this.sessions.delete(sessionId); // LRU touch
		ring.frames.push({ seq, json });
		ring.bytes += json.length;
		// Oldest-first eviction on either bound. A single frame larger than the
		// byte cap is still retained (the loop stops at one frame) — dropping it
		// would leave a hole nothing can fill, which is worse than briefly
		// exceeding a soft ceiling.
		while (
			ring.frames.length > this.limits.maxFrames ||
			(ring.bytes > this.limits.maxBytes && ring.frames.length > 1)
		) {
			const dropped = ring.frames.shift();
			if (!dropped) break;
			ring.bytes -= dropped.json.length;
		}
		this.sessions.set(sessionId, ring);
		while (this.sessions.size > this.limits.maxSessions) {
			const coldest = this.sessions.keys().next().value as string | undefined;
			if (coldest === undefined) break;
			this.sessions.delete(coldest);
		}
	}

	/**
	 * Frames after `sinceSeq`, oldest first.
	 *
	 * `complete` is the honest part of this API. It is true only when the ring
	 * can prove it still holds everything after the cursor — i.e. the oldest
	 * frame retained is the very next one the client expects. If the ring has
	 * been trimmed past that point, some frames are gone for good and the caller
	 * must fall back to the transcript rather than pretend the gap was closed.
	 *
	 * A cursor at or beyond the newest retained frame is `complete` with nothing
	 * to send: the client is already current.
	 */
	replayFrom(sessionId: string | undefined, sinceSeq: number): { frames: RetainedFrame[]; complete: boolean } {
		if (!sessionId) return { frames: [], complete: false };
		const ring = this.sessions.get(sessionId);
		if (!ring || ring.frames.length === 0) {
			// Nothing retained. Only "complete" if the caller is not actually
			// behind — which this ring cannot know, so say no and let the caller
			// compare against headSeq.
			return { frames: [], complete: false };
		}
		const oldest = ring.frames[0]!.seq;
		const frames = ring.frames.filter((f) => f.seq > sinceSeq);
		// Everything the client is missing is still here iff the ring's oldest
		// retained frame is no newer than the first frame it expects.
		const complete = oldest <= sinceSeq + 1;
		return { frames, complete };
	}

	/** Drop a session's retained frames (session deleted, or state reset). */
	forget(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	/** Retained frame count for a session — for tests and diagnostics. */
	countFor(sessionId: string): number {
		return this.sessions.get(sessionId)?.frames.length ?? 0;
	}

	get size(): number {
		return this.sessions.size;
	}
}

/* ───────────────────────── which frames are which ───────────────────────── */

export interface FrameClassInput {
	/** The event kind: `pi`, `approval-request`, `system-event`, `state`, … */
	event: string;
	/** Nesting depth for `pi` frames. 0 is the operator's own turn. */
	subagentDepth?: number;
	/** Minted by Brigade rather than emitted by Pi (the claude-cli tool plane). */
	synthetic?: boolean;
}

export interface FrameClass {
	/** Carries a monotonic per-session `seq`, so a client can detect a gap. */
	ordered: boolean;
	/** Must be RETAINED to be recoverable — no transcript can rebuild it. */
	replayOnly: boolean;
}

/**
 * Decide whether a frame is sequenced, and whether it must be retained.
 *
 * Extracted from `broadcast()` so it can be tested at all. Inline, the only way
 * to cover it was to boot a gateway; the practical result was that the rule
 * which decides what is recoverable had no direct test, on the exact path where
 * being wrong loses an operator's output silently.
 *
 * The two flags are not independent: `replayOnly` implies `ordered`, because
 * retention is precisely what makes sequencing those frames safe.
 */
export function classifyFrame(input: FrameClassInput): FrameClass {
	const isPi = input.event === "pi";
	// Clamped at 0. A negative depth is meaningless, and left unclamped it fell
	// through BOTH branches below — `depth > 0` false so not replay-only, and
	// `depth === 0` false so not top-level — quietly dropping the frame out of
	// the ordered stream altogether. A frame that vanishes from the sequence is
	// exactly the failure this subsystem exists to prevent.
	const rawDepth = isPi ? Number(input.subagentDepth) : 0;
	const depth = Number.isFinite(rawDepth) && rawDepth > 0 ? rawDepth : 0;
	const synthetic = isPi && input.synthetic === true;

	// SYNTHETIC DEPTH-0 FRAMES ONLY. Sub-agent frames are deliberately excluded
	// again — see the header for the full account. In short: they are retained
	// under the child's Pi session UUID while `resume` reads by session key, so
	// they were sequenced on a promise of replayability that never held, and
	// sequencing them flooded the gateway's per-session counter map.
	const replayOnly = isPi && depth === 0 && synthetic;

	const ordered =
		(isPi && depth === 0) ||
		input.event === "approval-request" ||
		input.event === "system-event";

	return { ordered, replayOnly };
}
