'use strict';
const $ = (id) => document.getElementById(id);
const S = { me: null, contacts: [], current: null, msgs: new Map(), settings: {}, capture: null, protection: true, codeMode: false, typingUntil: 0, lastTypingSent: 0, discovery: false, hotkeyListening: false };
if (window.api.platform === 'win32') document.body.classList.add('win');

// ---------- theme ----------
// Settings hold 'system' | 'dark' | 'light'; the document gets the resolved one.
const osDark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme(choice) {
  S.themeChoice = choice || 'system';
  const resolved = S.themeChoice === 'system' ? (osDark.matches ? 'dark' : 'light') : S.themeChoice;
  document.documentElement.dataset.theme = resolved;
  document.querySelectorAll('#theme button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.themeChoice));
  return resolved;
}
osDark.addEventListener('change', () => { if (S.themeChoice === 'system') applyTheme('system'); });

// ---------- helpers ----------
const esc = (s) => window.hl.esc(String(s));
const hue = (pub) => { let h = 0; for (const c of pub) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
function avatar(el, pub, name, status) {
  el.style.background = `linear-gradient(135deg, hsl(${hue(pub)} 65% 55%), hsl(${(hue(pub) + 40) % 360} 65% 45%))`;
  el.textContent = initials(name);
  if (status !== undefined) { const d = document.createElement('span'); d.className = 'st ' + status; el.appendChild(d); }
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts) => { const d = new Date(ts), t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return 'Today'; if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() !== t.getFullYear() ? 'numeric' : undefined }); };
const fmtListTime = (ts) => { const d = new Date(ts); return d.toDateString() === new Date().toDateString() ? fmtTime(ts) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
function toast(text, cls = '') { const t = document.createElement('div'); t.className = 'toast ' + cls; t.textContent = text; $('toasts').appendChild(t); setTimeout(() => t.remove(), 3800); }
const contact = (pub) => S.contacts.find((c) => c.pub === pub);
const ipcErr = (e) => String(e && e.message || e).replace(/^Error invoking remote method '\w+': (Error: )?/, '');

// ---------- layout ----------
S.prefs = { sidebarWidth: 300, sidebarCollapsed: false, codeWrap: true, codeCollapse: true };
S.list = true; // narrow mode: which pane is showing
const app = $('app');
function applyLayout() {
  const narrow = innerWidth < 640, short = innerHeight < 600;
  app.classList.toggle('narrow', narrow);
  app.classList.toggle('collapsed', !narrow && !!S.prefs.sidebarCollapsed);
  app.classList.toggle('list', narrow && (S.list || !S.current));
  document.body.classList.toggle('short', short);
  app.style.setProperty('--sidebar-w', Math.min(480, Math.max(220, S.prefs.sidebarWidth || 300)) + 'px');
}
addEventListener('resize', applyLayout);
addEventListener('focus', async () => { await refreshState(); if (S.current && (contact(S.current)?.unread || 0) > 0) select(S.current); });
function toggleSidebar() {
  if (innerWidth < 640) { S.list = !S.list; applyLayout(); if (!S.list) $('input').focus(); return; }
  S.prefs.sidebarCollapsed = !S.prefs.sidebarCollapsed; applyLayout(); window.api.setPref('sidebarCollapsed', S.prefs.sidebarCollapsed);
}
$('btnNav').onclick = toggleSidebar; $('btnNav2').onclick = toggleSidebar;
// drag the sidebar edge
(() => {
  const h = $('sideResize'); let dragging = false;
  h.onmousedown = (e) => { dragging = true; h.classList.add('active'); e.preventDefault(); document.body.style.cursor = 'col-resize'; };
  addEventListener('mousemove', (e) => { if (!dragging) return; S.prefs.sidebarWidth = Math.min(480, Math.max(220, e.clientX)); applyLayout(); });
  addEventListener('mouseup', () => { if (!dragging) return; dragging = false; h.classList.remove('active'); document.body.style.cursor = ''; window.api.setPref('sidebarWidth', S.prefs.sidebarWidth); });
  h.ondblclick = () => { S.prefs.sidebarWidth = 300; applyLayout(); window.api.setPref('sidebarWidth', 300); };
})();

// ---------- modals ----------
let openModal = null;
function show(id) { openModal = id; $('backdrop').classList.remove('hidden'); $(id).classList.remove('hidden'); const f = $(id).querySelector('input:not([readonly]),textarea:not([readonly])'); if (f) setTimeout(() => f.focus(), 30); }
// A share prompt (control, share back, the audience picker) can have another modal opened over it, Settings by its
// shortcut. When that one closes the prompt is still on screen: it is the open modal again and the backdrop stays,
// so that it is not left as a loose box that Esc and a click beside it no longer reach.
const SHARE_PROMPTS = ['mControl', 'mShareBack', 'mCast'];
function close() {
  if (!openModal) return;
  $(openModal).classList.add('hidden'); S.hotkeyListening = false; $('setHotkey').classList.remove('listening'); $('setModeHotkey').classList.remove('listening'); $('setFullHotkey').classList.remove('listening');
  const under = SHARE_PROMPTS.find((id) => !$(id).classList.contains('hidden'));
  if (under) { openModal = under; if (window.Share) window.Share.onShown(); return; }   // in view again: its Yes is disarmed anew
  $('backdrop').classList.add('hidden'); openModal = null; $('input').focus();
}
window.closeModal = close; // share.js has its own close(); it reaches the modal one through this name
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
$('backdrop').onclick = close;

// ---------- sidebar ----------
const prettyHotkey = (a) => { const mac = window.api.platform === 'darwin'; const m = { CommandOrControl: mac ? '⌘' : 'Ctrl', Super: mac ? '⌘' : 'Win', Meta: mac ? '⌘' : 'Win', Command: '⌘', Control: mac ? '⌃' : 'Ctrl', Alt: mac ? '⌥' : 'Alt', Shift: mac ? '⇧' : 'Shift', Space: mac ? 'Space' : 'Space', Return: mac ? '↩' : 'Enter', Backspace: mac ? '⌫' : 'Backspace' }; return String(a || '').split('+').map((k) => m[k] || k).join(mac ? '' : '+'); };
function renderMe() {
  $('meName').textContent = S.me.name || 'Unnamed';
  $('meSub').textContent = `${S.me.host}:${S.me.port}`;
  avatar($('meAvatar'), S.me.pub, S.me.name);
}
function renderContacts() {
  const q = $('search').value.trim().toLowerCase();
  const list = [...S.contacts].sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0)).filter((c) => !q || c.name.toLowerCase().includes(q));
  const root = $('contacts'); root.innerHTML = '';
  if (!list.length) { root.innerHTML = `<div class="muted small" style="padding:18px 12px;text-align:center">${S.contacts.length ? 'No matches' : 'No contacts yet'}</div>`; return; }
  for (const c of list) {
    const row = document.createElement('div'); row.className = 'contact' + (c.pub === S.current ? ' active' : ''); row.dataset.pub = c.pub;
    const av = document.createElement('div'); av.className = 'avatar'; avatar(av, c.pub, c.name, c.status);
    const main = document.createElement('div'); main.className = 'c-main';
    const prev = c.last ? (c.last.kind === 'code' ? c.last.text.split('\n')[0] : c.last.kind === 'image' ? 'Screenshot' : c.last.text) : (c.status === 'online' ? 'Online' : 'No messages yet');
    main.innerHTML = `<div class="c-name">${esc(c.name)}${c.verified ? ' <span class="verified">✓</span>' : ''}</div><div class="c-prev${c.last?.kind === 'code' ? ' code' : c.last?.kind === 'image' ? ' image' : ''}">${c.last?.from === 'me' ? '<span class="muted">You: </span>' : ''}${esc(prev)}</div>`;
    const side = document.createElement('div'); side.className = 'c-side';
    const live = window.Share ? window.Share.live(c.pub) : '';
    side.innerHTML = `<span class="c-time">${c.last ? fmtListTime(c.last.ts) : ''}</span>${live === 'out' || live === 'both' ? '<span class="live" title="You are sharing your screen with them">● sharing</span>' : live ? '<span class="live" title="Screen share in progress">● live</span>' : ''}${c.unread && c.pub !== S.current ? `<span class="badge">${c.unread}</span>` : ''}`;
    row.append(av, main, side);
    row.onclick = () => select(c.pub);
    root.appendChild(row);
  }
}
$('search').oninput = renderContacts;

