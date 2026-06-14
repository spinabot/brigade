/**
 * Config-write guard tests.
 *
 * The block cases are modeled on the exact production incident
 * (2026-06-11): the model piped ~/.brigade/brigade.json through inline
 * python and wrote it back (json.dump + open(...,'w')) — approved by the
 * operator who couldn't tell it was a write, and silently no-op'd while
 * claiming success. Reads of the same file stay allowed (discouraged via
 * tool docs, not blocked).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { detectConfigWrite, makeConfigWriteGuard } from "./config-write-guard.js";

const HOME_JSON = '"$HOME/.brigade/brigade.json"';

describe("detectConfigWrite — block cases", () => {
	it("the production incident: cat | python json.dump back into brigade.json", () => {
		const cmd =
			`cat ${HOME_JSON} | python -c "\nimport sys, json\ndata = json.load(sys.stdin)\n` +
			`data['org']['a2a']['mode'] = 'derived'\n` +
			`json.dump(data, open('$HOME/.brigade/brigade.json'.replace('$HOME', __import__('os').path.expanduser('~')), 'w'), indent=2)\n"`;
		assert.ok(detectConfigWrite(cmd), "must detect the python write-back");
	});

	it("shell redirect into the config", () => {
		assert.ok(detectConfigWrite(`echo '{}' > "$HOME/.brigade/brigade.json"`));
		assert.ok(detectConfigWrite(`cat patched.json >> ~/.brigade/brigade.json`));
	});

	it("sed -i on the credential store", () => {
		assert.ok(detectConfigWrite(`sed -i 's/old/new/' "$HOME/.brigade/agents/main/agent/auth-profiles.json"`));
	});

	it("tee / mv / cp into state files", () => {
		assert.ok(detectConfigWrite(`cat new.json | tee ~/.brigade/cron.json`));
		assert.ok(detectConfigWrite(`mv /tmp/patched.json "C:/Users/me/.brigade/brigade.json"`));
	});

	it("PowerShell Set-Content on the config", () => {
		assert.ok(detectConfigWrite(`Get-Content patched.json | Set-Content "$HOME/.brigade/brigade.json"`));
	});
});

describe("detectConfigWrite — allow cases", () => {
	it("pure reads (the json.dumps print form) stay allowed", () => {
		const cmd =
			`cat ${HOME_JSON} | python -c "\nimport sys, json\ndata = json.load(sys.stdin)\n` +
			`org = data.get('org', 'NOT FOUND')\nprint(json.dumps(org, indent=2))\n"`;
		assert.equal(detectConfigWrite(cmd), null);
	});

	it("writes that do not touch Brigade state are not the guard's business", () => {
		assert.equal(detectConfigWrite(`echo hi > /tmp/out.txt`), null);
		assert.equal(detectConfigWrite(`python -c "json.dump({}, open('/tmp/x.json','w'))"`), null);
	});

	it("a repo checkout's brigade.json (no .brigade dir context) is not protected", () => {
		assert.equal(
			detectConfigWrite(`json.dump(data, open('F:/Brigade/test-fixtures/brigade.json','w'))`),
			null,
		);
	});

	it("grep/cat of state files stays allowed", () => {
		assert.equal(detectConfigWrite(`cat ~/.brigade/brigade.json`), null);
		assert.equal(detectConfigWrite(`grep org "$HOME/.brigade/brigade.json"`), null);
	});
});

describe("makeConfigWriteGuard — hook behavior", () => {
	it("blocks bash with a config write and names the tool remedies", async () => {
		const guard = makeConfigWriteGuard();
		const res = await guard({
			toolCall: {
				name: "bash",
				arguments: { command: `echo '{}' > ~/.brigade/brigade.json` },
			},
		} as never);
		assert.equal(res?.block, true);
		assert.match(res?.reason ?? "", /manage_provider/);
		assert.match(res?.reason ?? "", /tell the operator the exact edit/);
	});

	it("ignores non-bash tools and read-only bash", async () => {
		const guard = makeConfigWriteGuard();
		assert.equal(
			await guard({ toolCall: { name: "write", arguments: { path: "x" } } } as never),
			undefined,
		);
		assert.equal(
			await guard({
				toolCall: { name: "bash", arguments: { command: "cat ~/.brigade/brigade.json" } },
			} as never),
			undefined,
		);
	});
});

describe("detectConfigWrite — additional write indicators (audit P1-2)", () => {
	// These literals don't match the original `.write(` / json.dump( set;
	// added so heredoc + pathlib + node-fs + PowerShell write-backs to state
	// files are caught.
	it("pathlib write_text / write_bytes", () => {
		assert.ok(detectConfigWrite(`python -c "from pathlib import Path; Path('$HOME/.brigade/brigade.json').write_text('{}')"`));
		assert.ok(detectConfigWrite(`Path('~/.brigade/cron.json').write_bytes(b'x')`));
	});

	it("python heredoc writing a state file", () => {
		const cmd = `python3 <<'PY'\nfrom pathlib import Path\nPath('${"$HOME"}/.brigade/brigade.json').write_text('{}')\nPY`;
		assert.ok(detectConfigWrite(cmd), "heredoc body referencing a state path + write_text must block");
	});

	it("node fs.writeFileSync / appendFileSync", () => {
		assert.ok(detectConfigWrite(`node -e "require('fs').writeFileSync(process.env.HOME+'/.brigade/brigade.json','{}')"`));
		assert.ok(detectConfigWrite(`node -e "fs.appendFileSync('~/.brigade/cron.json','x')"`));
	});

	it("PowerShell [IO.File]::WriteAllText", () => {
		assert.ok(detectConfigWrite(`[IO.File]::WriteAllText("$HOME/.brigade/brigade.json", "{}")`));
	});

	it(".writelines on a state file", () => {
		assert.ok(detectConfigWrite(`open('~/.brigade/brigade.json','w').writelines(lines)`));
	});

	it("still allows the same APIs against NON-state paths", () => {
		assert.equal(detectConfigWrite(`Path('/tmp/out.json').write_text('{}')`), null);
		assert.equal(detectConfigWrite(`fs.writeFileSync('/tmp/x.json','{}')`), null);
	});
});
