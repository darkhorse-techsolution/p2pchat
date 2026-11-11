// The share code of the renderer (ui/share/*.js) without a window: the parts that are plain logic.
// Each of those files is one closure that hangs its part on window.ShareKit and reads the app's
// globals only when called, so it loads into a bare context that has just what a test hands in.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };
function load(files, globals = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, ...globals });
  ctx.window = ctx;
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'share', f), 'utf8'), ctx, { filename: f });
  return ctx.ShareKit;
}

// C1: a pointer picture has to fit one data-channel message
{
  const sent = [], K = load(['kit.js', 'control.js']);
  K.sessions = { dc: (_sess, label, msg) => { sent.push({ label, msg }); return true; } };
  const sess = { pc: { sctp: { maxMessageSize: 262144 } }, ctl: { give: 'on' } };
  K.control.owner = { sess, token: 'tok' };
  const pic = (n) => ({ token: 'tok', w: 16, h: 16, pw: 32, ph: 32, hx: 1, hy: 2, png: 'A'.repeat(n) });
  const size = (n) => { const c = pic(n); return JSON.stringify({ t: 'cur', w: c.w, h: c.h, pw: c.pw, ph: c.ph, hx: c.hx, hy: c.hy, png: c.png }).length; };
  K.control.onCursor(pic(400));
  ok('C1 a small picture goes out on ctl, without the token', sent.length === 1 && sent[0].label === 'ctl' && Object.keys(sent[0].msg).join() === 't,w,h,pw,ph,hx,hy,png' && sent[0].msg.t === 'cur' && sent[0].msg.png.length === 400);
  const fill = 262144 - size(0);
  K.control.onCursor(pic(fill));
  ok('C1 a message of exactly the size the connection takes goes out', size(fill) === 262144 && sent.length === 2);
  K.control.onCursor(pic(fill + 1)); K.control.onCursor(pic(300000));
  ok('C1 one byte more is left out, and so is the largest picture main lets through', sent.length === 2);
  sess.pc.sctp = null;
  K.control.onCursor(pic(fill + 1)); K.control.onCursor(pic(fill));
  ok('C1 a connection that does not say its size is taken at 262144 bytes', K.DC_FIT === 262144 && sent.length === 3);
  sess.pc.sctp = { maxMessageSize: 1000 };
  K.control.onCursor(pic(2000)); K.control.onCursor(pic(400));
  ok('C1 the size the connection gives is the one that counts', sent.length === 4);
  K.control.onCursor({ ...pic(400), token: 'other' }); sess.ctl.give = 'off'; K.control.onCursor(pic(400));
  ok('C1 and a picture still goes out only with the token of the grant, while control is on', sent.length === 4);
}
