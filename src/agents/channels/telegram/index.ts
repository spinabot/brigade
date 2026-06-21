/** Telegram channel — public surface. */

export {
	createTelegramAdapter,
	deriveTopicName,
	TELEGRAM_CAPABILITIES,
	type CreateTelegramAdapterOptions,
} from "./adapter.js";
export {
	listTelegramAccountIds,
	resolveTelegramAccount,
	resolveTelegramBotToken,
	telegramAutoLabelTopics,
	telegramChannelEnabled,
	telegramThreadIdleTtlMs,
	telegramWebhookConfig,
	TELEGRAM_BOT_TOKEN_ENV_VAR,
	TELEGRAM_CHANNEL_ID,
	TELEGRAM_DEFAULT_ACCOUNT_ID,
	type ResolvedTelegramAccount,
	type TelegramWebhookConfig,
} from "./account-config.js";
export {
	resolveTelegramAllowedUpdates,
	type ResolveTelegramAllowedUpdatesOptions,
	type TelegramAllowedUpdate,
} from "./allowed-updates.js";
export {
	buildTelegramApprovalKeyboard,
	buildTelegramApprovalText,
	sanitizeTelegramCallbackData,
	TELEGRAM_CALLBACK_DATA_MAX_BYTES,
	type TelegramInlineKeyboardMarkup,
} from "./approval-native.js";
export { resolveTelegramApprover } from "./approval-authorize.js";
export {
	buildTelegramCommandMenu,
	normalizeTelegramCommandName,
	type TelegramBotCommand,
} from "./command-menu.js";
export {
	connectTelegram,
	isTelegramGetUpdatesConflict,
	isTelegramUnauthorized,
	redactTelegramToken,
	telegramBackoffDelay,
	type ConnectTelegramArgs,
	type TelegramBotIdentity,
	type TelegramConnection,
	type TelegramPollSpec,
	type TgInboundMessage,
} from "./connection.js";
export { markdownToTelegramHtml, telegramHtmlIsEmpty } from "./format.js";
export { createTelegramPlugin, type TelegramPluginDeps, type TelegramPluginHandle } from "./plugin.js";
export { probeTelegram, type TelegramProbeResult, type TelegramProbeIdentity } from "./probe.js";
export {
	buildTelegramWebhookRoute,
	hasValidTelegramWebhookSecret,
	safeEqualSecret,
	TELEGRAM_WEBHOOK_SECRET_HEADER,
} from "./webhook.js";
export { telegramModule } from "./module.js";
