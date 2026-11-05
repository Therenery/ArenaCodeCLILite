#!/usr/bin/env node
/**
 * arena_bridge.js - local OpenAI-ish bridge for arena.ai
 * Design: never forge requests. Drive the real page with real input events,
 * passively tap the page's own fetch stream. No cookies stored, no tokens minted.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const { parseFrame } = require('./lib/parse');

const VERSION = '0.4.2';
const CDP_PORT = 9222;
const PORT = 17892;
const HOST = '127.0.0.1';
const MIN_GAP_MS = 3000;
const READY_TIMEOUT_MS = 60000;
const ASK_MAX_MS = 7200000;   // 安全上限 2 小时
const ASK_IDLE_MS = 300000;   // 连续 5 分钟没有任何帧才判定卡死
const POLL_MS = 400;
const MAX_QUEUE = 4;

/* ---------- 可配置项（全部有默认值，不设也能跑） ---------- */
// 状态目录：仓库缓存、调试转储都落在这里
const STATE_DIR = process.env.ARB_STATE_DIR || path.join(require('os').homedir(), '.arena-bridge');
// 常驻标签页上限，超过就按最久未用淘汰，避免标签堆积
const MAX_SESSIONS = Math.max(1, Number(process.env.ARB_MAX_SESSIONS) || 6);
// 默认不打印 prompt 正文，也不落盘；排障时再开
const DEBUG_PROMPT = /^(1|true|yes)$/i.test(process.env.ARB_DEBUG_PROMPT || '');
// /upload 允许的目录白名单（path.delimiter 分隔）；留空表示不限制
// 默认只允许状态目录与当前工作目录；要放开请显式设置 ARB_UPLOAD_ROOTS
const UPLOAD_ROOTS = (process.env.ARB_UPLOAD_ROOTS || (STATE_DIR + path.delimiter + process.cwd())).split(path.delimiter).map(s => s.trim()).filter(Boolean);
// SSE 心跳间隔，防止客户端在长时间工具调用时判定连接空闲
const SSE_PING_MS = Math.max(1000, Number(process.env.ARB_SSE_PING_MS) || 15000);
// 单次输入框能装的字符上限，超出会被截断（页面里逐字符敲，越长越慢）
const MAX_PROMPT_CHARS = Math.max(500, Number(process.env.ARB_MAX_PROMPT_CHARS) || 6000);
// 可选鉴权：隧道把端口曝到手机上时，靠它挡住同机其它进程；留空即不校验
const AUTH_TOKEN = process.env.ARB_TOKEN || '';
// histories 的键上限，避免客户端换着 user 字段把内存撑爆
const MAX_HISTORY_KEYS = Math.max(4, Number(process.env.ARB_MAX_HISTORY_KEYS) || 32);
// 各接口统一的默认会话名，别让 /ask 和 /v1 各叫一个名字
const DEFAULT_SESSION = 'main';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// 哪些错误说明标签页本身坏了（要关掉重开）；超时、队列满这类不该顺手杀会话
const sessionBroken = msg => /composer still holds|send failed|page not ready|ws closed|tab closed|no composer|typing failed/.test(String(msg || ''));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 路径是否落在任一白名单目录内（解析软链后再比，避免 ../ 绕过）
function within(p, roots) {
  let rp;
  try { rp = fs.realpathSync(p); } catch (e) { return false; }
  return roots.some(root => {
    let rr;
    try { rr = fs.realpathSync(root); } catch (e) { return false; }
    return rp === rr || rp.startsWith(rr.endsWith(path.sep) ? rr : rr + path.sep);
  });
}

/* ---------- repo picker ---------- */
let repoCache = { repo: "", repos: [] };
try { repoCache = JSON.parse(require("fs").readFileSync(path.join(STATE_DIR, 'repos.json'), "utf8")); } catch (e) {}
async function realClick(c, p) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 });
  await sleep(70);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(70);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
}
const CHIP_POS_JS = "(function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){var t=(x.innerText||'').trim();return t.length>2&&t.length<60&&t.indexOf('/')>0&&t.indexOf(' ')<0})[0];if(!b)return '';var r=b.getBoundingClientRect();if(!r.width)return '';return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()";
const ADD_BTN_POS_JS = "(function(){var es=[].slice.call(document.querySelectorAll('[aria-label]')).filter(function(x){return /Add files and connections/i.test(x.getAttribute('aria-label')||'')});for(var i=0;i<es.length;i++){var r=es[i].getBoundingClientRect();if(r.width>0&&r.height>0)return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})}return ''})()";
// 文件框还没进 DOM 时，点一下「Add files and connections」把它逼出来。
// 点之前先拦下文件选择框：不然 Windows 原生对话框会弹出来卡在那儿，人也看得见。
async function clickAttach(c) {
  let chooser = null;
  c.onEvent = m => { if (m.method === 'Page.fileChooserOpened') chooser = m.params; };
  await c.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
  const pos = await c.ev(ADD_BTN_POS_JS).catch(() => '');
  if (pos) await realClick(c, JSON.parse(pos)).catch(() => {});
  for (let i = 0; i < 10 && !chooser; i++) await sleep(300);
  await c.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  c.onEvent = null;
  // 点出来的是菜单而不是文件框：按 Esc 收掉，页面上不留痕迹
  if (!chooser) {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
  }
  return chooser;
}
const SEL_TAB_POS_JS = "(function(){function inOpen(e){var p=e;for(var i=0;i<8&&p;i++){var st=p.getAttribute&&p.getAttribute('data-state');if(st==='open')return true;p=p.parentElement}return false}var els=[].slice.call(document.querySelectorAll('span,button,div'));for(var i=els.length-1;i>=0;i--){var e=els[i];if(e.children.length>1)continue;if((e.innerText||'').trim()!=='Select a repository')continue;var r=e.getBoundingClientRect();if(r.width<4||r.height<4)continue;if(!inOpen(e))continue;var px=Math.round(r.left+r.width/2),py=Math.round(r.top+r.height/2);var h=document.elementFromPoint(px,py);for(var k=0;k<4&&h;k++){if((h.innerText||'').trim()==='Select a repository')return JSON.stringify({x:px,y:py});h=h.parentElement}}return ''})()";
const OUTER_GH_POS_JS = "(function(){var best=null;[].slice.call(document.querySelectorAll('span,button,div')).forEach(function(e){if(e.children.length>1)return;if((e.innerText||'').trim()!=='GitHub')return;var r=e.getBoundingClientRect();if(r.width<4||r.height<4)return;var q=e,st='';for(var i=0;i<8&&q;i++){var s=q.getAttribute&&q.getAttribute('data-state');if(s){st=s;break}q=q.parentElement}if(st==='open')return;var px=Math.round(r.left+r.width/2),py=Math.round(r.top+r.height/2);var h=document.elementFromPoint(px,py);for(var k=0;k<4&&h;k++){if((h.innerText||'').trim()==='GitHub'){best={x:px,y:py};return}h=h.parentElement}});return best?JSON.stringify(best):''})()";
const GH_ITEM_POS_JS = "(function(){function inOpen(e){var p=e;for(var i=0;i<8&&p;i++){var st=p.getAttribute&&p.getAttribute('data-state');if(st==='open')return true;p=p.parentElement}return false}var els=[].slice.call(document.querySelectorAll('span,button,div'));var anchor=null;for(var i=0;i<els.length;i++){var e=els[i];if(e.children.length>1)continue;if((e.innerText||'').trim()!=='Connectors')continue;var r=e.getBoundingClientRect();if(r.width<4||r.height<4)continue;if(!inOpen(e))continue;anchor=r;break}if(!anchor)return '';for(var j=0;j<els.length;j++){var x=els[j];if(x.children.length>1)continue;if((x.innerText||'').trim()!=='GitHub')continue;var q=x.getBoundingClientRect();if(q.width<4||q.height<4)continue;if(Math.abs(q.top-anchor.top)>12)continue;var px=Math.round(q.left+q.width/2),py=Math.round(q.top+q.height/2);var h=document.elementFromPoint(px,py);for(var k=0;k<4&&h;k++){if((h.innerText||'').trim()==='GitHub')return JSON.stringify({x:px,y:py});h=h.parentElement}break}return ''})()";
const DIALOG_OPEN_JS = "(function(){var d=document.querySelector('[role=dialog],[role=menu]');return d?'1':'0'})()";
const OPEN_PICKER_JS = "(function(){var fire=function(el){var r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;var o={bubbles:true,cancelable:true,clientX:x,clientY:y,view:window,button:0,buttons:1,pointerId:1,isPrimary:true,pointerType:'mouse'};el.dispatchEvent(new PointerEvent('pointerdown',o));el.dispatchEvent(new MouseEvent('mousedown',o));el.dispatchEvent(new PointerEvent('pointerup',o));el.dispatchEvent(new MouseEvent('mouseup',o));el.dispatchEvent(new MouseEvent('click',o));};var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return /^[\\w.-]+\\/[\\w.-]+$/.test((x.innerText||'').trim())})[0];if(b){fire(b);return 'OK'}var g=[].slice.call(document.querySelectorAll('[aria-label]')).filter(function(x){return (x.getAttribute('aria-label')||'')==='GitHub'})[0];if(g){fire(g);return 'CLICKED_GITHUB'}return 'NO_CHIP'})()";
const LIST_REPOS_JS = "(function(){var d=document.querySelector('[role=dialog],[role=menu]');if(!d)return JSON.stringify({open:false,items:[]});var out=[];[].slice.call(d.querySelectorAll('*')).forEach(function(x){if(x.children.length>2)return;var t=(x.innerText||'').trim();if(!/^[\\w.-]+\\/[\\w.-]+$/.test(t))return;if(out.indexOf(t)<0)out.push(t)});return JSON.stringify({open:true,items:out})})()";
const CHIP_TEXT_JS = "(function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return /^[\\w.-]+\\/[\\w.-]+$/.test((x.innerText||'').trim())})[0];return b?(b.innerText||'').trim():''})()";
const repoPosJs = name => "(function(){var d=document.querySelector('[role=dialog]');if(!d)return '';var nm=" + JSON.stringify(name) + ";var es=[].slice.call(d.querySelectorAll('*')).filter(function(x){return (x.innerText||'').trim()===nm});if(!es.length)return '';var e=es[es.length-1];try{e.scrollIntoView({block:'center',inline:'nearest'})}catch(err){try{e.scrollIntoView()}catch(e2){}}var r=e.getBoundingClientRect();var px=Math.round(r.left+r.width/2),py=Math.round(r.top+r.height/2);if(py<4||py>innerHeight-4)return '';var h=document.elementFromPoint(px,py);for(var k=0;k<5&&h;k++){if((h.innerText||'').trim()===nm)return JSON.stringify({x:px,y:py});h=h.parentElement}return ''})()";

