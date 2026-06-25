/**
 * Tunnel provider registry — maps a provider name to its implementation.
 *
 * `cloudflare` is the default (zero-config, anonymous, auto-managed binary).
 * Add a provider by importing it here and listing it in `PROVIDERS`; the CLI's
 * `--provider` flag and `cfg.gateway.tunnel.provider` both resolve through this.
 */

import { boreProvider } from "./providers/bore.js";
import { cloudflareProvider } from "./providers/cloudflared.js";
import { customProvider } from "./providers/custom.js";
import type { TunnelProvider } from "./types.js";

/** The default provider used when none is configured. */
export const DEFAULT_PROVIDER = "cloudflare";

const PROVIDERS: readonly TunnelProvider[] = [cloudflareProvider, boreProvider, customProvider];

/** All known provider names, in display order. */
export function listProviderNames(): string[] {
  return PROVIDERS.map((p) => p.name);
}

/** Resolve a provider by name. Throws with a helpful message on unknown names. */
export function getProvider(name: string): TunnelProvider {
  const found = PROVIDERS.find((p) => p.name === name);
  if (!found) {
    throw new Error(
      `unknown tunnel provider "${name}". Known providers: ${listProviderNames().join(", ")}.`,
    );
  }
  return found;
}
