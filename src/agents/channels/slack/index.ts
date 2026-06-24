/** Slack channel — public surface. */

export {
	createSlackAdapter,
	buildReactionNote,
	SLACK_CAPABILITIES,
	type CreateSlackAdapterOptions,
	type SlackAdapter,
} from "./adapter.js";
export {
	listSlackAccountIds,
	resolveSlackAccount,
	resolveSlackBotToken,
	resolveSlackAppToken,
	resolveSlackSigningSecret,
	resolveSlackUserToken,
	slackChannelEnabled,
	slackEventsConfig,
	slackLiveStreamEnabled,
	slackStreamThrottleMs,
	slackSurfaceReasoning,
	slackThreadIdleTtlMs,
	SLACK_BOT_TOKEN_ENV_VAR,
	SLACK_APP_TOKEN_ENV_VAR,
	SLACK_SIGNING_SECRET_ENV_VAR,
	SLACK_CHANNEL_ID,
	SLACK_DEFAULT_ACCOUNT_ID,
	type ResolvedSlackAccount,
	type SlackEventsConfig,
} from "./account-config.js";
export {
	buildSlackApprovalMessage,
	buildSlackApprovalText,
	parseSlackApprovalAction,
	type SlackApprovalMessage,
} from "./approval-native.js";
export { resolveSlackApprover } from "./approval-authorize.js";
export {
	buildSlackApprovalBlocks,
	buildSlackInlineKeyboard,
	extractBlockActionPayload,
	SLACK_APPROVAL_ACTION_ID,
	SLACK_GENERAL_ACTION_ID,
	type SlackActionsBlock,
	type SlackBlock,
} from "./blocks.js";
export {
	buildSlackCommandManifest,
	normalizeSlackCommandName,
	type SlackSlashCommand,
} from "./command-menu.js";
export {
	connectSlack,
	isSlackUnauthorized,
	redactSlackToken,
	slackBackoffDelay,
	type ConnectSlackArgs,
	type SlackConnection,
	type SlackInboundMessage,
} from "./connection.js";
export {
	listSlackDirectoryPeers,
	listSlackDirectoryGroups,
	type SlackDirectoryEntry,
	type SlackDirectoryQuery,
	type SlackDirectoryWebClientLike,
} from "./directory-live.js";
export { markdownToSlackMrkdwn, slackMrkdwnIsEmpty, escapeSlackMrkdwn } from "./format.js";
export { createSlackPlugin, type SlackPluginDeps, type SlackPluginHandle } from "./plugin.js";
export { probeSlack, type SlackProbeResult, type SlackProbeBot, type SlackProbeTeam } from "./probe.js";
export {
	buildSlackWebhookRoute,
	verifySlackSignature,
	parseSlackBody,
	SLACK_SIGNATURE_HEADER,
	SLACK_TIMESTAMP_HEADER,
} from "./webhook.js";
export { slackModule } from "./module.js";