/* ---------- CDP plumbing ---------- */
function cdpApi(method, path) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: CDP_PORT, path, method, timeout: 8000 }, r => {
      let b = '';
      r.on('data', d => (b += d));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(b); } });
    });
    req.on('timeout', () => { req.destroy(new Error('cdp timeout')); });
    req.on('error', rej);
    req.end();
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.closed = false;
    this.onEvent = null; // 事件回调（Page.fileChooserOpened 这类没有 id 的推送）
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
        return;
      }
      if (m.method && this.onEvent) { try { this.onEvent(m); } catch (err) {} }
    };
    ws.onclose = () => { this.closed = true; for (const [, p] of this.pending) p.rej(new Error('ws closed')); this.pending.clear(); };
  }
  send(method, params = {}, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error('ws closed'));
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(method + ' timeout')); }, timeoutMs);
      this.pending.set(id, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) throw new Error('js: ' + (r.exceptionDetails.text || '') + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r && r.result ? r.result.value : undefined;
  }
  async evJson(expr) { const v = await this.ev(expr); try { return JSON.parse(v); } catch { return null; } }
  close() { try { this.ws.close(); } catch {} }
}

async function connectTab(tabId) {
  const list = await cdpApi('GET', '/json/list');
  const t = Array.isArray(list) ? list.find(x => x.id === tabId) : null;
  if (!t) throw new Error('tab gone');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws open failed')); });
  const c = new CDP(ws);
  /* Runtime.enable omitted: most detectable CDP side effect */
  await c.send('Page.enable');
  return c;
}

/* ---------- injected tap ---------- */
const INJECT = String.raw`
(() => {
  if (window.__arbInstalled) return;
  window.__arbInstalled = true;
  window.__arbSeq = 0;
  window.__arbStreams = [];
  const interesting = u => /nextjs-api\/stream|ai-proxy\/realtime/i.test(u);
  const push = (st, o) => {
    try { st.frames.push(o); if (st.frames.length > 30000) { st.frames.splice(0, 10000); st.base = (st.base || 0) + 10000; } } catch (e) {}
  };
  const note = (st, line) => {
    try {
      if (line.indexOf('data: ') === 0) {
        var o = null;
        try { o = JSON.parse(line.slice(6)); } catch (e) { o = null; }
        if (o && Array.isArray(o.records)) {
          for (var i = 0; i < o.records.length; i++) {
            var b = null;
            try { b = JSON.parse(o.records[i].body); } catch (e) { continue; }
            var d = (b && b.data) || {};
            if (d.type) push(st, { e: d.type, d: (typeof d.delta === 'string' ? d.delta : ''), n: d.toolName || '', i: d.input || null, t: Date.now() });
          }
          return;
        }
      }
      push(st, { l: line.slice(0, 6000), t: Date.now() });
    } catch (e) { push(st, { l: String(line).slice(0, 2000), t: Date.now() }); }
  };
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const req = args[0];
    const url = typeof req === 'string' ? req : (req && req.url) || '';
    const res = await origFetch.apply(this, args);
    try {
      if (interesting(url)) {
        const st = { id: ++window.__arbSeq, u: String(url), status: res.status, t: Date.now(), frames: [] };
        window.__arbStreams.push(st);
        if (window.__arbStreams.length > 40) window.__arbStreams.shift();
        const clone = res.clone();
        (async () => {
          const rd = clone.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const ls = buf.split('\n');
            buf = ls.pop();
            for (const ln of ls) { if (ln.trim()) note(st, ln); }
          }
          if (buf.trim()) note(st, buf);
          st.done = true;
        })().catch(e => { st.err = String(e); st.done = true; });
      }
    } catch (e) {}
    return res;
  };
  const XO = window.XMLHttpRequest;
  const xopen = XO.prototype.open, xsend = XO.prototype.send;
  XO.prototype.open = function (m, u) { this.__arbU = u; return xopen.apply(this, arguments); };
  XO.prototype.send = function () {
    if (interesting(String(this.__arbU || ''))) {
      const st = { id: ++window.__arbSeq, u: String(this.__arbU), status: 0, t: Date.now(), frames: [] };
      window.__arbStreams.push(st);
      this.addEventListener('progress', () => {
        try { const t = this.responseText || ''; const nl = t.lastIndexOf('\n'); if (nl > 0) note(st, t.slice(0, nl)); } catch (e) {}
      });
      this.addEventListener('load', () => { st.done = true; });
    }
    return xsend.apply(this, arguments);
  };
  try {
    const hide = (k, v) => Object.defineProperty(window, k, { value: v, enumerable: false, configurable: true, writable: true });
    hide('__arbInstalled', window.__arbInstalled);
    hide('__arbSeq', window.__arbSeq);
    hide('__arbStreams', window.__arbStreams);
    window.fetch = new Proxy(window.fetch, {});
    XO.prototype.open = new Proxy(XO.prototype.open, {});
    XO.prototype.send = new Proxy(XO.prototype.send, {});
  } catch (e) {}
})();
`;

/* ---------- browser ---------- */
// 浏览器不随本项目分发：用用户自己装的 Chrome（Edge / Chromium 也行）
const CHROME_PROFILE = process.env.ARB_PROFILE || path.join(STATE_DIR, 'chrome-profile');
let chromeHint = '';

function whichSync(bin) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try { if (fs.existsSync(p)) return p; } catch (e) {}
    }
  }
  return '';
}

// 找浏览器：ARB_CHROME 显式指定 > 各平台常见安装路径 > PATH
function findChrome() {
  if (process.env.ARB_CHROME) return process.env.ARB_CHROME;
  const cands = [];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    cands.push(
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      local ? path.join(local, 'Google\\Chrome\\Application\\chrome.exe') : '',
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      local ? path.join(local, 'Microsoft\\Edge\\Application\\msedge.exe') : '',
    );
  } else if (process.platform === 'darwin') {
    cands.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      const p = whichSync(n);
      if (p) cands.push(p);
    }
  }
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return '';
}

// 起浏览器。默认自己 spawn；SSH / 计划任务这类必须换会话启动的场景，用 ARB_CHROME_CMD 覆盖
function launchChrome() {
  const custom = process.env.ARB_CHROME_CMD || '';
  if (custom) {
    log('launching chrome by ARB_CHROME_CMD');
    try { exec(custom, () => {}); } catch (e) { log('launch err', e.message); }
    return true;
  }
  const bin = findChrome();
  if (!bin) {
    chromeHint = '没找到 Chrome：装一个 Chrome/Edge，或用 ARB_CHROME 指定可执行文件路径';
    log(chromeHint);
    return false;
  }
  try { fs.mkdirSync(CHROME_PROFILE, { recursive: true }); } catch (e) {}
  log('launching chrome', bin);
  try {
    const child = spawn(bin, [
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + CHROME_PROFILE,
      '--no-first-run',
      '--no-default-browser-check',
    ], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => log('chrome spawn err', e.message));
    child.unref();
  } catch (e) {
    chromeHint = 'Chrome 起不来：' + e.message;
    log(chromeHint);
    return false;
  }
  return true;
}

// 起不来时给一句人话，别只扔 chrome unavailable
function chromeDownError() {
  const why = chromeHint || '浏览器没响应 9222 端口，看看 Chrome 是不是被关掉了';
  return new Error('chrome unavailable：' + why);
}

let chromeLaunching = false;
async function ensureChrome() {
  try { await cdpApi('GET', '/json/version'); return true; } catch (e) {}
  if (chromeLaunching) { for (let i = 0; i < 40; i++) { await sleep(1500); try { await cdpApi('GET', '/json/version'); return true; } catch (e) {} } return false; }
  chromeLaunching = true;
  log('chrome down, launching');
  if (!launchChrome()) { chromeLaunching = false; return false; }
  for (let i = 0; i < 40; i++) { await sleep(1500); try { await cdpApi('GET', '/json/version'); chromeLaunching = false; log('chrome up'); return true; } catch (e) {} }
  chromeLaunching = false; log('chrome launch timeout'); return false;
}

const VERIFY_JS = "(()=>{try{var t=document.body.innerText||'';return /Just a moment|Verify you are human|确认您是真人|Checking your browser|Attention Required/i.test(t)||!!document.querySelector('iframe[src*=challenges.cloudflare.com],#challenge-form,#challenge-stage')}catch(e){return false}})()";
const EDITOR_SEL = `document.querySelector('textarea[name=message]')||document.querySelector('.ProseMirror[contenteditable="true"]')`;
const READY_JS = `!!(${EDITOR_SEL})`;
const VAL_JS = `(function(){var e=${EDITOR_SEL};if(!e)return 0;var v=(e.value!==undefined?e.value:(e.innerText||''));return String(v).replace(/[\s\u00a0\u200b]/g,'').length})()`;


// 左侧栏的会话列表：每个会话是一个指向 /agent/<uuid> 或 /c/<uuid> 的链接
const CONVERSATIONS_JS = String.raw`JSON.stringify((function(){
  var out=[], seen={};
  var as=[].slice.call(document.querySelectorAll('a[href]'));
  as.forEach(function(a){
    var h=a.getAttribute('href')||'';
    var m=h.match(/^\/(agent|c)\/([0-9a-f-]{8,})/i);
    if(!m||seen[h]) return;
    seen[h]=1;
    var t=String(a.innerText||'').replace(/\u00a0/g,' ').trim().split('\n')[0].trim();
    out.push({id:m[2], url:h, kind:m[1], title:t.slice(0,120)});
  });
  return {ok:true, conversations:out.slice(0,60), url:location.href};
})())`;

