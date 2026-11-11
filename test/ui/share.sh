#!/bin/sh
# Screen share flow against two FRESH dev instances on CDP 9421 (Alice) / 9422 (Bob), started with
# --use-fake-device-for-media-stream (a generated tone instead of the real microphone), --dry-input
# (remote control can be allowed, but no input helper starts: events are counted and dropped) and
# --clip-fake (the clipboard that control can share is a text in memory, never the system clipboard):
#   ./run.sh --instance=shareA --remote-debugging-port=9421 --x=20 --y=60 --use-fake-device-for-media-stream --dry-input --clip-fake &
#   ./run.sh --instance=shareB --remote-debugging-port=9422 --x=960 --y=60 --use-fake-device-for-media-stream --dry-input --clip-fake &
# Steps 1e and 1f click Allow on Alice, so they run only when her main process says it is dry and both
# say their clipboard is the fake one, or with REAL_INPUT=1. Off unless asked for, because they act on this machine itself or keep a picture of its screen:
#   REAL_INPUT=1                 without --dry-input: Bob's pointer, click and keys land here, and the pointer is read back
#   SHARE_FRAME=/path/frame.jpg  saves one frame of what Bob sees to that file
CDP="$(cd "$(dirname "$0")" && pwd)/cdp.js"
sleep_py() { python3 -c "import time;time.sleep($1)"; }
A() { node "$CDP" 9421 "$1"; }; B() { node "$CDP" 9422 "$1"; }
HEAD='JSON.stringify({btn:document.getElementById("btnShare").textContent.trim(),pill:document.getElementById("sharePill").classList.contains("hidden")?null:document.getElementById("sharePill").textContent,stats:document.getElementById("sharePill").title,mic:document.getElementById("btnMic").classList.contains("hidden")?null:document.getElementById("btnMic").classList.contains("on"),viewer:!document.getElementById("viewer").classList.contains("hidden"),video:(()=>{const v=document.getElementById("viewerVideo"),a=document.querySelector("#shareAudio audio");return v.srcObject?{w:v.videoWidth,h:v.videoHeight,ready:v.readyState,audio:a&&a.srcObject?a.srcObject.getAudioTracks().length:0,videoTracks:v.srcObject.getVideoTracks().length}:null})(),live:document.querySelectorAll(".contact .live").length,active:window.Share.active(),modal:!document.getElementById("mShareBack").classList.contains("hidden")})'
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
B "(async()=>{const st=document.querySelector('#shareAudio audio').srcObject;const ac=new AudioContext();const src=ac.createMediaStreamSource(st);const an=ac.createAnalyser();an.fftSize=2048;src.connect(an);await new Promise(r=>setTimeout(r,900));const d=new Float32Array(an.fftSize);an.getFloatTimeDomainData(d);let s=0;for(const x of d)s+=x*x;src.disconnect();ac.close();return JSON.stringify({audioTracks:st.getAudioTracks().length,rms:+Math.sqrt(s/d.length).toFixed(4)})})()"
if [ -n "$SHARE_FRAME" ]; then
  echo "--- bob: frame of what he sees -> saved"
  B "(()=>{const v=document.getElementById('viewerVideo');const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);return c.toDataURL('image/jpeg',0.6)})()" | sed 's/^data:image\/jpeg;base64,//' | base64 -d > "$SHARE_FRAME" && ls -la "$SHARE_FRAME"
