/**
 * `steer` must be able to say WHEN the running turn sees a message.
 *
 * Pi has both primitives: `steer()` injects into the turn in flight, and
 * `followUp()` is held until there are no more tool calls and no pending
 * steering — a real turn boundary. Brigade only ever called the first, so a
 * message the operator queued by reflex could derail a plan the model was
 * halfway through executing.
 *
 * Claude Code drains its queue "at the next LLM pause" and has five open
 * steering issues plus a documented docs-vs-behaviour bug from that ambiguity.
 * The distinction is worth having on the wire.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSteerDelivery as route } from "./steer-delivery.js";

test('"followUp" is held until a turn boundary', () => {
	assert.equal(route("followUp"), "followUp");
});

test("the DEFAULT stays steer, so existing clients are unaffected", () => {
	// The method is named `steer`. An external client calling it — the desktop
	// app, a third party — expects steering, and changing that silently would be
	// the same class of break as stripping message content by default.
	assert.equal(route(undefined), "steer");
	assert.equal(route("steer"), "steer");
});

test("an unknown value falls back to steer rather than guessing", () => {
	assert.equal(route("later"), "steer");
	assert.equal(route(""), "steer");
});