// 从当前页面读对话。Agent 页有明确的角色属性；/c/ 页只有气泡样式，按气泡对齐猜。
//
// Arena 的 agent 会话在 DOM 里只挂最新的一轮（transcriptReadStrategy=bounded），
// 更早的消息要靠 /api/chat/<id>/messages?cursor=... 一页页往回翻。游标藏在页面的
// RSC 负载里（"pagination":{"hasMore":..,"cursor":".."}），所以这里先从 DOM 取
// 最新一轮，再从负载里取游标往回翻，最后拼成完整历史。
const HISTORY_JS = String.raw`(async function(){
  function clean(t){ return String(t||'').replace(/\u00a0/g,' ').trim(); }
  function fromParts(m){
    var ps = Array.isArray(m && m.parts) ? m.parts : [];
    var t = ps.filter(function(p){ return p && p.type === 'text' && p.text; }).map(function(p){ return p.text; }).join('\n\n');
    return clean(t);
  }
  var out = [];
  var seen = {};
  var turns = [].slice.call(document.querySelectorAll('[data-agent-transcript-message="true"]'));
  turns.forEach(function(t){
    var mid = t.getAttribute('data-chat-message-id') || '';
    if (mid) seen[mid] = 1;
    var u = t.querySelector('[data-user-message-body-row="true"]');
    if (u) { var ut = clean(u.innerText); if (ut) out.push({role:'user', text:ut}); }
    var ps = [].slice.call(t.querySelectorAll('.prose')).filter(function(p){ return !p.closest('[data-user-message-body-row="true"]'); });
    var at = ps.map(function(p){ return clean(p.innerText); }).filter(Boolean).join('\n\n');
    if (at) out.push({role:'assistant', text:at});
  });
  if (!turns.length) {
    var ps2 = [].slice.call(document.querySelectorAll('.prose')).map(function(p){
      var r = p.getBoundingClientRect();
      return {p:p, y:r.top, x:r.left, text:clean(p.innerText)};
    }).filter(function(o){ return o.text; });
    ps2.sort(function(a,b){ return a.y - b.y || a.x - b.x; });
    ps2.forEach(function(o){ out.push({role: o.p.closest('[class*="bg-surface-raised"]') ? 'user' : 'assistant', text:o.text}); });
    if (!out.length) return JSON.stringify({ok:false, error:'页面里没读到对话'});
  }

  async function pageHtml(){
    var h = document.documentElement.outerHTML || '';
    if (h.indexOf('hasMore') >= 0) return h;
    try { var r = await fetch(location.href, {credentials:'include'}); return await r.text(); } catch (e) { return h; }
  }
  var html = (await pageHtml()).replace(/\\"/g, '"');
  var m = html.match(/"pagination":\{"hasMore":(true|false),"cursor":(null|"[^"]+")/);
  if (!m) return JSON.stringify({ok:true, messages:out, via:'dom-only', url:location.href, turns:out.length});
  var hasMore = m[1] === 'true';
  var cursor = m[2] === 'null' ? null : m[2].slice(1, -1);
  if (!hasMore || !cursor) return JSON.stringify({ok:true, messages:out, via:'role-attrs', url:location.href, turns:out.length});

  var id = location.pathname.split('/').filter(Boolean).pop();
  var older = [];
  var pages = 0;
  var lastErr = '';
  while (cursor && pages < 20) {
    var resp = null;
    try {
      resp = await fetch('/api/chat/' + id + '/messages?cursor=' + encodeURIComponent(cursor), {credentials:'include'});
    } catch (e) { lastErr = 'fetch: ' + e.message; break; }
    if (!resp.ok) { lastErr = 'http ' + resp.status; break; }
    var j = null;
    try { j = await resp.json(); } catch (e) { lastErr = 'json'; break; }
    var msgs = (j && j.messages) || [];
    var block = [];
    msgs.forEach(function(mm){
      var mid = mm.id || '';
      if (mid && seen[mid]) return;
      var text = fromParts(mm);
      if (!text) return;
      if (mid) seen[mid] = 1;
      block.push({role: mm.role === 'user' ? 'user' : 'assistant', text: text});
    });
    older = block.concat(older);
    pages++;
    var pg = (j && j.pagination) || {};
    cursor = (pg.hasMore && pg.cursor) ? pg.cursor : null;
  }
  var all = older.concat(out);
  return JSON.stringify({ok:true, messages:all, via: pages ? 'api-paged' : 'role-attrs', url:location.href, turns:all.length, pages:pages, err:lastErr});
})()`;
const RESUME_JS = "(function(){var cs=[].slice.call(document.querySelectorAll('[aria-label]')).filter(function(x){return /close review/i.test(x.getAttribute('aria-label')||'')})[0];if(cs){cs.click();return 2}var bs=[].slice.call(document.querySelectorAll('button'));var b=bs.filter(function(x){return /^\\s*(关闭|Close)\\s*$/i.test((x.getAttribute('aria-label')||''))})[0];if(b){b.click();return 1}return 0})()";
const REVIEW_JS = "(()=>{try{var t=(document.body&&document.body.innerText)||'';return t.indexOf('此任务成功了吗')>=0||t.indexOf('Did this task succeed')>=0}catch(e){return false}})()";

// 一轮结束后 Arena 会弹「此任务成功了吗」面板，它把输入框整个顶掉；
// 不关掉的话下一次提问会找不到 composer。只关面板，不重载页面。
async function dismissReview(c) {
  try {
    if (!(await c.ev(REVIEW_JS))) return false;
    const clicked = await c.ev(RESUME_JS).catch(() => 0);
    if (!clicked) {
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
    }
    await sleep(900);
    log('dismissed review panel', clicked ? 'button' : 'escape');
    return true;
  } catch (e) { return false; }
}

// 回合结束后面板要过一两秒才渲染出来，所以后台轮询，不拖慢响应。
function dismissReviewSoon(c) {
  (async () => {
    for (let i = 0; i < 20; i++) {
      if (await dismissReview(c)) return;
      await sleep(500);
    }
  })().catch(() => {});
}

async function waitReady(c, maxMs) {
  const t0 = Date.now();
  const lim = maxMs || READY_TIMEOUT_MS;
  while (Date.now() - t0 < lim) {
    if (await c.ev(VERIFY_JS)) throw needVerify(c);
    if (await c.ev(READY_JS)) { await sleep(600); return; }
    if (await c.ev(REVIEW_JS)) {
      await dismissReview(c);
      continue;
    }
    await sleep(700);
  }
  throw new Error('page not ready (no composer)');
}

// 桥重启后别急着开新标签：优先接管已有的 arena 页面，历史才不会丢、标签才不会堆
async function adoptTab(base) {
  let adoptTabId = null;
  try {
    const list = await cdpApi('GET', '/json/list');
    if (!Array.isArray(list)) return null;
    const used = new Set([...sessions.values()].map(x => x.tabId));
    const want = 'https://arena.ai' + base;
    const cand = list.filter(t => t.type === 'page' && String(t.url).indexOf(want) === 0 && !used.has(t.id));
    if (!cand.length) return null;
    for (const t of cand) {
      adoptTabId = t.id;
      const c = await connectTab(t.id).catch(() => null);
      if (!c) continue;
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT }).catch(() => {});
      await c.ev(INJECT).catch(() => {});
      // A finished agent turn leaves the review panel open, which hides the
      // composer; dismissing it is enough. Reloading a conversation tab
      // wedges the page, so try every candidate before giving up.
      for (let i = 0; i < 20; i++) {
        if (await c.ev(READY_JS).catch(() => false)) break;
        await dismissReview(c);
        await sleep(500);
      }
      if (await c.ev(READY_JS).catch(() => false)) {
        await sleep(600);
        return { tabId: t.id, cdp: c, url: t.url };
      }
      log('adopt: tab not usable, closing', t.id);
      try { await cdpApi('GET', '/json/close/' + t.id); } catch (e2) {}
    }
    return null;
  } catch (e) {
    log('adopt failed', e.message);
    // A tab we could not drive would otherwise linger forever; the profile
    // is dedicated to the bridge, so close it rather than leak it.
    if (adoptTabId) {
      try { await cdpApi('GET', '/json/close/' + adoptTabId); log('closed unusable tab', adoptTabId); } catch (e2) {}
    }
    return null;
  }
}

let lastMinAt = 0;
// 可选：让窗口缩到后台。不配 ARB_MINIMIZE_CMD 就什么都不做
function minimizeChrome() {
  const cmd = process.env.ARB_MINIMIZE_CMD || '';
  if (!cmd) return;
  const now = Date.now();
  if (now - lastMinAt < 1200) return;
  lastMinAt = now;
  try { exec(cmd, () => {}); } catch (e) {}
}

let lastRestoreAt = 0;
// 撞上人机验证时得让人看得见页面：先把标签页激活，再让窗口从最小化里出来。
// Windows 上桥常驻在 session 0，够不到 session 1 的窗口，所以默认走计划任务。
function restoreChrome() {
  const now = Date.now();
  if (now - lastRestoreAt < 3000) return;
  lastRestoreAt = now;
  const cmd = process.env.ARB_RESTORE_CMD || (process.platform === 'win32' ? 'schtasks /run /tn arena_restore' : '');
  if (!cmd) return;
  log('restoring chrome window for verification');
  try { exec(cmd, () => {}); } catch (e) {}
}

// 所有 NEED_VERIFY 的抛出点都走这里：先叫人，再报错
function needVerify(c) {
  restoreChrome();
  if (c && c.send) c.send('Page.bringToFront').catch(() => {});
  return new Error('NEED_VERIFY');
}

async function openTab(model, mode, models, navUrl) {
  const q = [];
  if (model && !/^arena-/.test(model)) q.push('model_a=' + encodeURIComponent(model));
  let base = '/agent';
  if (mode === 'direct') base = '/text/direct';
  else if (mode === 'side') {
    base = '/text/side-by-side';
    if (models && models[0]) q.push('model_a=' + encodeURIComponent(models[0]));
    if (models && models[1]) q.push('model_b=' + encodeURIComponent(models[1]));
  } else if (mode === 'battle') {
    // 对战没有独立路由：首页的 Mode 下拉里选 Battle
    base = '/';
  }
  const url = navUrl || ('https://arena.ai' + base + (q.length ? '?' + q.join('&') : ''));
  // 对战 / 并排每一轮都是独立会话，接管旧页面会把上一轮的问答带进来
  const adopted = (navUrl || mode === 'battle' || mode === 'side') ? null : await adoptTab(base);
  if (adopted) {
    log('adopted tab', adopted.tabId, String(adopted.url).slice(0, 60));
    minimizeChrome();
    return adopted;
  }
  const tab = await cdpApi('PUT', '/json/new?' + encodeURIComponent('about:blank'));
  if (!tab || !tab.id) throw new Error('cannot create tab: ' + JSON.stringify(tab).slice(0, 120));
  const c = await connectTab(tab.id);
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });
  await c.send('Page.navigate', { url });
  // 打开已有会话时要等历史渲染完，比空白页慢
  await waitReady(c, navUrl ? 45000 : undefined);
  if (mode === 'battle') {
    // 首页默认就是 battle，但用户上次选过别的模式时要显式切回来
    await c.ev("(function(){var s=document.querySelector('select');if(!s||s.value==='battle')return;var d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');d.set.call(s,'battle');s.dispatchEvent(new Event('change',{bubbles:true}));})()").catch(() => {});
    await sleep(1200);
  }
  log('tab ready', tab.id, url);
  minimizeChrome();
  return { tabId: tab.id, cdp: c, url };
}

