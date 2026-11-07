#!/bin/sh
# Full UI flow against two running instances on CDP ports 9411 (Alice) and 9412 (Bob).
CDP="$(cd "$(dirname "$0")" && pwd)/cdp.js"
sleep_py() { python3 -c "import time;time.sleep($1)"; }
A() { node "$CDP" 9411 "$1"; }; B() { node "$CDP" 9412 "$1"; }
echo "--- names"
A "(()=>{document.getElementById('firstName').value='Alice';document.getElementById('firstGo').click();return 'ok'})()" >/dev/null
B "(()=>{document.getElementById('firstName').value='Bob';document.getElementById('firstGo').click();return 'ok'})()" >/dev/null
sleep_py 0.8
echo "--- invite -> add"
INV=$(A "document.getElementById('emptyInvite').click(); new Promise(r=>setTimeout(()=>r(document.getElementById('myInvite').value),400))")
A "(()=>{document.querySelector('#mInvite [data-close]').click();return 'ok'})()" >/dev/null
B "(()=>{document.getElementById('btnAdd').click();document.getElementById('addInvite').value='$INV';document.getElementById('addGo').click();return 'ok'})()" >/dev/null
sleep_py 3
for P in 9411 9412; do node "$CDP" $P "window.api.state().then(s=>JSON.stringify({me:s.me.name,vaultSecure:s.vaultSecure,contacts:s.contacts.map(c=>c.name+':'+c.status),chat:!document.getElementById('chat').classList.contains('hidden'),head:document.getElementById('chatSub').textContent}))"; done
echo "--- bob: text via Enter"
B "(()=>{const i=document.getElementById('input');i.value='hey Alice, the new build is up';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return 'ok'})()" >/dev/null
sleep_py 1.2
A "JSON.stringify([...document.querySelectorAll('#messages .msg')].map(m=>m.className+' | '+(m.querySelector('.bubble,pre')||{}).textContent?.slice(0,50)))"
echo "--- alice: code mode + Cmd+Enter"
A "(()=>{document.getElementById('btnCode').click();document.getElementById('codeLang').value='js';const i=document.getElementById('input');i.value='// retry with backoff\nasync function retry(fn, n = 3) {\n  for (let i = 0; i < n; i++) {\n    try { return await fn(); } catch (e) { if (i === n - 1) throw e; }\n    await new Promise(r => setTimeout(r, 2 ** i * 100));\n  }\n}';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true}));return 'codeMode after send='+document.getElementById('composer').classList.contains('code')})()"
sleep_py 1.2
B "JSON.stringify({msgs:[...document.querySelectorAll('#messages .msg')].map(m=>m.className),codeHead:document.querySelector('.msg.peer .code-head')?.textContent.trim(),tokens:document.querySelectorAll('.codebox .tk-k').length+'kw '+document.querySelectorAll('.codebox .tk-c').length+'cm '+document.querySelectorAll('.codebox .tk-f').length+'fn '+document.querySelectorAll('.codebox .tk-s').length+'str',sidebar:document.querySelector('.contact .c-prev')?.className+' | '+document.querySelector('.contact .c-prev')?.textContent})"
echo "--- bob: fenced block typed as plain text"
B "(()=>{const i=document.getElementById('input');i.value='\`\`\`py\ndef greet(name):\n    print(f\"hello {name}\")  # from bob\n\`\`\`';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return 'ok'})()" >/dev/null
sleep_py 1.2
A "JSON.stringify({langs:[...document.querySelectorAll('#messages .msg.code .lang')].map(l=>l.textContent),pyComment:!!document.querySelector('#messages .msg.peer.code .tk-c'),ticks:[...document.querySelectorAll('#messages .msg.me .tick')].map(t=>t.className)})"
echo "--- typing indicator"
B "(()=>{const i=document.getElementById('input');i.value='t';i.dispatchEvent(new Event('input'));return 'ok'})()" >/dev/null
sleep_py 0.7
A "document.getElementById('typing').classList.contains('hidden')?'NO dots':'dots visible'"
echo "--- bob: paste detection switches to code mode"
B "(()=>{const i=document.getElementById('input');i.value='';const dt=new DataTransfer();dt.setData('text','function a() {\n  return 1;\n}\nconst b = a();');i.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true}));return 'codeMode='+document.getElementById('composer').classList.contains('code')+' lang='+document.getElementById('codeLang').value})()"
B "(()=>{document.getElementById('input').value='';document.getElementById('btnCode').click();return 'reset'})()" >/dev/null
echo "--- info modal: safety numbers match"
SA=$(A "window.api.contact((await window.api.state()).contacts[0].pub).then(c=>c.safetyNumber)" 2>/dev/null || A "window.api.state().then(s=>window.api.contact(s.contacts[0].pub)).then(c=>c.safetyNumber)")
SB=$(B "window.api.state().then(s=>window.api.contact(s.contacts[0].pub)).then(c=>c.safetyNumber)")
echo "alice sees: $SA"; echo "bob sees:   $SB"; [ "$SA" = "$SB" ] && echo "MATCH" || echo "MISMATCH"
echo "--- settings modal renders"
A "(()=>{document.getElementById('btnSettings').click();return JSON.stringify({hotkey:document.getElementById('setHotkey').value,protection:document.getElementById('setProtection').checked,vault:document.getElementById('vaultInfo').className+' '+document.getElementById('vaultInfo').textContent.slice(0,44)})})()"
A "(()=>{document.querySelector('#mSettings [data-close]').click();return 'closed'})()" >/dev/null
