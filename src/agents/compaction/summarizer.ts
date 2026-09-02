/**
 * The compaction summarizer — Brigade's own, not Pi's.
 *
 * Pi's `compact()` owns a prompt Brigade cannot see, price or harden, and it
 * REPLACES the session's history. Mid-turn compaction needs neither: it needs a
 * summary of a prefix, produced on demand, with the transcript left untouched.
 *
 * So the summarization runs on an ISOLATED, tool-less session — the same
 * mechanism the memory and skill distillers already use (`makeIsolatedLlm`).
 * Three properties matter here and all of them fall out of that choice:
 *
 *   • It builds its OWN Pi session, which carries no `transformContext`. A
 *     summarizer that ran through Brigade's transform chain could re-enter
 *     mid-turn compaction and recurse; this one structurally cannot.
 *   • It is `inMemory()`, so a compaction writes nothing to disk and never
 *     appears in the operator's transcript as a phantom turn.
 *   • It reuses the resolved model and auth, so it works on all 21 providers
 *     with no per-provider branch — which is the entire reason mid-turn
 *     compaction is built on a transform seam rather than Anthropic's
 *     server-side `pause_after_compaction` beta.
 */

import {
	makeIsolatedLlm,
	type IsolatedLlmUsage,
	type MakeExtractionLlmArgs,
} from "../memory/extract.js";
import { buildCompactionSystemPrompt, wrapTranscriptForSummary } from "./summarizer-prompt.js";

/**
 * Wall-clock cap on one mid-turn summarization.
 *
 * Sized from observed reality rather than taste: Claude Code's own transcripts
 * show compactions taking well over a minute on a full window, so a 60s bound
 * would fail the exact case compaction exists for. Tunable for slower local
 * models.
 */
export const COMPACTION_LLM_TIMEOUT_MS_DEFAULT = 120_000;

export function getCompactionTimeoutMs(): number {
	const raw = process.env.BRIGADE_COMPACTION_TIMEOUT_MS;
	const parsed = raw ? Number(raw) : NaN;
	// 10s floor so a misconfigured "0" cannot disable compaction by timing out
	// before any model could answer.
	return Number.isFinite(parsed) && parsed >= 10_000
		? parsed
		: COMPACTION_LLM_TIMEOUT_MS_DEFAULT;
}

export interface CompactionSummarizerArgs extends MakeExtractionLlmArgs {
	/** Fold a previous compaction forward instead of summarizing a summary. */
	priorSummary?: string;
	timeoutMs?: number;
	/**
	 * What the summarization cost, so it can be metered rather than recorded as
	 * unpriceable spend. Compaction on a full window is one of the largest
	 * single model calls Brigade ever makes; leaving it unpriced degraded the
	 * operator's session total to `≥$X` for the rest of the session.
	 */
	onUsage?: (usage: IsolatedLlmUsage) => void;
}

/**
 * Build `(transcript) => Promise<summary>` for the mid-turn compactor.
 *
 * Returns `undefined` when the pieces needed to make a model call are missing,
 * so the caller can leave mid-turn compaction off rather than wiring a
 * summarizer that would fail on first use.
 */
export function createCompactionSummarizer(
	args: CompactionSummarizerArgs,
): ((transcript: string, signal?: AbortSignal, priorSummary?: string) => Promise<string>) | undefined {
	if (!args.workspaceDir || !args.agentDir || !args.model || !args.modelRegistry) {
		return undefined;
	}
	// The prompt is built PER CALL, because whether a prior summary exists is a
	// property of the history at that moment, not of the turn. Baking it in at
	// construction time meant a second compaction inside one turn would have
	// re-summarized the first one — the telephone game the `<prior-summary>`
	// slot exists to prevent.
	const build = (priorSummary?: string) =>
		makeIsolatedLlm(
			buildCompactionSystemPrompt(priorSummary === undefined ? {} : { priorSummary }),
			{
				workspaceDir: args.workspaceDir,
				agentDir: args.agentDir,
				authStorage: args.authStorage,
				modelRegistry: args.modelRegistry,
				model: args.model,
			},
			args.timeoutMs ?? getCompactionTimeoutMs(),
			args.onUsage,
		);
	// The transcript is wrapped in a delimiter the system prompt's security
	// block refers to by name. Tool output — fetched pages, file contents,
	// command results — is attacker-influenceable, and a summary is re-injected
	// into the model's context on every later turn, so an injection that lands
	// here is persistent. Of every harness surveyed, only Gemini CLI guards it.
	//
	// FORWARD THE SIGNAL. This parameter used to be spelt `_signal` and dropped,
	// which made the whole abort path decorative: the runner would stop WAITING
	// on a cancelled summarization, but the isolated session underneath kept
	// streaming a full context window to the provider and kept billing for it.
	// Compaction is one of the largest single calls Brigade makes, so the one
	// call an operator most wants to cancel was the one call they could not.
	return (transcript: string, signal?: AbortSignal, priorSummary?: string) =>
		build(priorSummary ?? args.priorSummary)(wrapTranscriptForSummary(transcript), signal);
}