/* ---------- input ---------- */
async function keyCombo(c, modifiers, key, code, vk) {
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}

async function waitIdle(c, quietMs, maxMs) {
  const q = quietMs || 1200, m = maxMs || 20000;
  const t0 = Date.now();
  let lastActive = Date.now();
  while (Date.now() - t0 < m) {
    const ls = (await listStreams(c)) || [];
    const active = ls.filter(x => !x.done);
    if (active.length) lastActive = Date.now();
    else if (Date.now() - lastActive >= q) return true;
    await sleep(300);
  }
  return false;
}


async function clickSend(c) {
  const ST = "(function(){var bs=[].slice.call(document.querySelectorAll('button'));var s=bs.filter(function(b){return /send/i.test(b.getAttribute('aria-label')||'')})[0];if(!s)return '';var q=s.getBoundingClientRect();var pe=getComputedStyle(s).pointerEvents;return JSON.stringify({x:Math.round(q.left+q.width/2),y:Math.round(q.top+q.height/2),pe:pe})})()";
  for (let i = 0; i < 20; i++) {
    // 合成鼠标事件在后台/最小化窗口里可能被丢弃；DOM click 兜底
    if (i >= 3) {
      const dom = await c.ev("(function(){var bs=[].slice.call(document.querySelectorAll('button'));var s=bs.filter(function(b){return /send/i.test(b.getAttribute('aria-label')||'')})[0];if(!s||s.disabled)return '';s.click();return 'ok'})()");
      if (dom === 'ok') { await sleep(900); if ((await c.ev(VAL_JS)) <= 1) return true; }
      await sleep(250);
      continue;
    }
    const raw = await c.ev(ST);
    if (raw && raw.charAt(0) === '{') {
      const p = JSON.parse(raw);
      if (p.pe !== 'none') {
        await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 });
        await sleep(80);
        await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
        await sleep(80);
        await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
        await sleep(900);
        const left = await c.ev(VAL_JS);
        log('clickSend try ' + i + ' left=' + left);
        if (left <= 1) return true;
      }
    }
    await sleep(250);
  }
  return false;
}

async function typePrompt(c, text) {
  await sleep(800);
  const pos = await c.evJson("(function(){var e=" + EDITOR_SEL + ";if(!e)return null;e.focus();var r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()");
  if (pos && pos.x) {
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await sleep(250);
  }
  await keyCombo(c, 2, 'a', 'KeyA', 65);
  await sleep(80);
  await keyCombo(c, 0, 'Backspace', 'Backspace', 8);
  await sleep(250);
  // 超过上限不能装作没发生：先告警，调用方在响应里能看到 truncated 标记
  if (text.length > MAX_PROMPT_CHARS) {
    log('WARN prompt truncated ' + text.length + ' -> ' + MAX_PROMPT_CHARS + ' chars');
  }
  const body = text.slice(0, MAX_PROMPT_CHARS);
  const want = body.replace(/[\s\u00a0\u200b]/g, '').length;
  // 一次插入整段：逐字符发键事件要几十秒，长 prompt 期间页面容易自己跳走
  await c.send('Input.insertText', { text: body });
  await sleep(500);
  let n = await c.ev(VAL_JS);
  if (n < Math.max(1, Math.floor(want * 0.9))) {
    // 回退：部分编辑器不吃 insertText，退回逐字符
    for (let i = 0; i < body.length; i++) {
      await c.send('Input.dispatchKeyEvent', { type: 'char', text: body.charAt(i) });
      if (i % 25 === 24) await sleep(20);
    }
    await sleep(700);
    n = await c.ev(VAL_JS);
  }
  log('typed len=' + n + ' url=' + String(await c.ev('location.href')).slice(0, 60));
  if (!n) throw new Error('typing failed (editor empty after insert)');
  let ok = await clickSend(c);
  if (!ok) {
    // 并排对照页的发送键有时不响应合成鼠标事件，回车是同一路径的兜底
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(1200);
    ok = (await c.ev(VAL_JS)) <= 1;
  }
  if (!ok) throw new Error('send failed (composer still holds text)');
}


/* ---------- stop generation ---------- */
const STOP_POS_JS = "(function(){var bs=[].slice.call(document.querySelectorAll('button'));var b=bs.filter(function(x){var s=(x.getAttribute('aria-label')||'')+' '+(x.innerText||'');return /stop|\u505c\u6b62/i.test(s)}).filter(function(x){var r=x.getBoundingClientRect();return r.width>2&&r.height>2})[0];if(!b)return '';var r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()";
async function isGenerating(c) {
  const v = await c.ev(STOP_POS_JS).catch(() => '');
  return !!(v && v.charAt(0) === '{');
}
async function stopGeneration(c) {
  const v = await c.ev(STOP_POS_JS).catch(() => '');
  if (!v || v.charAt(0) !== '{') return false;
  try { await realClick(c, JSON.parse(v)); } catch (e) { return false; }
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    if (!(await isGenerating(c))) return true;
  }
  return false;
}
/* ---------- stream reading ---------- */
async function listStreams(c) {
  // n 是绝对帧号（base + 本流帧数），和 readFrames 返回的 n 同一坐标系；
  // 之前这里用的是相对帧数，流被裁剪过（base>0）时游标会对不上，正文重复一遍
  const v = await c.evJson("(function(){return JSON.stringify((window.__arbStreams||[]).map(function(s){return {id:s.id,u:s.u,t:s.t,n:(s.base||0)+s.frames.length,done:!!s.done}}))})()");
  return v || [];
}
async function readFrames(c, sid, from) {
  const v = await c.evJson("(function(){var s=(window.__arbStreams||[]).filter(function(x){return x.id===" + sid + "})[0];if(!s)return JSON.stringify({gone:true});var b=s.base||0;var rel=" + from + "-b;if(rel<0)rel=0;return JSON.stringify({n:b+s.frames.length,done:!!s.done,f:s.frames.slice(rel)})})()");
  return v;
}

/* ---------- session ---------- */
const sessions = new Map();
const histories = new Map();
// 每个 CLI 会话最近一轮对战的结果，/vote 用它把投票和答案对上
const battleRounds = new Map();
// 标签页被关掉/重建后，页面自己的上下文没了；下一条请求要把服务端历史补进 prompt，
// 否则对话中途遇到一次错误就悄悄失忆，用户只会觉得「它怎么忘了刚才说的」
const contextLost = new Set();
// 会话名 -> 网页端会话地址。标签页被淘汰或重建时导航回去，页面自己会把完整历史
//（包括人工在网页上做的操作）加载回来，比拿内存里的 histories 回放可靠。
// 存盘是因为桥一重启内存就空了，那样记了也白记。
const SESSION_URLS_FILE = path.join(STATE_DIR, 'session-urls.json');
const sessionUrls = new Map();
try {
  const j = JSON.parse(fs.readFileSync(SESSION_URLS_FILE, 'utf8'));
  for (const k of Object.keys(j)) if (typeof j[k] === 'string') sessionUrls.set(k, j[k]);
} catch (e) {}
function saveSessionUrls() {
  try { fs.writeFileSync(SESSION_URLS_FILE, JSON.stringify(Object.fromEntries(sessionUrls))); } catch (e) {}
}

function setHistory(name, h) {
  histories.delete(name);
  histories.set(name, h);
  while (histories.size > MAX_HISTORY_KEYS) histories.delete(histories.keys().next().value);
}

async function resetSession(name, why) {
  const s = sessions.get(name);
  if (!s) return;
  try { await cdpApi('GET', '/json/close/' + s.tabId); } catch (e) {}
  try { s.cdp.close(); } catch (e) {}
  sessions.delete(name);
  if (histories.has(name)) contextLost.add(name);
  log('session reset ' + name + (why ? ' (' + why + ')' : ''));
}

// 标签页堆积是长期使用的主要痛点：超过上限就淘汰最久未用的一条
async function evictSessions(keepKey) {
  if (sessions.size < MAX_SESSIONS) return;
  const victims = [...sessions.entries()]
    .filter(([k, s]) => k !== keepKey && !s.busy)
    .sort((a, b) => (a[1].lastAsk || 0) - (b[1].lastAsk || 0));
  while (sessions.size >= MAX_SESSIONS && victims.length) {
    const [k, s] = victims.shift();
    log('evict session ' + k + ' (limit ' + MAX_SESSIONS + ')');
    try { await cdpApi('GET', '/json/close/' + s.tabId); } catch (e) {}
    try { s.cdp.close(); } catch (e) {}
    sessions.delete(k);
    histories.delete(k);
  }
}

async function getSession(name, opts) {
  const key = name || DEFAULT_SESSION;
  let s = sessions.get(key);
  if (s && opts.fresh) { try { await cdpApi('GET', '/json/close/' + s.tabId); } catch (e) {} try { s.cdp.close(); } catch (e) {} sessions.delete(key); s = null; }
  if (s) {
    const alive = await s.cdp.ev("1+1").catch(() => null);
    if (alive === 2) return s;
    log('tab for ' + key + ' is gone, reopening');
    sessions.delete(key); s = null;
    if (histories.has(key)) contextLost.add(key);
  }
  if (!(await ensureChrome())) throw chromeDownError();
  await evictSessions(key);
  let r = null;
  if (opts.fresh) { sessionUrls.delete(key); saveSessionUrls(); } // 新会话不留旧地址
  // 标签页没了就导航回原会话，页面自己加载完整历史
  let resumeUrl = opts.fresh ? null : (opts.url || sessionUrls.get(key) || null);
  for (let attempt = 0; attempt < 3; attempt++) {
    try { r = await openTab(opts.model, opts.mode, opts.models, resumeUrl); break; }
    catch (e) {
      log('openTab failed #' + attempt + ': ' + e.message);
      if (resumeUrl && !opts.url) {
        // 记下的地址打不开（会话被删了），丢掉它退回首页，别一直撞
        log('resume url unusable, falling back: ' + resumeUrl);
        sessionUrls.delete(key);
        saveSessionUrls();
        resumeUrl = null;
        continue;
      }
      if (attempt === 2) throw e;
      await sleep(1500);
      await ensureChrome();
    }
  }
  if (resumeUrl) contextLost.delete(key); // 页面自带历史，不用回放
  s = { name: key, tabId: r.tabId, cdp: r.cdp, model: opts.model || '', mode: opts.mode || 'direct', lastAsk: 0, busy: false };
  sessions.set(key, s);
  return s;
}

