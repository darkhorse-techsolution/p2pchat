#!/bin/sh
# Screen share to several contacts, against five FRESH dev instances that this script starts and stops
# itself: Alice (CDP 9421) shares, Bob, Cy, Dee and Eve (9422 .. 9425) watch.
#   sh test/ui/cast.sh
#   CAST_NAME=x CAST_PORT=9451 sh test/ui/cast.sh   # instance names xA .. xE, CDP 9451 .. 9455 (default: cast, 9421)
#
# What it needs: a screen that can be captured. What Alice shares is this machine's real display, so the
# display has to be awake and unlocked, and the Electron binary of run.sh needs the Screen Recording
# permission. If the first capture does not start, or a later one, the script says so, stops its instances
# and ends. It takes about 8 minutes and puts five windows on the desktop; two of them go full screen for
# a few seconds.
#
# Safe by default. Every instance starts with --use-fake-device-for-media-stream (a generated tone
# instead of the microphone), --dry-input (remote control can be allowed, but no input helper starts:
# events are counted and dropped) and --clip-fake (the clipboard that control can share is a text in
# memory, never the system clipboard). The script goes on only when every instance says control.dry and
# clip.fake are true, and reads both again right before every click on Allow. It presses no key, reads
# no frame and no recording, sends nothing to the OS and never touches the system clipboard.
#
# What it prints: per step the readings as the app gives them, and for every value that is fixed one line
#   ok    <step> <what>: <value>          or          DIFF  <step> <what>: expected <x>, got <y>
# then how many of each, the ERROR lines each instance logged during the run, and "instances left: 0".
# Frame rates and delays are printed without a verdict: they depend on the machine. So that the screen
# always has something moving, a square is animated in Eve's window for the whole run and her capture
# blocking is off (a still screen gives a capture almost no frames, and the checks that frames keep
# arriving would say nothing). Step 6 switches Alice's blocking off and on again for its own readings.
# The steps:
#    1 the picker: two contacts get one capture      9 a yes nobody asked for
#    2 the microphone is one switch                 10 clipboard text with control, and off for good
#    3 leave, add, stop one, stop all               11 the clipboard needs both switches and the box
#    4 the audience limit                           12 the app's own shortcuts in full screen (state only)
#    5 two, three, four viewers: each encoder       13 the bar above a full-screen viewer
#    6 where viewers can read this window: no names 14 a request that runs out; Deny and its cooldown
#    7 layout with the audience bar                 15 every way control ends; talking back
#    8 control with two viewers: one at a time
#
# Development aid, off unless asked for: CAST_CANVAS=1 puts a drawn picture in place of the screen
# capture, in the page of each instance through CDP, for this run only (the app has no such mode). It is
# for working on this script while no screen can be captured. The main process then knows of no shared
# display and allows no control, so every step that needs a grant is skipped and says so. CAST_CANVAS=2
# runs those steps as well: each Allow then ends in "Nothing is being shared" and their lines read DIFF.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; CDP="$ROOT/test/ui/cdp.js"
NAME=${CAST_NAME:-cast}; PA=${CAST_PORT:-9421}; PB=$((PA + 1)); PC=$((PA + 2)); PD=$((PA + 3)); PE=$((PA + 4))
CANVAS=${CAST_CANVAS:-0}
sleep_py() { python3 -c "import time;time.sleep($1)"; }
A() { node "$CDP" $PA "$1"; }; B() { node "$CDP" $PB "$1"; }; C() { node "$CDP" $PC "$1"; }; D() { node "$CDP" $PD "$1"; }; E() { node "$CDP" $PE "$1"; }
left() { pgrep -f "instance=${NAME}[A-E]" | wc -l | tr -d ' '; }
stop() { for p in $(pgrep -f "instance=${NAME}[A-E]"); do kill "$p" 2>/dev/null; done; }
LOGS="$HOME/Library/Logs/P2P Chat"; lines() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
OKS=0; DIFFS=0
CHECK() { if [ "$2" = "$3" ]; then OKS=$((OKS + 1)); echo "ok    $1: $3"; else DIFFS=$((DIFFS + 1)); echo "DIFF  $1: expected $2, got $3"; fi; }
# the end of every run, also of one that stops early or dies: the counts, the logs, every instance stopped
ENDED=0
finish() {
  [ "$ENDED" = 1 ] && return; ENDED=1
  echo "--- checks: $OKS ok, $DIFFS DIFF"
  for L in A B C D E; do
    F="$LOGS/p2pchat-$NAME$L.log"; [ -f "$F" ] || continue
    eval "N0=\$L0$L"; [ "$(lines "$F")" -lt "${N0:-0}" ] && N0=0   # the app started a new file (it rotates at 2 MB): all of it is this run's
    echo "$NAME$L ERROR lines: $(tail -n +$((${N0:-0} + 1)) "$F" | grep -c ' ERROR ')"
  done
  stop; sleep_py 1.5; [ "$(left)" = 0 ] || sleep_py 2
  echo "instances left: $(left)"
}
trap finish EXIT; trap 'finish; exit 1' INT TERM
stop; sleep_py 1
# A port that answers already belongs to some other instance: every command below would go to that one.
for P in $PA $PB $PC $PD $PE; do
  curl -s -m 2 "http://127.0.0.1:$P/json/version" >/dev/null 2>&1 && { echo "STOP: CDP port $P is in use by another program (an instance left over from an earlier run?): nothing is started"; trap - EXIT; exit 1; }
done
for L in A B C D E; do
  eval "L0$L=\$(lines \"\$LOGS/p2pchat-$NAME$L.log\")"   # the logs outlive a run: count only what this one adds
  rm -rf "$HOME/Library/Application Support/P2P Chat ($NAME$L)" "$HOME/.config/P2P Chat ($NAME$L)" 2>/dev/null
done
X=20; Y=60
for L in A B C D E; do
  eval "P=\$P$L"
  "$ROOT/run.sh" --instance=$NAME$L --remote-debugging-port=$P --x=$X --y=$Y --use-fake-device-for-media-stream --dry-input --clip-fake >/dev/null 2>&1 &
  X=$((X + 200)); Y=$((Y + 40))
done
for P in $PA $PB $PC $PD $PE; do for i in $(seq 1 40); do curl -s "http://127.0.0.1:$P/json/version" >/dev/null 2>&1 && break; sleep_py 0.5; done; done
sleep_py 3

