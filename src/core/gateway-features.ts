import { EVENT_NAMES, REQUEST_METHODS } from "../protocol.js";
import { type HelloOk, PROTOCOL_CAPABILITIES } from "../protocol/handshake.js";
import { listRegisteredMethods } from "./gateway-caller-impl.js";

/**
 * Build each connection's discovery snapshot from every live dispatch source.
 *
 * The WebSocket dispatcher handles static wire methods, extension methods and
 * the in-process handler registry. Omitting that final registry hides callable
 * built-ins such as memory.write/manage from feature-detecting clients. Preserve
 * the existing wire/extension order, append registry-only methods, and advertise
 * overlaps only once. Read the registry on each call so new connections reflect
 * handler registration, disposal and extension reloads.
 *
 * Discovery does not grant access: the dispatcher's scope/session guards remain
 * authoritative. No protocol version or named capability changes are implied.
 */
export function buildGatewayFeatures(customMethods: Iterable<string>): HelloOk["features"] {
	return {
		methods: [...new Set([...REQUEST_METHODS, ...customMethods, ...listRegisteredMethods()])],
		events: [...EVENT_NAMES],
		capabilities: [...PROTOCOL_CAPABILITIES],
	};
}