// ---------- conversation ----------
async function select(pub) {
  S.current = pub;
  const c = contact(pub); if (!c) return;
  const unread = c.unread; c.unread = 0;
  $('empty').classList.add('hidden'); $('chat').classList.remove('hidden');
  S.list = false; applyLayout();
  renderHead();
  const msgs = await window.api.conversation(pub);
  S.msgs.set(pub, msgs);
  renderMessages(true, unread);
  renderContacts();
  if (!app.classList.contains('narrow') || !S.list) $('input').focus();
}
function renderHead() {
  const c = contact(S.current); if (!c) return;
  $('chatName').textContent = c.name;
  $('chatVerified').classList.toggle('hidden', !c.verified);
  const sub = $('chatSub'); sub.className = 'chat-sub ' + c.status;
  sub.textContent = c.status === 'online' ? 'Online · end-to-end encrypted' : c.status === 'connecting' ? 'Connecting…' : `Offline · ${c.host}:${c.port} · messages queue until they return`;
  const av = $('chatAvatar'); av.innerHTML = ''; avatar(av, c.pub, c.name, c.status);
  if (window.Share) window.Share.render();
}
function atBottom() { const m = $('messages'); return m.scrollHeight - m.scrollTop - m.clientHeight < 60; }
function scrollBottom() { const m = $('messages'); m.scrollTop = m.scrollHeight; $('jump').classList.add('hidden'); }
function renderMessages(jump, unread = 0) {
  const msgs = S.msgs.get(S.current) || [];
  const root = $('messages'); const wasBottom = atBottom(); root.innerHTML = '';
  // the unread divider sits before the last `unread` messages from the peer
  let firstUnread = -1;
  if (unread > 0) { let n = 0; for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].from === 'peer') { n++; firstUnread = i; if (n === unread) break; } } }
  let lastDay = '', prev = null, prevEl = null;
  msgs.forEach((m, i) => {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { const d = document.createElement('div'); d.className = 'day'; d.textContent = fmtDay(m.ts); root.appendChild(d); lastDay = day; prev = null; }
    if (i === firstUnread) { const u = document.createElement('div'); u.className = 'unread-div'; u.textContent = `${unread} new`; root.appendChild(u); prev = null; }
    const cont = prev && prev.from === m.from && m.ts - prev.ts < 120000;
    if (!cont && prevEl) prevEl.classList.add('last');
    const el = messageEl(m, cont); root.appendChild(el); prev = m; prevEl = el;
  });
  if (prevEl) prevEl.classList.add('last');
  if (jump || wasBottom) scrollBottom();
}
const URL_RE = /https?:\/\/[^\s<>"'）)\]]+/g;
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u200d\ufe0f\u20e3\s])+$/u;
function isEmojiOnly(t) { if (!EMOJI_ONLY.test(t)) return false; const n = [...t.matchAll(/\p{Extended_Pictographic}/gu)].length; return n > 0 && n <= 3; }
// text -> nodes, with URLs as links that open in the system browser (never in the app)
function renderText(text) {
  const frag = document.createDocumentFragment(); let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a'); a.href = m[0]; a.textContent = m[0]; a.title = 'Opens in your browser';
    a.onclick = (e) => { e.preventDefault(); window.api.openExternal(m[0]); };
    frag.appendChild(a); last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}
