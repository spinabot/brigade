/**
 * BlueBubbles extension module.
 *
 * Registers the BlueBubbles channel adapter through the seam, AND — because
 * BlueBubbles is a WEBHOOK-in channel — registers a gateway HTTP route PER
 * configured account that receives the server's webhook POSTs and feeds them into
 * the started adapter for THAT account (after verifying the password embedded in
 * the registered webhook URL query string).
 *
 * The loader gates the adapter by the usual extension config; the adapter itself
 * only starts when `channels.bluebubbles.enabled` is true AND a serverUrl +
 * password resolve — so bundling this module is inert until the operator opts in.
 *
 *   - The default account keeps the base webhook path (`/bluebubbles/webhook`)
 *     and feeds the inline adapter directly.
 *   - Each NAMED account (only present when >1 account is configured) gets its own
 *     route on a distinct path, whose `resolveSink` looks up THAT account's
 *     STARTED adapter at request time via the per-account adapter registry
 *     (`account-registry.ts`) the plugin populates on `startAccount`.
 *     `b.httpRoute(...)` is only available at `register()` time (before the plugin
 *     starts accounts), so the late binding is essential. Mirrors `slack/module.ts`.
 */

import { defineModule } from "../sdk.js";
import {
	bluebubblesChannelEnabled,
	listBlueBubblesAccountIds,
	resolveBlueBubblesPassword,
	resolveBlueBubblesWebhookPath,
	BLUEBUBBLES_DEFAULT_ACCOUNT_ID,
} from "./account-config.js";
import { getBlueBubblesAccountSink } from "./account-registry.js";
import { createBlueBubblesAdapter, type BlueBubblesAdapter } from "./adapter.js";
import { buildBlueBubblesWebhookRoute } from "./webhook.js";

export const bluebubblesModule = defineModule({
	id: "bluebubbles",
	register(b) {
		const adapter = createBlueBubblesAdapter() as BlueBubblesAdapter;
		b.channel(adapter);

		// Only register inbound routes when the channel is enabled (a disabled
		// install exposes no inbound HTTP surface).
		if (!bluebubblesChannelEnabled(b.config as never)) return;

		const accountIds = listBlueBubblesAccountIds(b.config as never);
		const isMultiAccount = accountIds.length > 1;
		for (const accountId of accountIds) {
			const isDefault = accountId === BLUEBUBBLES_DEFAULT_ACCOUNT_ID;
			b.httpRoute(
				buildBlueBubblesWebhookRoute({
					path: resolveBlueBubblesWebhookPath(b.config as never, accountId),
					// Each route verifies with ITS OWN account's password.
					password: resolveBlueBubblesPassword(b.config as never, accountId),
					resolveSink:
						isDefault && !isMultiAccount
							? () => adapter
							: () => getBlueBubblesAccountSink(accountId) ?? null,
				}),
			);
		}
	},
});