# bash 3.2 (/bin/sh here) mangles nested double quotes inside $(...): probes with braces go in variables
click() { echo "(()=>{document.getElementById('$1').click();return 'clicked $1'})()"; }
CHAT() { echo "(()=>{document.querySelector('.contact[data-pub=\"$1\"]').click();return 'chat opened'})()"; }
SHOWN() { echo "!document.getElementById('$1').classList.contains('hidden')"; }
TEXT() { echo "document.getElementById('$1').textContent"; }
NAMEQ() { echo "(()=>{document.getElementById('firstName').value='$1';document.getElementById('firstGo').click();return 'ok'})()"; }
ADDQ() { echo "(()=>{document.getElementById('btnAdd').click();document.getElementById('addInvite').value='$1';document.getElementById('addGo').click();return 'ok'})()"; }
echo "--- 0. names, invites, and the two safety flags on every instance"
A "$(NAMEQ Alice)" >/dev/null; B "$(NAMEQ Bob)" >/dev/null; C "$(NAMEQ Cy)" >/dev/null; D "$(NAMEQ Dee)" >/dev/null; E "$(NAMEQ Eve)" >/dev/null
sleep_py 0.8
for V in B C D E; do INV=$(A "window.api.invite()"); $V "$(ADDQ "$INV")" >/dev/null; sleep_py 3; done   # an invite is a one-time token: one each
sleep_py 1
PUBA=$(A "window.api.state().then(s=>s.me.pub)"); PUBB=$(B "window.api.state().then(s=>s.me.pub)"); PUBC=$(C "window.api.state().then(s=>s.me.pub)"); PUBD=$(D "window.api.state().then(s=>s.me.pub)"); PUBE=$(E "window.api.state().then(s=>s.me.pub)")
case "$PUBA$PUBB$PUBC$PUBD$PUBE" in *[!A-Za-z0-9_-]*|"") echo "unexpected public key text: stopping"; finish; exit 1;; esac
STQ='window.api.state().then(s=>JSON.stringify({me:s.me.name,contacts:s.contacts.map(c=>c.name+":"+c.status),version:s.version}))'
SAFEQ='window.api.state().then(s=>JSON.stringify({dry:s.control.dry===true,fake:!!s.clip&&s.clip.fake===true}))'
SAFE='{"dry":true,"fake":true}'
for V in A B C D E; do
  echo "$V: $($V "$STQ") $($V "$SAFEQ")"
  [ "$($V "$SAFEQ")" = "$SAFE" ] || { echo "STOP: instance $V does not report control.dry and clip.fake as true: nothing more is done"; finish; exit 1; }