const COLLAPSE_LINES = 18;
S.codeOpen = new Set();   // blocks the user expanded this session
function messageEl(m, cont) {
  const el = document.createElement('div'); el.className = `msg ${m.from}${cont ? ' cont' : ''}${m.kind === 'code' ? ' code' : m.kind === 'image' ? ' image' : ''}`; el.dataset.id = m.id;
  if (m.kind === 'code') {
    const { html, lang } = window.hl.highlight(m.text, m.lang);
    const lines = m.text.split('\n').length;
    const wrap = S.prefs.codeWrap !== false, fold = S.prefs.codeCollapse !== false && lines > COLLAPSE_LINES && !S.codeOpen.has(m.id);
    el.innerHTML = `<div class="codebox ${wrap ? 'wrap' : 'nowrap'}${fold ? ' collapsed' : ''}"><div class="code-head"><span class="lang">${esc(lang)}</span><span class="lines">${lines} line${lines === 1 ? '' : 's'}</span><button class="wrapbtn" title="Wrap long lines instead of scrolling sideways">${wrap ? 'Wrap' : 'Scroll'}</button><button class="copybtn">Copy</button></div><pre><code>${html}</code></pre>${fold ? `<button class="code-more">Show all ${lines} lines</button>` : ''}</div>`;
    el.querySelector('.copybtn').onclick = async (e) => { await window.api.copy(m.text); e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1200); };
    el.querySelector('.wrapbtn').onclick = async () => { S.prefs.codeWrap = !(S.prefs.codeWrap !== false); await window.api.setPref('codeWrap', S.prefs.codeWrap); renderMessages(false); };
    const more = el.querySelector('.code-more'); if (more) more.onclick = () => { S.codeOpen.add(m.id); renderMessages(false); };
  } else if (m.kind === 'image') {
    // The bytes come separately (pulled from the peer after the record); until then a placeholder with the right shape.
    const box = document.createElement('div'); box.className = 'shot-box';
    if (m.blob) {
      const img = document.createElement('img'); img.className = 'shot'; img.src = blobUrl(m); img.width = m.w; img.height = m.h; img.alt = 'Screenshot'; img.title = 'Click to view full size'; img.draggable = false;
      img.onclick = () => openLightbox(m);
      box.appendChild(img);
    } else {
      const WAIT = { pending: 'Receiving screenshot…', offline: 'Arrives when they are back online', quota: 'Not downloaded: image storage for this contact is full', unavailable: 'Not available from their device right now' };
      const w = document.createElement('div'); w.className = 'shot-wait'; w.style.aspectRatio = `${m.w} / ${m.h}`;
      const t = document.createElement('span'); t.textContent = WAIT[m.fetch] || WAIT.pending; w.appendChild(t);
      if (m.fetch === 'quota' || m.fetch === 'unavailable') {
        const r = document.createElement('button'); r.textContent = m.fetch === 'quota' ? 'Download' : 'Retry';
        r.onclick = async () => { try { await window.api.fetchImage(S.current, m.id); r.textContent = 'Asking…'; r.disabled = true; } catch (e) { toast(ipcErr(e), 'err'); } };
        w.appendChild(r);
      }
      box.appendChild(w);
    }
    el.appendChild(box);
    const tools = document.createElement('div'); tools.className = 'bubble-tools';
    const c = document.createElement('button'); c.textContent = 'Copy'; c.title = 'Copy the image';
    c.onclick = async () => { try { await window.api.copyImage(S.current, m.id); c.textContent = 'Copied'; setTimeout(() => (c.textContent = 'Copy'), 1200); } catch (e) { toast(ipcErr(e), 'err'); } };
    const s = document.createElement('button'); s.textContent = 'Save'; s.title = 'Save the image to a file';
    s.onclick = async () => { try { await window.api.saveImage(S.current, m.id); } catch (e) { toast(ipcErr(e), 'err'); } };
    tools.append(c, s); el.appendChild(tools);
  } else {
    const b = document.createElement('div'); b.className = 'bubble' + (isEmojiOnly(m.text) ? ' emoji' : ''); b.appendChild(renderText(m.text)); el.appendChild(b);
    const tools = document.createElement('div'); tools.className = 'bubble-tools';
    const c = document.createElement('button'); c.textContent = 'Copy'; c.title = 'Copy message text';
    c.onclick = async () => { await window.api.copy(m.text); c.textContent = 'Copied'; setTimeout(() => (c.textContent = 'Copy'), 1200); };
    tools.appendChild(c); el.appendChild(tools);
  }
  const meta = document.createElement('div'); meta.className = 'meta' + (m.from === 'me' && m.status !== 'delivered' ? ' pending' : '');
  meta.innerHTML = `${fmtTime(m.ts)}${m.from === 'me' ? ` <span class="tick ${m.status}" title="${m.status === 'delivered' ? 'Delivered to their device' : 'Queued until they are online'}">${m.status === 'delivered' ? '✓✓' : '○'}</span>` : ''}`;
  el.appendChild(meta);
  return el;
}
$('messages').onscroll = () => { if (atBottom()) $('jump').classList.add('hidden'); };
$('jump').onclick = scrollBottom;

