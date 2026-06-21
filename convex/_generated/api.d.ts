/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as auth from "../auth.js";
import type * as blobs from "../blobs.js";
import type * as channels from "../channels.js";
import type * as config from "../config.js";
import type * as cron from "../cron.js";
import type * as execApprovals from "../execApprovals.js";
import type * as extensions from "../extensions.js";
import type * as health from "../health.js";
import type * as instance from "../instance.js";
import type * as logs from "../logs.js";
import type * as memory from "../memory.js";
import type * as messages from "../messages.js";
import type * as org from "../org.js";
import type * as sessions from "../sessions.js";
import type * as skills from "../skills.js";
import type * as subagents from "../subagents.js";
import type * as whatsappAuth from "../whatsappAuth.js";
import type * as workspace from "../workspace.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  auth: typeof auth;
  blobs: typeof blobs;
  channels: typeof channels;
  config: typeof config;
  cron: typeof cron;
  execApprovals: typeof execApprovals;
  extensions: typeof extensions;
  health: typeof health;
  instance: typeof instance;
  logs: typeof logs;
  memory: typeof memory;
  messages: typeof messages;
  org: typeof org;
  sessions: typeof sessions;
  skills: typeof skills;
  subagents: typeof subagents;
  whatsappAuth: typeof whatsappAuth;
  workspace: typeof workspace;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