done
CHECK "0 dry input and the fake clipboard on all five" "$SAFE$SAFE$SAFE$SAFE$SAFE" "$(A "$SAFEQ")$(B "$SAFEQ")$(C "$SAFEQ")$(D "$SAFEQ")$(E "$SAFEQ")"
for i in $(seq 1 30); do R="$(A "window.api.state().then(s=>s.relay)") $(B "window.api.state().then(s=>s.relay)") $(C "window.api.state().then(s=>s.relay)") $(D "window.api.state().then(s=>s.relay)") $(E "window.api.state().then(s=>s.relay)")"; [ "$R" = "up up up up up" ] && break; sleep_py 2; done
echo "relay links: $R"
[ "$R" = "up up up up up" ] || { echo "the relay link is not up on every instance (a share would connect slowly and spoil the timed steps): stopping"; finish; exit 1; }
# The only way this script clicks Allow: on Alice, after her main process said control.dry === true and
# she and the asker ($1) said clip.fake === true, read right before the click.
ALLOW() {
  d=$(A "window.api.state().then(s=>s.control.dry===true)"); f="$(A "window.api.state().then(s=>!!s.clip&&s.clip.fake===true)")$($1 "window.api.state().then(s=>!!s.clip&&s.clip.fake===true)")"
  [ "$d$f" = truetruetrue ] || { echo "STOP: control.dry on alice is $d, clip.fake on alice and $1 is $f: Allow is not clicked, nothing more is done"; finish; exit 1; }
  echo "alice: $(A "$ALLOWQ")"
}
ALLOWQ='(()=>{const b=document.getElementById("controlYes"),off=b.disabled;b.click();return "dry and fake confirmed, Allow clicked"+(off?" while it was still disarmed":"")})()'
CANVASQ='(()=>{if(window.__canvas)return "drawn picture in place already";const md=navigator.mediaDevices;window.__canvas={calls:0};md.getDisplayMedia=async()=>{window.__canvas.calls++;const c=document.createElement("canvas");c.width=1920;c.height=1080;const g=c.getContext("2d");let t=0;const draw=()=>{t++;g.fillStyle="#203040";g.fillRect(0,0,1920,1080);g.fillStyle="hsl("+(t*7%360)+",90%,50%)";g.fillRect(700+300*Math.sin(t/7),400+250*Math.cos(t/9),220,220);g.fillStyle="#fff";g.font="48px monospace";g.fillText("frame "+t,60,90)};draw();const id=setInterval(draw,33);const st=c.captureStream(30),tr=st.getVideoTracks()[0],stop=tr.stop.bind(tr);tr.stop=()=>{clearInterval(id);stop()};return st};return "getDisplayMedia gives a drawn picture in this page"})()'
if [ "$CANVAS" != 0 ]; then for V in A B C D E; do echo "CAST_CANVAS on $V: $($V "$CANVASQ")"; done; fi
GRANTS=1; [ "$CANVAS" = 1 ] && GRANTS=0   # no grant exists without a display that main knows as shared
SKIP() { echo "skipped with CAST_CANVAS=1 (needs a control grant, which needs the real capture): $1"; }
TOASTLOG='(()=>{if(window.__toasts)return "logging toasts already";window.__toasts=[];new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>window.__toasts.push(n.textContent)))).observe(document.getElementById("toasts"),{childList:true});return "logging toasts"})()'
TOASTSQ='JSON.stringify(window.__toasts)'
for V in A B C D E; do $V "window.api.setPref('shareMode','one').then(v=>'ok')" >/dev/null; $V "$TOASTLOG" >/dev/null; done
for V in B C D E; do $V "$(CHAT "$PUBA")" >/dev/null; done
ANIM='(()=>{if(window.__anim)return "animating already";const d=document.createElement("div");d.style.cssText="position:fixed;left:0;top:0;width:220px;height:220px;z-index:99999;background:#f00;pointer-events:none";document.body.appendChild(d);window.__anim=true;let t=0;const f=()=>{t++;d.style.transform="translate("+(200+150*Math.sin(t/7))+"px,"+(200+150*Math.cos(t/9))+"px)";d.style.background="hsl("+(t*7%360)+",90%,50%)";requestAnimationFrame(f)};f();return "a square moves in the window"})()'
echo "eve: capture blocking $(E "window.api.protection(false).then(v=>v?'STILL ON':'off for the whole run')"), $(E "$ANIM") (nothing is sent to the OS)"
A "$(CHAT "$PUBB")" >/dev/null; sleep_py 0.5
LOGA="$LOGS/p2pchat-${NAME}A.log"; dm() { grep -c 'display media' "$LOGA"; }
# the audience as the sharer has it, on one line
CASTQ='window.api.state().then(s=>JSON.stringify((()=>{const d=window.Share.debugAll(),bar=document.getElementById("castBar");return {sessions:Object.keys(d.sessions).length,capture:d.capture,mic:d.mic,members:Object.values(d.cast.members),control:d.control,bar:bar.classList.contains("hidden")?null:document.getElementById("castBarText").textContent,pill:document.getElementById("sharePill").classList.contains("hidden")?null:document.getElementById("sharePill").textContent,btn:document.getElementById("btnShare").textContent.trim(),live:[...document.querySelectorAll(".contact .live")].map(e=>e.textContent),mainControlOn:s.control.on}})()))'
CAPQ='JSON.stringify(window.Share.debugAll().capture)'
MEMQ='JSON.stringify(Object.values(window.Share.debugAll().cast.members).sort())'
PILLQ='(()=>{const p=document.getElementById("sharePill");return p.classList.contains("hidden")?null:p.textContent})()'
BTNQ='document.getElementById("btnShare").textContent.trim()'
BARQ='(()=>{const b=document.getElementById("castBar");return b.classList.contains("hidden")?null:document.getElementById("castBarText").textContent})()'
FRAMESQ='(()=>{const d=window.Share.debug();return d&&d.in?d.in.frames:null})()'
VIEWQ='JSON.stringify((()=>{const d=window.Share.debug();return d?{conn:d.conn,in:d.in,remote:{screen:d.remote.screen,mic:d.remote.mic},aud:document.getElementById("viewerAud").textContent,viewerShown:!document.getElementById("viewer").classList.contains("hidden"),audioEls:document.querySelectorAll("#shareAudio audio").length,take:d.ctl.take,asked:d.ctl.asked}:{session:null,viewerShown:!document.getElementById("viewer").classList.contains("hidden")}})())'
# frames decoded on instance $1 must grow over $2 seconds (two reads; the poll behind the number runs every 2 s)
GROWS() { a=$($1 "$FRAMESQ"); sleep_py "$2"; b=$($1 "$FRAMESQ"); if [ "$b" -gt "$a" ] 2>/dev/null; then OKS=$((OKS + 1)); echo "ok    $3: $a -> $b in $2 s"; else DIFFS=$((DIFFS + 1)); echo "DIFF  $3: frames decoded did not grow in $2 s ($a -> $b)"; fi; }
# ticks exactly the contacts given in the open picker and reads it back
PICK() { echo "(()=>{const want=[$1];document.querySelectorAll('#castList input').forEach(i=>{const on=want.includes(i.dataset.pub);if(i.checked!==on&&!i.disabled)i.click()});return JSON.stringify({rows:[...document.querySelectorAll('#castList label')].map(l=>l.textContent.trim()+(l.querySelector('input').checked?' [x]':' [ ]')+(l.querySelector('input').disabled?' (locked)':'')),count:document.getElementById('castCount').textContent,go:document.getElementById('castGo').textContent+(document.getElementById('castGo').disabled?' (disabled)':''),hint:document.getElementById('castHint').textContent})})()"; }
# Alice's screen goes to exactly these contacts, through the picker as a person sets it
AUDIENCE() {
  if [ "$(A "$(SHOWN castBar)")" = true ]; then A "$(click castBarManage)" >/dev/null; else A "(()=>{document.getElementById('btnShareMode').click();document.getElementById('shareCastOpen').click();return 'menu, Several contacts'})()" >/dev/null; fi
  sleep_py 0.4; A "$(PICK "$1")" >/dev/null; A "$(click castGo)" >/dev/null; sleep_py "${2:-7}"
}
# a share that should run and does not: the screen went away under the script (asleep, locked), or it never could be captured
NEED_CAPTURE() {
  [ "$(A 'window.Share.debugAll().capture.state')" = live ] && return 0
  echo "STOP: alice's capture is not running ($1). The screen cannot be captured right now: is the display asleep or locked, or the Screen Recording permission missing? alice's toasts: $(A "$TOASTSQ")"
  finish; exit 2
}

echo "--- 1. the picker: Bob and Cy get one capture"
echo "idle: $(A "$CASTQ")"
D0=$(dm)
A "(()=>{document.getElementById('btnShareMode').click();document.getElementById('shareCastOpen').click();return 'menu, Several contacts'})()" >/dev/null; sleep_py 0.5
echo "picker as it opens (chat with Bob open): $(A "$(PICK "'$PUBB'")")"
echo "picker with both ticked: $(A "$(PICK "'$PUBB','$PUBC'")")"
A "$(click castGo)" >/dev/null; sleep_py 7
NEED_CAPTURE "after the first Start sharing"
echo "alice: $(A "$CASTQ")"
CHECK "1 one capture, two leases" '{"state":"live","leases":2}' "$(A "$CAPQ")"
CHECK "1 both are live members" '["live","live"]' "$(A "$MEMQ")"
if [ "$CANVAS" = 0 ]; then CHECK "1 one 'display media' line in alice's log" 1 "$(( $(dm) - D0 ))"; else echo "getDisplayMedia calls in alice's page (CAST_CANVAS): $(A 'window.__canvas.calls')"; fi
CHECK "1 the bar names both" "Sharing your screen with Bob and Cy" "$(A "$BARQ")"
CHECK "1 both contact rows are marked" '["● sharing","● sharing"]' "$(A 'JSON.stringify([...document.querySelectorAll(".contact .live")].map(e=>e.textContent))')"
CHECK "1 the pill in bob's chat" "Sharing · 2 viewers" "$(A "$PILLQ")"
echo "bob: $(B "$VIEWQ")"; echo "cy:  $(C "$VIEWQ")"
GROWS B 5 "1 bob's frames grow"; GROWS C 5 "1 cy's frames grow"
CHECK "1 bob is told how many watch" " · 2 watching" "$(B "$(TEXT viewerAud)")"
CHECK "1 bob has video and sound" '{"video":true,"audio":true,"cast":2}' "$(B '(()=>{const i=window.Share.debug().in;return JSON.stringify({video:i.video,audio:i.audio,cast:i.cast})})()')"