// ---------- composer ----------
const input = $('input');
function grow() { input.style.height = 'auto'; input.style.height = Math.min(240, input.scrollHeight) + 'px'; }
function setCodeMode(on) { S.codeMode = on; $('composer').classList.toggle('code', on); $('codeBar').classList.toggle('hidden', !on); input.placeholder = on ? 'Paste or type code' : 'Message'; input.spellcheck = !on; input.focus(); }
$('btnCode').onclick = () => setCodeMode(!S.codeMode);
const looksLikeCode = (t) => t.includes('\n') && (/[{};=<>]/.test(t) || /^\s{2,}\S/m.test(t)) && t.split('\n').length >= 3;
input.addEventListener('paste', (e) => {
  const t = e.clipboardData.getData('text');
  if (!S.codeMode && looksLikeCode(t) && !input.value.trim()) { setCodeMode(true); $('codeLang').value = window.hl.detect(t); }
});
input.oninput = () => { grow(); if (S.current && Date.now() - S.lastTypingSent > 2000) { S.lastTypingSent = Date.now(); window.api.typing(S.current); } };
input.onkeydown = (e) => {
  if (e.key === 'Escape' && S.codeMode) { e.preventDefault(); setCodeMode(false); return; }
  const send = S.codeMode ? (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) : (e.key === 'Enter' && !e.shiftKey);
  if (send) { e.preventDefault(); sendNow(); }
};
async function sendNow() {
  if (!S.current) return;
  let text = input.value; if (!text.trim()) return;
  let kind = S.codeMode ? 'code' : 'text', lang = S.codeMode ? $('codeLang').value : '';
  const fence = text.match(/^```(\w*)\n([\s\S]*?)\n?```\s*$/);
  if (!S.codeMode && fence) { kind = 'code'; lang = fence[1]; text = fence[2]; }
  try {
    const msg = await window.api.send(S.current, { kind, text: kind === 'code' ? text.replace(/\s+$/, '') : text.trim(), lang });
    (S.msgs.get(S.current) || S.msgs.set(S.current, []).get(S.current)).push(msg);
    renderMessages(true);
    input.value = ''; grow();
    if (S.codeMode) setCodeMode(false);
  } catch (e) { toast(ipcErr(e), 'err'); }
}
$('btnSend').onclick = sendNow;

// ---------- screenshot ----------
// One click: main captures the display this window is on (the chat window itself is
// left out) and sends it as an image message. The result is pushed like a sent text.
$('btnShot').onclick = async () => {
  const pub = S.current; if (!pub) return;   // the chat it was clicked in, even if the user switches during the capture
  const b = $('btnShot'); if (b.classList.contains('busy')) return; b.classList.add('busy');
  try {
    const msg = await window.api.screenshot(pub);
    const list = S.msgs.get(pub) || S.msgs.set(pub, []).get(pub);
    if (!list.some((m) => m.id === msg.id)) list.push(msg);
    if (S.current === pub) renderMessages(true); else refreshState();
  } catch (e) {
    const err = ipcErr(e);
    if (/screen-permission/.test(err)) showScreenPermission(/relaunch/.test(err) ? 'relaunch' : 'ask'); else toast(err, 'err');
  } finally { b.classList.remove('busy'); }
};
$('shotSettings').onclick = () => window.api.openScreenSettings();
// Shared by the screenshot and screen-share buttons: why macOS will not let us read the screen yet.
function showScreenPermission(why) {
  $('shotLead').textContent = why === 'relaunch'
    ? 'Screen Recording is allowed now, but macOS applies it only to an app started after that. Quit P2P Chat (Settings → Quit app) and open it again.'
    : 'macOS lets an app read the screen only after you allow it. If a dialog just appeared, choose "Open System Settings"; otherwise use the button below.';
  show('mShot');
}
window.showScreenPermission = showScreenPermission;

// ---------- image viewer ----------
const blobUrl = (m) => `p2pblob://img/${S.current}/${m.id}`;
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
let lbMsg = null;
function openLightbox(m) { lbMsg = m; $('lbImg').src = blobUrl(m); $('lbMeta').textContent = `${m.w} × ${m.h} · ${fmtBytes(m.bytes)}`; $('lightbox').classList.remove('hidden'); }
function closeLightbox() { $('lightbox').classList.add('hidden'); $('lbImg').removeAttribute('src'); lbMsg = null; }
$('lightbox').onclick = (e) => { if (e.target === $('lightbox') || e.target.hasAttribute('data-lb-close')) closeLightbox(); };
$('lbCopy').onclick = async () => { if (!lbMsg) return; try { await window.api.copyImage(S.current, lbMsg.id); toast('Image copied', 'ok'); } catch (e) { toast(ipcErr(e), 'err'); } };
$('lbSave').onclick = async () => { if (!lbMsg) return; try { await window.api.saveImage(S.current, lbMsg.id); } catch (e) { toast(ipcErr(e), 'err'); } };