/* ---------- ask ---------- */
async function askOnce(s, prompt, onDelta, ctx) {
  const c = s.cdp;
  const aborted = () => !!(ctx && ctx.aborted && ctx.aborted());
  if (await c.ev(VERIFY_JS)) throw needVerify(c);
  if (!(await c.ev(READY_JS))) { await waitReady(c); }
  if (await isGenerating(c)) {
    log('previous turn still generating, stopping it first');
    await stopGeneration(c);
    await sleep(800);
  }
  await waitConversation(c);
  await waitIdle(c);
  const preList = (await listStreams(c)) || [];
  const pre = new Map(preList.map(x => [x.id, x.n]));
  const sendTs = Date.now();
  await typePrompt(c, prompt);
  const t0 = Date.now();
  let text = '', reasoning = '', done = false, routed = '', tick = 0, doneNoTextAt = 0, doneSeen = false;
  const cursors = new Map();
  const tools = [];
  let lastFrameAt = Date.now();

  // 帧格式的解析全部在 lib/parse.js，这里只管累积和分发
  const applyFrame = f => {
    const r = parseFrame(f);
    for (const ev of r.events) {
      if (ev.type === 'text') { text += ev.text; onDelta && onDelta({ type: 'text', text: ev.text }); }
      else if (ev.type === 'reasoning') { reasoning += ev.text; onDelta && onDelta({ type: 'reasoning', text: ev.text }); }
      else if (ev.type === 'tool') { tools.push({ name: ev.name, input: ev.input }); onDelta && onDelta({ type: 'tool', name: ev.name, input: ev.input }); }
    }
    if (r.routed) routed = r.routed;
    if (r.done) done = true;
    if (r.error) { const err = new Error(r.error); err.fatal = true; throw err; }
    return r;
  };

  let sendRetries = 0, lastSendAt = Date.now();
  while (Date.now() - t0 < ASK_MAX_MS) {
    await sleep(POLL_MS);
    if (c.closed) throw new Error('tab closed');
    // 客户端已经断开（Ctrl-C）：任务没必要继续跑，占着全局队列
    if (aborted()) { throw Object.assign(new Error('aborted by client'), { aborted: true }); }
    const now = (await listStreams(c)) || [];
    const cand = now.filter(x => /create-evaluation|create-chat|realtime|ai-proxy/.test(x.u) && (x.t >= sendTs - 1500 || pre.has(x.id)));
    if (++tick % 30 === 0) log('poll', JSON.stringify({ cur: [...cursors], len: text.length, streams: now.length, done }));
    if (!cand.length) {
      if (await c.ev(VERIFY_JS)) throw needVerify(c);
      if (Date.now() - lastSendAt > 10000 && sendRetries < 2) {
        const left = await c.ev(VAL_JS);
        if (left <= 1) {
          sendRetries++;
          log('no stream after ' + Math.round((Date.now() - lastSendAt) / 1000) + 's, re-sending #' + sendRetries);
          try { await typePrompt(c, prompt); } catch (e) { log('re-send failed', e.message); }
          lastSendAt = Date.now();
          continue;
        }
      }
      if (Date.now() - lastSendAt > 45000) throw new Error('no stream appeared (send may have failed)');
      continue;
    }
    let anyDone = false;
    for (const st of cand) {
      if (!cursors.has(st.id)) { cursors.set(st.id, pre.get(st.id) || 0); log('stream', st.id, st.u.slice(0, 70), 'from', cursors.get(st.id)); }
      const r = await readFrames(c, st.id, cursors.get(st.id));
      if (!r || r.gone) continue;
      if (r.f && r.f.length) {
        cursors.set(st.id, r.n); lastFrameAt = Date.now();
        for (const f of r.f) {
          if (applyFrame(f).out) st.hasOut = true;
        }
      }
      if (r.done && st.hasOut) anyDone = true;
    }
    if (anyDone) doneSeen = true;
    if (done) break;
    if (doneSeen) {
      if (!doneNoTextAt) doneNoTextAt = Date.now();
      if (text.trim() && Date.now() - lastFrameAt > 8000) { done = true; break; }
      if (Date.now() - doneNoTextAt > 20000) throw new Error('stream ended with no text (session may be in review state)');
    }
    if (Date.now() - lastFrameAt > ASK_IDLE_MS) throw new Error('stalled: no frame for ' + Math.round(ASK_IDLE_MS / 1000) + 's');
  }
  if (!text.trim()) throw new Error('empty answer from upstream');
  dismissReviewSoon(c);
  return { text, reasoning, routed, done, tools };
}

/* ---------- battle / side-by-side ---------- */
// 对战页把两个回答并排放在一个 carousel 里，每条是一个子节点：
// 第一行是「助手 A / 助手 B」（投票后换成真实模型名），下面是正文。
const BATTLE_PANES_JS = "(function(){var cs=[].slice.call(document.querySelectorAll('div')).filter(function(e){return String(e.className||'').indexOf('@container/carousel')>=0});if(!cs.length)return '';var c=cs[cs.length-1];if(c.childElementCount!==2)return '';function pane(k){var sp=[].slice.call(k.querySelectorAll('span')).map(function(s){return (s.innerText||'').trim()}).filter(Boolean);var t=(k.innerText||'').trim();var lb=sp[0]||'';return {label:lb,text:t.slice(lb.length).trim()}}return JSON.stringify({a:pane(c.children[0]),b:pane(c.children[1])})})()";
const VOTE_READY_JS = "(()=>{var re=/^(A\s*更好|B\s*更好|都好|都不好|A is better|B is better|Tie|Both are bad|Both are good)$/i;var bs=[].slice.call(document.querySelectorAll('button'));return bs.filter(function(b){return re.test((b.innerText||'').trim())}).length>=2})()";
const VOTE_RE = {
  a: /^A\s*更好$|^A is better$/i,
  b: /^B\s*更好$|^B is better$/i,
  tie: /^都好$|^Tie$|^Both are good$/i,
  both: /^都不好$|^Both are bad$/i,
};
const ANON_LABEL_RE = /^(助手|assistant)\s*[AB]$/i;
// 模型按钮渲染出来才算页面水合完成：过早输入时 React 还没挂上发送处理器
const MODELS_READY_JS = "(()=>{var bs=[].slice.call(document.querySelectorAll('button'));var m=bs.filter(function(b){var t=(b.innerText||'').trim();return t.length>3&&t.length<40&&/^(gemini|gpt|claude|glm|qwen|kimi|grok|deepseek|mimo|muse|inkling|mistral|auto|max)/i.test(t)});return m.length>=2})()";

