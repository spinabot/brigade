/**
 * Bundled (in-tree) Brigade extension modules.
 *
 * Each capability ships as a module that registers itself through the seam.
 * They land here in build order: whatsapp first, then more channels, sub-agents,
 * cron, voice, … User modules dropped in `~/.brigade/extensions/` are discovered
 * + loaded by the loader alongside these (same gating) — see `discovery.ts`.
 */

import { bluebubblesModule } from "../../channels/bluebubbles/module.js";
import { discordModule } from "../../channels/discord/module.js";
import { imessageModule } from "../../channels/imessage/module.js";
import { slackModule } from "../../channels/slack/module.js";
import { telegramModule } from "../../channels/telegram/module.js";
import { whatsAppModule } from "../../channels/whatsapp/module.js";
import { arxivModule } from "./arxiv.js";
import { braveModule } from "./brave.js";
import { duckduckgoModule } from "./duckduckgo.js";
import { exaModule } from "./exa.js";
import { firecrawlModule } from "./firecrawl.js";
import { githubSearchModule } from "./github-search.js";
import { hackerNewsModule } from "./hackernews.js";
import { npmSearchModule } from "./npm-search.js";
import { ollamaSearchModule } from "./ollama-search.js";
import { perplexityModule } from "./perplexity.js";
import { searxngModule } from "./searxng.js";
import { tavilyModule } from "./tavily.js";
import { wikipediaModule } from "./wikipedia.js";
import type { BrigadeModule } from "../types.js";

export const BUNDLED_MODULES: BrigadeModule[] = [
	whatsAppModule,
	// Telegram channel adapter — inert until `channels.telegram.enabled: true`
	// and a bot token resolves (config `${VAR}` ref or TELEGRAM_BOT_TOKEN env).
	telegramModule,
	// Slack channel adapter — inert until `channels.slack.enabled: true` and a
	// bot token resolves (config `${VAR}` ref or SLACK_BOT_TOKEN env). Socket Mode
	// (default) also needs an app token; events mode registers an HTTP route.
	slackModule,
	// Discord channel adapter — inert until `channels.discord.enabled: true` and a
	// bot token resolves (config `${VAR}` ref, sealed token, or DISCORD_BOT_TOKEN
	// env). Inbound is the Gateway (WebSocket) only — no HTTP route.
	discordModule,
	// iMessage channel adapter — inert until `channels.imessage.enabled: true` and
	// a runnable `imsg` CLI binary resolves. Driven as a JSON-RPC subprocess
	// (`imsg rpc`); inbound is the subprocess notification stream only — no HTTP
	// route. Requires Messages.app signed in on the host (macOS).
	imessageModule,
	// BlueBubbles channel adapter (richer iMessage transport) — inert until
	// `channels.bluebubbles.enabled: true` and a serverUrl + password resolve.
	// REST-out to the BlueBubbles macOS server; inbound via a gateway webhook
	// route (the server password is embedded in the registered webhook URL).
	bluebubblesModule,
	// Web-fetch + web-search providers. Each module is inert unless its
	// credential is configured (env var or `tools.web.{search,fetch}.providers.<id>`).
	// The registry picks the active provider by `autoDetectOrder` ascending —
	// lower wins — so the operator's preferred backend lands when configured.
	//
	//   autoDetectOrder priority — lower number = picked sooner:
	//     10  Firecrawl fetch (key-gated, JS-heavy fallback)
	//     20  Tavily search (AI-answer, one-shot RAG)
	//     30  Brave search (structured native API)
	//     40  Exa search (neural / content extraction)
	//     45  Perplexity search (research-mode)
	//     50  Firecrawl search (same key as fetch)
	//     90  Ollama local web search (free when daemon running)
	//     100 DuckDuckGo (keyless HTML scrape + Instant Answer fast-path)
	//     150 Wikipedia (keyless, specialised: definitions / overviews)
	//     160 Hacker News Algolia (keyless, specialised: tech / startup signal)
	//     165 arXiv (keyless, specialised: research papers)
	//     170 GitHub REST search (keyless 60/hr; token raises cap)
	//     175 npm registry search (keyless, specialised: package discovery)
	//     180 SearXNG (self-hosted, operator-supplied URL)
	//
	// The specialised keyless providers (Wikipedia / HN / arXiv / GitHub /
	// npm) sort below DuckDuckGo so a vanilla query still goes to a
	// general-purpose engine. The model addresses them by name via the
	// per-call `provider: "<id>"` override on `web_search`.
	arxivModule,
	braveModule,
	duckduckgoModule,
	exaModule,
	firecrawlModule,
	githubSearchModule,
	hackerNewsModule,
	npmSearchModule,
	ollamaSearchModule,
	perplexityModule,
	searxngModule,
	tavilyModule,
	wikipediaModule,
];