// ---------- add / invite ----------
$('btnAdd').onclick = $('emptyAdd').onclick = () => { $('addInvite').value = ''; $('addErr').classList.add('hidden'); show('mAdd'); };
$('addPaste').onclick = async () => { $('addInvite').value = await window.api.paste(); };
$('addInvite').onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('addGo').click(); } };
$('addGo').onclick = async () => {
  try { const c = await window.api.addContact($('addInvite').value); await refreshState(); close(); select(c.pub); toast(`Added ${c.name}. Connecting…`, 'ok'); }
  catch (e) { $('addErr').textContent = ipcErr(e); $('addErr').classList.remove('hidden'); }
};
async function showInvite(fresh) { if (fresh || !$('myInvite').value) $('myInvite').value = await window.api.invite(); show('mInvite'); }
$('emptyInvite').onclick = () => showInvite(false);
$('addShowInvite').onclick = () => { close(); showInvite(false); };
$('inviteCopy').onclick = async () => { await window.api.copy($('myInvite').value); $('inviteCopy').textContent = 'Copied'; setTimeout(() => ($('inviteCopy').textContent = 'Copy'), 1200); };
$('inviteNew').onclick = () => showInvite(true);
$('addDiscover').onclick = async () => {
  S.discovery = await window.api.discovery(!S.discovery);
  $('addDiscover').textContent = `LAN discovery: ${S.discovery ? 'on' : 'off'}`; $('peers').classList.toggle('hidden', !S.discovery); if (!S.discovery) $('peers').innerHTML = '';
};

// ---------- info ----------
async function openInfo() {
  const c = await window.api.contact(S.current); if (!c) return;
  const av = $('infoAvatar'); av.innerHTML = ''; avatar(av, c.pub, c.name);
  $('infoName').textContent = c.name; $('infoAddr').textContent = `${c.host}:${c.port} · ${c.status}`;
  $('infoSafety').textContent = c.safetyNumber; $('infoVerified').checked = c.verified; $('infoRename').value = c.name;
  $('infoHistory').disabled = c.status !== 'online'; $('infoHistory').title = c.status === 'online' ? 'Ask the peer to send their copy of this conversation' : 'Peer must be online: history comes from their device, not a server';
  show('mInfo');
}
$('btnInfo').onclick = openInfo; $('btnMore').onclick = openInfo;
$('infoVerified').onchange = async (e) => { await window.api.setVerified(S.current, e.target.checked); };
$('infoRename').onchange = async (e) => { if (e.target.value.trim()) await window.api.renameContact(S.current, e.target.value.trim()); };
$('infoHistory').onclick = async () => { try { await window.api.requestHistory(S.current); toast('Asked peer for their copy of the conversation'); close(); } catch (e) { toast(ipcErr(e), 'err'); } };
$('infoRemove').onclick = async () => { if (!confirm('Remove this contact and delete the conversation from this device?')) return; if (window.Share) window.Share.forget(S.current); await window.api.removeContact(S.current); S.current = null; close(); $('chat').classList.add('hidden'); $('empty').classList.remove('hidden'); await refreshState(); };