async function readBattlePanes(c) {
  const raw = await c.ev(BATTLE_PANES_JS).catch(() => '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

const NOT_READY_RE = /^(Generating|生成中|Thinking|思考中)[.…]*$/i;
const paneReady = (t) => !!t && !NOT_READY_RE.test(String(t).trim());

async function askBattle(s, prompt) {
  const c = s.cdp;
  if (await c.ev(VERIFY_JS)) throw needVerify(c);
  if (!(await c.ev(READY_JS))) await waitReady(c);
  for (let i = 0; i < 24; i++) { if (await c.ev(MODELS_READY_JS).catch(() => false)) break; await sleep(500); }
  await sleep(600);
  if (await isGenerating(c)) { await stopGeneration(c); await sleep(800); }
  await typePrompt(c, prompt);
  const t0 = Date.now();
  let lastSig = '', changedAt = Date.now(), sawSendStuck = 0;
  while (Date.now() - t0 < ASK_MAX_MS) {
    await sleep(POLL_MS);
    if (c.closed) throw new Error('tab closed');
    if (await c.ev(VERIFY_JS)) throw needVerify(c);
    const p = await readBattlePanes(c);
    if (p && paneReady(p.a.text) && paneReady(p.b.text)) {
      if (await c.ev(VOTE_READY_JS)) return p;
      const sig = p.a.text.length + ':' + p.b.text.length;
      if (sig !== lastSig) { lastSig = sig; changedAt = Date.now(); }
      else if (Date.now() - changedAt > 8000) return p;  // 投票条没渲染也别卡死
    } else if (!p) {
      const left = await c.ev(VAL_JS).catch(() => 0);
      if (left > 1) {
        sawSendStuck++;
        if (sawSendStuck === 3) log('warn: composer holds text after send, keep waiting');
      }
    }
  }
  throw new Error('battle timeout: no two answers');
}

async function voteBattle(c, choice) {
  const re = VOTE_RE[choice];
  if (!re) throw new Error('bad choice');
  const raw = await c.ev("(function(){var re=new RegExp(" + JSON.stringify(re.source) + ",'i');var bs=[].slice.call(document.querySelectorAll('button'));for(var i=0;i<bs.length;i++){var t=(bs[i].innerText||'').trim();if(re.test(t)){var r=bs[i].getBoundingClientRect();if(r.width>0&&r.height>0)return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})}}return ''})()").catch(() => '');
  if (!raw || raw.charAt(0) !== '{') throw new Error('vote button not found (already voted?)');
  await realClick(c, JSON.parse(raw));
  await sleep(1200);
  for (let i = 0; i < 12; i++) {
    const p = await readBattlePanes(c);
    if (p && p.a.label && !ANON_LABEL_RE.test(p.a.label)) return p;
    await sleep(500);
  }
  return await readBattlePanes(c);
}

/* ---------- queue ---------- */
const queue = [];
let working = false;
// 队列长度不含正在跑的那一个：文档里的「上限 4」指的是排队数
const queueDepth = () => queue.length;
const busyFull = () => queue.length >= MAX_QUEUE;
function enqueue(fn) {
  return new Promise((res, rej) => {
    if (queue.length >= MAX_QUEUE) return rej(Object.assign(new Error('busy: queue full'), { busy: true }));
    queue.push({ fn, res, rej });
    pump();
  });
}
async function pump() {
  if (working) return;
  working = true;
  while (queue.length) {
    const job = queue.shift();
    try { job.res(await job.fn()); } catch (e) { job.rej(e); }
  }
  working = false;
}

/* ---------- http ---------- */
function readBody(req) {
  return new Promise((res, rej) => {
    let b = ''; let n = 0;
    req.on('data', d => { n += d.length; if (n > 4 * 1024 * 1024) { rej(new Error('body too large')); req.destroy(); } b += d; });
    req.on('end', () => res(b));
    req.on('error', rej);
  });
}

// 长任务（Agent 跑工具时可能几分钟没有文本）必须有心跳，否则客户端按空闲超时断开
function startSSE(res) {
  res.writeHead(200, Object.assign({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }, CORS_HEADERS));
  res.write(': open\n\n');
  const ping = setInterval(() => {
    try { if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n'); } catch (e) {}
  }, SSE_PING_MS);
  if (ping.unref) ping.unref();
  return () => { clearInterval(ping); try { res.end(); } catch (e) {} };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Arena-Drop-System',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// 隧道把 17892 曝到手机上之后，同机任意进程都能用这个桥；ARB_TOKEN 非空时要求 Bearer
function authorized(req) {
  if (!AUTH_TOKEN) return true;
  const h = String(req.headers.authorization || '');
  return h === 'Bearer ' + AUTH_TOKEN;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => {
    const s = JSON.stringify(obj);
    try {
      res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) }, CORS_HEADERS));
      res.end(s);
    } catch (e) { /* 客户端已断开 */ }
  };

  if (req.method === 'OPTIONS') {
    try { res.writeHead(204, CORS_HEADERS); res.end(); } catch (e) {}
    return;
  }
  if (!authorized(req) && u.pathname !== '/health') {
    log('401 ' + req.method + ' ' + u.pathname);
    return send(401, { error: { message: 'unauthorized: set Authorization: Bearer $ARB_TOKEN', type: 'auth_error' } });
  }

  if (u.pathname === '/health') {
    const ok = await cdpApi('GET', '/json/version').then(() => true).catch(() => false);
    if (!ok) ensureChrome().catch(() => {});
    return send(200, {
      ok, chrome: ok, version: VERSION, uptime: Math.round(process.uptime()),
      sessions: [...sessions.keys()], queue: queueDepth(), working,
      limits: { maxQueue: MAX_QUEUE, maxSessions: MAX_SESSIONS, minGapMs: MIN_GAP_MS, maxPromptChars: MAX_PROMPT_CHARS },
      auth: !!AUTH_TOKEN,
    });
  }
  if (u.pathname === '/debug') {
    const name = u.searchParams.get('session') || DEFAULT_SESSION;
    const s = sessions.get(name);
    if (!s) return send(404, { error: 'no session', sessions: [...sessions.keys()] });
    try {
      const st = await s.cdp.evJson("JSON.stringify({inst:!!window.__arbInstalled,seq:window.__arbSeq,st:(window.__arbStreams||[]).map(function(x){return{id:x.id,u:x.u,n:x.frames.length,done:!!x.done}})})");
      const href = await s.cdp.ev('location.href');
      return send(200, { state: st, url: href });
    } catch (e) { return send(500, { error: e.message }); }
  }
  if (u.pathname === '/models') {
    return send(200, { models: ['auto', 'max'] });
  }
  if (u.pathname === '/repos' || u.pathname === '/repo') {
    const rn = u.searchParams.get('session') || 'main';
    const want = u.searchParams.get('name') || '';
    // cached=0 / false 不能当缓存：'0' 在 JS 里是真值，会把切换请求吞掉
    const cachedFlag = u.searchParams.get('cached');
    if (cachedFlag && cachedFlag !== '0' && cachedFlag !== 'false')
      return send(200, { repo: repoCache.repo, repos: repoCache.repos, cached: true });
    const doRepo = async () => {
      // 仓库芯片只长在「还没开始对话」的 /agent 页面上。一旦进了具体会话，
      // 输入框下面只剩一条只读的仓库栏（仓库 + 分支 + Create PR），点不开选择器。
      // 所以：读列表用专门的空白页，切换则必须把会话页导航回 /agent。
      const key = want ? rn : rn + '#repos';
      const s = await getSession(key, { mode: 'agent', url: 'https://arena.ai/agent' });
      if (want) await s.cdp.send('Page.navigate', { url: 'https://arena.ai/agent' }).catch(() => {});
      await waitReady(s.cdp);
      const escKey = async () => {
        await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
        await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
        await sleep(400);
      };
      const readList = async () => {
        const raw = await s.cdp.ev(LIST_REPOS_JS).catch(() => '');
        try { return raw ? JSON.parse(raw) : { items: [] }; } catch (e) { return { items: [] }; }
      };
      let chip = await s.cdp.ev(CHIP_TEXT_JS).catch(() => '');
      for (let i = 0; i < 10 && !chip; i++) { await sleep(700); chip = await s.cdp.ev(CHIP_TEXT_JS).catch(() => ''); }
      if (!chip) throw new Error('页面上没有仓库芯片（会话页面？）');
      if (want && chip === want) return { ok: true, repo: chip, repos: repoCache.repos || [], changed: false };
      const chipPos = await s.cdp.ev(CHIP_POS_JS).catch(() => '');
      if (!chipPos || chipPos.charAt(0) !== '{') throw new Error('找不到仓库芯片的位置');
      await realClick(s.cdp, JSON.parse(chipPos));
      await sleep(1500);
      let list = { items: [] };
      for (let i = 0; i < 10; i++) {
        list = await readList();
        if (list.items && list.items.length) break;
        await sleep(600);
      }
      if (!list.items || !list.items.length) { await escKey(); throw new Error('弹层里没读到仓库列表（GitHub 未连接？）'); }
      if (!want) { await escKey(); return { repo: chip, repos: list.items }; }
      let pos = '';
      for (let i = 0; i < 10; i++) {
        pos = await s.cdp.ev(repoPosJs(want)).catch(() => '');
        if (pos && pos.charAt(0) === '{') break;
        pos = '';
        await sleep(400);
      }
      if (!pos) { await escKey(); throw new Error('列表里没有 ' + want + ' | available: ' + list.items.join(', ')); }
      await realClick(s.cdp, JSON.parse(pos));
      await sleep(1200);
      if (await s.cdp.ev(DIALOG_OPEN_JS) === '1') await escKey();
      let after = '';
      for (let i = 0; i < 10; i++) { after = await s.cdp.ev(CHIP_TEXT_JS).catch(() => ''); if (after === want) break; await sleep(600); }
      return { ok: true, repo: after || want, repos: list.items, changed: true };
    };
    // 走同一个队列：否则切仓库会在一轮回答跑到一半时去点页面，把正在生成的状态搅乱
    return enqueue(doRepo).then(r => {
      minimizeChrome();
      // 真的切了仓库才等于开新对话：页面上没有旧上下文了，服务端历史也要跟着清
      if (r.changed) { histories.delete(rn); contextLost.delete(rn); }
      repoCache = { repo: r.repo || '', repos: r.repos || [] };
      try { fs.writeFileSync(path.join(STATE_DIR, 'repos.json'), JSON.stringify(repoCache)); } catch (e) {}
      send(200, r);
    }).catch(e => { minimizeChrome(); send(e && e.busy ? 429 : 500, { error: e.message }); });
  }
  if (u.pathname === '/upload' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(400, { error: 'bad json' }); }
    const rn = body.session || 'main';
    const files = (Array.isArray(body.files) ? body.files : [body.file]).filter(Boolean).map(String);
    if (!files.length) return send(400, { error: 'no files' });
    const missing = files.filter(f => { try { return !fs.statSync(f).isFile(); } catch (e) { return true; } });
    if (missing.length) return send(400, { error: 'not found: ' + missing.join(', ') });
    // 这个接口会把本地文件内容送到 arena.ai，属于外发面，白名单外一律拒绝
    if (UPLOAD_ROOTS.length) {
      const denied = files.filter(f => !within(f, UPLOAD_ROOTS));
      if (denied.length) return send(403, { error: 'outside ARB_UPLOAD_ROOTS: ' + denied.join(', ') });
    }
    const names = files.map(f => path.basename(f));
    const doUp = async () => {
      if (!(await ensureChrome())) throw chromeDownError();
      const s = await getSession(rn, { mode: 'agent' });
      await waitReady(s.cdp);
      // composer 挂上之后文件框还要再晚一拍才进 DOM，先等它；等不到就点附件按钮逼它出来
      let objectId = '', backendNodeId = 0;
      for (let i = 0; i < 20; i++) {
        const obj = await s.cdp.send('Runtime.evaluate', {
          expression: "document.querySelector('input[type=file]')",
          objectGroup: 'arena-upload',
        }).catch(() => null);
        objectId = (obj && obj.result && obj.result.objectId) || '';
        if (objectId) break;
        if (i === 4) {
          const fc = await clickAttach(s.cdp);
          if (fc && fc.backendNodeId) { backendNodeId = fc.backendNodeId; break; }
        }
        await sleep(400);
      }
      if (objectId) await s.cdp.send('DOM.setFileInputFiles', { files, objectId });
      else if (backendNodeId) await s.cdp.send('DOM.setFileInputFiles', { files, backendNodeId });
      else {
        await s.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'arena-upload' }).catch(() => {});
        throw new Error('no file input on page');
      }
      // 用完就放，别让文件节点在页面里挂一整轮
      await s.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'arena-upload' }).catch(() => {});
      await sleep(1500);
      let seen = [];
      for (let i = 0; i < 20; i++) {
        const txt = await s.cdp.ev('(document.body&&document.body.innerText)||""');
        seen = names.filter(n => String(txt).indexOf(n) >= 0);
        if (seen.length === names.length) break;
        await sleep(700);
      }
      if (seen.length !== names.length) throw new Error('upload not confirmed: ' + names.filter(n => seen.indexOf(n) < 0).join(', '));
      return { ok: true, attached: seen, files: names };
    };
    // 同样走队列：上传要往输入框里塞文件，和正在生成的回答抢页面必然打架
    return enqueue(doUp).then(r => send(200, r)).catch(e => send(/NEED_VERIFY/.test(e.message) ? 409 : (e && e.busy ? 429 : 500), { error: e.message }));
  }
  if (u.pathname === '/battle' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(400, { ok: false, error: 'bad json' }); }
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return send(400, { ok: false, error: 'empty prompt' });
    const session = body.session || DEFAULT_SESSION;
    const mode = body.mode === 'side' ? 'side' : 'battle';
    const models = Array.isArray(body.models) ? body.models.map(String).filter(Boolean).slice(0, 2) : [];
    // 对战标签页独立于 agent/direct 的聊天页，用后缀区分，免得互相抢页面
    const key = session + '#battle';
    const opts = { mode, models, fresh: true };
    const run = async () => {
      if (!(await ensureChrome())) throw chromeDownError();
      const s = await getSession(key, opts);
      s.busy = true;
      try {
        const gap = Date.now() - (s.lastAsk || 0);
        if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
        s.lastAsk = Date.now();
        const p = await askBattle(s, prompt);
        battleRounds.set(session, { panes: p, mode, at: Date.now() });
        return p;
      } finally {
        s.busy = false;
      }
    };
    try {
      const p = await enqueue(run);
      minimizeChrome();
      return send(200, { ok: true, session, mode, a: p.a, b: p.b });
    } catch (e) {
      minimizeChrome();
      log('battle error:', e.message);
      return send(/NEED_VERIFY/.test(e.message) ? 409 : (e.busy ? 429 : 500), { ok: false, error: e.message });
    }
  }
  if (u.pathname === '/vote' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(400, { ok: false, error: 'bad json' }); }
    const session = body.session || DEFAULT_SESSION;
    const choice = String(body.choice || '').toLowerCase();
    if (!VOTE_RE[choice]) return send(400, { ok: false, error: 'choice must be a|b|tie|both' });
    const s = sessions.get(session + '#battle');
    if (!s) return send(404, { ok: false, error: 'no battle round for this session' });
    try {
      const p = await enqueue(() => voteBattle(s.cdp, choice));
      const round = battleRounds.get(session);
      if (round) { round.voted = choice; round.revealed = p; }
      return send(200, { ok: true, choice, a: p.a, b: p.b });
    } catch (e) {
      return send(/NEED_VERIFY/.test(e.message) ? 409 : 500, { ok: false, error: e.message });
    }
  }
  if (u.pathname === '/new') {
    const name = u.searchParams.get('session') || DEFAULT_SESSION;
        histories.delete(name); contextLost.delete(name); sessionUrls.delete(name); saveSessionUrls();
    const s = sessions.get(name);
    if (s) { try { await cdpApi('GET', '/json/close/' + s.tabId); } catch (e) {} try { s.cdp.close(); } catch (e) {} sessions.delete(name); }
    const bs = sessions.get(name + '#battle');
    if (bs) { try { await cdpApi('GET', '/json/close/' + bs.tabId); } catch (e) {} try { bs.cdp.close(); } catch (e) {} sessions.delete(name + '#battle'); }
    battleRounds.delete(name);
    return send(200, { ok: true });
  }
  if (u.pathname === '/conversations') {
    const name = u.searchParams.get('session') || DEFAULT_SESSION;
    try {
      const s = await getSession(name, { mode: 'agent' });
      if (await s.cdp.ev(VERIFY_JS)) return send(409, { ok: false, error: needVerify(s.cdp).message });
      const data = await s.cdp.evJson(CONVERSATIONS_JS);
      if (!data || !data.ok) return send(500, { ok: false, error: '页面里没读到会话列表' });
      return send(200, data);
    } catch (e) {
      return send(/NEED_VERIFY/.test(e.message) ? 409 : 500, { ok: false, error: e.message });
    }
  }

  if (u.pathname === '/history') {
    const name = u.searchParams.get('session') || DEFAULT_SESSION;
    const s = sessions.get(name);
    if (!s) return send(404, { ok: false, error: '这个会话没有打开的标签页（先问一句，或先 /resume 选一个）' });
    try {
      const data = await s.cdp.evJson(HISTORY_JS);
      if (!data || !data.ok) return send(500, { ok: false, error: '页面里没读到对话' });
      return send(200, Object.assign({ session: name }, data));
    } catch (e) {
      return send(500, { ok: false, error: e.message });
    }
  }

  if (u.pathname === '/open' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(400, { ok: false, error: 'bad json' }); }
    const name = body.session || DEFAULT_SESSION;
    let target = String(body.url || '');
    if (target.charAt(0) === '/') target = 'https://arena.ai' + target;
    if (!/^https:\/\/arena\.ai\/(agent|c)\/[0-9a-f-]{8,}/i.test(target)) {
      return send(400, { ok: false, error: 'url 必须是 arena.ai 的会话地址' });
    }
    try {
      let s = sessions.get(name);
      if (s && s.busy) return send(409, { ok: false, error: '正在生成，先停下再切换会话' });
      if (!s) {
        s = await getSession(name, { mode: body.mode || 'agent', url: target });
      } else {
        try {
          const cur = String(await s.cdp.ev('location.href') || '');
          if (cur !== target) {
            // 后台标签页的重载会被 Chrome 节流，先提到前台再导航
            await s.cdp.send('Page.bringToFront').catch(() => {});
            await s.cdp.send('Page.navigate', { url: target });
          }
          await waitReady(s.cdp, 25000);
        } catch (e) {
          // 标签页可能已经卡死（渲染进程崩了但 JS 还活着），换一个新标签页重来
          log('open failed on existing tab, reopening: ' + e.message);
          try { await cdpApi('GET', '/json/close/' + s.tabId); } catch (e2) {}
          try { s.cdp.close(); } catch (e2) {}
          sessions.delete(name);
          s = await getSession(name, { mode: body.mode || 'agent', url: target });
        }
        // 对话正文比输入框晚一点渲染，等它出来再让客户端读历史
        for (let i = 0; i < 10; i++) {
          const got = await s.cdp.ev("!!document.querySelector('[data-user-message-body-row=\"true\"],[data-agent-transcript-message=\"true\"],.prose')").catch(() => false);
          if (got) break;
          await sleep(400);
        }
      }
      // 页面已经是唯一上下文，旧的回放缓存作废
      histories.delete(name);
      contextLost.delete(name);
      sessionUrls.set(name, target);
      saveSessionUrls();
      minimizeChrome();
      return send(200, { ok: true, session: name, url: target });
    } catch (e) {
      return send(/NEED_VERIFY/.test(e.message) ? 409 : 500, { ok: false, error: e.message });
    }
  }

  if ((u.pathname === '/v1/chat/completions' || u.pathname === '/chat/completions') && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(400, { error: { message: 'bad json', type: 'invalid_request_error' } }); }