fi
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
DRY=$(A "window.api.state().then(s=>s.control.dry===true)")
FAKEQ='window.api.state().then(s=>!s.clip||s.clip.fake===true)'   # a build from before the link has no clip state and shares none
[ "$(A "$FAKEQ")$(B "$FAKEQ")" = truetrue ] || { echo "clip.fake is not true on both instances: no click on Allow, stopping"; exit 1; }
if [ "$DRY" = true ] || [ "$REAL_INPUT" = 1 ]; then
  echo "--- 1e. remote control: bob asks, alice allows (alice's input is dry: $DRY)"
  CTLQ='JSON.stringify({btn:document.getElementById("viewerCtl").textContent,ctl:window.Share.debug().ctl,pill:document.getElementById("sharePill").textContent,stop:!document.getElementById("btnStopCtl").classList.contains("hidden"),videoCtl:document.getElementById("viewerVideo").classList.contains("ctl")})'
  DLGQ='JSON.stringify({open:!document.getElementById("mControl").classList.contains("hidden"),name:document.getElementById("controlName").textContent})'
  B "(()=>{document.getElementById('viewerCtl').click();return 'clicked'})()" >/dev/null
  sleep_py 1.5
  echo "alice dialog: $(A "$DLGQ")  bob: $(B "$CTLQ")"
  A "(()=>{document.getElementById('controlYes').click();return 'allowed'})()" >/dev/null
  sleep_py 3
  echo "bob:   $(B "$CTLQ")"
  echo "alice: $(A "$CTLQ")"
  echo "alice main: $(A "window.api.state().then(s=>JSON.stringify(s.control))")"
  if [ "$REAL_INPUT" = 1 ] && [ "$DRY" != true ] && [ "$(uname)" = Darwin ]; then
    # Real injection, kept harmless: the pointer moves 5 px and back; then alice's own window is brought to
    # the front and bob clicks into her composer and types "hi" there, only if her page has keyboard focus.
    CUR='ObjC.import("CoreGraphics"); var l=$.CGEventGetLocation($.CGEventCreate(null)); Math.round(l.x)+" "+Math.round(l.y)'
    BOUNDS=$(A "window.api.state().then(s=>JSON.stringify(s.control.display.bounds))")
    frac() { python3 -c "import json,sys;b=json.loads(sys.argv[1]);print(round((float(sys.argv[2])-b['x'])/b['width'],4),round((float(sys.argv[3])-b['y'])/b['height'],4))" "$BOUNDS" "$1" "$2"; }
    P0=$(osascript -l JavaScript -e "$CUR"); X0=${P0% *}; Y0=${P0#* }
    F=$(frac $((X0+5)) $((Y0+5))); B "window.Share.inject({t:'m',x:${F% *},y:${F#* }})" >/dev/null; sleep_py 0.6
    P1=$(osascript -l JavaScript -e "$CUR")
    F=$(frac "$X0" "$Y0"); B "window.Share.inject({t:'m',x:${F% *},y:${F#* }})" >/dev/null; sleep_py 0.6
    echo "pointer: before $P0 -> after bob's move $P1 (wanted $((X0+5)) $((Y0+5))) -> back $(osascript -l JavaScript -e "$CUR")"
    CDP_CALL='{"method":"Page.bringToFront"}' A "'front'" >/dev/null; sleep_py 1
    COMP=$(A "(()=>{const r=document.getElementById('input').getBoundingClientRect();return JSON.stringify({x:Math.round(window.screenX+r.left+r.width/2),y:Math.round(window.screenY+(window.outerHeight-window.innerHeight)+r.top+r.height/2),focus:document.hasFocus()})})()")
    echo "alice composer on screen: $COMP"
    if [ "${COMP##*focus\":}" = "true}" ]; then
      CX=$(echo "$COMP" | sed 's/.*"x":\([0-9]*\).*/\1/'); CY=$(echo "$COMP" | sed 's/.*"y":\([0-9]*\).*/\1/')
      F=$(frac "$CX" "$CY"); FX=${F% *}; FY=${F#* }
      A "(()=>{document.getElementById('input').value='';document.getElementById('input').blur();return 'cleared'})()" >/dev/null
      B "(async()=>{const I=window.Share.inject;I({t:'m',x:$FX,y:$FY});I({t:'b',b:0,d:1,x:$FX,y:$FY});I({t:'b',b:0,d:0,x:$FX,y:$FY});await new Promise(r=>setTimeout(r,400));for(const c of ['KeyH','KeyI']){I({t:'k',c,d:1});I({t:'k',c,d:0});await new Promise(r=>setTimeout(r,120));}return 'typed'})()" >/dev/null
      sleep_py 1
      echo "alice after bob's click + keys: $(A "JSON.stringify({active:document.activeElement.id,composer:document.getElementById('input').value})") (want active=input composer=hi)"
      A "(()=>{document.getElementById('input').value='';return 'cleared'})()" >/dev/null
      F=$(frac "$X0" "$Y0"); B "window.Share.inject({t:'m',x:${F% *},y:${F#* }})" >/dev/null
    else
      echo "alice's page did not get focus: click + typing skipped (nothing injected blind)"
    fi
  fi
  echo "--- 1f. alice: ✋ Stop control -> bob loses it; bob asks again, alice denies"
  A "(()=>{document.getElementById('btnStopCtl').click();return 'clicked'})()" >/dev/null
  sleep_py 1.5
  echo "bob:   $(B "$CTLQ")"
  echo "alice: $(A "$CTLQ") main on=$(A "window.api.state().then(s=>s.control.on)")"
  B "(()=>{document.getElementById('viewerCtl').click();return 'clicked'})()" >/dev/null
  sleep_py 1
  A "(()=>{document.getElementById('controlNo').click();return 'denied'})()" >/dev/null
  sleep_py 1
  echo "bob after deny: $(B "$CTLQ")"
else
  echo "--- 1e, 1f. remote control: skipped (alice was not started with --dry-input; REAL_INPUT=1 runs them with real pointer and key events)"
fi
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
