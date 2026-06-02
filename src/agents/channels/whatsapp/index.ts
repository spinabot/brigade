/** WhatsApp channel — public surface. */

export { createWhatsAppAdapter, type CreateWhatsAppAdapterOptions } from "./adapter.js";
export {
	listWhatsAppAccountIds,
	resolveWhatsAppAccount,
	resolveWhatsAppAccountAuthDir,
	whatsappChannelEnabled,
	WHATSAPP_CHANNEL_ID,
	WHATSAPP_DEFAULT_ACCOUNT_ID,
	type ResolvedWhatsAppAccount,
} from "./account-config.js";
export { connectWhatsApp, type WaInboundText, type WhatsAppConnection } from "./connection.js";
export { whatsAppModule } from "./module.js";
export { createWhatsAppPlugin, type WhatsAppPluginDeps } from "./plugin.js";