echo "--- 2. the microphone is one switch for everyone who gets the screen"
MICQ=$(printf %s 'JSON.stringify({bob:window.Share.debug("@B@").local.mic,cy:window.Share.debug("@C@").local.mic,audienceOn:window.Share.debugAll().mic.audienceOn,leases:window.Share.debugAll().mic.leases})' | sed "s/@B@/$PUBB/; s/@C@/$PUBC/")
A "$(click btnMic)" >/dev/null; sleep_py 1.2
CHECK "2 one click in bob's chat mutes it for both" '{"bob":false,"cy":false,"audienceOn":false,"leases":2}' "$(A "$MICQ")"
echo "bob sees: $(B 'JSON.stringify(window.Share.debug().remote)')  cy sees: $(C 'JSON.stringify(window.Share.debug().remote)')  alice toasts: $(A "$TOASTSQ")"
A "$(click btnMic)" >/dev/null; sleep_py 1.2
CHECK "2 a second click brings it back for both" '{"bob":true,"cy":true,"audienceOn":true,"leases":2}' "$(A "$MICQ")"

echo "--- 3. cy leaves, is added again with one click, bob is stopped alone, then everyone"
C "$(click viewerEnd)" >/dev/null; sleep_py 2
CHECK "3 after cy's End only bob is left" '["live"]' "$(A "$MEMQ")"
CHECK "3 the capture goes on with one lease" '{"state":"live","leases":1}' "$(A "$CAPQ")"
GROWS B 4 "3 bob's frames still grow"
A "$(CHAT "$PUBC")" >/dev/null; sleep_py 0.6
CHECK "3 the button in cy's chat" "＋ Add to share" "$(A "$BTNQ")"
A "$(click btnShare)" >/dev/null; sleep_py 6
CHECK "3 added: two leases again" '{"state":"live","leases":2}' "$(A "$CAPQ")"
if [ "$CANVAS" = 0 ]; then CHECK "3 still one 'display media' line for this capture" 1 "$(( $(dm) - D0 ))"; else echo "getDisplayMedia calls in alice's page (CAST_CANVAS): $(A 'window.__canvas.calls')"; fi
A "$(CHAT "$PUBB")" >/dev/null; sleep_py 0.6
CHECK "3 the button in bob's chat" "■ Stop sharing" "$(A "$BTNQ")"
A "$(click btnShare)" >/dev/null; sleep_py 2.5
CHECK "3 stopped for bob: he has no share left" false "$(B 'window.Share.active()')"
CHECK "3 cy still watches" true "$(C "$(SHOWN viewer)")"
echo "alice: $(A "$CASTQ")"
A "$(click castBarStop)" >/dev/null; sleep_py 2.5
CHECK "3 Stop sharing in the bar: the capture is off" '{"state":"idle","leases":0}' "$(A "$CAPQ")"
CHECK "3 nobody has a share left" "false false false" "$(A 'window.Share.active()') $(B 'window.Share.active()') $(C 'window.Share.active()')"
CHECK "3 main has no control on" false "$(A 'window.api.state().then(s=>s.control.on)')"

echo "--- 4. the audience limit, set to 1 in alice's page for this step"
A "(()=>{window.ShareKit.tune.MAX_AUDIENCE=1;return 'MAX_AUDIENCE=1'})()" >/dev/null
A "$(click btnShare)" >/dev/null; sleep_py 6; NEED_CAPTURE "step 4"
A "$(CHAT "$PUBC")" >/dev/null; sleep_py 0.6
T0=$(A 'window.__toasts.length'); A "$(click btnShare)" >/dev/null; sleep_py 2
CHECK "4 a second contact is not added" '{"sessions":1,"members":1}' "$(A 'JSON.stringify({sessions:Object.keys(window.Share.debugAll().sessions).length,members:Object.keys(window.Share.debugAll().cast.members).length})')"
echo "alice is told: $(A "JSON.stringify(window.__toasts.slice($T0))")  cy has a share: $(C 'window.Share.active()')"
A "(()=>{window.ShareKit.tune.MAX_AUDIENCE=4;window.ShareKit.cast.stop('user');return 'limit back at 4, stopped'})()" >/dev/null; sleep_py 2.5

echo "--- 5. two, three and four viewers: what each viewer's encoder is given, and what it gives"
SHQ='JSON.stringify(window.ShareKit.sessions.all().filter(x=>x.screenSender).map(x=>{const e=x.screenSender.getParameters().encodings[0],q=x.q||{};return {to:window.ShareKit.nameOf(x.pub),cap:e.maxBitrate/1e6+"M/"+e.maxFramerate+("scaleResolutionDownBy" in e?"/x"+Math.round(e.scaleResolutionDownBy*1000)/1000:""),inFps:Math.round(q.inFps||0),encFps:Math.round(q.encFps||0),encMs:q.encMs,skip:q.skip,limit:q.limit,out:(q.outW||0)+"x"+(q.outH||0)}}))'
CAPSQ='JSON.stringify(window.ShareKit.sessions.all().filter(x=>x.screenSender).map(x=>{const e=x.screenSender.getParameters().encodings[0];return e.maxBitrate/1e6+"M/"+e.maxFramerate}))'
VQ='JSON.stringify((()=>{const d=window.Share.debug(),q=d&&d.q;return q?{conn:d.conn,watching:d.in.cast,rxIn2s:q.rx,shownIn2s:q.out,drop:q.drop,freeze:q.freeze,bufMs:q.bufMs,decMs:q.decMs,shownMs:q.shownMs,e2eMs:q.e2eMs}:{conn:d&&d.conn,q:null}})())'
READ() { # $1: label, then the viewers to read
  T=$1; shift; sleep_py 12
  echo "$T sharer, per viewer: $(A "$SHQ")"
  for V in "$@"; do echo "$T viewer $V: $($V "$VQ")"; done
}
A "$(CHAT "$PUBB")" >/dev/null; sleep_py 0.5
AUDIENCE "'$PUBB','$PUBC'"; NEED_CAPTURE "step 5"
CHECK "5 two viewers: the one-to-one values each" '["8M/30","8M/30"]' "$(A "$CAPSQ")"
READ "2 viewers:" B C
AUDIENCE "'$PUBB','$PUBC','$PUBD'"
CHECK "5 three viewers" '["5M/20","5M/20","5M/20"]' "$(A "$CAPSQ")"
READ "3 viewers:" B C D
AUDIENCE "'$PUBB','$PUBC','$PUBD','$PUBE'"
CHECK "5 four viewers" '["4M/15","4M/15","4M/15","4M/15"]' "$(A "$CAPSQ")"
READ "4 viewers:" B C D E
CHECK "5 four members, one capture" '{"state":"live","leases":4}' "$(A "$CAPQ")"
CHECK "5 dee is told how many watch" " · 4 watching" "$(D "$(TEXT viewerAud)")"
CANCELQ='(()=>{document.querySelector("#mCast [data-close]").click();return "picker closed"})()'
A "$(click castBarManage)" >/dev/null; sleep_py 0.4
echo "picker at four: $(A "$(PICK "'$PUBB','$PUBC','$PUBD','$PUBE'")")"
CHECK "5 the picker counts, and warns of nothing while this window is hidden from captures" "4 of 4 / " "$(A "$(TEXT castCount)") / $(A "$(TEXT castHint)")"
A "$CANCELQ" >/dev/null