// ---------- settings ----------
function renderSettings() {
  $('setName').value = S.me.name || ''; $('setHotkey').value = prettyHotkey(S.settings.hotkey || ''); $('setModeHotkey').value = prettyHotkey(S.settings.modeHotkey || ''); $('setFullHotkey').value = prettyHotkey(S.settings.fullHotkey || ''); renderMode(S.mode);
  const hk = document.querySelector('#setHotkey').parentElement.nextElementSibling; if (hk) hk.textContent = S.backgroundApp ? (window.api.platform === 'darwin' ? 'No Dock icon and no menu-bar icon: this hotkey is the only way to bring the window back (or open the app again from Launchpad). Closing the window hides it.' : 'No taskbar button: this hotkey and the tray icon bring the window back.') : 'On Linux the window stays in the taskbar and the hotkey works on X11 sessions only.'; $('setRelay').value = S.settings.relay || ''; renderRelay(S.relay || 'off');
  applyTheme(S.settings.theme || 'system');
  $('setProtection').checked = S.protection; $('setProtection').disabled = !S.capture.supported; $('setProtectionHow').textContent = S.capture.how;
  $('setProtection').closest('label').classList.toggle('hidden', !!S.capture.variant); $('setProtectionHow').classList.toggle('hidden', !!S.capture.variant);   // the monitor build has no capture blocking to switch
  $('setDiscovery').checked = !!S.settings.discovery;
  $('autostartRow').classList.toggle('hidden', !S.autostartSupported); $('setAutostart').checked = !!S.settings.autostart;
  $('setPopups').checked = S.settings.popups !== false; $('setPopupText').checked = S.settings.popupText !== false;
  $('setCodeWrap').checked = S.prefs.codeWrap !== false; $('setCodeCollapse').checked = S.prefs.codeCollapse !== false;
  document.querySelectorAll('#shareModeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === (S.settings.shareMode || 'one')));
  $('setTurn').value = S.turn?.host ?? ''; $('setTurnUser').value = S.turn?.user ?? ''; $('setTurnPass').value = S.turn?.pass ?? ''; $('setCallsRelayOnly').checked = !!S.settings.callsRelayOnly; $('setRecordShares').checked = !!S.settings.recordShares; $('setClipboardSync').checked = S.settings.clipboardSync !== false; $('recordingsDir').textContent = S.recordingsDir || '';
  $('aboutLine').textContent = `P2P Chat ${S.version}${S.packaged ? '' : ' (dev)'} · log: ${S.logPath || 'n/a'}`;
  const v = $('vaultInfo'); v.className = 'vault ' + (S.vaultSecure ? 'ok' : 'warn');
  v.textContent = (S.vaultSecure ? 'Vault key held by the OS keychain · ' : S.packaged ? 'Vault key stored unprotected (no keychain available) · ' : 'Dev run: vault key is a plain file, Keychain not used · ') + S.vaultPath;
}
$('btnSettings').onclick = () => { renderSettings(); show('mSettings'); };
$('setName').onchange = async (e) => { S.me.name = await window.api.setName(e.target.value.trim() || 'Unnamed'); renderMe(); };
document.querySelectorAll('#theme button').forEach((b) => (b.onclick = async () => { applyTheme(b.dataset.v); S.settings.theme = await window.api.setTheme(b.dataset.v); }));
$('setProtection').onchange = async (e) => { renderShield(await window.api.protection(e.target.checked)); };
const savePopups = async () => { const r = await window.api.setPopups({ popups: $('setPopups').checked, popupText: $('setPopupText').checked }); S.settings.popups = r.popups; S.settings.popupText = r.popupText; };
$('setPopups').onchange = savePopups; $('setPopupText').onchange = savePopups;
$('setCodeWrap').onchange = async (e) => { S.prefs.codeWrap = await window.api.setPref('codeWrap', e.target.checked); if (S.current) renderMessages(false); };
$('setCodeCollapse').onchange = async (e) => { S.prefs.codeCollapse = await window.api.setPref('codeCollapse', e.target.checked); if (S.current) renderMessages(false); };
$('popupPreview').onclick = () => window.api.testPopup();
document.querySelectorAll('#shareModeSeg button').forEach((b) => (b.onclick = async () => { S.settings.shareMode = await window.api.setPref('shareMode', b.dataset.v); renderSettings(); if (window.Share) window.Share.render(); }));
const saveTurn = async () => { S.turn = { host: await window.api.setPref('turn', $('setTurn').value), user: await window.api.setPref('turnUser', $('setTurnUser').value), pass: await window.api.setPref('turnPass', $('setTurnPass').value) }; toast('Call server saved. It applies to the next share.', 'ok'); };
$('setTurn').onchange = saveTurn; $('setTurnUser').onchange = saveTurn; $('setTurnPass').onchange = saveTurn;
$('setCallsRelayOnly').onchange = async (e) => { S.settings.callsRelayOnly = await window.api.setPref('callsRelayOnly', e.target.checked); };
$('setRecordShares').onchange = async (e) => { S.settings.recordShares = await window.api.setPref('recordShares', e.target.checked); if (window.Share) window.Share.onSettings(); };
$('setClipboardSync').onchange = async (e) => { S.settings.clipboardSync = await window.api.setPref('clipboardSync', e.target.checked); if (window.Share) window.Share.onSettings(); };
$('openRecordings').onclick = () => window.api.openRecordings();
$('setAutostart').onchange = async (e) => { S.settings.autostart = await window.api.setAutostart(e.target.checked); };
$('setDiscovery').onchange = async (e) => { S.discovery = await window.api.discovery(e.target.checked); S.settings.discovery = S.discovery; };
$('btnQuit').onclick = () => { if (confirm('Quit P2P Chat? Contacts will see you offline and queue messages for you.')) window.api.quit(); };
const HK = { hotkey: { field: 'setHotkey', err: 'hotkeyErr', api: (a) => window.api.setHotkey(a) }, modeHotkey: { field: 'setModeHotkey', err: 'modeHotkeyErr', api: (a) => window.api.setModeHotkey(a) }, fullHotkey: { field: 'setFullHotkey', err: 'fullHotkeyErr', api: (a) => window.api.setFullHotkey(a) } };
for (const k of Object.keys(HK)) $(HK[k].field).onclick = () => { S.hotkeyListening = k; $(HK[k].field).classList.add('listening'); $(HK[k].field).value = 'press keys…'; $(HK[k].err).classList.add('hidden'); };
$('hotkeyReset').onclick = () => applyHotkey(S.defaults?.hotkey || 'Control+Super+X', 'hotkey');
$('modeHotkeyReset').onclick = () => applyHotkey(S.defaults?.modeHotkey || 'Control+Super+Backspace', 'modeHotkey');
$('fullHotkeyReset').onclick = () => applyHotkey(S.defaults?.fullHotkey || 'Control+Super+Return', 'fullHotkey');
const KEYMAP = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Enter: 'Return', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
document.addEventListener('keydown', (e) => {
  if (!S.hotkeyListening) return;
  e.preventDefault(); e.stopPropagation();
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
  const mods = []; if (e.metaKey) mods.push('Super'); if (e.ctrlKey) mods.push('Control'); if (e.altKey) mods.push('Alt'); if (e.shiftKey) mods.push('Shift');
  let key = KEYMAP[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : /^F\d{1,2}$/.test(e.key) ? e.key : '');
  if (!key) return;
  const which = typeof S.hotkeyListening === 'string' ? S.hotkeyListening : 'hotkey';
  if (!mods.length) { $(HK[which].err).textContent = window.api.platform === 'darwin' ? 'Use at least one modifier (⌘ / ⌃ / ⌥ / ⇧)' : 'Use at least one modifier (Win / Ctrl / Alt / Shift)'; $(HK[which].err).classList.remove('hidden'); return; }
  applyHotkey([...mods, key].join('+'), which);
}, true);
async function applyHotkey(accel, which = 'hotkey') {
  const h = HK[which]; S.hotkeyListening = false; $(h.field).classList.remove('listening');
  const r = await h.api(accel);
  $(h.field).value = prettyHotkey(r.hotkey); S.settings[which] = r.hotkey;
  if (r.ok) { $(h.err).classList.add('hidden'); toast(`${which === 'hotkey' ? 'Show/hide' : which === 'modeHotkey' ? 'Window-mode' : 'Full-screen'} hotkey set to ${prettyHotkey(r.hotkey)}`, 'ok'); } else { $(h.err).textContent = `Could not use ${accel}: ${r.error}`; $(h.err).classList.remove('hidden'); }
}

// ---------- shield ----------
const MODE_TEXT = { overlap: 'Overlap · normal window', top: 'On top · floats above other windows', overlay: 'Overlay · clicks pass through' };
const MODE_HINT = { overlap: 'A normal window: it takes your clicks and other windows can cover it.', top: 'Stays above every other window and still takes your clicks.', overlay: 'Stays above everything and lets every click and keystroke go to the app behind it. Pair it with a low opacity to keep an eye on the chat while you work. The mouse cannot reach this window in Overlay, so leave it with the window-mode hotkey.' };
function renderMode(mode) {
  S.mode = mode || 'overlap';
  $('modeRow').className = 'mode-row ' + S.mode; $('modeText').textContent = MODE_TEXT[S.mode] || S.mode;
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.mode));
  $('modeHint').textContent = MODE_HINT[S.mode] || '';
}
document.querySelectorAll('#mode button').forEach((b) => (b.onclick = async () => renderMode(await window.api.setMode(b.dataset.v))));
function renderOpacity(o) {
  const pct = Math.round((o || 1) * 100);
  const r = $('opacity'); r.value = pct; r.style.setProperty('--pct', pct + '%'); $('opacityVal').textContent = pct + '%';
}
$('opacity').oninput = async (e) => { const o = Number(e.target.value) / 100; renderOpacity(o); await window.api.setOpacity(o); };
$('opacity').ondblclick = async () => { renderOpacity(1); await window.api.setOpacity(1); };
function renderRelay(status) {
  S.relay = status;
  const row = $('relayRow'); row.className = 'relay-row ' + status;
  $('relayText').textContent = status === 'up' ? 'Relay connected · reachable from anywhere' : status === 'connecting' ? 'Relay: reconnecting…' : 'No relay · local network only';
  const pill = $('relayPill'); pill.className = 'pill ' + status; pill.textContent = status === 'up' ? 'connected' : status;
}
$('relayRow').onclick = () => { $('btnSettings').click(); setTimeout(() => $('setRelay').focus(), 60); };
$('setRelay').onchange = async (e) => {
  try { const r = await window.api.setRelay(e.target.value.trim()); $('setRelay').value = r.relay; renderRelay(r.status); $('relayErr').classList.add('hidden'); toast(r.relay ? 'Relay set. Invites you create from now on include it.' : 'Relay removed', 'ok'); }
  catch (err) { $('relayErr').textContent = ipcErr(err); $('relayErr').classList.remove('hidden'); }
};
function renderShield(on) {
  S.protection = on; const b = $('shield');
  b.classList.toggle('hidden', !!(S.capture && S.capture.variant)); if (S.capture && S.capture.variant) return;   // the monitor build: no shield at all
  if (S.capture && !S.capture.supported) { b.className = 'shield off'; b.disabled = true; $('shieldText').textContent = window.api.platform === 'linux' ? 'No capture blocking on Linux (no OS API)' : 'Capture blocking unavailable here'; b.title = S.capture.how; return; }
  b.className = 'shield ' + (on ? 'on' : 'off'); $('shieldText').textContent = on ? 'Screenshots blocked' : 'Screenshots ALLOWED'; b.title = on ? S.capture.how : 'Click to block screen capture';
}
$('shield').onclick = async () => renderShield(await window.api.protection(!S.protection));

