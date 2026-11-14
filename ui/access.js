'use strict';
// The unattended-access notice (main/accesscard.js). Receives { theme, solid, text } from main.
const $ = (id) => document.getElementById(id);
window.access.onShow((p) => {
  document.documentElement.dataset.theme = p.theme;
  if (p.solid) document.documentElement.dataset.solid = '1';
  $('text').textContent = p.text; $('text').title = p.text;
});
$('stop').onclick = () => window.access.stop();
