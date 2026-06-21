# Changelog

## [1.2.1](https://github.com/spinabot/brigade/compare/brigade-v1.2.0...brigade-v1.2.1) (2026-06-21)


### Bug Fixes

* **deps:** resolve npm audit advisories (8 of 9; pi has no upstream fix yet) ([30d63c0](https://github.com/spinabot/brigade/commit/30d63c0f6a2cc389d56552da88197a5a2a0ae4c6))

## [1.2.0](https://github.com/spinabot/brigade/compare/brigade-v1.1.0...brigade-v1.2.0) (2026-06-21)


### Features

* **channels:** Telegram channel + channel SDK ([71bb2e6](https://github.com/spinabot/brigade/commit/71bb2e6a50d024ca39e90ac49f456b81428f5729))

## [1.1.0](https://github.com/spinabot/brigade/compare/brigade-v1.0.2...brigade-v1.1.0) (2026-06-21)


### Features

* **convex:** brigade convex command to run the bundled self-hosted backend ([6f331df](https://github.com/spinabot/brigade/commit/6f331dfa7c32313a2d38473309e1c2c541bd816e))


### Bug Fixes

* **install:** always show how to use brigade in the current shell ([1337148](https://github.com/spinabot/brigade/commit/1337148418bbe9c8602530b72aef68618a934002))
* **install:** install + verify Node and put it on PATH before installing brigade ([aac7dc6](https://github.com/spinabot/brigade/commit/aac7dc60366f249ce728328127edf0fd4dc5bad3))

## [1.0.2](https://github.com/spinabot/brigade/compare/brigade-v1.0.1...brigade-v1.0.2) (2026-06-21)


### Bug Fixes

* ship convex/ in the npm package so convex mode works when installed ([8851238](https://github.com/spinabot/brigade/commit/8851238f823ce44e01e88954621924641b949f0f))

## [1.0.1](https://github.com/spinabot/brigade/compare/brigade-v1.0.0...brigade-v1.0.1) (2026-06-21)


### Bug Fixes

* harden installer Node setup and PATH placement (macOS + Windows) ([05b5f1c](https://github.com/spinabot/brigade/commit/05b5f1cc3b6d00f9d719df485c60441b9aa710d6))
* installer persists PATH on fresh macOS and emits ASCII-only output ([3b32aad](https://github.com/spinabot/brigade/commit/3b32aad3b054f8ac402203e807e23e1c396e69a1))
* lazy-load convex storage so filesystem onboarding does not crash ([4d8e1ca](https://github.com/spinabot/brigade/commit/4d8e1caa2c5fdec78c1365a9af0df54ac34ab468))

## [1.0.0](https://github.com/spinabot/brigade/compare/brigade-v0.1.2...brigade-v1.0.0) (2026-06-21)


### Features

* add config schema and validation commands, enhance provider environment variable handling ([123f28a](https://github.com/spinabot/brigade/commit/123f28a3e51642fe9d13a93961187b023b082eb2))
* add convex dependency to package.json ([801338b](https://github.com/spinabot/brigade/commit/801338be6392c518c88eb9f38935d5de25c6f497))
* add Hacker News and npm search providers with tests ([334ac01](https://github.com/spinabot/brigade/commit/334ac01fea2fa1fa26884e3476b526fbb997e1d0))
* add instance admin functions for convex backend management ([7c4a5ed](https://github.com/spinabot/brigade/commit/7c4a5eda48f250dd4895af9bcabc82ed10c35e56))
* add manage_access tool for owner-only agent-to-agent access control ([a248eef](https://github.com/spinabot/brigade/commit/a248eef6b37cc06222b1edaf821c10ce1db86f2b))
* add manage_skill tool for owner-only skill CRUD operations ([2c1f41b](https://github.com/spinabot/brigade/commit/2c1f41b37dfe30f359cbd45ac74a9e46e714a470))
* add out-of-process gateway supervision ([345bef3](https://github.com/spinabot/brigade/commit/345bef39ea9d9096cda3c845efb7e5a6a6294379))
* add per-channel access control and daemon management ([ba2b0c5](https://github.com/spinabot/brigade/commit/ba2b0c5e50eee8323aa0258e6279af11f91286b6))
* add Playwright-based browser tool for handling JS-heavy pages ([181747c](https://github.com/spinabot/brigade/commit/181747c6d99b18acaed6dd6d544619f391281908))
* add secret input mode option for onboarding and credential storage ([ec7c6d5](https://github.com/spinabot/brigade/commit/ec7c6d50a55ab2f0cdfdef754c45bf06c0ebc8e0))
* add send_media tool for sending media attachments through channels ([116d580](https://github.com/spinabot/brigade/commit/116d580029d43e7dba4bb19bdec4d9fadc79fee0))
* add session target validation and error handling ([8437667](https://github.com/spinabot/brigade/commit/8437667c8d41f962621cc9c5fa638f583869f44c))
* add Tavily search provider and web_extract tool ([baa0ab3](https://github.com/spinabot/brigade/commit/baa0ab3ab0c95a27df254c8e3ecace8267bdfd36))
* add terminal cleanup functionality and shared themes for Brigade ([a9e4f42](https://github.com/spinabot/brigade/commit/a9e4f4279b5129361b888d9687903852c48910a2))
* add tests for workspace path validation and resolution functions ([d75c48f](https://github.com/spinabot/brigade/commit/d75c48f7e9dd79a45ff079dde9b2c889ce578ff7))
* add web-shared utilities and SSRF guard ([549a7bc](https://github.com/spinabot/brigade/commit/549a7bcee2832b7e5194352d77b707ba1ee6e341))
* agent-scope fix, skill grants, org-access visibility, OAuth tool, web-search fallback chain, connect command, and runtime hardening ([53f7a1c](https://github.com/spinabot/brigade/commit/53f7a1cf7c977793e06206fd15963999f086540d))
* **assembler:** add baseline voice tone guidelines and streamline messaging instructions ([d51ee18](https://github.com/spinabot/brigade/commit/d51ee189891b5ba912d3ad12f0f0ba0e11ffec1e))
* **auth:** implement profile cooldown and ordering logic ([a6ebf7d](https://github.com/spinabot/brigade/commit/a6ebf7d810c12bf82cc67bcee4c56553b9e7b7f2))
* **channels:** enforce senderIsOwner as false for channel-routed turns to prevent approval request issues ([b94f2b9](https://github.com/spinabot/brigade/commit/b94f2b9466b7a270f32c3c5dbe29dfba7a6e755e))
* **channels:** gateway channel manager + serialized turn executor ([abd9645](https://github.com/spinabot/brigade/commit/abd96456e1b970686f16123a1f9d69e8a610bfe0))
* **channels:** implement channel approval routing for exec-gate prompts ([0fa5402](https://github.com/spinabot/brigade/commit/0fa54022eb123371b012e2ef7c03c14532e3f938))
* **composio:** current connect API, paginated catalog, hands-free status, PLATFORM guidance ([7f2b648](https://github.com/spinabot/brigade/commit/7f2b6486ac0cc3a2184c7d9ccd9a34d4013871a3))
* **composio:** sealed key store, live app catalog, always-mounted tool ([7579f9d](https://github.com/spinabot/brigade/commit/7579f9d32c3c484b3310feafcf5da9f7ca307a45))
* consolidate mergeSignals function into web-provider-helpers for reuse across modules ([94cfca3](https://github.com/spinabot/brigade/commit/94cfca39b05e9306b39024b641cd8e207dad6b41))
* **consolidation:** implement memory consolidation logic with deduplication and testing ([809a9c8](https://github.com/spinabot/brigade/commit/809a9c84abda3955b707c29383ea0f1c1099a1b9))
* **cron:** enhance delivery channel validation and announce delivery ([0119ed1](https://github.com/spinabot/brigade/commit/0119ed11a591e32106fb349cb349c88de3af951c))
* **cron:** implement cron job scheduling and session management ([638360a](https://github.com/spinabot/brigade/commit/638360ad94628875079e49b7e61dafb2ae83c10b))
* enhance access control logic for group messaging and wildcard support ([f71fca1](https://github.com/spinabot/brigade/commit/f71fca1e20ba66046ace5a8e990e244c998fafb9))
* enhance agent command and non-interactive setup to support provider resolution and defaults ([c1894db](https://github.com/spinabot/brigade/commit/c1894dbcac6ab85ed1619f153a423646f5020f2d))
* enhance agents_list tool to enumerate all configured agents with reachability flags ([9971837](https://github.com/spinabot/brigade/commit/99718376b5743047a32ab29439d59175bbc91ecc))
* enhance assembler with new sections for tooling, execution bias, safety, and workspace, and improve persona file sorting ([e5573e2](https://github.com/spinabot/brigade/commit/e5573e229143d9541085f4bbc562fe9700f8867d))
* enhance chat command and system prompt handling for model identity and workspace integration ([f87ec3f](https://github.com/spinabot/brigade/commit/f87ec3fc1cf6f02f5243a5c6cd60d5c377fc5456))
* enhance config commands with helpful hints and improve status reporting with last error details ([2f04871](https://github.com/spinabot/brigade/commit/2f0487141bb584269d0932243dabd5adb24edd70))
* enhance connect and chat commands with reasoning and autocomplete improvements ([298f871](https://github.com/spinabot/brigade/commit/298f871ec9488da4d905b8ddab76ead77ebbde5c))
* enhance cron RPC methods with new parameters and results ([8437667](https://github.com/spinabot/brigade/commit/8437667c8d41f962621cc9c5fa638f583869f44c))
* enhance error handling and logging for provider failures across multiple components ([31039ec](https://github.com/spinabot/brigade/commit/31039ec5a044a4c1d34a573dc24372ff5fd982d7))
* enhance error handling by translating auth errors into Brigade-native messages ([cb21020](https://github.com/spinabot/brigade/commit/cb21020247b4b80a7ab68ee314708dfddb8a8e83))
* enhance exec-gate and browser tools with improved error messaging and command previews; update web tools guidance for clarity and usability ([e7fc0a0](https://github.com/spinabot/brigade/commit/e7fc0a0a7b3ad1d0402cc008de8f43a70bdad145))
* enhance extension system with user module discovery and lifecycle management ([57c0840](https://github.com/spinabot/brigade/commit/57c0840c40354b972fb912256d04e3374343bdf8))
* enhance onboarding and credential handling with key reference support and improved environment variable resolution ([25b7645](https://github.com/spinabot/brigade/commit/25b7645a8055d21da8dc3c744528b080641036d6))
* enhance search provider configurations and validation for Brave, DuckDuckGo, Exa, Perplexity, and Tavily modules ([1451ad8](https://github.com/spinabot/brigade/commit/1451ad8ae582e016775cc47a02facca562442f65))
* enhance session management with quiet hours and sub-agent completion bridge ([731395d](https://github.com/spinabot/brigade/commit/731395dac5be995e1254781bd6fa7dff6e487904))
* enhance slash command parser with additional edge case tests for /thinking and /model commands ([d21af10](https://github.com/spinabot/brigade/commit/d21af102b78800b21e5ed9fbb00662af15629913))
* enhance stream handling with stop reason recovery and add tests ([4d67098](https://github.com/spinabot/brigade/commit/4d67098be88b3a8125da4ad571c39a120816b9bc))
* Enhance sub-agent cleanup policy and improve tool result summarization ([ea87755](https://github.com/spinabot/brigade/commit/ea8775567351a5353b1f50183d438e117cc54226))
* Enhance system prompt assembly with new guidance and options ([a7db967](https://github.com/spinabot/brigade/commit/a7db96741e5889c6da6d5346728a24b25e1fd640))
* enhance tool handling and command parsing ([c019980](https://github.com/spinabot/brigade/commit/c019980560113b3c1f258409eee766e23643f0eb))
* enhance workspace jail guard to validate paths against agent cwd and improve test coverage ([dfbddb5](https://github.com/spinabot/brigade/commit/dfbddb598d2a6e79f57b81649ddbe3cb7aa37927))
* **extensions:** add Pi-native extension seam (agent + product registries) ([fe4e2db](https://github.com/spinabot/brigade/commit/fe4e2db6b9105a3c907f0a45bece47bc9e6d1217))
* group access control, thinking-level continuity, live model discovery ([a85e6e5](https://github.com/spinabot/brigade/commit/a85e6e532045433f74683a5784f46dcdd98cf213))
* implement A2A policy canonicalization and agent command handling ([f5fcd5f](https://github.com/spinabot/brigade/commit/f5fcd5fbb25c2da3cec5218d1a499ef6fd22d564))
* implement agent event bus for managing events across turns and enhance chat session handling ([ba70c7e](https://github.com/spinabot/brigade/commit/ba70c7e84df9c412fbdd3a788641a7611eb8a436))
* implement agents management commands and shared utilities ([54705e9](https://github.com/spinabot/brigade/commit/54705e935c746abc3c955e9a6104366530425ead))
* implement approval bridge for tool call consent ([021cf16](https://github.com/spinabot/brigade/commit/021cf163b8b6ee0c23be4c0f49229cc21e4b3ce2))
* implement DNS pinning for SSRF-guarded fetch ([181747c](https://github.com/spinabot/brigade/commit/181747c6d99b18acaed6dd6d544619f391281908))
* implement EmbeddedChatClient to unify chat interfaces and enhance session management across TUI and gateway ([e46afd8](https://github.com/spinabot/brigade/commit/e46afd856ece12e61932458db7aad3fe24c8da3f))
* implement exec-approvals command suite for bash tool gating ([5f4114a](https://github.com/spinabot/brigade/commit/5f4114a3335bd25bcbf23779859e8340dff83e61))
* implement gateway auto-spawn functionality with tests ([89f6bd6](https://github.com/spinabot/brigade/commit/89f6bd6c136c774ecb674d4ecaf5ab9e8092bf54))
* implement per-agent provider and model resolution in cron isolated-agent executor ([67ca64c](https://github.com/spinabot/brigade/commit/67ca64cdd1cc07302a23d5eec8651c04d58f194b))
* implement reply sanitization and enhance WhatsApp linking experience ([accc6cb](https://github.com/spinabot/brigade/commit/accc6cb38de368833548caf135e1b05ec650a588))
* implement runBrigadeTurnLoop for enhanced turn handling ([8548d7c](https://github.com/spinabot/brigade/commit/8548d7ca9593568e9a6ff068526a45333b421e66))
* implement session key utilities and enhance session management ([3456094](https://github.com/spinabot/brigade/commit/3456094255f4d2c1fddabf28b081d3ffba8ab5ff))
* Implement sub-agent metadata persistence and related functionality (Primitive [#6](https://github.com/spinabot/brigade/issues/6)) ([7c0f8ba](https://github.com/spinabot/brigade/commit/7c0f8ba0b0c5d5e3fc873842c81c8779e1d4ea31))
* Implement thinking fallback mechanism and tool guards ([6550564](https://github.com/spinabot/brigade/commit/65505640af17b6f30fa7f9db6e886d036916661f))
* integrate playwright-core as a hard dependency and enhance web-tools onboarding process ([c94cfe8](https://github.com/spinabot/brigade/commit/c94cfe862a7c078d1b350dff41be7f5f3576864c))
* **logging:** create structured subsystem logger ([a6ebf7d](https://github.com/spinabot/brigade/commit/a6ebf7d810c12bf82cc67bcee4c56553b9e7b7f2))
* **memory:** implement Brigade memory storage and tools ([2e64316](https://github.com/spinabot/brigade/commit/2e64316f55e25c7992ab725c3270a343c419f02f))
* **memory:** implement session-scoped origin tracking for memory writes and recalls ([118dfb5](https://github.com/spinabot/brigade/commit/118dfb5389a76f6b1d8ce01cf5da99d0ba7941d6))
* **memory:** Tideline — long-term memory framework (filesystem + convex parity) ([ba15353](https://github.com/spinabot/brigade/commit/ba1535312f63689feec5c284162b24954c329eee))
* **memory:** Tideline graph vault + extraction churn fix + skills/security hardening ([985ae59](https://github.com/spinabot/brigade/commit/985ae5934953cddeaa6d5dd295148734ee67eab5))
* **memory:** Tideline Phase 4 bench + engine hardening (30 bug fixes) ([7f822f5](https://github.com/spinabot/brigade/commit/7f822f5e58d4f9e02ce5dd9750b5d2c9214bad6b))
* **memory:** Tideline v3 — memory graph, dream, governance, MCP, autonomous loop (live) ([b9ad965](https://github.com/spinabot/brigade/commit/b9ad965a2a2792da77895948feeb71e78a01e669))
* **model-resolution:** implement never-miss model resolution and discovery for uncatalogued models ([e2bd733](https://github.com/spinabot/brigade/commit/e2bd733dee9aa62b3d557bd2b11fc935351cd418))
* onboarding wizard enhancements ([7c4a5ed](https://github.com/spinabot/brigade/commit/7c4a5eda48f250dd4895af9bcabc82ed10c35e56))
* **org:** introduce virtual-office layer with org awareness and escalation inbox ([255e1a6](https://github.com/spinabot/brigade/commit/255e1a6f966a3af5853200d4f45df20c087254ff))
* refactor onboarding process to enhance environment variable handling and user prompts ([6171982](https://github.com/spinabot/brigade/commit/6171982d3f5c8b92ca94969f865f5f7b44369d24))
* refine smoke test script with detailed phases and improved output formatting ([7f6f656](https://github.com/spinabot/brigade/commit/7f6f656e001abf1c43bffadc0a641dfb793a5cb4))
* **searchable-select:** implement searchable select list with type-to-filter functionality ([47c6e8d](https://github.com/spinabot/brigade/commit/47c6e8d2f294a3e647452b357ff1bf0c5443c9fc))
* **sessions:** enhance session delegation with agentId support and improve documentation ([169061d](https://github.com/spinabot/brigade/commit/169061d1321351e8b52af915bb6400faec7242c2))
* **sessions:** implement session file repair logic ([a6ebf7d](https://github.com/spinabot/brigade/commit/a6ebf7d810c12bf82cc67bcee4c56553b9e7b7f2))
* **skills:** implement skill discovery and eligibility system ([fb28308](https://github.com/spinabot/brigade/commit/fb283087070f0cbf12f06db985458481c7e0621f))
* **skills:** update metadata from 'openclaw' to 'brigade' across multiple skill files ([5d143cc](https://github.com/spinabot/brigade/commit/5d143cc9760933b11fe01ca5fd870ea5580fbc31))
* **skills:** update metadata from 'openclaw' to 'brigade' across multiple skill files ([a4e269e](https://github.com/spinabot/brigade/commit/a4e269e89950d5c0e2051791a9387c1ac743d131))
* **skills:** update metadata from 'openclaw' to 'brigade' across multiple skills and add git-commit skill documentation ([8c27963](https://github.com/spinabot/brigade/commit/8c2796352390f66a77dc627aa6bdc938989cc888))
* **skills:** update skill metadata to replace 'openclaw' with 'brigade' and add yaml dependency ([338b15f](https://github.com/spinabot/brigade/commit/338b15f753b5912460005118cd7d1a5007e7a049))
* **storage:** close remaining hardening gaps — nonce-safe ACL, LID lookup, skills mirror, key fingerprint, AAD ([64b38c4](https://github.com/spinabot/brigade/commit/64b38c43db3f93c4c30c9d5b891dc3baca690ca5))
* **storage:** convex-mode auth dispatch — sealed credentials, verbatim state blobs ([b562990](https://github.com/spinabot/brigade/commit/b5629900eec36a7f30dad6a1cd9cead382f3e85e))
* **storage:** convex-mode Baileys auth — useConvexAuthState (PR-C3+C4) ([ad45043](https://github.com/spinabot/brigade/commit/ad4504368b039245bc77975c8ff1c32c847cdef8))
* **storage:** convex-mode channel access-control dispatch — policy local, rows reconciled ([7242bdc](https://github.com/spinabot/brigade/commit/7242bdcccf7d0131c28a3f0f34c38924f2c22751))
* **storage:** convex-mode config dispatch — cache-primed reads, store-routed writes ([fe40cf6](https://github.com/spinabot/brigade/commit/fe40cf6a8528bc6f2d0c20d940afc9052ea609d9))
* **storage:** convex-mode cron dispatch + OS cache dir relocation ([ccebe30](https://github.com/spinabot/brigade/commit/ccebe30fe5df7c10df0a518f964288c2876df76d))
* **storage:** convex-mode exec-approvals dispatch — cached gate, store-routed mutations ([c4ac894](https://github.com/spinabot/brigade/commit/c4ac894ac6eed0f6c9df6332d61cc974b841466a))
* **storage:** convex-mode instance coordination — pid/heartbeat rows, OS-cache lock ([bcbe8aa](https://github.com/spinabot/brigade/commit/bcbe8aafde190b916f4d8101cf984b0639330547))
* **storage:** convex-mode logs + Chromium relocate (PR-C7) ([5425f04](https://github.com/spinabot/brigade/commit/5425f04be870c30829277b6454ad68dea61e468f))
* **storage:** convex-mode memory dispatch — facts, extract cursors, consolidate throttle ([9cb7694](https://github.com/spinabot/brigade/commit/9cb7694e3eba90e3b0de247a548ff1f31fbe85cd))
* **storage:** convex-mode models.json — OS-cache mirror, sealed blob source of truth ([a59a61f](https://github.com/spinabot/brigade/commit/a59a61f4028f6f3f3bb46713683925758de93a26))
* **storage:** convex-mode Pi transcripts — inMemory SessionManager + write-behind queue ([b6f9920](https://github.com/spinabot/brigade/commit/b6f99201c3ec14a12c93feda1bf05e5687fa7561))
* **storage:** convex-mode session dispatch — cached sessions.json + marshalled adapter ([4c39618](https://github.com/spinabot/brigade/commit/4c396184d141bdb19a27a59861f76eced6d450bb))
* **storage:** convex-mode workspace mirror — local working copy, Convex restore ([b4ea676](https://github.com/spinabot/brigade/commit/b4ea676cc597852fa1f57e7bebe1a2f6d42c465a))
* **storage:** dual-mode foundation — BrigadeStore + convex adapters + boot wiring ([251253f](https://github.com/spinabot/brigade/commit/251253f752af341b154153b7c9a939116b49d51b))
* **storage:** instance admin, encryption keyfile, convex admin + schema, storage-mode onboarding ([b433730](https://github.com/spinabot/brigade/commit/b4337307ad66f87543aaaf7b13d6d0c164758b68))
* **storage:** live workspace mirror — persona/lifecycle/skill edits reach convex as they happen ([0fc11d6](https://github.com/spinabot/brigade/commit/0fc11d65fb3ea0f9f55e8ae26e90a6736e0e8c41))
* **storage:** mode-aware instance readers — status/doctor/supervisor see convex rows ([c0a746c](https://github.com/spinabot/brigade/commit/c0a746c7ca90bd8d21b80c1aceaa600288bf8e3c))
* **storage:** strict-zero guard — preventive fs patches + detective watcher ([9bce058](https://github.com/spinabot/brigade/commit/9bce058ccb3351aa259d4d872cdf408bb434f58c))
* **storage:** strict-zero smoke script — the live-backend verification ([06e4f36](https://github.com/spinabot/brigade/commit/06e4f366caaba32fc61e9ec8fd841176ce4a475b))
* **storage:** WA media — local cache hot path, background Convex mirror ([273cf49](https://github.com/spinabot/brigade/commit/273cf49048a015ae81d95c03c378be6e7c208990))
* **subagents:** introduce spawn_agents tool for parallel sub-agent execution and enhance sub-agent depth handling ([2eddf1a](https://github.com/spinabot/brigade/commit/2eddf1ab52b96a057d4c87ee3c6b5ff71e3af1df))
* **tests:** add comprehensive tests for web search filters and browser tool schema ([3f022d5](https://github.com/spinabot/brigade/commit/3f022d510a606b3c7ca876be3e65363fdaa040d3))
* Tideline LLM relationship graph + org, channels, release automation ([ce0a72e](https://github.com/spinabot/brigade/commit/ce0a72ea1b78d36444b5f5abd7da2b9ced81cea4))
* update branding with lion emoji and enhance descriptions across multiple files ([b26ee3a](https://github.com/spinabot/brigade/commit/b26ee3a550bfad010d6b0ded696c925707341e3e))
* update smoke test to handle model override after reset ([89ba6a3](https://github.com/spinabot/brigade/commit/89ba6a3b8225b6898ce8153ab89c2f1c0baaf0e1))
* update TypeScript build configuration and add build-specific tsconfig ([7da9137](https://github.com/spinabot/brigade/commit/7da91377f946c5b75a62caab227e406c138bb253))
* **versioning:** implement build identity reporting and format version output ([e2d800a](https://github.com/spinabot/brigade/commit/e2d800a8cc481df0a3b36c0c1686a8553380dc95))
* **web-search:** add support for additional search filters and error handling ([b8e9d4e](https://github.com/spinabot/brigade/commit/b8e9d4ec2e9281c67f41daf60088f221de6dee4b))
* **whatsapp:** catch up on connect and stop dropping group/LID senders ([9ab3779](https://github.com/spinabot/brigade/commit/9ab37793ec8be048f798e859bbec47b895ff4ffb))
* **whatsapp:** catch up on connect and stop dropping group/LID senders ([ae37c9d](https://github.com/spinabot/brigade/commit/ae37c9d58e6e7be99b9bd571dd0aaeedd263f166))
* **whatsapp:** first channel — Baileys connection + QR link, behind the seam ([1a05bce](https://github.com/spinabot/brigade/commit/1a05bce6d8df7d1cc77b46e2fe538392ab95dadf))
* **wizard:** implement non-interactive setup and provider catalog ([ed1fd4e](https://github.com/spinabot/brigade/commit/ed1fd4e28c0b2c0e4acaa76267068000e659b69d))


### Bug Fixes

* **access-control:** operator not implicitly allowed in non-allowlisted groups ([4ec2253](https://github.com/spinabot/brigade/commit/4ec2253064dabd970683312020fc55f3fc1efa35))
* **channels:** harden WhatsApp reconnect + channel/seam audit fixes ([eb2530a](https://github.com/spinabot/brigade/commit/eb2530a50deb34dc348b630b2f51c35872d8cc4b))
* **cli:** batch-3 — drain write-behind chains before CLI process.exit (convex mode) ([438b3d7](https://github.com/spinabot/brigade/commit/438b3d729a54c7722c97531297a48e3149fe02b5))
* **connect:** improve streaming render performance and reduce flicker on Windows Terminal ([6dc4844](https://github.com/spinabot/brigade/commit/6dc48442a4380af00f33e9586aa90ce82ca6932e))
* **convex:** byte-budget the instance-reset erase loop; add OAuth favicon ([7eca11d](https://github.com/spinabot/brigade/commit/7eca11d709f6a505454e124b03c3f2bdaa4c0371))
* **convex:** sessions.upsertEntry merges instead of replacing ([2a8bafe](https://github.com/spinabot/brigade/commit/2a8bafe84cfa55b341bc365a7e36e3e1fa380bcf))
* **convex:** stop deploy-time tsc from planting .js artifacts; harden A2A contract and store migration ([2779f23](https://github.com/spinabot/brigade/commit/2779f238c78bad6ff7915bac5c93058c4a97a035))
* **cron:** stabilize every-schedule anchor to prevent drift on restarts ([a15d8c5](https://github.com/spinabot/brigade/commit/a15d8c556e4977cea82fca702616b90228fa0bfb))
* enhance sentinel management ([7c4a5ed](https://github.com/spinabot/brigade/commit/7c4a5eda48f250dd4895af9bcabc82ed10c35e56))
* enhance web-fetch with retry logic for transient failures ([181747c](https://github.com/spinabot/brigade/commit/181747c6d99b18acaed6dd6d544619f391281908))
* ensure approval prompt width safety ([7c4a5ed](https://github.com/spinabot/brigade/commit/7c4a5eda48f250dd4895af9bcabc82ed10c35e56))
* ensure pending heartbeat wakes are drained correctly in onTimer ([8437667](https://github.com/spinabot/brigade/commit/8437667c8d41f962621cc9c5fa638f583869f44c))
* improve web search query validation ([116d580](https://github.com/spinabot/brigade/commit/116d580029d43e7dba4bb19bdec4d9fadc79fee0))
* **memory:** isolate consolidation per origin ([d5a2800](https://github.com/spinabot/brigade/commit/d5a2800db23b4504ed24c070f3c44b4fa828f806))
* **storage:** address adversarial review of the convex-mode batches ([2166cb6](https://github.com/spinabot/brigade/commit/2166cb6d8ad42a9d66b9ab89a1cc738a5c241458))
* **storage:** batch-1 strict-zero correctness — no ~/.brigade writes in convex mode ([c0833f9](https://github.com/spinabot/brigade/commit/c0833f9fd0205ac4e6dfa268353bfe66de036826))
* **storage:** batch-2 convex runtime breakers — config channels, cron persistence, auth, gateway pid ([f408618](https://github.com/spinabot/brigade/commit/f408618fe339f66466e374f82e6318db8d84919c))
* **storage:** batch-4 — convex log fidelity (sessionEvents + subsystem extras) ([954a328](https://github.com/spinabot/brigade/commit/954a328350dfd0ee0cbfd187dea38668848e18a2))
* **storage:** batch-5 — workspace + skills mirror fidelity (convex mode) ([9b087ea](https://github.com/spinabot/brigade/commit/9b087ea829edd3693aa286e2d01353526ff8ebda))
* **storage:** batch-7 — convex migration + persistence fidelity ([c6dd4f0](https://github.com/spinabot/brigade/commit/c6dd4f0209f4c58c214745d4a0189842dcc633bd))
* **storage:** close last file-mapping gap — config backups in convex mode ([3e94df4](https://github.com/spinabot/brigade/commit/3e94df4ab3e13f37d51adaf980f86103f51d110c))
* **whatsapp:** batch-6 — Baileys auth lifecycle in convex mode ([87ef183](https://github.com/spinabot/brigade/commit/87ef183738eb1fef1643cfd6b3096fa4e853fda8))


### Miscellaneous Chores

* release 1.0.0 ([fe0e374](https://github.com/spinabot/brigade/commit/fe0e374fdb9a660973615f25d83ef71c8b589134))

## Changelog

All notable changes to Brigade are documented in this file.

This changelog is maintained automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commit](https://www.conventionalcommits.org/) messages. Do not edit
released sections by hand.
