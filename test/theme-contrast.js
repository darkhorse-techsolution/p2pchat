// WCAG 2.1 contrast check over both palettes in ui/theme.css. No dependencies.
const fs = require('node:fs'); const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'theme.css'), 'utf8');
const block = (name) => { const i = css.indexOf(`:root[data-theme="${name}"]`); const j = css.indexOf('}', i); return css.slice(i, j); };
const tokens = (name) => Object.fromEntries([...block(name).matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// A surface the stylesheet mixes, [token, percent, token] = color-mix(in srgb, token percent%, token), as a hex colour.
const mixed = (t, [a, pct, b]) => (/^#/.test(t[a] || '') && /^#/.test(t[b] || '') ? '#' + hex(t[a]).map((c, i) => Math.round(c * pct / 100 + hex(t[b])[i] * (100 - pct) / 100).toString(16).padStart(2, '0')).join('') : '');
// what must be readable on what, and the floor it must clear
const PAIRS = [
  ['text', 'bg', 7], ['text', 'panel', 7], ['text', 'side', 7], ['text', 'panel-2', 7], ['text', 'peer', 7],
  ['dim', 'bg', 4.5], ['dim', 'panel', 4.5], ['dim', 'side', 4.5], ['dim', 'panel-2', 4.5],
  ['faint', 'bg', 4.5], ['faint', 'panel', 4.5], ['faint', 'side', 4.5],
  ['accent-text', 'bg', 4.5], ['accent-text', 'panel', 4.5], ['accent-text', 'panel-2', 4.5],
  ['on-accent', 'accent', 4.5],
  ['good', 'panel', 4.5], ['warn', 'panel', 4.5], ['bad', 'panel', 4.5], ['good', 'side', 4.5], ['bad', 'side', 4.5],
  ['line', 'panel', 1.3], ['line-2', 'panel', 1.5],
  ['tk-c', 'code-bg', 4.5], ['tk-s', 'code-bg', 4.5], ['tk-n', 'code-bg', 4.5], ['tk-k', 'code-bg', 4.5], ['tk-f', 'code-bg', 4.5], ['tk-t', 'code-bg', 4.5], ['tk-l', 'code-bg', 4.5], ['tk-p', 'code-bg', 4.5], ['tk-o', 'code-bg', 4.5],
  ['text', 'code-bg', 7],
  ['bad', ['bad', 10, 'panel'], 4.5], ['bad', 'panel-2', 4.5],   // the audience bar of a screen share, and its buttons
  ['bg', 'good', 4.5],                                           // the clipboard buttons of a control session (on-accent on good is 1.99 in the dark palette)
];
let fails = 0, n = 0;
for (const theme of ['dark', 'light']) {
  const t = tokens(theme);
  for (const [fg, on, min] of PAIRS) {
    const bg = Array.isArray(on) ? `${on[0]}${on[1]}/${on[2]}` : on, back = Array.isArray(on) ? mixed(t, on) : t[on] || '';
    if (!/^#/.test(t[fg] || '') || !/^#/.test(back)) { console.log('SKIP ', theme, fg, 'on', bg, '(not a hex token)'); continue; }
    const r = ratio(t[fg], back); n++;
    const ok = r >= min; if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${theme.padEnd(5)} ${fg.padEnd(11)} on ${bg.padEnd(8)} ${r.toFixed(2).padStart(6)}  (min ${min})`);
  }
}
console.log(`\n${n - fails}/${n} pairs meet their floor`);
process.exit(fails ? 1 : 0);
