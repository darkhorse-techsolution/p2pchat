'use strict';
// Screen share: recording what they send.
// MediaRecorder on a snapshot of the remote stream (their screen, their voice), 1 s pieces
// handed to the main process, which appends them to a .webm in the Videos folder. Wanted
// by the viewer's button for this share, or by the Settings switch for every share, the
// running one included; the state frame carries `rec` so the sharer sees it.
//
// Reads from app.js: S, $, toast, ipcErr. Reads K.sessions.sendState and K.paint at call time.
(() => {
  const K = window.ShareKit;
  const REC_MIME = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
  const fmtClock = (ms) => { const t = Math.floor(ms / 1000); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  const recReady = (sess) => { const st = sess.remote.stream; return !!(sess.remote.screen && st && st.getVideoTracks().length && (!sess.remote.mic || st.getAudioTracks().length)); };
  async function startRecording(sess) {
    if (sess.rec || sess.recStarting || !recReady(sess)) return;
    if (!REC_MIME) { toast('Recording is not supported here', 'err'); sess.recWanted = false; return; }
    sess.recStarting = true;
    let id, file;
    try {
      ({ id, file } = await window.api.recordStart(sess.pub));
      if (sess.closed) { window.api.recordStop(id).catch(() => {}); return; }   // the share ended while the file was being created: main removes the empty file
      const stream = new MediaStream(sess.remote.stream.getTracks());   // a snapshot: tracks added later never disturb the recorder
      const recorder = new MediaRecorder(stream, { mimeType: REC_MIME, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 96_000 });
      const rec = { id, file, recorder, since: Date.now(), bytes: 0, q: Promise.resolve(), timer: null, failed: '' };
      recorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        rec.q = rec.q.then(async () => {   // pieces reach the file in order
          if (rec.failed) return;
          try { rec.bytes = await window.api.recordChunk(id, new Uint8Array(await e.data.arrayBuffer())); }
          catch (err) { rec.failed = ipcErr(err); if (recorder.state !== 'inactive') recorder.stop(); }
        });
      };
      recorder.onerror = (e) => { rec.failed = rec.failed || (e.error && e.error.message) || 'recorder error'; if (recorder.state !== 'inactive') recorder.stop(); };
      recorder.onstop = () => finishRecording(sess, rec);
      recorder.start(1000);
      rec.timer = setInterval(() => { if (sess.rec === rec && !sess.closed && S.current === sess.pub) renderRec(sess); }, 1000);
      sess.rec = rec;
      K.sessions.sendState(sess); K.paint();
    } catch (e) {
      if (id && !sess.rec) window.api.recordStop(id).catch(() => {});   // the file exists but nothing records into it: left open it would count toward main's two recordings for good
      toast(`Recording did not start: ${ipcErr(e)}`, 'err'); sess.recWanted = false;
    }
    finally { sess.recStarting = false; }
  }
  function stopRecording(sess) { const rec = sess.rec; if (!rec) return; if (rec.recorder.state !== 'inactive') rec.recorder.stop(); else finishRecording(sess, rec); }
  async function finishRecording(sess, rec) {
    if (sess.rec !== rec) return;
    sess.rec = null; clearInterval(rec.timer);
    if (rec.failed) sess.recWanted = false;   // no retry loop on a disk that is full
    await rec.q;
    let saved = null; try { saved = await window.api.recordStop(rec.id); } catch {}
    if (saved) K.rec.last = saved.file;
    if (rec.failed) toast(`Recording stopped: ${rec.failed}${saved ? ` (${fmtBytes(saved.bytes)} kept)` : ''}`, 'err');
    else if (saved) toast(`Recording saved (${fmtBytes(saved.bytes)}): ${saved.file}`, 'ok');
    if (!sess.closed) { K.sessions.sendState(sess); K.paint(); }
  }
  function syncRecording(sess) {
    if (sess.recWanted && !sess.rec) startRecording(sess);      // waits for the tracks if they are not there yet
    else if (sess.rec && (!sess.recWanted || !sess.remote.screen)) stopRecording(sess);
  }
  function renderRec(sess) {
    const b = $('viewerRec'), on = !!sess.rec; b.classList.toggle('on', on);
    b.textContent = on ? `● ${fmtClock(Date.now() - sess.rec.since)}${sess.rec.bytes ? ' · ' + fmtBytes(sess.rec.bytes) : ''}` : '● Record';
    b.title = on ? 'Stop recording (the file is kept)' : 'Record what you see and hear from them to a file';
  }
  function toggle(sess) { sess.recWanted = !sess.rec; syncRecording(sess); renderRec(sess); }   // the viewer's Record button
  K.rec = { last: null, ready: recReady, sync: syncRecording, toggle, stop: stopRecording, paint: renderRec };   // last: the file of the last saved recording
})();
