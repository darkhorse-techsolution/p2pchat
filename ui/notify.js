'use strict';
// Pop-up window content. Receives { theme, solid, name, pub, text, kind, showText, more } from main.
const $ = (id) => document.getElementById(id);
const hue = (pub) => { let h = 0; for (const c of pub || '') h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
window.notify.onShow((p) => {
  document.documentElement.dataset.theme = p.theme;
  if (p.solid) document.documentElement.dataset.solid = '1';
  $('avatar').style.background = `linear-gradient(135deg, hsl(${hue(p.pub)} 65% 55%), hsl(${(hue(p.pub) + 40) % 360} 65% 45%))`;
  $('avatar').textContent = (p.name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  $('name').textContent = p.name || 'New message';
  $('more').hidden = !(p.more > 0); $('more').textContent = p.more > 0 ? `+${p.more} more` : '';
  const t = $('text'); t.className = 'text';
  if (p.kind === 'image') { t.classList.add('hidden-text'); t.textContent = 'sent a screenshot'; }
  else if (p.kind === 'share') { t.classList.add('hidden-text'); t.textContent = 'is sharing their screen: open the chat to watch'; }
  else if (!p.showText) { t.classList.add('hidden-text'); t.textContent = p.kind === 'code' ? 'sent a code snippet' : 'sent a message'; }
  else if (p.kind === 'code') { t.classList.add('code'); t.textContent = p.text; }
  else t.textContent = p.text;
  const card = $('card'); card.classList.remove('in'); void card.offsetWidth; card.classList.add('in');
  window.notify.sized(Math.ceil(card.getBoundingClientRect().height) + 16);
});
