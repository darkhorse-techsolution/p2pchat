#!/bin/sh
# Delay readout check on two FRESH dev instances (CDP 9441 sharer "latA", 9442 viewer "latB"). Starts them,
# pairs them, shares A's screen, animates a square in A's own window (A runs with --no-protection so its
# window is part of the picture; nothing is sent to the OS), then prints the viewer's and the sharer's
# readout (window.Share.debug().q) and the stats line. Extra Electron flags for both instances go in
# LAT_FLAGS, e.g. LAT_FLAGS=--share-cushion for the pre-0.8 playout behaviour:
#   sh test/ui/latency.sh                     # play-at-once (default)
#   LAT_FLAGS=--share-cushion sh test/ui/latency.sh
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; CDP="$ROOT/test/ui/cdp.js"
sleep_py() { python3 -c "import time;time.sleep($1)"; }
A() { node "$CDP" 9441 "$1"; }; B() { node "$CDP" 9442 "$1"; }
stop() { for p in $(pgrep -f "instance=lat[AB]"); do kill "$p" 2>/dev/null; done; }
stop; sleep_py 1
# The two logs outlive a run (only the data folders are removed below), so an ERROR line of an earlier run
# would be counted again every time: remember where each log ends now and count what this run adds.
LOGS="$HOME/Library/Logs/P2P Chat"; lines() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
LA0=$(lines "$LOGS/p2pchat-latA.log"); LB0=$(lines "$LOGS/p2pchat-latB.log")
rm -rf "$HOME/Library/Application Support/P2P Chat (latA)" "$HOME/Library/Application Support/P2P Chat (latB)" "$HOME/.config/P2P Chat (latA)" "$HOME/.config/P2P Chat (latB)" 2>/dev/null
"$ROOT/run.sh" --instance=latA --remote-debugging-port=9441 --x=20 --y=60 --use-fake-device-for-media-stream --no-protection $LAT_FLAGS >/dev/null 2>&1 &
"$ROOT/run.sh" --instance=latB --remote-debugging-port=9442 --x=960 --y=60 --use-fake-device-for-media-stream $LAT_FLAGS >/dev/null 2>&1 &
for P in 9441 9442; do for i in $(seq 1 40); do curl -s "http://127.0.0.1:$P/json/version" >/dev/null 2>&1 && break; sleep_py 0.5; done; done
sleep_py 3
A "(()=>{document.getElementById('firstName').value='Alice';document.getElementById('firstGo').click();return 'ok'})()" >/dev/null
B "(()=>{document.getElementById('firstName').value='Bob';document.getElementById('firstGo').click();return 'ok'})()" >/dev/null
sleep_py 0.8
INV=$(A "document.getElementById('emptyInvite').click(); new Promise(r=>setTimeout(()=>r(document.getElementById('myInvite').value),400))")
A "(()=>{document.querySelector('#mInvite [data-close]').click();return 'ok'})()" >/dev/null
B "(()=>{document.getElementById('btnAdd').click();document.getElementById('addInvite').value='$INV';document.getElementById('addGo').click();return 'ok'})()" >/dev/null
sleep_py 3
A "(()=>{document.getElementById('btnShare').click();return 'share clicked'})()"
sleep_py 6
ANIM='(()=>{const d=document.createElement("div");d.style.cssText="position:fixed;left:0;top:0;width:220px;height:220px;z-index:99999;background:#f00";document.body.appendChild(d);let t=0;const f=()=>{t++;d.style.transform="translate("+(200+150*Math.sin(t/7))+"px,"+(200+150*Math.cos(t/9))+"px)";d.style.background="hsl("+(t*7%360)+",90%,50%)";requestAnimationFrame(f)};f();return "animating"})()'
A "$ANIM"
VQ='(()=>{const d=window.Share.debug();const q=d&&d.q;return JSON.stringify(q?{conn:d.conn,bufMs:q.bufMs,wantMs:q.wantMs,holdMs:q.holdMs,decMs:q.decMs,shownMs:q.shownMs,e2eMs:q.e2eMs,rx:q.rx,out:q.out,drop:q.drop,freeze:q.freeze,voiceMs:q.voiceMs,dec:q.dec}:{conn:d&&d.conn,q:null})})()'
SQ='(()=>{const d=window.Share.debug();const q=d&&d.q;return JSON.stringify(q?{inFps:q.inFps,encFps:q.encFps,encMs:q.encMs,skip:q.skip,limit:q.limit,hint:q.hint,impl:q.impl,svc:q.svc,target:q.target}:{q:null})})()'
for i in 1 2 3; do sleep_py 5; echo "viewer q $i: $(B "$VQ")"; done
echo "sharer q:  $(A "$SQ")"
echo "viewer line: $(B 'document.getElementById("viewerStats").textContent')"
echo "sharer pill: $(A 'document.getElementById("sharePill").title')"
echo "errors in the page consoles and logs:"
for n in latA latB; do
  L="$LOGS/p2pchat-$n.log"; [ -f "$L" ] || continue
  [ "$n" = latA ] && N0=$LA0 || N0=$LB0
  [ "$(lines "$L")" -lt "$N0" ] && N0=0   # the app started a new file (it rotates at 2 MB): all of it is this run's
  tail -n +$((N0 + 1)) "$L" | grep -c " ERROR " | sed "s/^/  $n ERROR lines: /"; grep " share " "$L" | tail -1 | cut -c1-330 | sed "s/^/  $n log: /"
done
stop; sleep_py 1; echo "instances left: $(pgrep -f 'instance=lat[AB]' | wc -l | tr -d ' ')"
