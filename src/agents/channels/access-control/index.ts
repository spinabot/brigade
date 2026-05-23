/** Channel access control — public surface. */

export { evaluateAccess, type EvaluateAccessArgs } from "./policy.js";
export {
	PAIRING_MAX_PENDING,
	PAIRING_TTL_MS,
	addAllowFrom,
	approvePairingCode,
	eraseAccessState,
	isAllowed,
	readAllowFrom,
	readGroupAllowFrom,
	readPendingPairings,
	removeAllowFrom,
	revokePairingCode,
	upsertPairingRequest,
} from "./store.js";
export type { AccessDecision, DmPolicy, PairingRequest } from "./types.js";
