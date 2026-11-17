'use strict';
// The unattended-access notice (main/accesscard.js). Receives { theme, solid, text, audio } from main.
// audio: null = screen only (no mute button); { on } = this machine is sending its microphone, and the
// button mutes or unmutes it.
const $ = (id) => document.getElementById(id);
window.access.onShow((p) => {
  document.documentElement.dataset.theme = p.theme;
  if (p.solid) document.documentElement.dataset.solid = '1';
  $('text').textContent = p.text; $('text').title = p.text;
  const mute = $('mute'), a = p.audio;
  mute.classList.toggle('hidden', !a);
  if (a) { mute.textContent = a.on ? 'Mute mic' : 'Unmute'; mute.title = a.on ? 'Mute your microphone for the connected contact' : 'Send your microphone again'; }
});
$('stop').onclick = () => window.access.stop();
$('mute').onclick = () => window.access.mute();