const ctext = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x && typeof x === 'object' ? String(x.text || x.content || '') : String(x || '')).join('') : (c == null ? '' : String(c));
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const sys = msgs.filter(m => m && m.role === 'system').map(m => ctext(m.content)).join('\n\n');
    log('v1 msgs=' + msgs.length + ' roles=' + msgs.map(m => m && m.role).join(','));
    const prior = msgs.filter(m => m && m.role !== 'system' && m.content);
    if (!prior.length) return send(400, { error: { message: 'no user message', type: 'invalid_request_error' } });
    const last = ctext(prior[prior.length - 1].content);
    const name = body.user || body.session || 'main';
    const bodyPrior = prior.length > 1 ? prior.slice(0, -1) : null;
    const srvPrior = histories.get(name) || [];
    const fresh = body.arena_new === true || body.arena_continue === false;
    // 标签页重建过（LRU 淘汰 / 出错重置）时页面自己没上下文，得把服务端历史补回去，
    // 否则用户在对话中途会遇到「它怎么忘了刚才说的」这种无声失忆
    // 进程刚起、标签页被 LRU 淘汰或重建过时，页面里没有上下文；
    // 只有这种情况才需要把客户端带来的历史回放进去。
    const needReplay = fresh || contextLost.has(name) || !sessions.has(name);
    // 新会话（fresh）没有客户端历史时，绝不能用服务端历史回填：那是上一个会话
    // 的内容，塞进新标签页会让模型把旧对话当成当前上下文，看起来就是「串台」。
    const useHist = needReplay
      ? (bodyPrior && bodyPrior.length ? bodyPrior : (fresh ? null : (srvPrior.length ? srvPrior : null)))
      : null;
    if (needReplay && !useHist) log('replay skipped, no history for ' + name);
    let prompt = last;
    if (useHist) {
      const hist = useHist.map(m => (m.role === 'assistant' ? '助手' : '用户') + '：' + ctext(m.content)).join('\n\n');
      prompt = '以下是本次对话之前的记录，请接着最后一条继续回答，不要复述历史。\n\n【对话记录】\n' + hist + '\n\n【当前问题】\n' + last;
    }
    const dropSys = String(req.headers['x-arena-drop-system'] || '') === '1';
    // Arena 自带系统提示词，客户端的一律不转发
    const CTX_RE = /-{3}[^\n]*Context from:[\s\S]*?End of Context from:[^\n]*\n?-{0,3}/g;
    if (CTX_RE.test(prompt)) { prompt = prompt.replace(CTX_RE, ''); log('ctx stripped -> ' + prompt.length); }
    // 只剥客户端确实会注入的那几个标签。以前这里用 /<\/?[a-z-]+-[a-z-]+>/ 一把梭，
    // 用户问「<my-component> 为什么会这样」时标签会连同标签名一起被吃掉
    prompt = prompt
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<(environment_details|environment_context|user_info|available_tools|repo_context)>[\s\S]*?<\/\1>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!prompt.trim()) return send(400, { error: { message: 'empty prompt', type: 'invalid_request_error' } });
    // 默认只记长度；正文属于隐私，排障时用 ARB_DEBUG_PROMPT=1 显式打开
    if (DEBUG_PROMPT) {
      log('PROMPT len=' + prompt.length + ' head=' + prompt.slice(0, 200).replace(/[\r\n]+/g, ' '));
      try { fs.writeFileSync(path.join(STATE_DIR, 'last-prompt.txt'), prompt); } catch (e) {}
    } else {
      log('PROMPT len=' + prompt.length);
    }
    const truncated = prompt.length > MAX_PROMPT_CHARS;
    const opts = { model: body.model && body.model !== 'auto' ? body.model : '', mode: (body.metadata && body.metadata.mode) || 'agent', models: (function (m) { if (Array.isArray(m)) return m.map(String).filter(Boolean).slice(0, 2); if (typeof m === 'string' && m) return m.split(',').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 2); return []; })(body.metadata && body.metadata.models), fresh };
    const wantStream = !!body.stream;
    const id = 'chatcmpl-' + Date.now().toString(36);
    const created = Math.floor(Date.now() / 1000);
    const out = (str) => { if (res.writableEnded || res.destroyed) return false; try { return res.write(str); } catch (e) { return false; } };
    const chunk = (delta) => out('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model || 'arena-agent', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');

    // 客户端断开（Ctrl-C）就别让任务继续跑满 10 分钟占着队列
    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) clientGone = true; });
    const ctx = { aborted: () => clientGone };
    let live = null;   // 本轮真正用的 session，出错时要靠它停生成/重置

    const run = async () => {
      if (!(await ensureChrome())) throw chromeDownError();
      // 常驻 battle/side 模式：普通提问也走并排，两栏答案合成一条消息
      if (opts.mode === 'battle' || opts.mode === 'side') {
        const key = name + '#battle';
        if (!(await ensureChrome())) throw chromeDownError();
        const s2 = await getSession(key, { mode: opts.mode, models: opts.models, fresh: true });
        live = s2;
        s2.busy = true;
        try {
          const gap = Date.now() - (s2.lastAsk || 0);
          if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
          s2.lastAsk = Date.now();
          const p = await askBattle(s2, prompt);
          battleRounds.set(name, { panes: p, mode: opts.mode, at: Date.now() });
          const text = '**A · ' + (p.a.label || 'A') + '**\n\n' + (p.a.text || '') + '\n\n---\n\n**B · ' + (p.b.label || 'B') + '**\n\n' + (p.b.text || '') + '\n\n投票：/vote a | b | tie | both';
          if (wantStream) chunk({ content: text });
          return { text };
        } finally {
          s2.busy = false;
        }
      }
      const s = await getSession(name, opts);
      live = s;
      s.busy = true;   // 淘汰与退出都看这个字段，别把正在跑的会话连根拔掉
      try {
        const gap = Date.now() - (s.lastAsk || 0);
        if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
        s.lastAsk = Date.now();
        const r = await askOnce(s, prompt, wantStream ? (d => {
          if (d.type === 'reasoning') { chunk({ reasoning_content: d.text }); return; }
          if (d.type === 'tool') { chunk({ reasoning_content: '\n\u00b7 ' + d.name + ' ' + JSON.stringify(d.input || {}).slice(0, 300) + '\n' }); return; }
          if (d.type !== 'text') return;
          chunk({ content: d.text });
        }) : null, ctx);
        s.lastAsk = Date.now();
        if (r && r.text) {
          const h = histories.get(name) || [];
          h.push({ role: 'user', content: last });
          h.push({ role: 'assistant', content: r.text });
          if (h.length > 24) h.splice(0, h.length - 24);
          setHistory(name, h);
          contextLost.delete(name);
        }
        // 第一轮之后地址会变成 /agent/<id>；人工在网页上切过会话也能跟上
        try {
          const href = String((await s.cdp.ev('location.href')) || '');
          if (/^https:\/\/arena\.ai\/(agent|c)\/[0-9a-f-]{8,}/i.test(href) && sessionUrls.get(name) !== href) {
            sessionUrls.set(name, href);
            saveSessionUrls();
          }
        } catch (e) {}
        return r;
      } finally {
        s.busy = false;
      }
    };

    if (wantStream) {
      // 队列满要在发响应头之前判掉，否则客户端会收到 200 + 错误事件
      if (busyFull()) return send(429, { error: { message: 'busy: queue full', type: 'rate_limit_error' } });
      const endSSE = startSSE(res);
      try {
        const r = await enqueue(run);
        if (truncated) chunk({ reasoning_content: '\n\u00b7 prompt 超长，已截断到 ' + MAX_PROMPT_CHARS + ' 字符\n' });
        if (r && r.routed) chunk({ reasoning_content: '\n\u00b7 routed -> ' + r.routed + '\n' });
        out('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model || 'arena-agent', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
        out('data: [DONE]\n\n');
      } catch (e) {
        // 以前这里引用了不存在的 s（run 内的局部变量），一进 catch 就 ReferenceError，
        // 结果是 SSE 永远不结束：客户端只能看到 endless ping，等不到任何回答或错误
        log('v1 error:', e.message);
        if (e.aborted || clientGone) {
          log('client gone, stopping generation');
        } else {
          if (live) { try { await stopGeneration(live); } catch (e9) {} }
          if (sessionBroken(e.message)) { try { await resetSession(name, e.message); } catch (e9) {} }
          out('data: ' + JSON.stringify({ error: { message: e.message, type: 'upstream_error' } }) + '\n\n');
          out('data: [DONE]\n\n');
        }
      } finally {
        endSSE();
      }
      return;
    }

    try {
      const r = await enqueue(run);
      return send(200, {
        id, object: 'chat.completion', created, model: body.model || 'arena-agent',
        choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: prompt.length, completion_tokens: (r.text || '').length, total_tokens: prompt.length + (r.text || '').length },
        arena: { tools: r.tools, reasoning: r.reasoning, routed: r.routed, truncated }
      });
    } catch (e) {
      log('v1 error:', e.message);
      // 别再无差别杀会话了：「队列满」根本不是会话的问题，
      // 以前这条路径会把正在跑的那一轮连标签页一起关掉
      if (e.busy) return send(429, { error: { message: e.message, type: 'rate_limit_error' } });
      if (e.aborted || clientGone) return send(499, { error: { message: 'client closed request', type: 'aborted' } });
      if (live) { try { await stopGeneration(live); } catch (e9) {} }
      if (sessionBroken(e.message)) { try { await resetSession(name, e.message); } catch (e9) {} }
      return send(500, { error: { message: e.message, type: 'upstream_error' } });
    }
  }
  if (u.pathname === '/v1/models') {
    return send(200, { object: 'list', data: [{ id: 'arena-agent', object: 'model', created: 0, owned_by: 'arena' }, { id: 'arena-direct', object: 'model', created: 0, owned_by: 'arena' }] });
  }
  if (u.pathname === '/ask' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(400, { error: 'bad json' }); }
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return send(400, { error: 'empty prompt' });
    const name = body.session || DEFAULT_SESSION;
    const stream = !!body.stream;
    const truncated = prompt.length > MAX_PROMPT_CHARS;
    const opts = { model: body.model || '', mode: body.mode || 'agent', fresh: !!body.new };

    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) clientGone = true; });
    const ctx = { aborted: () => clientGone };
    const out = (str) => { if (res.writableEnded || res.destroyed) return; try { res.write(str); } catch (e) {} };
    let live = null;

    const run = async () => {
      if (!(await ensureChrome())) throw chromeDownError();
      const s = await getSession(name, opts);
      live = s;
      s.busy = true;
      try {
        const gap = Date.now() - (s.lastAsk || 0);
        if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
        s.lastAsk = Date.now();
        const r = await askOnce(s, prompt, d => { if (stream) out('data: ' + JSON.stringify(d) + '\n\n'); }, ctx);
        s.lastAsk = Date.now();
        return r;
      } finally {
        s.busy = false;
      }
    };

    const fail = async (e) => {
      log('ask error:', e.message);
      if (e.aborted || clientGone) return;
      if (live) { try { await stopGeneration(live); } catch (e9) {} }
      if (sessionBroken(e.message)) { try { await resetSession(name, e.message); } catch (e9) {} }
    };

    if (stream) {
      if (busyFull()) return send(429, { ok: false, error: 'busy: queue full' });
      const endSSE = startSSE(res);
      try {
        const r = await enqueue(run);
        out('data: ' + JSON.stringify({ type: 'done', text: r.text, reasoning: r.reasoning, routed: r.routed, tools: r.tools, truncated }) + '\n\n');
      } catch (e) {
        await fail(e);
        if (!(e.aborted || clientGone)) out('data: ' + JSON.stringify({ type: 'error', error: e.message }) + '\n\n');
      } finally {
        endSSE();
      }
      return;
    }

    try {
      const r = await enqueue(run);
      return send(200, { ok: true, text: r.text, reasoning: r.reasoning, routed: r.routed, tools: r.tools, truncated });
    } catch (e) {
      await fail(e);
      if (e.aborted || clientGone) return send(499, { ok: false, error: 'client closed request' });
      const code = /NEED_VERIFY/.test(e.message) ? 409 : (e.busy || /busy/.test(e.message)) ? 429 : 500;
      return send(code, { ok: false, error: e.message });
    }
  }
  send(404, { error: 'not found' });
});

