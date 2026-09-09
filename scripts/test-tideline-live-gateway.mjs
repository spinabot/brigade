/** Opt-in real gateway/model test. Build first; credential arrives only on stdin. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tideline-live-gateway-"));
const state = path.join(directory, "state");
const rl = createInterface({ input: process.stdin, terminal: false });
console.log("READY_FOR_DEV_CREDENTIAL");
let apiKey = await new Promise(resolve => rl.once("line", resolve)); rl.close();
assert.ok(apiKey, "credential required");

const childSource = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {createServer} from 'node:net';
import {once} from 'node:events';
os.homedir=()=>path.join(process.env.BRIGADE_STATE_DIR,'test-home');
syncBuiltinESMExports();
const originalFetch=globalThis.fetch;
let providerCalls=0;
const accounting=[];
const captures=[];
globalThis.fetch=async(input,options)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(!['openrouter.ai','127.0.0.1','localhost'].includes(url.hostname))throw new Error('Unexpected outbound host in isolated test');
 if(url.hostname==='openrouter.ai'&&url.pathname.endsWith('/chat/completions')){
  if(++providerCalls>6)throw new Error('Live gateway provider-call ceiling');
  const body=JSON.parse(options.body);
  // Bound this test's generation and pin routing; do not replace the SDK's
  // authentication-aware stream function or bypass production prompt assembly.
  body.max_tokens=256;
  body.provider={only:['anthropic'],allow_fallbacks:false};
  options={...options,body:JSON.stringify(body)};
  const response=await originalFetch(input,options);
  captures.push(response.clone().text().then(text=>{
   for(const line of text.split('\n')){
    if(!line.startsWith('data: ')||line==='data: [DONE]')continue;
    try{const frame=JSON.parse(line.slice(6));if(frame.usage)accounting.push({id:frame.id,model:frame.model,usage:frame.usage});}catch{}
   }
  }).catch(()=>{}));
  return response;
 }
 return originalFetch(input,options);
};
const {default:WebSocket}=await import('ws');
const {writeConfigSafe}=await import('./dist/config/io.js');
const {startServer}=await import('./dist/core/server.js');
writeConfigSafe({agents:{defaults:{provider:'openrouter',model:{primary:'anthropic/claude-sonnet-4.5'}}},tools:{allow:['recall_memory']},session:{autoEnableA2AAtBoot:false},extensions:{enabled:false},channels:{}});
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
let server,socket,hello,completed;let counter=0;const pending=new Map();
function transcripts(){
 const dir=path.join(process.env.BRIGADE_STATE_DIR,'agents','main','sessions');
 return fs.readdirSync(dir).filter(f=>f.endsWith('.jsonl')).flatMap(f=>fs.readFileSync(path.join(dir,f),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)));
}
function assistantTexts(){return transcripts().filter(e=>e.type==='message'&&e.message?.role==='assistant').flatMap(e=>(e.message.content??[]).filter(b=>b.type==='text').map(b=>b.text));}
try{
 server=await startServer({port,host:'127.0.0.1'});
 socket=new WebSocket('ws://127.0.0.1:'+port);
 socket.on('message',data=>{
  const frame=JSON.parse(data.toString());if(frame.type==='hello-ok')hello=frame;
  if(frame.type==='res'){const item=pending.get(frame.id);if(item){pending.delete(frame.id);clearTimeout(item.timer);if(frame.ok)item.resolve(frame.payload);else item.reject(new Error('Gateway RPC failed: '+JSON.stringify(frame.error)));}}
 });
 await once(socket,'open');
 function rpc(method,params){return new Promise((resolve,reject)=>{const id=String(++counter);const timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout '+method));},90000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({type:'req',id,method,params}));});}
 await rpc('memory.write',{agentId:'main',content:'Project Cerulean deployment approval code is cobalt-928.',segment:'knowledge'});
 assert.ok(hello.features.methods.includes('memory.write')&&hello.features.methods.includes('memory.manage'));
 await rpc('prompt',{agentId:'main',text:'According only to remembered facts, what is Project Cerulean deployment approval code? Reply with the code only.'});
 const rememberedAnswer=assistantTexts().at(-1)?.trim();
 assert.equal(rememberedAnswer,'cobalt-928','final answer must be the stored fact absent from the user prompt');
 const before=assistantTexts().length;
 await rpc('prompt',{agentId:'main',text:'What is my zodiac sign? Use only remembered facts. If not recorded, reply exactly UNKNOWN. Do not guess.'});
 const newTexts=assistantTexts().slice(before);
 const unknownAnswer=newTexts.at(-1)?.trim();
 assert.equal(unknownAnswer,'UNKNOWN','final answer must abstain on an unavailable fact');
 await Promise.all(captures);
 assert.ok(providerCalls>=2&&accounting.length===providerCalls,'every provider call must have accounting');
 assert.ok(accounting.every(row=>Number.isFinite(row.usage.cost)),'every provider call must report cost');
 completed={passed:true,providerCalls,rpcCount:counter,advertisedMemoryMethods:true,rememberedAnswer,unknownAnswer,accounting};
}finally{
 for(const item of pending.values())clearTimeout(item.timer);
 if(socket&&socket.readyState!==WebSocket.CLOSED){socket.close();await once(socket,'close');}
 if(server)await server.stop();
}
console.log('GATEWAY_LIVE_RESULT '+JSON.stringify(completed));
`;
try {
 const env = { PATH: process.env.PATH, TMPDIR: directory, BRIGADE_STATE_DIR: state,
  BRIGADE_MODE: "filesystem", BRIGADE_PROFILE: "default", OPENROUTER_API_KEY: apiKey,
  BRIGADE_NO_UPDATE_CHECK: "1", BRIGADE_DISABLE_HEARTBEAT: "1", BRIGADE_DISABLE_MEMORY_EXTRACT: "1",
  BRIGADE_DISABLE_SKILL_REVIEW: "1", BRIGADE_DISABLE_SKILL_CURATOR: "1", BRIGADE_DISABLE_BEHAVIOR_REVIEW: "1", NODE_DISABLE_COMPILE_CACHE: "1" };
 const result = await new Promise(resolve => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], { cwd: repository, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const timeout = setTimeout(() => child.kill("SIGKILL"), 210000);
  child.stdout.on("data", b => { stdout += b; });
  child.stderr.on("data", b => { stderr += b; });
  child.on("error", () => { clearTimeout(timeout); resolve({ status: 1, stdout, stderr: "Child launch failed" }); });
  child.on("exit", status => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
 });
 const redact = s => s.replaceAll(apiKey, "[REDACTED]").replace(/sk-or-[\w-]+/g, "[REDACTED]");
 fs.writeFileSync(path.join(directory, "run.log"), redact(result.stdout + "\n" + result.stderr), { mode: 0o600 });
 const line = result.stdout.split("\n").find(line => line.startsWith("GATEWAY_LIVE_RESULT "));
 if (line && result.status === 0) {
  const report = JSON.parse(line.slice("GATEWAY_LIVE_RESULT ".length));
  fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, evidenceDir: directory }, null, 2));
 } else console.error(JSON.stringify({ passed: false, status: result.status, evidenceDir: directory, error: redact(result.stderr).slice(-2500) }));
 assert.equal(result.status, 0, "real gateway/model test failed");
 assert.ok(line, "missing gateway/model completion evidence");
} finally {
 apiKey = undefined;
 fs.rmSync(state, { recursive: true, force: true });
}
