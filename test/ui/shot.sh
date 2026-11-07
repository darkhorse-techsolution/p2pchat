#!/bin/sh
# Screenshot flow against two FRESH dev instances on CDP 9421 (Alice) / 9422 (Bob). Start them first:
#   ./run.sh --instance=shotA --remote-debugging-port=9421 --x=40 --y=60 &
#   ./run.sh --instance=shotB --remote-debugging-port=9422 --x=1000 --y=60 &
CDP="$(cd "$(dirname "$0")" && pwd)/cdp.js"
sleep_py() { python3 -c "import time;time.sleep($1)"; }
A() { node "$CDP" 9421 "$1"; }; B() { node "$CDP" 9422 "$1"; }
echo "--- names"
A "(()=>{document.getElementById('firstName').value='Alice';document.getElementById('firstGo').click();return 'ok'})()" >/dev/null
B "(()=>{document.getElementById('firstName').value='Bob';document.getElementById('firstGo').click();return 'ok'})()" >/dev/null
sleep_py 0.8
echo "--- invite -> add"
INV=$(A "document.getElementById('emptyInvite').click(); new Promise(r=>setTimeout(()=>r(document.getElementById('myInvite').value),400))")
A "(()=>{document.querySelector('#mInvite [data-close]').click();return 'ok'})()" >/dev/null
B "(()=>{document.getElementById('btnAdd').click();document.getElementById('addInvite').value='$INV';document.getElementById('addGo').click();return 'ok'})()" >/dev/null
sleep_py 3
for P in 9421 9422; do node "$CDP" $P "window.api.state().then(s=>JSON.stringify({me:s.me.name,contacts:s.contacts.map(c=>c.name+':'+c.status),chat:!document.getElementById('chat').classList.contains('hidden')}))"; done
echo "--- alice: click the camera button"
A "(()=>{const b=document.getElementById('btnShot');b.click();return 'clicked busy='+b.classList.contains('busy')})()"
sleep_py 1.2
echo "--- bob, right after: placeholder while the bytes are still coming?"
B "JSON.stringify([...document.querySelectorAll('#messages .msg.peer.image')].map(m=>({wait:!!m.querySelector('.shot-wait'),img:!!m.querySelector('img.shot')})))"
sleep_py 3
echo "--- alice: own bubble"
A "JSON.stringify({mine:[...document.querySelectorAll('#messages .msg.me.image')].map(m=>{const i=m.querySelector('img.shot');return {loaded:i&&i.complete&&i.naturalWidth>0,natural:i?i.naturalWidth+'x'+i.naturalHeight:null,attr:i?i.width+'x'+i.height:null,rendered:i?Math.round(i.getBoundingClientRect().width)+'x'+Math.round(i.getBoundingClientRect().height):null,tick:m.querySelector('.tick')?.className,tools:[...m.querySelectorAll('.bubble-tools button')].map(b=>b.textContent)}}),busy:document.getElementById('btnShot').classList.contains('busy'),prev:document.querySelector('.contact .c-prev')?.className+' | '+document.querySelector('.contact .c-prev')?.textContent})"
echo "--- bob: received bubble"
B "JSON.stringify({theirs:[...document.querySelectorAll('#messages .msg.peer.image')].map(m=>{const i=m.querySelector('img.shot');return {wait:!!m.querySelector('.shot-wait'),loaded:i&&i.complete&&i.naturalWidth>0,natural:i?i.naturalWidth+'x'+i.naturalHeight:null,rendered:i?Math.round(i.getBoundingClientRect().width)+'x'+Math.round(i.getBoundingClientRect().height):null,src:i?i.src.replace(/img\/.{43}\//,'img/<pub>/'):null}}),prev:document.querySelector('.contact .c-prev')?.className+' | '+document.querySelector('.contact .c-prev')?.textContent,unread:document.querySelector('.unread-div')?.textContent||null})"
echo "--- bob: viewer"
B "(()=>{document.querySelector('#messages .msg.peer.image img.shot').click();return JSON.stringify({open:!document.getElementById('lightbox').classList.contains('hidden'),meta:document.getElementById('lbMeta').textContent})})()"
sleep_py 0.6
B "JSON.stringify({viewerImg:document.getElementById('lbImg').naturalWidth+'x'+document.getElementById('lbImg').naturalHeight,fits:document.getElementById('lbImg').getBoundingClientRect().width<=innerWidth})"
B "(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return 'after Esc: open='+!document.getElementById('lightbox').classList.contains('hidden')+' src='+document.getElementById('lbImg').getAttribute('src')})()"
echo "--- bob: Copy -> system clipboard"
B "window.api.state().then(s=>window.api.copyImage(s.contacts[0].pub, document.querySelector('#messages .msg.peer.image').dataset.id)).then(r=>'copyImage='+r)"
osascript -e 'clipboard info' 2>/dev/null | tr ',' '\n' | head -4
echo "--- alice: permission modal renders (cannot be triggered here: permission is granted)"
A "(()=>{show('mShot');const v=!document.getElementById('mShot').classList.contains('hidden');const steps=document.querySelectorAll('#mShot .steps li').length;close();return 'mShot visible='+v+' steps='+steps})()"
echo "--- logs"
for P in 9421 9422; do L=$(node "$CDP" $P "window.api.state().then(s=>s.logPath)"); echo "$L"; grep -E "screenshot|ERROR|renderer" "$L" | tail -5; done
