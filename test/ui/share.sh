#!/bin/sh
# Screen share flow against two FRESH dev instances on CDP 9421 (Alice) / 9422 (Bob), started with
# --use-fake-device-for-media-stream (a generated tone instead of the real microphone):
#   ./run.sh --instance=shareA --remote-debugging-port=9421 --x=20 --y=60 --use-fake-device-for-media-stream &
#   ./run.sh --instance=shareB --remote-debugging-port=9422 --x=960 --y=60 --use-fake-device-for-media-stream &
CDP="$(cd "$(dirname "$0")" && pwd)/cdp.js"
sleep_py() { python3 -c "import time;time.sleep($1)"; }
A() { node "$CDP" 9421 "$1"; }; B() { node "$CDP" 9422 "$1"; }
HEAD='JSON.stringify({btn:document.getElementById("btnShare").textContent.trim(),pill:document.getElementById("sharePill").classList.contains("hidden")?null:document.getElementById("sharePill").textContent,stats:document.getElementById("sharePill").title,mic:document.getElementById("btnMic").classList.contains("hidden")?null:document.getElementById("btnMic").classList.contains("on"),viewer:!document.getElementById("viewer").classList.contains("hidden"),video:(()=>{const v=document.getElementById("viewerVideo");return v.srcObject?{w:v.videoWidth,h:v.videoHeight,ready:v.readyState,audio:v.srcObject.getAudioTracks().length,videoTracks:v.srcObject.getVideoTracks().length}:null})(),live:document.querySelectorAll(".contact .live").length,active:window.Share.active(),modal:!document.getElementById("mShareBack").classList.contains("hidden")})'
echo "--- names"
A "(()=>{document.getElementById('firstName').value='Alice';document.getElementById('firstGo').click();return 'ok'})()" >/dev/null
B "(()=>{document.getElementById('firstName').value='Bob';document.getElementById('firstGo').click();return 'ok'})()" >/dev/null
sleep_py 0.8
echo "--- invite -> add"
INV=$(A "document.getElementById('emptyInvite').click(); new Promise(r=>setTimeout(()=>r(document.getElementById('myInvite').value),400))")
A "(()=>{document.querySelector('#mInvite [data-close]').click();return 'ok'})()" >/dev/null
B "(()=>{document.getElementById('btnAdd').click();document.getElementById('addInvite').value='$INV';document.getElementById('addGo').click();return 'ok'})()" >/dev/null
sleep_py 3
for P in 9421 9422; do node "$CDP" $P "window.api.state().then(s=>JSON.stringify({me:s.me.name,contacts:s.contacts.map(c=>c.name+':'+c.status),ice:s.turn.host}))"; done
echo "--- 1. alice: one click, one way"
A "(()=>{document.getElementById('btnShare').click();return 'clicked'})()"
sleep_py 5
echo "alice: $(A "$HEAD")"
echo "bob:   $(B "$HEAD")"
echo "--- bob hears the tone? (RMS of the remote audio)"
B "(async()=>{const st=document.getElementById('viewerVideo').srcObject;const ac=new AudioContext();const src=ac.createMediaStreamSource(st);const an=ac.createAnalyser();an.fftSize=2048;src.connect(an);await new Promise(r=>setTimeout(r,900));const d=new Float32Array(an.fftSize);an.getFloatTimeDomainData(d);let s=0;for(const x of d)s+=x*x;src.disconnect();ac.close();return JSON.stringify({audioTracks:st.getAudioTracks().length,rms:+Math.sqrt(s/d.length).toFixed(4)})})()"
echo "--- bob: frame of what he sees -> saved"
B "(()=>{const v=document.getElementById('viewerVideo');const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);return c.toDataURL('image/jpeg',0.6)})()" | sed 's/^data:image\/jpeg;base64,//' | base64 -d > "${SHARE_FRAME:-/tmp/share-frame.jpg}" && ls -la "${SHARE_FRAME:-/tmp/share-frame.jpg}"
# bash 3.2 (/bin/sh here) mangles nested double quotes inside $(...): probes with braces go in variables, like HEAD
FULLQ='window.api.state().then(s=>JSON.stringify({fullscreen:s.windowFlags.fullscreen,theater:document.body.classList.contains("theater"),page:[innerWidth,innerHeight],screen:[screen.width,screen.height]}))'
RECQ='JSON.stringify({btn:document.getElementById("viewerRec").textContent,rec:window.Share.debug().rec,bytes:window.Share.debug().recBytes})'
PILLQ='JSON.stringify({pill:document.getElementById("sharePill").textContent,remoteRec:window.Share.debug().remoteRec})'
echo "--- 1b. bob: full screen on (window flag + page = screen), then off"
B "(()=>{document.getElementById('viewerFull').click();return 'clicked'})()" >/dev/null
sleep_py 1.5
echo "bob full: $(B "$FULLQ")"
B "(()=>{document.getElementById('viewerFull').click();return 'clicked'})()" >/dev/null
sleep_py 1.5
echo "bob back: $(B "$FULLQ")"
echo "--- 1c. bob: Record for 4 s via the viewer button; alice's pill says recorded"
B "(()=>{document.getElementById('viewerRec').click();return 'clicked'})()" >/dev/null
sleep_py 4
echo "bob rec:    $(B "$RECQ")"
echo "alice pill: $(A "$PILLQ")"
B "(()=>{document.getElementById('viewerRec').click();return 'clicked'})()" >/dev/null
sleep_py 2
REC1=$(B "window.Share.lastRecording()")
echo "saved: $REC1 ($(stat -f %z "$REC1" 2>/dev/null || stat -c %s "$REC1") bytes) magic=$(xxd -l 4 -p "$REC1") (1a45dfa3 = EBML/WebM)"
echo "bob after:  $(B "$RECQ")"
echo "alice after: $(A "$PILLQ")"
echo "--- 1d. bob: the Settings switch turned on during the share starts a recording; off stops it"
B "window.api.setPref('recordShares',true).then(v=>'recordShares='+v)"
sleep_py 3
echo "bob auto: $(B "$RECQ")"
B "window.api.setPref('recordShares',false).then(v=>'recordShares='+v)"
sleep_py 2
REC2=$(B "window.Share.lastRecording()")
echo "bob off:  $(B "$RECQ") second file: $REC2 ($(stat -f %z "$REC2" 2>/dev/null || stat -c %s "$REC2") bytes)"
[ "$REC1" != "$REC2" ] && echo "two distinct files: yes" || echo "two distinct files: NO"
rm -f "$REC1" "$REC2"
echo "--- 2. bob: talk back"
B "(()=>{document.getElementById('viewerTalk').click();return 'clicked'})()" >/dev/null
sleep_py 2.5
echo "alice: $(A "$HEAD")"
echo "bob:   $(B "$HEAD")"
echo "--- 3. bob: share mine (two way)"
B "(()=>{document.getElementById('viewerShareBack').click();return 'clicked'})()" >/dev/null
sleep_py 5
echo "alice: $(A "$HEAD")"
echo "bob:   $(B "$HEAD")"
echo "--- 4. alice: stop sharing (bob still shares)"
A "(()=>{document.getElementById('btnShare').click();return 'clicked'})()" >/dev/null
sleep_py 2.5
echo "alice: $(A "$HEAD")"
echo "bob:   $(B "$HEAD")"
echo "--- 5. bob: stop sharing -> session over"
B "(()=>{document.getElementById('btnShare').click();return 'clicked'})()" >/dev/null
sleep_py 2
echo "alice: $(A "$HEAD")"
echo "bob:   $(B "$HEAD")"
echo "--- 6. two-way from the start: alice sets mode two, shares; bob gets the prompt and accepts"
A "window.api.setPref('shareMode','two').then(v=>'mode='+v)"
A "(()=>{document.getElementById('btnShare').click();return 'clicked'})()" >/dev/null
sleep_py 4
echo "bob:   $(B "$HEAD")"
B "(()=>{document.getElementById('shareBackYes').click();return 'accepted'})()" >/dev/null
sleep_py 5
echo "alice: $(A "$HEAD")"
echo "bob:   $(B "$HEAD")"
echo "--- 7. alice: End -> both idle"
A "(()=>{document.getElementById('viewerEnd').click();return 'clicked'})()" >/dev/null
sleep_py 2
echo "alice: $(A "$HEAD")"
echo "bob:   $(B "$HEAD")"
echo "--- 8. through the call server only (TURN on the box): both relay-only, one way"
A "window.api.setPref('callsRelayOnly',true).then(v=>'relayOnly='+v)"; B "window.api.setPref('callsRelayOnly',true).then(v=>'relayOnly='+v)"
A "window.api.setPref('shareMode','one').then(v=>'mode='+v)" >/dev/null
A "(()=>{document.getElementById('btnShare').click();return 'clicked'})()" >/dev/null
sleep_py 9
echo "alice: $(A "$HEAD")"
echo "bob:   $(B "$HEAD")"
A "(()=>{document.getElementById('btnShare').click();return 'clicked'})()" >/dev/null
sleep_py 1.5
echo "after stop: alice active=$(A "window.Share.active()") bob active=$(B "window.Share.active()")"
echo "--- logs"
for P in 9421 9422; do L=$(node "$CDP" $P "window.api.state().then(s=>s.logPath)"); echo "$L: errors=$(grep -c ERROR "$L") display-media=$(grep -c 'display media' "$L")"; grep ERROR "$L" | tail -3 | cut -c1-160; done
