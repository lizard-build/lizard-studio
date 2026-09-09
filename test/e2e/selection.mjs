// Real Chrome selection events, service worker and composer; no user profile or model.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'studio-selection-test-'));
const session = 'studio-selection-' + process.pid;
const exec = promisify(execFile);
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/frame' ? '<p id="child">Child frame passage</p>' : '<!doctype html><title>Selection fixture</title><p id="copy">First selected passage</p><p id="next">Second selected passage</p><input id="field" value="Input selection"><input id="secret" type="password" value="Masked test value"><iframe src="/frame" id="frame"></iframe>');
});
const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const origin = 'http://127.0.0.1:' + port;
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
manifest.content_scripts = [manifest.content_scripts.at(-1)];
manifest.content_scripts[0].matches = [origin + '/*'];
manifest.host_permissions = [origin + '/*'];
manifest.side_panel = { default_path: 'harness.html' };
manifest.icons = undefined;
for (const path of ['src/background.js', 'src/selection.js', 'src/panel/panel.js', 'src/panel/panel.css']) {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), readFileSync(join(root, path)));
}
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
writeFileSync(join(dir, 'harness.html'), '<!doctype html><meta charset="utf-8"><title>Selection test</title><link rel="stylesheet" href="src/panel/panel.css"><div id="messages"></div><div id="chips" class="context-chips hidden"></div><textarea id="input"></textarea><script src="setup.js"></script><script src="chat.js"></script><script src="src/panel/panel.js"></script>');
writeFileSync(join(dir, 'setup.js'), 'window.RKRender={markdown:s=>{const e=document.createElement("p");e.textContent=s;return e}};window.RKIconHTML=()=>"";');
const hooks = `
  activeId = 'test';
  const testChat = {id:activeId,cwd:'/tmp',contexts:[],attachments:[],queue:[],turnRunning:true,messagesEl:document.getElementById('messages')};
  chats.set(activeId,testChat);
  els.contextChips=document.getElementById('chips'); els.input=document.getElementById('input');
  window.selectionTest={
    current:()=>liveSelection,
    queue:async(text)=>{els.input.value=text;await sendPrompt();return testChat.queue.at(-1)},
    queued:()=>testChat.queue.map(e=>({text:e.text,contexts:e.contexts,formatted:formatContexts(e)})),
    addManual:()=>{testChat.contexts.push({kind:'page',title:'Manual attachment',url:'https://manual.test'});renderContextChips()},
  };
`;
writeFileSync(join(dir, 'chat.js'), readFileSync(join(root, 'src/panel/chat.js'), 'utf8').replace('  window.RKChat =', hooks + '\n  window.RKChat ='));
async function browser(...args) {
  const {stdout} = await exec('agent-browser', ['--session', session, ...args, '--json'], {timeout:60000,maxBuffer:1024*1024});
  const r = JSON.parse(stdout); if (!r.success) throw new Error(r.error); return r.data;
}
try {
  const launch = ['--profile',join(dir,'profile'),'--extension',dir];
  if (process.env.STUDIO_TEST_CHROME) launch.push('--executable-path',process.env.STUDIO_TEST_CHROME);
  await browser(...launch,'open','chrome-extension://nhcgkijjijdinhldjohkmbbgjokobecd/harness.html');
  const result = await browser('eval', `(async()=>{
    const wait=async(fn)=>{const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('Selection condition timed out');await new Promise(r=>setTimeout(r,10))}};
    const tab=await chrome.tabs.create({url:${JSON.stringify(origin)},active:true});
    const run=(func,args=[],allFrames=false)=>chrome.scripting.executeScript({target:{tabId:tab.id,allFrames},func,args});
    await new Promise(r=>{const f=(id,info)=>{if(id===tab.id&&info.status==='complete'){chrome.tabs.onUpdated.removeListener(f);r()}};chrome.tabs.onUpdated.addListener(f)});
    const select=async(id)=>run((id)=>{const e=document.getElementById(id);document.activeElement?.blur();const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r)},[id]);
    await select('copy'); await wait(()=>selectionTest.current()?.text==='First selected passage');
    const chip=document.getElementById('chips');
    if(chip.textContent!=='1 selection'||chip.classList.contains('hidden'))throw Error('Missing selection chip');
    await selectionTest.queue('Explain this');
    await select('next');await wait(()=>selectionTest.current()?.text==='Second selected passage');
    await selectionTest.queue('And this');
    await run(()=>getSelection().removeAllRanges());await wait(()=>!selectionTest.current());
    if(!chip.classList.contains('hidden'))throw Error('Chip did not clear');
    const queued=selectionTest.queued();
    if(queued[0].contexts[0].text!=='First selected passage'||queued[1].contexts[0].text!=='Second selected passage')throw Error('Queued selections changed');
    await run(()=>{const e=document.getElementById('field');e.focus();e.setSelectionRange(0,5)});
    await wait(()=>selectionTest.current()?.text==='Input');
    await run(()=>{const e=document.getElementById('secret');e.focus();e.select()});await wait(()=>!selectionTest.current());
    await run(()=>{const e=document.getElementById('child');if(!e)return;window.focus();const r=document.createRange();r.selectNodeContents(e);getSelection().removeAllRanges();getSelection().addRange(r)},[],true);
    await wait(()=>selectionTest.current()?.text==='Child frame passage');
    selectionTest.addManual();
    const blank=await chrome.tabs.create({url:'about:blank',active:true});await wait(()=>!selectionTest.current());
    if(!chip.textContent.includes('Manual attachment'))throw Error('Manual context was removed');
    await chrome.tabs.update(tab.id,{active:true});await wait(()=>selectionTest.current()?.text==='Child frame passage');
    await chrome.tabs.update(tab.id,{url:${JSON.stringify(origin + '/new')}});await wait(()=>!selectionTest.current());
    await chrome.tabs.remove([tab.id,blank.id]);
    return {passed:true,queued:queued.map(e=>({text:e.text,selected:e.contexts[0].text,formatted:e.formatted})),checks:['appear','replace','clear','queued snapshot','input','password exclusion','iframe','tab switch','manual attachment','navigation']};
  })()`);
  assert.equal(result.result.passed, true);
  console.log(JSON.stringify(result.result, null, 2));
} finally {
  await browser('close').catch(()=>{});
  server.close();
  console.log('Fixture: ' + dir);
}
