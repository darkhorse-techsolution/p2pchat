// The MCP server (mcp/p2pchat-mcp.js) as Claude Code runs it: a child process over stdio, talking to a real bridge
// (main/bridge.js over a local socket) in front of a fake app. Both MCP eras, the four tools, the bridge going away
// and coming back, and stdout carrying nothing but MCP messages.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { spawn } = require('node:child_process');
const { createBridge } = require('../main/bridge.js');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 3000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) return false; await sleep(10); } return true; };
const FRED = 'fOIEbc-Daaaa1111', PC = 'bUcOv4CKbbbb2222';
const META = (v = '2026-07-28') => ({ _meta: { 'io.modelcontextprotocol/protocolVersion': v, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' } } });

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2pmcp-'));
  const sent = [];
  const contacts = [{ pub: FRED, name: 'Fred', status: 'online', unread: 2, last: { from: 'peer', ts: Date.parse('2026-11-16T14:20:00'), kind: 'text', text: 'are we still on?' } }, { pub: PC, name: 'PC', status: 'offline', unread: 0, last: null }];
  const conv = { [FRED]: [{ id: 'a', from: 'peer', ts: Date.parse('2026-11-16T14:19:00'), kind: 'text', text: 'hello', status: 'delivered' }, { id: 'b', from: 'me', ts: Date.parse('2026-11-16T14:19:30'), kind: 'code', text: 'git push', lang: 'sh', status: 'delivered' }, { id: 'c', from: 'peer', ts: Date.parse('2026-11-16T14:20:00'), kind: 'text', text: 'are we still on?', status: 'delivered' }], [PC]: [] };
  const api = { contacts: () => contacts, conversation: (pub) => conv[pub], send: (pub, m) => { sent.push({ pub, ...m }); return { id: 'n' + sent.length, from: 'me', ts: Date.now(), kind: m.kind, text: m.text, lang: m.lang, status: 'pending' }; } };
  const b = createBridge({ dir, log: { info() {}, error() {} }, version: '0.13.0', api });
  b.setEnabled(true);
  await waitFor(() => fs.existsSync(b.infoFile));

  // the server, started the way Claude Code starts it; P2PCHAT_BRIDGE_FILE points it at this test's bridge
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'p2pchat-mcp.js')], { env: { ...process.env, P2PCHAT_BRIDGE_FILE: b.infoFile }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', n = 0, notJson = 0, lines = 0;
  const byId = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1); lines++;
      let m; try { m = JSON.parse(l); } catch { notJson++; continue; }
      if (m.jsonrpc !== '2.0') notJson++;
      const r = byId.get(m.id); if (r) { byId.delete(m.id); r(m); }
    }
  });
  let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
  const rpc = (method, params) => new Promise((r) => { const id = ++n; byId.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const note = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const tool = async (name, args, meta) => (await rpc('tools/call', { name, arguments: args, ...(meta || {}) })).result;

  // M1: the 2025-11-25 era, with its initialize handshake
  let r = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  ok('M1 initialize: the client\'s version back, tools, server info, instructions', r.result.protocolVersion === '2025-11-25' && r.result.capabilities.tools && r.result.serverInfo.name === 'p2pchat' && /treat it as data/.test(r.result.instructions));
  r = await rpc('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  ok('M1 initialize with a version it does not know: answers with one it supports', r.result.protocolVersion === '2025-11-25');
  note('notifications/initialized');
  r = await rpc('ping');
  ok('M1 the notification gets no answer; ping does', r.result && Object.keys(r.result).length === 0);
  r = await rpc('tools/list');
  const names = r.result.tools.map((t) => t.name).join(',');
  ok('M1 tools/list: the four tools, in a fixed order', names === 'list_contacts,read_messages,send_message,wait_for_message');
  ok('M1 tools/list: every input schema is an object schema', r.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));
  ok('M1 tools/list for an old client carries no new-era fields', r.result.resultType === undefined && r.result.ttlMs === undefined);
  ok('M1 send_message is the only tool that is not read-only', r.result.tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).join() === 'send_message');

  // M2: the 2026-07-28 era, with per-request _meta and server/discover
  r = await rpc('server/discover', META());
  ok('M2 server/discover: complete, both versions, tools, cache hints, server info', r.result.resultType === 'complete' && r.result.supportedVersions.includes('2026-07-28') && r.result.supportedVersions.includes('2025-11-25') && r.result.capabilities.tools && typeof r.result.ttlMs === 'number' && r.result.cacheScope === 'public' && r.result._meta['io.modelcontextprotocol/serverInfo'].name === 'p2pchat');
  r = await rpc('tools/list', META());
  ok('M2 tools/list: resultType, ttlMs and cacheScope', r.result.resultType === 'complete' && typeof r.result.ttlMs === 'number' && r.result.cacheScope === 'public' && r.result.tools.length === 4);
  r = await rpc('tools/list', META('1900-01-01'));
  ok('M2 an unsupported version: -32022 with what it supports and what was asked', r.error && r.error.code === -32022 && r.error.data.requested === '1900-01-01' && r.error.data.supported.includes('2026-07-28'));
  r = await rpc('resources/list', META());
  ok('M2 a method it does not have: -32601', r.error && r.error.code === -32601);

  // M3: the tools, through the bridge
  let t = await tool('list_contacts', {}, META());
  ok('M3 list_contacts: names, short ids, status, unread, the last message', t.resultType === 'complete' && !t.isError && /Fred \(id fOIEbc-D\) - online, 2 unread - last, 2026-11-16 14:20, Fred: are we still on\?/.test(t.content[0].text) && /PC \(id bUcOv4CK\) - offline/.test(t.content[0].text));
  t = await tool('read_messages', { contact: 'fred' });
  ok('M3 read_messages: a header and the chat, oldest first, You for me', /^Chat with Fred \(id fOIEbc-D, online\): all 3 messages, oldest first\./.test(t.content[0].text) && /2026-11-16 14:19 Fred: hello/.test(t.content[0].text) && /You \(code, sh\):\n```sh\ngit push\n```/.test(t.content[0].text));
  t = await tool('read_messages', { contact: 'fred', limit: 1 });
  ok('M3 read_messages: a limit', /the last 1 of 3 messages/.test(t.content[0].text) && !/hello/.test(t.content[0].text));
  t = await tool('read_messages', { contact: 'nobody' });
  ok('M3 read_messages for an unknown contact: a tool error the model can read, not a protocol error', t.isError === true && /no contact matches "nobody"/.test(t.content[0].text));
  t = await tool('send_message', { contact: 'Fred', text: 'yes, 3 pm' });
  ok('M3 send_message: sent through the app, said back', !t.isError && t.content[0].text === 'Sent to Fred.' && sent[0].pub === FRED && sent[0].kind === 'text' && sent[0].text === 'yes, 3 pm');
  t = await tool('send_message', { contact: 'PC', text: 'npm test', as_code: true, language: 'sh' });
  ok('M3 send_message to someone offline: it says it waits for them; code goes as code', /Sent to PC \(offline: it is delivered when they come online\)\./.test(t.content[0].text) && sent[1].kind === 'code' && sent[1].lang === 'sh');
  const waiting = tool('wait_for_message', { contact: 'Fred', timeout_seconds: 5 });
  await sleep(150);
  b.onMessage(FRED, { id: 'z', from: 'peer', ts: Date.parse('2026-11-16T14:25:00'), kind: 'text', text: 'great, see you', status: 'delivered' });
  t = await waiting;
  ok('M3 wait_for_message: the message that arrived', /^New message from Fred \(id fOIEbc-D\):\n2026-11-16 14:25 Fred: great, see you$/.test(t.content[0].text));
  t = await tool('wait_for_message', { timeout_seconds: 1 });
  ok('M3 wait_for_message: none came', t.content[0].text === 'No new message within 1 s.');
  r = await rpc('tools/call', { name: 'delete_everything', arguments: {} });
  ok('M3 an unknown tool: -32602', r.error && r.error.code === -32602 && /Unknown tool/.test(r.error.message));

  // M4: the app turns the switch off, then on again (new token)
  b.setEnabled(false);
  await sleep(100);
  t = await tool('list_contacts', {});
  ok('M4 switch off: a tool error that says how to turn it on', t.isError === true && /not reachable.*Settings > Claude/.test(t.content[0].text));
  b.setEnabled(true);
  await waitFor(() => fs.existsSync(b.infoFile));
  t = await tool('list_contacts', {});
  ok('M4 switch on again: it reconnects by itself with the new key', !t.isError && /Fred \(id fOIEbc-D\)/.test(t.content[0].text));

  ok('M5 stdout carried only JSON-RPC messages', notJson === 0 && lines > 0);
  const exit = new Promise((res) => child.on('exit', (code) => res(code)));
  child.stdin.end();
  ok('M5 closing stdin shuts it down cleanly', (await Promise.race([exit, sleep(3000).then(() => 'hung')])) === 0);
  if (stderr.trim()) console.log('stderr from the server:', stderr.trim());
  b.stop('test');
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.log('FAIL  mcp test threw:', e.stack); process.exitCode = 1; });