echo "--- 6. where viewers can read this window (alice's capture blocking off for this step) nothing names a contact"
echo "alice: capture blocking $(A "window.api.protection(false).then(v=>v?'STILL ON':'off')")"; sleep_py 0.8
A "$(click castBarManage)" >/dev/null; sleep_py 0.4
CHECK "6 the picker says so" "This window is not hidden from screen capture here: viewers also see this list and your chats." "$(A "$(TEXT castHint)")"
A "$CANCELQ" >/dev/null
CHECK "6 the bar counts, it does not name" "Sharing your screen with 4 contacts" "$(A "$BARQ")"
CHECK "6 no contact row is marked" 0 "$(A 'document.querySelectorAll(".contact .live").length')"
echo "alice: capture blocking $(A "window.api.protection(true).then(v=>v?'on again':'STILL OFF')")"; sleep_py 0.8
CHECK "6 with blocking on again the bar names them" "Sharing your screen with Bob, Cy, Dee and Eve" "$(A "$BARQ")"
AUDIENCE "'$PUBB','$PUBC'" 4
CHECK "5 back at two viewers: the one-to-one values again" '["8M/30","8M/30"]' "$(A "$CAPSQ")"
CHECK "5 dee and eve have no share left" "false false" "$(D 'window.Share.active()') $(E 'window.Share.active()')"

echo "--- 7. layout with the audience bar, at 1080x740 and at 500x700"
LAYQ='JSON.stringify((()=>{const r=(id)=>document.getElementById(id).getBoundingClientRect(),head=document.querySelector(".chat-head").getBoundingClientRect();return {scrollTop:document.documentElement.scrollTop,composerInside:r("composer").bottom<=innerHeight,barMeetsHead:Math.abs(r("castBar").bottom-head.top)<0.01,buttonsInside:[...document.getElementById("castBar").querySelectorAll("button")].filter(b=>!b.classList.contains("hidden")).every(b=>b.getBoundingClientRect().right<=innerWidth)}})())'
for SZ in "1080 740" "500 700"; do
  set -- $SZ
  A "window.api.devResize($1,$2).then(b=>'resized')" >/dev/null; sleep_py 0.8
  A "$(CHAT "$PUBB")" >/dev/null; sleep_py 0.5
  CHECK "7 ${1}x$2" '{"scrollTop":0,"composerInside":true,"barMeetsHead":true,"buttonsInside":true}' "$(A "$LAYQ")"
done
A "window.api.devResize(1080,740).then(b=>'size back')" >/dev/null; sleep_py 0.6

echo "--- 8. control with two viewers: one dialog, one controller"
EVQ='window.api.state().then(s=>JSON.stringify({on:s.control.on,pub:s.control.pub?s.control.pub.slice(0,8):null,dry:s.control.dry,events:s.control.events,refused:s.control.refused}))'
CTLALL='JSON.stringify(window.Share.debugAll().control)'
P8B=$(printf %.8s "$PUBB")
# what the dialog shows 100 ms, 300 ms and 1 s after it opens, sampled inside alice's page
SAMPLE='(()=>{window.__dlg=(async()=>{const d=document.getElementById("mControl"),y=document.getElementById("controlYes"),t0=performance.now();while(d.classList.contains("hidden")&&performance.now()-t0<9000)await new Promise(r=>setTimeout(r,4));if(d.classList.contains("hidden"))return "the dialog did not open in 9 s";const o=performance.now(),at=(ms)=>new Promise(r=>setTimeout(r,Math.max(0,ms-(performance.now()-o))));await at(100);const a=document.activeElement?document.activeElement.id:null;await at(300);const d3=y.disabled;await at(1000);const k=/key (\S+)\)/.exec(document.getElementById("controlWho").textContent);return JSON.stringify({name:document.getElementById("controlName").textContent,keyChars:k?k[1].length:0,focusAt100ms:a,allowDisabledAt300ms:d3,allowDisabledAt1s:y.disabled})})();return "watching for the dialog"})()'
A "$SAMPLE" >/dev/null; B "$(click viewerCtl)" >/dev/null; sleep_py 2.5
CHECK "8 the dialog: who asks, the key, Deny has the keyboard, Allow armed late" '{"name":"Bob","keyChars":8,"focusAt100ms":"controlNo","allowDisabledAt300ms":true,"allowDisabledAt1s":false}' "$(A 'window.__dlg')"
echo "who: $(A "$(TEXT controlWho)")"
CHECK "8 the request is bob's" "{\"owner\":null,\"pending\":\"$P8B\",\"taking\":null}" "$(A "$CTLALL")"
C "$(click viewerCtl)" >/dev/null; sleep_py 0.9
CHECK "8 cy asks meanwhile: answered at once, no second dialog" 'false Bob' "$(C 'window.Share.debug().ctl.asked') $(A "$(TEXT controlName)")"
echo "cy is told: $(C "$TOASTSQ")"
if [ "$GRANTS" = 1 ]; then
  ALLOW B; sleep_py 1.2
  CHECK "8 bob owns control" "{\"owner\":\"$P8B\",\"pending\":null,\"taking\":null}" "$(A "$CTLALL")"
  CHECK "8 main: on, bob, dry" "{\"on\":true,\"pub\":\"$P8B\",\"dry\":true}" "$(A 'window.api.state().then(s=>JSON.stringify({on:s.control.on,pub:s.control.pub?s.control.pub.slice(0,8):null,dry:s.control.dry}))')"
  A "$(CHAT "$PUBC")" >/dev/null; sleep_py 0.6
  CHECK "8 in cy's chat the button says who controls" "✋ Stop control (Bob)" "$(A "$(TEXT btnStopCtl)")"
  echo "alice's bar: $(A "$BARQ")  per viewer: $(A "$CAPSQ")"
  # what main counted since the last call: events that reached the (dry) helper, events it refused
  COUNTED() { n=$(A 'window.api.state().then(s=>s.control.events+" "+s.control.refused)'); set -- $n; echo "$(( $1 - ${EV0:-0} )) $(( $2 - ${RF0:-0} ))"; EV0=$1; RF0=$2; }
  COUNTED >/dev/null
  B "(()=>'inject returned '+window.Share.inject({t:'m',x:0.5,y:0.5}))()" >/dev/null; sleep_py 0.6
  CHECK "8 a move from bob is counted (and dropped: dry)" "1 0" "$(COUNTED)"; COUNTED >/dev/null
  C "(()=>{const K=window.ShareKit;return 'sent '+K.sessions.dc(K.sessions.all()[0],'ctl',{t:'m',x:0.4,y:0.4})})()" >/dev/null; sleep_py 0.6
  CHECK "8 a move from cy, who does not control, is not" "0 0" "$(COUNTED)"; COUNTED >/dev/null
  A "(()=>{window.api.input('wrong',{t:'r'});return 'input with a wrong token'})()" >/dev/null; sleep_py 0.5
  CHECK "8 input with a wrong token is refused by main" "0 1" "$(COUNTED)"
  A "$(click btnStopCtl)" >/dev/null; sleep_py 1.2
  CHECK "8 Stop control from cy's chat" "false {\"owner\":null,\"pending\":null,\"taking\":null} false" "$(B 'window.Share.debug().ctl.take') $(A "$CTLALL") $(A 'window.api.state().then(s=>s.control.on)')"
  A "$(CHAT "$PUBB")" >/dev/null; sleep_py 0.5
