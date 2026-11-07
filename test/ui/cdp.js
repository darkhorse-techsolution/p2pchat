// Minimal CDP driver using Node 25's built-in WebSocket. Drives the real
// renderer of a running Electron app, so what it proves is the shipped UI path.
const [,, port, ...script] = process.argv;
const expr = script.join(' ');

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  // the app has more than one page once the pop-up exists: pick by URL (CDP_URL overrides, default = the main window)
  const want = process.env.CDP_URL || 'index.html';
  const page = list.find((t) => t.type === 'page' && t.url.includes(want)) || list.find((t) => t.type === 'page');
  if (!page) { console.error('no page target on', port, JSON.stringify(list.map(t=>t.type))); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  // CDP_WIN='{"width":500,"height":700}' resizes the REAL window (persists across connections)
  if (process.env.CDP_WIN) {
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const bws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r, j) => { bws.onopen = r; bws.onerror = j; });
    const bcall = (id, method, params) => new Promise((res) => { const h = (m) => { const d = JSON.parse(m.data); if (d.id === id) { bws.removeEventListener('message', h); res(d.result); } }; bws.addEventListener('message', h); bws.send(JSON.stringify({ id, method, params })); });
    const { windowId } = await bcall(1, 'Browser.getWindowForTarget', { targetId: page.id });
    await bcall(2, 'Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', ...JSON.parse(process.env.CDP_WIN) } });
    bws.close(); await new Promise((r) => setTimeout(r, 350));
  }
  if (process.env.CDP_CALL) {
    const call = JSON.parse(process.env.CDP_CALL);
    await new Promise((res) => { const h = (m) => { const d = JSON.parse(m.data); if (d.id === 99) { ws.removeEventListener('message', h); res(d); } }; ws.addEventListener('message', h); ws.send(JSON.stringify({ id: 99, ...call })); });
  }
  const out = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('cdp timeout')), 15000);
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id === 1) { clearTimeout(t); resolve(d.result); }
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  if (out.exceptionDetails) { console.error('EXCEPTION:', JSON.stringify(out.exceptionDetails.exception?.description || out.exceptionDetails)); process.exit(1); }
  const v = out.result?.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
