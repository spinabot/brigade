/** Channel access control — public surface. */

export { evaluateAccess, type EvaluateAccessArgs } from "./policy.js";
export {
	formatAllowFrom,
	type AllowFromEntry,
	type FormatAllowFromOptions,
} from "./format-allow-from.js";
export {
	PAIRING_MAX_PENDING,
	PAIRING_TTL_MS,
	addAllowFrom,
	approvePairingCode,
	clearChannelOwner,
	eraseAccessState,
	isAllowed,
	readAllowFrom,
	readChannelOwner,
	readGroupAllowFrom,
	readPendingPairings,
	removeAllowFrom,
	revokePairingCode,
	setChannelOwner,
	upsertPairingRequest,
} from "./store.js";
export type { AccessDecision, DmPolicy, PairingRequest } from "./types.js";