else
  SKIP "Allow, who owns control, input with and without the token, Stop control"
  A "$(click controlNo)" >/dev/null; sleep_py 10.6   # Deny, and its cooldown, so that the next steps find bob free to ask
fi

echo "--- 9. a yes nobody asked for starts nothing"
R0=$(A "window.Share.debug('$PUBB').ctl.recv")
A "(()=>{const K=window.ShareKit;return 'sent '+K.sessions.dc(K.sessions.get('$PUBB'),'ctl',{t:'ctl',on:true})})()" >/dev/null; sleep_py 1
CHECK "9 bob does not start controlling" 'false false' "$(B 'window.Share.debug().ctl.take') $(B 'document.getElementById("viewerVideo").classList.contains("ctl")')"
CHECK "9 bob answers with a release" 1 "$(( $(A "window.Share.debug('$PUBB').ctl.recv") - R0 ))"

echo "--- 10. clipboard text with control (the fake clipboards), and off for good"
GET='window.api.devClip("get")'
SET() { echo "window.api.devClip('set',$1).then(()=>'set')"; }
CLIPALL='JSON.stringify(window.Share.debugAll().clip)'
CLIPON='(()=>{const c=window.Share.debugAll().clip;return c?c.on:null})()'
FIELD() { echo "(()=>{const c=window.Share.debugAll().clip;return c?c.$1:null})()"; }
MAINON='window.api.state().then(s=>s.clip.on)'
TAKE="window.ShareKit.sessions.get('$PUBA').ctl.take"
ASK() { B "$(click viewerCtl)" >/dev/null; sleep_py 1.5; }
SWITCH() { echo "window.api.setPref('clipboardSync',$1).then(v=>{S.settings.clipboardSync=v;window.Share.onSettings();return 'clipboardSync='+v})"; }
A "$(SET "'before'")" >/dev/null; C "$(SET "'cy text'")" >/dev/null
ASK
CHECK "10 the dialog offers the clipboard, ticked" 'true true' "$(A "$(SHOWN controlClipRow)") $(A 'document.getElementById("controlClip").checked')"
CHECK "10 the Allow button says what it allows" "Allow control and clipboard" "$(A "$(TEXT controlYes)")"
if [ "$GRANTS" = 1 ]; then
  ALLOW B; sleep_py 1.5
  CHECK "10 the link is on, on both sides and in both main processes" 'true true true true' "$(A "$CLIPON") $(B "$CLIPON") $(A "$MAINON") $(B "$MAINON")"
  CHECK "10 alice's pill" "Sharing · controlled · 2 viewers · clipboard" "$(A "$PILLQ")"
  CHECK "10 both see the 📋 button" 'true true' "$(A "$(SHOWN btnClip)") $(B "$(SHOWN viewerClip)")"
  sleep_py 1.5
  CHECK "10 what alice had before is not sent" false "$(B "$GET.then(t=>t==='before')")"
  A "$(SET "'alpha'")" >/dev/null; sleep_py 1.5
  CHECK "10 alice copies: bob has it" "alpha 1 1" "$(B "$GET") $(A "$(FIELD tx)") $(B "$(FIELD rx)")"
  sleep_py 3; CHECK "10 it is not sent back" 0 "$(B "$(FIELD tx)")"
  B "$(SET "'beta'")" >/dev/null; sleep_py 1.5
  CHECK "10 bob copies: nothing moves until he is back at the shared screen" alpha "$(A "$GET")"
  B "(()=>{window.ShareKit.clip.poke();return 'poked, as the pointer entering the video does'})()" >/dev/null; sleep_py 1.5
  CHECK "10 then alice has it" beta "$(A "$GET")"
  A "window.api.devClip('set','x'.repeat(70000)).then(()=>'set')" >/dev/null; sleep_py 1.5
  CHECK "10 70000 characters are not sent" "beta 1" "$(B "$GET") $(A "$(FIELD skipped)")"
  A "window.api.devClip('set','a'+String.fromCharCode(0)+'b').then(()=>'set')" >/dev/null; sleep_py 1.5
  CHECK "10 a text with a NUL is not sent" 2 "$(A "$(FIELD skipped)")"
  CHECK "10 cy, who only watches, has no link and his own text" 'null cy text false' "$(C "$CLIPALL") $(C "$GET") $(C "$MAINON")"
  A "$(click btnClip)" >/dev/null; sleep_py 1.2
  CHECK "10 the 📋 button: the link is off on both sides, control stays" 'null null true false' "$(A "$CLIPALL") $(B "$CLIPALL") $(B "$TAKE") $(A "$MAINON")"
  A "$(SET "'gamma'")" >/dev/null; sleep_py 2
  CHECK "10 nothing is sent after that" beta "$(B "$GET")"
  A "$(SWITCH false)" >/dev/null; sleep_py 0.5; A "$(SWITCH true)" >/dev/null; sleep_py 1
  CHECK "10 the Settings switch off and on does not bring it back" null "$(A "$CLIPALL")"
  A "$(click btnStopCtl)" >/dev/null; sleep_py 1.2
  ASK; ALLOW B; sleep_py 1.5
  CHECK "10 a new request allowed with the box: on again" 'true true' "$(A "$CLIPON") $(B "$CLIPON")"
  A "$(click btnStopCtl)" >/dev/null; sleep_py 1.2
  CHECK "10 Stop control ends the link with it" 'false false false' "$(A "$MAINON") $(B "$MAINON") $(A 'window.api.state().then(s=>s.control.on)')"
