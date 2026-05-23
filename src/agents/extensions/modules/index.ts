/**
 * Bundled (in-tree) Brigade extension modules.
 *
 * Each capability ships as a module that registers itself through the seam.
 * They land here in build order: whatsapp first, then more channels, sub-agents,
 * cron, voice, … User modules dropped in `~/.brigade/extensions/` are discovered
 * + loaded by the loader alongside these (same gating) — see `discovery.ts`.
 */

import { whatsAppModule } from "../../channels/whatsapp/module.js";
import type { BrigadeModule } from "../types.js";

export const BUNDLED_MODULES: BrigadeModule[] = [whatsAppModule];
