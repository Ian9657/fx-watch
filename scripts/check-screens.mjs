// Open the app (npm run dev must be running) at phone and desktop sizes in
// headless Chrome and check that it fits one screen without scrolling,
// throws no errors, and turns over. Screenshots go to screens/ for a look.
//
//   npm run check:screens
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const APP = 'http://localhost:8787/';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIZES = [
  [375, 667, 'iphone-se'], [390, 844, 'iphone-14'], [430, 932, 'iphone-pro-max'],
  [360, 800, 'android'], [412, 915, 'android-large'], [1280, 800, 'desktop'],
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!(await fetch(APP).then(r => r.ok, () => false))) {
  console.error(`Nothing at ${APP}: start it with npm run dev first.`);
  process.exit(1);
}
const password = process.env.PASSWORD || 'localtest'; // .dev.vars

rmSync('screens', { recursive: true, force: true });
mkdirSync('screens/.profile', { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9339', '--user-data-dir=screens/.profile', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 60 && !targets; i++) { await sleep(250); targets = await fetch('http://127.0.0.1:9339/json/list').then(r => r.json(), () => null); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0;
const pending = new Map(), errors = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id) pending.get(m.id)?.(m.result);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const value = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;

await send('Runtime.enable');
await send('Page.navigate', { url: APP }); await sleep(1000);
await value(`localStorage.setItem('password', ${JSON.stringify(password)}); localStorage.setItem('turned', '1'); localStorage.setItem('wound', '1')`);

let failed = 0;
for (const [width, height, name] of SIZES) {
  errors.length = 0;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 600 });
  await send('Page.reload', { ignoreCache: true }); await sleep(3000);
  const m = await value(`document.fonts.ready.then(() => {
    const box = id => document.getElementById(id).getBoundingClientRect();
    scrollTo(0, 500);
    const r = { locked: !document.getElementById('lock').hidden, watch: Math.round(box('case').width),
      bottom: Math.round(document.querySelector('footer').getBoundingClientRect().bottom), scrolled: scrollY,
      tall: document.documentElement.classList.contains('tall') };
    scrollTo(0, 0);
    return r;
  })`);
  writeFileSync(`screens/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await value(`document.getElementById('case').click()`); await sleep(1500);
  const back = await value(`document.getElementById('case').classList.contains('over') && !!document.querySelector('#polar .hub-span')`);
  writeFileSync(`screens/${name}-back.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  const problems = [
    m.locked && 'stuck on the lock screen (wrong PASSWORD?)',
    width < 600 && (m.scrolled > 0 || m.tall) && 'page scrolls',
    m.bottom > height && `footer below the screen (${m.bottom} > ${height})`,
    !back && "back didn't turn over",
    ...errors.map(e => `error: ${e}`),
  ].filter(Boolean);
  failed += problems.length > 0;
  console.log(`${problems.length ? '✖' : '✔'} ${name.padEnd(15)} ${width}x${height}  watch ${m.watch}px (${Math.round(m.watch / width * 100)}% wide)` +
    (problems.length ? `\n    ${problems.join('\n    ')}` : ''));
}
ws.close();
chrome.kill();
rmSync('screens/.profile', { recursive: true, force: true });
console.log(`Screenshots in screens/.`);
process.exit(failed ? 1 : 0);
