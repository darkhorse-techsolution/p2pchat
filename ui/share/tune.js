'use strict';
// Screen share: every value and every decision the delay and the picture depend on, and nothing
// else. Capture and encoder limits, codec order, the receiver's playout hints, which MediaStream a
// track is sent on, the pacing of pointer moves, and the delay readout. Work on latency happens in
// this file; the rest of the share code calls K.tune and holds none of these numbers.
//
// Reads K.sessions.dc (ui/share/session.js) at call time.
(() => {
  const K = window.ShareKit;
  // Caps: VP9 screen content at up to 8 Mb/s and 30 fps, 2560 px wide. Congestion control brings
  // the rate down on a weak link; on a LAN or a good direct path text stays sharp and motion smooth.
  const MAX_W = 2560, MAX_H = 1600, FPS = 30, VIDEO_KBPS = 8000;
  const MOVE_MS = 8;                  // a pointer move goes out as it arrives, at most one per 8 ms
  const MOVE_BUF = 1024;              // bytes queued on the move channel: SCTP has not drained for about 30 moves, the path is stalled, drop rather than replay
  const ASK_MS = 45000;               // a control request with no answer expires
  const GIVE_ASK_MS = ASK_MS - 5000;  // the sharer's dialog gives up first, so the viewer gets one answer and not its own timeout on top
  const SPLIT_MIC = false;            // the microphone on a MediaStream of its own: released peers (0.7.1) read both tracks from one, so off
  const MAX_AUDIENCE = 4;             // contacts that get my screen at once, from the one capture; read as K.tune.MAX_AUDIENCE where it is used
  const MOVE_EV = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove';   // raw: not held to the next frame

  // The viewer plays what arrives as soon as it arrives: no jitter-buffer cushion for a share
  // that is driven live (Chromium hints; both ignored where unsupported).
  function lowLatency(receiver) {
    try { receiver.jitterBufferTarget = 0; } catch {}
    try { receiver.playoutDelayHint = 0; } catch {}
  }
  // VP9 first: its screen-content mode keeps text sharp at a given rate. The rest in Chromium's order.
  function preferCodecs(pc, sender) {
    try {
      const tr = pc.getTransceivers().find((t) => t.sender === sender);
      const caps = RTCRtpReceiver.getCapabilities('video');
      if (!tr || !tr.setCodecPreferences || !caps) return;
      const rank = (c) => (/vp9/i.test(c.mimeType) ? 0 : 1);
      tr.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
    } catch (e) { console.warn('codec preference', e.message); }
  }

  function sendMove(sess, m) {   // first move after a pause: at once; inside a burst: the latest, when the hold ends
    const c = sess.ctl, now = performance.now(), wait = MOVE_MS - (now - c.moveAt);
    if (wait <= 0) { clearTimeout(c.flush); c.flush = null; c.move = null; c.moveAt = now; K.sessions.dc(sess, 'move', m); return; }
    c.move = m;
    if (!c.flush) c.flush = setTimeout(() => { c.flush = null; const p = c.move; if (p) { c.move = null; c.moveAt = performance.now(); K.sessions.dc(sess, 'move', p); } }, wait);
  }

  // One capture, several viewers: every viewer is an encoder of its own, so from the third on each gets
  // less. Up to two get the one-to-one values. The viewer who drives the screen keeps the full frame
  // rate, whatever the audience: the pointer has to feel live there.
  function tier(n, controlled) {
    const t = n <= 2 ? { kbps: VIDEO_KBPS, fps: FPS, maxW: MAX_W } : n === 3 ? { kbps: 5000, fps: 20, maxW: 1920 } : { kbps: 4000, fps: 15, maxW: 1920 };
    if (controlled) { t.fps = FPS; t.kbps = Math.max(t.kbps, 5000); }
    return t;
  }
  const encoding = (t) => ({ maxBitrate: t.kbps * 1000, maxFramerate: t.fps });
  // Sets a tier on one session's screen sender: encoder parameters only, never a renegotiation. The
  // down-scaling comes from the width of the session's own clone, read on every call (a clone need not
  // have the size the capture was held to). A session that was scaled once keeps the key, at 1 when it
  // is no longer needed, so a tier that goes back up takes the scaling off again.
  // The parameters are read and set in one go, but the browser applies them a moment later: an offer or
  // answer that lands in between changes them underneath (their RTCP part) and the set is refused. They
  // are then read and set again, unless a later call has taken over or the share ended meanwhile.
  async function sender(sess, t) {
    const snd = sess.screenSender;
    if (!snd || !sess.screenTrack) return;
    const w = sess.screenTrack.getSettings().width || 0, scale = w > t.maxW ? w / t.maxW : 1, enc = encoding(t);
    if (scale > 1 || sess.scaled) { enc.scaleResolutionDownBy = scale; sess.scaled = true; }
    const turn = sess.capTurn = (sess.capTurn || 0) + 1;
    for (let tries = 3; tries > 0; tries--) {
      try { const p = snd.getParameters(); p.encodings = [enc]; await snd.setParameters(p); return; }
      catch (e) { if (sess.closed || sess.screenSender !== snd || sess.capTurn !== turn) return; if (tries === 1) console.error('share caps', e.message); }
    }
  }

  // Where the delay sits: per-window averages from the same 2 s report (viewer: buffer, decode, shown; sharer: encoder input and output).
  function readout(sess, st) {
    const p = sess.q || {}, f = sess.pic || {}, q = { hint: sess.screenTrack ? sess.screenTrack.contentHint : '', sent: sess.ctl.sent, recv: sess.ctl.recv };
    sess.pic = null;
    st.forEach((r) => {
      if (r.type === 'media-source' && r.kind === 'video') { q.inFps = r.framesPerSecond; q.inN = r.frames; }
      if (r.type === 'outbound-rtp' && r.kind === 'video') Object.assign(q, { encFps: r.framesPerSecond, encN: r.framesEncoded, encT: r.totalEncodeTime, limit: r.qualityLimitationReason, target: r.targetBitrate, impl: r.encoderImplementation, svc: r.scalabilityMode, outW: r.frameWidth, outH: r.frameHeight, keyN: r.keyFramesEncoded, hugeN: r.hugeFramesSent, paceT: r.totalPacketSendDelay, pkts: r.packetsSent });
      if (r.type === 'inbound-rtp' && r.kind === 'video') Object.assign(q, { rxN: r.framesReceived, decN: r.framesDecoded, decT: r.totalDecodeTime, dropN: r.framesDropped, jbT: r.jitterBufferDelay, jbTgt: r.jitterBufferTargetDelay, jbMin: r.jitterBufferMinimumDelay, jbN: r.jitterBufferEmittedCount, procT: r.totalProcessingDelay, nackN: r.nackCount, frzN: r.freezeCount, lossN: r.packetsLost, dec: r.decoderImplementation });
      if (r.type === 'inbound-rtp' && r.kind === 'audio') Object.assign(q, { aT: r.jitterBufferDelay, aTgt: r.jitterBufferTargetDelay, aMin: r.jitterBufferMinimumDelay, aN: r.jitterBufferEmittedCount });
      if (r.type === 'media-playout') { q.poT = r.totalPlayoutDelay; q.poN = r.totalSamplesCount; }
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) q.avail = r.availableOutgoingBitrate;
    });
    const d = (k) => (q[k] || 0) - (p[k] || 0);                                          // growth of a counter in this window
    const ms = (t, n) => (d(n) > 0 ? Math.max(0, Math.round(1000 * d(t) / d(n))) : 0);   // seconds over a count -> ms each
    return (sess.q = Object.assign(q, {
      bufMs: ms('jbT', 'jbN'), wantMs: ms('jbMin', 'jbN'), holdMs: Math.max(0, ms('jbTgt', 'jbN') - ms('jbMin', 'jbN')),   // hold: what A/V sync or a set minimum adds over the network's own need
      decMs: ms('decT', 'decN'), procMs: ms('procT', 'decN'), rx: d('rxN'), out: d('decN'), drop: d('dropN'), nack: d('nackN'), freeze: d('frzN'), loss: d('lossN'),
      shownMs: f.n ? Math.round(f.show / f.n) : 0, e2eMs: f.c ? Math.round(f.e2e / f.c) : 0, e2eWorst: Math.round(f.worst || 0),
      voiceMs: ms('aT', 'aN'), voiceDevMs: ms('poT', 'poN'), voiceHoldMs: Math.max(0, ms('aTgt', 'aN') - ms('aMin', 'aN')),
      encMs: ms('encT', 'encN'), paceMs: ms('paceT', 'pkts'), skip: Math.max(0, d('inN') - d('encN')), keys: d('keyN'), huge: d('hugeN'),   // skip: frames that reached the encoder and were not encoded
      ctlOut: d('sent'), ctlIn: d('recv'), moveBuf: sess.ctl.mv ? sess.ctl.mv.bufferedAmount : 0,
    }));
  }

  K.tune = {
    MAX_W, MAX_H, FPS, VIDEO_KBPS, MOVE_MS, MOVE_BUF, ASK_MS, GIVE_ASK_MS, SPLIT_MIC, MAX_AUDIENCE, MOVE_EV,
    displayConstraints: () => ({ video: { frameRate: { ideal: FPS, max: FPS } }, audio: false }),
    capture: async (track) => { try { await track.applyConstraints({ width: { max: MAX_W }, height: { max: MAX_H }, frameRate: { ideal: FPS, max: FPS } }); } catch {} },
    micConstraints: () => ({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }),
    hint: (controlled) => (controlled ? 'motion' : 'detail'),   // smooth over sharp while they drive
    codecs: preferCodecs,
    receiver: (receiver, kind) => { if (kind === 'video') lowLatency(receiver); },
    tier, encoding, sender,
    streamFor: (sess, kind) => (kind === 'audio' && SPLIT_MIC && sess.ver >= 2 ? (sess.micLocal ||= new MediaStream()) : sess.local),
    sendMove, readout,
  };
})();
