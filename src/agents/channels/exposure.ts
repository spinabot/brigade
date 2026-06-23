/**
 * Channel-exposure resolver — turns a channel's `meta.exposure` (+ the legacy
 * `meta.showConfigured` / `meta.showInSetup` booleans) into a concrete
 * per-surface visibility verdict.
 *
 * Brand-scrubbed analogue of upstream's `src/channels/plugins/exposure.ts`.
 *
 * Three surfaces, each an independent boolean that DEFAULTS TO VISIBLE when the
 * channel says nothing:
 *
 *   - `configured` — show in "configured channels" lists (`brigade status`,
 *     account pickers). Precedence: `exposure.configured` → `showConfigured`
 *     → `true`.
 *   - `setup`      — offer in the onboarding / setup wizard. Precedence:
 *     `exposure.setup` → `showInSetup` → `true`.
 *   - `docs`       — surface in generated docs / help. Precedence:
 *     `exposure.docs` → `true`.
 *
 * The default-true floor matters: a channel plugin authored without ANY
 * exposure metadata stays fully visible, so adding this resolver never hides
 * an existing channel.
 */

import type { ChannelMeta } from "./types.core.js";

/** The subset of `ChannelMeta` the resolver reads. */
export type ChannelExposureInput = Pick<ChannelMeta, "exposure" | "showConfigured" | "showInSetup">;

/** Concrete per-surface visibility verdict (every key resolved to a boolean). */
export interface ResolvedChannelExposure {
	configured: boolean;
	setup: boolean;
	docs: boolean;
}

/**
 * Resolve a channel's exposure to concrete booleans. Pure; safe to call with a
 * bare `{}` (everything defaults to `true`). Accepts `undefined`/`null` meta
 * as "all visible" so callers needn't null-guard.
 */
export function resolveChannelExposure(
	meta: ChannelExposureInput | undefined | null,
): ResolvedChannelExposure {
	const exposure = meta?.exposure;
	return {
		configured: exposure?.configured ?? meta?.showConfigured ?? true,
		setup: exposure?.setup ?? meta?.showInSetup ?? true,
		docs: exposure?.docs ?? true,
	};
}

/** True when the channel should appear in "configured channels" views. */
export function isChannelVisibleInConfiguredLists(
	meta: ChannelExposureInput | undefined | null,
): boolean {
	return resolveChannelExposure(meta).configured;
}

/** True when the channel should be offered in the setup / onboarding wizard. */
export function isChannelVisibleInSetup(
	meta: ChannelExposureInput | undefined | null,
): boolean {
	return resolveChannelExposure(meta).setup;
}

/** True when the channel should be surfaced in generated docs / help. */
export function isChannelVisibleInDocs(
	meta: ChannelExposureInput | undefined | null,
): boolean {
	return resolveChannelExposure(meta).docs;
}
