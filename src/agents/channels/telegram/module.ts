/**
 * Telegram extension module.
 *
 * Registers the Telegram channel adapter through the seam. The loader gates it
 * by the usual extension config (`extensions.disabled` / `entries`), and the
 * adapter itself only starts when `channels.telegram.enabled` is true AND a bot
 * token resolves — so bundling this module is inert until the operator opts in.
 *
 * In WEBHOOK transport mode (`channels.telegram.mode: "webhook"`) the module
 * ALSO registers a gateway HTTP route that receives Telegram's update POSTs and
 * feeds them into the started adapter (after verifying the secret-token header).
 * Polling mode (the default) registers no HTTP surface.
 */

import { defineModule } from "../sdk.js";
import { telegramWebhookConfig } from "./account-config.js";
import { createTelegramAdapter, type TelegramAdapter } from "./adapter.js";
import { buildTelegramWebhookRoute } from "./webhook.js";

export const telegramModule = defineModule({
	id: "telegram",
	register(b) {
		const adapter = createTelegramAdapter() as TelegramAdapter;
		b.channel(adapter);
		// Webhook transport: register the inbound gateway route. The route resolves
		// the SAME started adapter to feed updates into. Gated on config so a
		// polling (default) install exposes no inbound HTTP surface.
		const transport = telegramWebhookConfig(b.config as never);
		if (transport.mode === "webhook") {
			b.httpRoute(
				buildTelegramWebhookRoute({
					path: transport.path,
					secretToken: transport.secretToken,
					resolveSink: () => adapter,
				}),
			);
		}
	},
});