server.on('error', e => {
  // 以前 listen 失败只会被 uncaughtException 记一行日志，进程还活着但没在监听，
  // 表现为「服务在跑，请求全都不通」
  if (e && e.code === 'EADDRINUSE') {
    log('port ' + PORT + ' already in use, another bridge is running? exiting');
    process.exit(1);
  }
  log('server error', (e && e.stack) || e);
  process.exit(1);
});
server.listen(PORT, HOST, () => log('listening http://' + HOST + ':' + PORT + ' v' + VERSION));
process.on('uncaughtException', e => log('uncaught', (e && e.stack) || e));
process.on('unhandledRejection', e => log('unhandled', (e && e.stack) || e));

// 退出时把会话标签一起关掉，别把 Chrome 留一堆孤儿页
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down (' + sig + '), closing ' + sessions.size + ' session(s)');
  try { server.close(); } catch (e) {}
  try { for (const [, s] of sessions) { if (s.busy) await stopGeneration(s.cdp); } } catch (e) {}
  for (const [, s] of sessions) {
    try { await cdpApi('GET', '/json/close/' + s.tabId); } catch (e) {}
    try { s.cdp.close(); } catch (e) {}
  }
  sessions.clear();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

async function waitConversation(c, maxMs) {
  const t0 = Date.now();
  const lim = maxMs || 25000;
  while (Date.now() - t0 < lim) {
    const u = String((await c.ev('location.href')) || '');
    if (/\/agent\/[0-9a-f-]{8,}/i.test(u)) return true;
    // 裸 /agent 或 /text/direct 表示这个标签页还没开过对话，本来就没有 id 可等；
    // 以前每条「新会话的第一问」都会在这里空转满 25 秒
    if (/^https:\/\/arena\.ai\/(agent|text\/direct)\/?(?:[?#].*)?$/i.test(u)) return false;
    await sleep(500);
  }
  log('waitConversation gave up on ' + String(await c.ev('location.href').catch(() => '')));
  return false;
}