else
  SKIP "the link itself: what is sent, what is not, the 📋 button, the switch"
  A "$(click controlNo)" >/dev/null; sleep_py 10.6
fi

echo "--- 11. the clipboard needs both Settings switches and the box"
B "$(SWITCH false)" >/dev/null; sleep_py 0.5
ASK
CHECK "11 bob's switch off: no clipboard row, a note instead" 'false true' "$(A "$(SHOWN controlClipRow)") $(A "$(SHOWN controlClipNote)")"
echo "note: $(A "$(TEXT controlClipNote)")"
if [ "$GRANTS" = 1 ]; then
  ALLOW B; sleep_py 1.5
  CHECK "11 control without a link" 'true null null false false' "$(B "$TAKE") $(A "$CLIPALL") $(B "$CLIPALL") $(A "$MAINON") $(B "$MAINON")"
  A "$(click btnStopCtl)" >/dev/null; sleep_py 1.2
else A "$(click controlNo)" >/dev/null; sleep_py 10.6; fi
B "$(SWITCH true)" >/dev/null; A "$(SWITCH false)" >/dev/null; sleep_py 0.5
ASK
CHECK "11 alice's switch off: the note names her Settings" 'false true' "$(A "$(SHOWN controlClipRow)") $(A '/switched off in your Settings/.test(document.getElementById("controlClipNote").textContent)')"
if [ "$GRANTS" = 1 ]; then
  ALLOW B; sleep_py 1.5
  CHECK "11 control without a link" 'true null null' "$(B "$TAKE") $(A "$CLIPALL") $(B "$CLIPALL")"
  A "$(click btnStopCtl)" >/dev/null; sleep_py 1.2
else A "$(click controlNo)" >/dev/null; sleep_py 10.6; fi
A "$(SWITCH true)" >/dev/null; sleep_py 0.5
ASK
A '(()=>{document.getElementById("controlClip").click();return "unticked"})()' >/dev/null
CHECK "11 the box unticked: the Allow button" "Allow control" "$(A "$(TEXT controlYes)")"
if [ "$GRANTS" = 1 ]; then
  ALLOW B; sleep_py 1.5
  CHECK "11 control without a link" 'true null null' "$(B "$TAKE") $(A "$CLIPALL") $(B "$CLIPALL")"
  A "$(click btnStopCtl)" >/dev/null; sleep_py 1.2
else SKIP "what each Allow of this step leaves: control on, no link"; A "$(click controlNo)" >/dev/null; sleep_py 10.6; fi

echo "--- 12. the app's own shortcuts in full screen while controlling: the state only, no key is pressed"
KQ='window.api.state().then(s=>JSON.stringify({keysRemote:s.keysRemote,keysWanted:window.Share.debugAll().keysWanted,hotkeyOk:s.hotkeyOk}))'
ONQ='{"keysRemote":true,"keysWanted":true,"hotkeyOk":true}'; OFFQ='{"keysRemote":false,"keysWanted":false,"hotkeyOk":true}'
FULL() { $1 "$(click viewerFull)" >/dev/null; sleep_py 1.6; }
if [ "$GRANTS" = 1 ]; then
  GRANT() { ASK; ALLOW B; sleep_py 1.5; }
  GRANT; CHECK "12 control without full screen" "true $OFFQ" "$(B "$TAKE") $(B "$KQ")"
  FULL B; CHECK "12 full screen while controlling" "$ONQ" "$(B "$KQ")"
  B "$(click viewerCtl)" >/dev/null; sleep_py 1.2; CHECK "12 bob lets go of control" "$OFFQ" "$(B "$KQ")"
  GRANT; CHECK "12 granted again in full screen" "$ONQ" "$(B "$KQ")"
  FULL B; CHECK "12 bob leaves full screen" "$OFFQ" "$(B "$KQ")"
  FULL B; CHECK "12 back in full screen" "$ONQ" "$(B "$KQ")"
  A "$(click btnStopCtl)" >/dev/null; sleep_py 1.2; CHECK "12 alice stops control" "$OFFQ" "$(B "$KQ")"
  GRANT; CHECK "12 granted once more" "$ONQ" "$(B "$KQ")"
  B "window.api.hide().then(()=>'hidden')" >/dev/null; sleep_py 1.5; CHECK "12 bob's window is hidden (it stays hidden from here on)" "$OFFQ" "$(B "$KQ")"
  A "$(click btnStopCtl)" >/dev/null; sleep_py 1.2
else
  FULL B; CHECK "12 full screen without control: the keys stay here" "$OFFQ" "$(B "$KQ")"; FULL B
  SKIP "the switch going on, and each of the four ways it goes off"
fi

echo "--- 13. the bar above a full-screen viewer: bob controls alice's screen while she watches cy's"
AUDIENCE "'$PUBB'" 3
C "$(click btnShare)" >/dev/null; sleep_py 6
A "$(CHAT "$PUBC")" >/dev/null; sleep_py 0.6
CHECK "13 alice watches cy and shares to bob: a bar, since bob's chat is not the open one" "Sharing your screen with Bob" "$(A "$BARQ")"
ZQ='window.api.state().then(s=>JSON.stringify((()=>{const bar=document.getElementById("castBar"),cs=getComputedStyle(bar);return {fullscreen:s.windowFlags.fullscreen,barClass:bar.className,zIndex:cs.zIndex,position:cs.position,stop:document.getElementById("castBarStopCtl").classList.contains("hidden")?null:document.getElementById("castBarStopCtl").textContent}})()))'
if [ "$GRANTS" = 1 ]; then
  ASK; ALLOW B; sleep_py 1.2
  FULL A
  CHECK "13 in full screen the bar is on top, with Stop control" '{"fullscreen":true,"barClass":"cast-bar ctl","zIndex":"61","position":"fixed","stop":"✋ Stop control"}' "$(A "$ZQ")"
  A "$(click castBarStopCtl)" >/dev/null; sleep_py 1
  CHECK "13 Stop control in the bar" 'false false' "$(A 'window.api.state().then(s=>s.control.on)') $(B "$TAKE")"
  FULL A
