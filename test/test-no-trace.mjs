import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9335;
const SITE = 'http://localhost:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'anonymizer-'))}`,
  '--autoplay-policy=no-user-gesture-required', '--window-size=420,900', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

let page;
for (let i = 0; i < 50 && !page; i++) {
  await sleep(200);
  try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch {  }
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails));
  return r.result.result.value;
};

async function runOne(file, raw) {
  await send('Page.navigate', { url: SITE });
  await sleep(1000);
  await run(`while (!window.anonymizer || document.getElementById('file').disabled) await new Promise(r => setTimeout(r, 100));`);
  await run(`const b = await (await fetch('test/${file}')).blob(); const dt = new DataTransfer(); dt.items.add(new File([b], '${file}', { type: 'video/webm' }));
    const inp = document.getElementById('file'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));`);
  await run(`while (document.getElementById('s-review').hidden) await new Promise(r => setTimeout(r, 100));`);
  if (raw) await run(`const S = window.anonymizer.S; S.raw = ${JSON.stringify(raw)}; window.anonymizer.retrack({});`);
  const used = await run(`return window.anonymizer.S.raw;`);
  await run(`document.getElementById('export').click(); while (document.getElementById('s-done').hidden && document.getElementById('fatal').hidden) await new Promise(r => setTimeout(r, 200));`);
  const res = await run(`const S = window.anonymizer.S; const buf = await S.resultFile.arrayBuffer();
    const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(x => x.toString(16).padStart(2, '0')).join('');
    return { taille: buf.byteLength, fingerprint: h, info: document.getElementById('doneInfo').textContent, error: document.getElementById('fatal').textContent, masques: S.tracks.length };`);
  return { ...res, raw: used };
}

const a = await runOne('face-a.webm');
const b = await runOne('face-b.webm', a.raw);
ws.close();
chrome.kill();

const show = ({ raw, ...r }) => r;
console.log(JSON.stringify({ a: show(a), b: show(b) }, null, 2));
const fails = [];
if (a.error || b.error) fails.push('error shown');
if (!/export rapide/.test(a.info) || !/export rapide/.test(b.info)) fails.push("l'export rapide n'a pas servi : " + a.info + ' / ' + b.info);
if (a.fingerprint !== b.fingerprint) fails.push('the two output files differ: the result depends on the original face');
if (fails.length) { console.error('FAILED\n- ' + fails.join('\n- ')); process.exitCode = 1; } else console.log('OK: identical files, no trace of the face');
