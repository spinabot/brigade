import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { renderLaunchdPlist } from "./launchd.js";
import { renderSchtasksXml } from "./schtasks.js";
import type { ServiceContext } from "./service.js";
import { renderSystemdUnit } from "./systemd.js";

const CTX: ServiceContext = {
	nodePath: "/usr/bin/node",
	brigadeBin: "/opt/brigade/brigade.mjs",
	cwd: "/home/op",
	env: { BRIGADE_STATE_DIR: "/var/lib/brigade", LOG_LEVEL: "info" },
	stdoutPath: "/var/log/brigade/daemon.stdout.log",
	stderrPath: "/var/log/brigade/daemon.stderr.log",
};

describe("renderLaunchdPlist", () => {
	it("emits a Label, ProgramArguments, KeepAlive, RunAtLoad, and the env block", () => {
		const out = renderLaunchdPlist(CTX);
		assert.match(out, /<key>Label<\/key><string>com\.brigade\.gateway<\/string>/);
		assert.match(out, /<key>ProgramArguments<\/key>/);
		assert.match(out, /<string>\/usr\/bin\/node<\/string>/);
		assert.match(out, /<string>\/opt\/brigade\/brigade\.mjs<\/string>/);
		assert.match(out, /<string>gateway<\/string>\s*<string>run<\/string>/);
		assert.match(out, /<key>RunAtLoad<\/key><true\/>/);
		assert.match(out, /<key>KeepAlive<\/key><true\/>/);
		assert.match(out, /<key>EnvironmentVariables<\/key>[\s\S]*BRIGADE_STATE_DIR/);
	});

	it("XML-escapes paths that contain & or <", () => {
		const out = renderLaunchdPlist({ ...CTX, cwd: "/a&b" });
		assert.match(out, /<string>\/a&amp;b<\/string>/);
	});
});

describe("renderSystemdUnit", () => {
	it("includes [Unit] [Service] [Install] + Restart=on-failure + Environment lines", () => {
		const out = renderSystemdUnit(CTX);
		assert.match(out, /^\[Unit\]/m);
		assert.match(out, /^\[Service\]/m);
		assert.match(out, /^\[Install\]/m);
		assert.match(out, /Restart=on-failure/);
		assert.match(out, /WantedBy=default\.target/);
		assert.match(out, /Environment=BRIGADE_STATE_DIR=\/var\/lib\/brigade/);
		assert.match(out, /ExecStart=\/usr\/bin\/node\s+\/opt\/brigade\/brigade\.mjs\s+gateway\s+run/);
	});

	it("falls back to a comment when there are no env overrides", () => {
		const out = renderSystemdUnit({ ...CTX, env: {} });
		assert.match(out, /# no Environment= overrides/);
	});
});

describe("renderSchtasksXml", () => {
	it("describes a logon trigger + restart-on-failure + Exec with brigade gateway run", () => {
		const out = renderSchtasksXml(CTX);
		assert.match(out, /<LogonTrigger>/);
		assert.match(out, /<RestartOnFailure>[\s\S]*<Count>3<\/Count>/);
		assert.match(out, /<Command>\/usr\/bin\/node<\/Command>/);
		assert.match(out, /<Arguments>&quot;\/opt\/brigade\/brigade\.mjs&quot;\s+gateway\s+run<\/Arguments>/);
		assert.match(out, /<Environment Variable="BRIGADE_STATE_DIR" Value="\/var\/lib\/brigade"/);
	});

	it("omits the EnvironmentVariables block when no env overrides exist", () => {
		const out = renderSchtasksXml({ ...CTX, env: {} });
		assert.equal(out.includes("<EnvironmentVariables>"), false);
	});
});