// ---------- state + events ----------
async function refreshState() {
  const s = await window.api.state();
  S.me = s.me; S.contacts = s.contacts; S.settings = s.settings; S.capture = s.capture; S.vaultSecure = s.vaultSecure; S.vaultPath = s.vaultPath; S.recordingsDir = s.recordingsDir; S.discovery = !!s.settings.discovery;
  S.autostartSupported = s.autostartSupported; S.version = s.version; S.packaged = s.packaged; S.logPath = s.logPath; S.backgroundApp = s.backgroundApp; S.defaults = s.defaults; S.turn = s.turn; renderMode(s.mode);
  S.prefs = { sidebarWidth: s.settings.sidebarWidth ?? 300, sidebarCollapsed: !!s.settings.sidebarCollapsed, codeWrap: s.settings.codeWrap !== false, codeCollapse: s.settings.codeCollapse !== false }; applyLayout();
  applyTheme(s.settings.theme || 'system');
  renderMe(); renderContacts(); renderShield(s.protection); renderRelay(s.relay);
  $('opacityRow').classList.toggle('hidden', !s.opacitySupported); renderOpacity(s.opacity);
  if (S.current) renderHead();
  $('addDiscover').textContent = `LAN discovery: ${S.discovery ? 'on' : 'off'}`;
}
window.api.onEvent(async (ev) => {
  switch (ev.type) {
    case 'contact': case 'status':
      if (ev.type === 'status' && window.Share) window.Share.onStatus(ev);
      await refreshState();
      if (ev.pub === S.current) renderHead();
      // A contact that arrived through an inbound handshake is the natural thing to open.
      if (!S.current && S.contacts.length) select(ev.pub && contact(ev.pub) ? ev.pub : S.contacts[0].pub);
      break;
    case 'message': {
      if (ev.pub === S.current) {
        const list = S.msgs.get(S.current) || []; if (!list.some((m) => m.id === ev.msg.id)) { list.push(ev.msg); S.msgs.set(S.current, list); const b = atBottom(); renderMessages(false); if (!b && ev.msg.from === 'peer') $('jump').classList.remove('hidden'); }
        // only a window the user is actually looking at clears unread; hidden or unfocused, it keeps counting
        if (ev.msg.from === 'peer' && document.visibilityState === 'visible' && document.hasFocus()) window.api.conversation(S.current);
      }
      else if (ev.msg.from === 'peer') { if (!S.current) { await refreshState(); return select(ev.pub); } const c = contact(ev.pub); if (c) toast(`${c.name}: ${ev.msg.kind === 'code' ? 'sent a code snippet' : ev.msg.kind === 'image' ? 'sent a screenshot' : ev.msg.text.slice(0, 60)}`); }
      await refreshState(); break;
    }
    // refreshes, not reads: a tick or an image arriving must not clear unread on a window nobody is looking at
    case 'update': if (ev.pub === S.current) { S.msgs.set(S.current, await window.api.conversationPeek(S.current)); renderMessages(false); } break;
    case 'history': if (ev.pub === S.current) { S.msgs.set(S.current, await window.api.conversationPeek(S.current)); renderMessages(true); } if (ev.part === ev.parts) toast(`History restored: ${ev.added} message${ev.added === 1 ? '' : 's'} recovered`, 'ok'); await refreshState(); break;
    case 'share': if (window.Share) window.Share.onFrame(ev); break;
    case 'typing': if (ev.pub === S.current) { $('typing').classList.remove('hidden'); S.typingUntil = Date.now() + 3000; setTimeout(() => { if (Date.now() >= S.typingUntil) $('typing').classList.add('hidden'); }, 3100); } break;
    case 'error': toast(ev.message, 'err'); break;
    case 'info': break;
    case 'discovered': if (!S.discovery || ev.known) break; if (document.getElementById('p-' + ev.invite.slice(-10))) break;
      { const row = document.createElement('div'); row.className = 'peer'; row.id = 'p-' + ev.invite.slice(-10);
        row.innerHTML = `<span>${esc(ev.name)}</span><span class="muted small">${esc(ev.host)}</span><span class="spacer"></span>`;
        const b = document.createElement('button'); b.className = 'primary'; b.textContent = 'Add'; b.onclick = () => { $('addInvite').value = ev.invite; $('addGo').click(); }; row.appendChild(b); $('peers').appendChild(row); }
      break;
    case 'protection': S.capture = { supported: ev.supported, how: ev.how }; renderShield(ev.on); if (window.Share) window.Share.render(); renderContacts(); break;   // a window that shows in captures names nobody in the audience bar, and marks no row
    case 'relay': renderRelay(ev.status); if (ev.status === 'up') refreshState(); break;
    case 'opacity': renderOpacity(ev.opacity); break;
    case 'fullHotkey': if (window.Share && window.Share.active()) window.Share.setFull(); break;
    case 'mode': renderMode(ev.mode); toast(`${MODE_TEXT[ev.mode]}. ${prettyHotkey(ev.hotkey)} cycles modes.`, ev.mode === 'overlay' ? '' : 'ok'); break;
    case 'settings': S.settings = { ...S.settings, ...ev }; if (openModal === 'mSettings') renderSettings(); if (window.Share) window.Share.onSettings(); break;
    case 'fullscreen': if (window.Share) window.Share.onFullscreen(ev); break;
    case 'control': if (window.Share) window.Share.onControl(ev); break;
    case 'cursor': if (window.Share) window.Share.onCursor(ev); break;
    case 'clip': if (window.Share) window.Share.onClip(ev); break;
    case 'shown': input.focus(); if (window.Share) window.Share.onShown(); if (S.current && (contact(S.current)?.unread || 0) > 0) select(S.current); break;
  }
});

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (S.hotkeyListening) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape' && lbMsg) { closeLightbox(); return; }
  // Esc on the control dialog is its Deny. Closing it only would leave the request open behind the page until
  // it ran out: the asker waiting, and every other viewer who asks told that someone else has control.
  if (e.key === 'Escape' && openModal === 'mControl') { $('controlNo').click(); return; }
  if (e.key === 'Escape' && openModal) { close(); return; }
  if (mod && e.key === 'n') { e.preventDefault(); $('btnAdd').click(); }
  if (mod && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
  if (mod && e.key === ',') { e.preventDefault(); $('btnSettings').click(); }
  if (mod && e.key === 'e' && S.current) { e.preventDefault(); setCodeMode(!S.codeMode); }
  if (mod && e.key === 'i' && !openModal) { e.preventDefault(); showInvite(false); }
});

// ---------- boot ----------
(async () => {
  await refreshState();
  if (!S.me.name) { $('hotkeyNote').innerHTML = S.backgroundApp ? `This app has no Dock, taskbar or menu-bar icon. Show and hide it with <kbd>${esc(prettyHotkey(S.settings.hotkey))}</kbd>. Change the key in Settings (⌘,). Closing the window just hides it.` : `Show and hide the window with <kbd>${esc(prettyHotkey(S.settings.hotkey))}</kbd> (X11 sessions) or from the dock.`; show('mName'); $('firstGo').onclick = async () => { const n = $('firstName').value.trim(); if (!n) return; S.me.name = await window.api.setName(n); renderMe(); close(); }; $('firstName').onkeydown = (e) => { if (e.key === 'Enter') $('firstGo').click(); }; }
  else if (S.contacts.length) select(S.contacts.sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0))[0].pub);
  grow();
})();