else
  FULL A; echo "in full screen, nobody controls: $(A "$ZQ")"; FULL A
  SKIP "the bar above the full-screen viewer while someone controls"
fi
CHECK "13 out of full screen again" false "$(A 'window.api.state().then(s=>s.windowFlags.fullscreen)')"
C "$(click btnShare)" >/dev/null; sleep_py 2
A "$(CHAT "$PUBB")" >/dev/null; sleep_py 0.5
AUDIENCE "'$PUBB','$PUBC'"; NEED_CAPTURE "step 13"

echo "--- 14. a request that runs out; Deny and its cooldown (this step waits about a minute)"
T0=$(B 'window.__toasts.length')
ASK
CHECK "14 asked: the dialog is open" true "$(A "$(SHOWN mControl)")"
sleep_py 40
CHECK "14 41 s later it has closed by itself" 'false null false' "$(A "$(SHOWN mControl)") $(A 'JSON.stringify(window.Share.debugAll().control.pending)') $(B 'window.Share.debug().ctl.asked')"
sleep_py 6
CHECK "14 bob got one answer, also past his own 45 s" '["Alice did not answer"]' "$(B "JSON.stringify(window.__toasts.slice($T0))")"
ASK
CHECK "14 a request that ran out starts no cooldown: the dialog opens" true "$(A "$(SHOWN mControl)")"
A "$(click controlNo)" >/dev/null; TD=$(python3 -c "import time;print(time.time())"); sleep_py 1
B "$(click viewerCtl)" >/dev/null; sleep_py 1.2
CHECK "14 after Deny, asked again inside 10 s: no dialog, and bob is answered" 'false false' "$(A "$(SHOWN mControl)") $(B 'window.Share.debug().ctl.asked')"
C "$(click viewerCtl)" >/dev/null; sleep_py 1.2
CHECK "14 the cooldown is bob's alone: cy's request opens the dialog" 'true Cy' "$(A "$(SHOWN mControl)") $(A "$(TEXT controlName)")"
A "$(click controlNo)" >/dev/null; sleep_py 0.6
sleep_py "$(python3 -c "import time;print(max(0, 10.6 - (time.time() - $TD)))")"
ASK
CHECK "14 after 10 s bob's request opens it again" 'true Bob' "$(A "$(SHOWN mControl)") $(A "$(TEXT controlName)")"
A "$(click controlNo)" >/dev/null; sleep_py 10.6

echo "--- 15. every way control ends, each from a fresh grant; and bob talks back"
ENDQ='window.api.state().then(s=>JSON.stringify({owner:window.Share.debugAll().control.owner,on:s.control.on,pub:s.control.pub,clip:s.clip.on}))'
ENDED='{"owner":null,"on":false,"pub":null,"clip":false}'
B "$(click viewerTalk)" >/dev/null; sleep_py 3
AUDA=$(printf %s '(async()=>{const a=await window.Share.audio("@B@");await new Promise(r=>setTimeout(r,1000));const b=await window.Share.audio("@B@");return JSON.stringify({audioElements:document.querySelectorAll("#shareAudio audio").length,packetsFromBobGrow:!!(a&&b&&a.in&&b.in&&b.in.packets>a.in.packets)})})()' | sed "s/@B@/$PUBB/g")
CHECK "15 bob talks back: alice hears him, in one audio element" '{"audioElements":1,"packetsFromBobGrow":true}' "$(A "$AUDA")"
CHECK "15 cy hears nothing new" 1 "$(C 'document.querySelectorAll("#shareAudio audio").length')"
B "$(click viewerTalk)" >/dev/null; sleep_py 1
if [ "$GRANTS" = 1 ]; then
  FRESH() { ASK; ALLOW B; sleep_py 1.5; CHECK "15 a fresh grant with its clipboard link, before $1" true "$(A 'window.api.state().then(s=>s.control.on&&s.clip.on)')"; }
  FRESH "bob's End"; B "$(click viewerEnd)" >/dev/null; sleep_py 1.5
  CHECK "15 bob clicks End" "$ENDED" "$(A "$ENDQ")"; GROWS C 4 "15 cy still watches"
  AUDIENCE "'$PUBB','$PUBC'"
  FRESH "Stop sharing in bob's chat"; A "$(click btnShare)" >/dev/null; sleep_py 1.5
  CHECK "15 alice stops sharing with bob" "$ENDED" "$(A "$ENDQ")"; GROWS C 4 "15 cy still watches"
  AUDIENCE "'$PUBB','$PUBC'"
  FRESH "Stop sharing in the bar"; A "$(click castBarStop)" >/dev/null; sleep_py 2
  CHECK "15 alice stops sharing with everyone" "$ENDED" "$(A "$ENDQ")"
  B "(()=>{if(window.Share.active())window.Share.end();return 'bob ends what is left of his session (his microphone)'})()" >/dev/null; sleep_py 1.5
  A "(()=>{document.getElementById('btnShareMode').click();document.getElementById('shareCastOpen').click();return 'menu'})()" >/dev/null; sleep_py 0.4; A "$(PICK "'$PUBB','$PUBC'")" >/dev/null; A "$(click castGo)" >/dev/null; sleep_py 7; NEED_CAPTURE "step 15"
  FRESH "bob quits"
else
  SKIP "End, Stop sharing in the chat and in the bar, each from a fresh grant with its clipboard link"
fi
B "window.api.quit().then(()=>'quit asked')" >/dev/null 2>&1; sleep_py 3.5
CHECK "15 bob's app quits" "$ENDED" "$(A "$ENDQ")"; GROWS C 4 "15 cy still watches"
CHECK "15 bob is out of the audience or waited for" true "$(A '(()=>{const m=Object.values(window.Share.debugAll().cast.members).sort().join();return m==="live"||m==="away,live"})()')"
echo "alice: $(A "$CASTQ")"
A "$(click castBarStop)" >/dev/null; sleep_py 2.5
CHECK "15 the end: no session, no capture, no control" '{"sessions":0,"capture":"idle","control":false,"clip":false}' "$(A 'window.api.state().then(s=>JSON.stringify({sessions:window.ShareKit.sessions.all().length,capture:window.Share.debugAll().capture.state,control:s.control.on,clip:s.clip.on}))')"
echo "toasts, alice: $(A "$TOASTSQ")"
echo "toasts, cy: $(C "$TOASTSQ")"
finish
