import { createDetector, detectBoth, neededScore } from './detector.js';

if (location.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
  location.replace('https://' + location.host + location.pathname + location.search + location.hash);
}

const $ = (id) => document.getElementById(id);

const MIN_SCORE = 0.3;

const SMALL_SCORE = 0.2;

const BIG_FROM = 0.12, BIG_TO = 0.25, BIG_SCORE = 0.85, LOW_SCORE = 0.7;

const JUDGE = { confirm: MIN_SCORE };
const RULE = { min: MIN_SCORE, small: SMALL_SCORE, big: BIG_SCORE, from: BIG_FROM, to: BIG_TO };
const RULE_BEST = { ...RULE, checkBelow: 0.7 };
const RESCUE_MIN = 0.3, RESCUE_MAX = 400;

const LOW_EVERY = 3;
const SIZE_DEFAULT = 1.3;
const MAX_FILES = 20;
const ANALYSIS_FPS = 30;
const HOLD_FRAMES = 4;
const KEEP_SCORE = 0.15;

const TRACK = {
  gap: 20,
  match: 1.6,
  lowMatch: 0.6,
  lowGrow: 1.5,
  hold: HOLD_FRAMES,
  unionMax: 4,
  minReach: 0.02,
};
const DET_SIDE_DEEP = 1920;
const DET_SIDE = 1280;
const MAX_SIDE = 1920;
const MAX_SIDE_PHOTO = 4096;

const VERSION = '0.7.0';
const DEBUG = location.hostname === 'localhost' || new URLSearchParams(location.search).has('debug');

const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

const video = $('src');
const view = $('view');
const vctx = view.getContext('2d');
const work = document.createElement('canvas');
const wctx = work.getContext('2d');
const preview = document.createElement('canvas');
const pctx = preview.getContext('2d');

const S = {
  runners: [], parallel: 0,
  kind: 'video',
  img: null,
  W: 0, H: 0, duration: 0, fps: 30, srcFps: 30,
  start: 0, first: 0,
  tracks: [],
  base: [],
  frames: [],
  manual: [],
  sel: null,
  nextId: 1,
  t: 0,
  style: 'black',
  size: SIZE_DEFAULT,
  quality: false,
  blurStrength: 7,
  follow: null,
  items: [], cur: 0,
  results: [],
  cancelAll: false,
  skipped: 0,
  run: 0,
  live: false,
  exporting: false,
  zipUrl: null,
  shown: 0,
  split: null,
  emoji: '😶',
  keepAudio: true,
  job: null,
  playing: false,
  file: null,
  fast: false,
  srcUrl: null,
  resultUrl: null,
  resultFile: null,
  previewUrl: null,
  found: [],
  audioCtx: null,
  audioNode: null,
  wake: null,
  scanMs: 0,
  seekFallbacks: 0,
  detectMs: 0, detectCount: 0,
  raw: [],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isPhoto = () => S.kind === 'photo';
const needed = (d) => neededScore(d, Math.min(S.W, S.H), RULE);
const isSure = (d) => d.sure;
function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ix * iy / (a.w * a.h + b.w * b.h - ix * iy);
}

function judge(boxes) {
  const full = boxes.filter((b) => !b.lo), low = boxes.filter((b) => b.lo);
  for (const d of full) {
    d.sure = d.s >= needed(d) || (d.s >= JUDGE.confirm && low.some((l) => iou(d, l) > 0.3));
    d.weak = d.sure && d.s < MIN_SCORE;
  }
  const extra = low.filter((l) => l.s >= LOW_SCORE && l.w / Math.min(S.W, S.H) >= BIG_FROM && !full.some((d) => d.sure && iou(d, l) > 0.3));
  for (const l of extra) l.sure = true;
  return full.concat(extra);
}

function show(step) {
  for (const s of ['home', 'scan', 'review', 'export', 'done']) $('s-' + s).hidden = s !== step;
  const host = { scan: $('scanFrame'), review: $('stage'), export: $('exportFrame') }[step];
  if (host && view.parentNode !== host) host.prepend(view);
  window.scrollTo(0, 0);
}

function fail(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}

async function keepAwake(on) {
  try {
    if (on && navigator.wakeLock) S.wake = await navigator.wakeLock.request('screen');
    if (!on && S.wake) { await S.wake.release(); S.wake = null; }
  } catch {}
}

let shownAt = performance.now();
document.addEventListener('visibilitychange', () => { if (!document.hidden) shownAt = performance.now(); });

function startWorker() {
  return new Promise((resolve) => {
    let w;
    try { w = new Worker('detect-worker.js', { type: 'module' }); } catch { resolve(null); return; }
    const pending = new Map();
    let nextId = 1, broken = null;
    const giveUp = setTimeout(() => { w.terminate(); resolve(null); }, 20000);
    const breakDown = (why) => {
      if (!broken) {
        broken = new Error(why);
        const i = S.runners.indexOf(runner);
        if (i >= 0 && S.runners.length > 1) S.runners.splice(i, 1);
        else if (i >= 0) localRunner().then((r) => { const j = S.runners.indexOf(runner); if (j >= 0) S.runners[j] = r; }, () => {});
      }
      w.terminate();
      for (const p of pending.values()) { clearTimeout(p.timer); p.ko(broken); }
      pending.clear();
    };
    const watch = (id) => setTimeout(() => {
      const p = pending.get(id);
      if (!p) return;
      if (document.hidden || performance.now() - shownAt < 60000) p.timer = watch(id);
      else breakDown('silent worker');
    }, 60000);
    const runner = {
      stop: () => w.terminate(),
      detect: (bitmap, maxSide, always) => new Promise((ok, ko) => {
        if (broken) { bitmap.close(); ko(broken); return; }
        const id = nextId++;
        pending.set(id, { ok, ko, timer: watch(id) });
        w.postMessage({ type: 'detect', id, bitmap, w: bitmap.width, h: bitmap.height, maxSide, minScore: KEEP_SCORE, always, rule: S.quality ? RULE_BEST : RULE }, [bitmap]);
      }),
      rescue: (bitmap, hints) => new Promise((ok, ko) => {
        if (broken) { bitmap.close(); ko(broken); return; }
        const id = nextId++;
        pending.set(id, { ok, ko, timer: watch(id) });
        w.postMessage({ type: 'rescue', id, bitmap, hints }, [bitmap]);
      }),
    };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { clearTimeout(giveUp); resolve(runner); return; }
      const p = pending.get(m.id);
      if (m.type === 'error' && !p) { clearTimeout(giveUp); resolve(null); breakDown('worker failed'); return; }
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.type === 'done' || m.type === 'found') p.ok(m.boxes); else p.ko(new Error(m.message));
    };
    w.onerror = () => { clearTimeout(giveUp); resolve(null); breakDown('worker failed'); };
    w.postMessage({ type: 'init' });
  });
}

async function localRunner() {
  const detect = await createDetector(new URL('.', location.href).href);
  return {
    detect: async (bitmap, maxSide, always) => {
      const boxes = await detectBoth(detect, bitmap, bitmap.width, bitmap.height, maxSide, KEEP_SCORE, always, S.quality ? RULE_BEST : RULE);
      bitmap.close();
      return boxes;
    },
    rescue: async (bitmap, hints) => {
      const boxes = [];
      for (const h of hints) boxes.push(await detect.zoomFind(bitmap, h, 4, 0.2));
      bitmap.close();
      return boxes;
    },
  };
}

let MB = null;
async function loadFastExport() {
  if (new URLSearchParams(location.search).has('slow')) return;
  if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) return;
  try {
    MB = await import('./vendor/mediabunny/mediabunny.min.mjs');
    for (const [codec, id] of [['avc', 'avc1.42001f'], ['vp9', 'vp09.00.31.08']]) {
      const { supported } = await VideoEncoder.isConfigSupported({ codec: id, width: 1280, height: 720, bitrate: 4e6 });
      if (supported) { S.fast = codec; break; }
    }
  } catch (e) {
    console.error(e);
  }
}

async function init() {
  try {
    const cores = navigator.hardwareConcurrency || 2;
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const roomy = cores >= 8 && (navigator.deviceMemory || 8) >= 8;
    const wanted = clamp(cores - 1, 1, ios ? 2 : roomy ? 4 : 3);
    const noWorkers = new URLSearchParams(location.search).has('simple');
    const [workers] = await Promise.all([
      noWorkers ? [] : Promise.all(Array.from({ length: wanted }, startWorker)).then((w) => w.filter(Boolean)),
      loadFastExport(),
    ]);
    S.runners = workers.length ? workers : [await localRunner()];
    addEventListener('pagehide', () => { for (const r of S.runners) if (r.stop) r.stop(); });
    addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
    S.parallel = workers.length;
    $('file').disabled = false;
    $('pickLabel').removeAttribute('aria-disabled');
    $('pickText').innerHTML = matchMedia('(pointer: fine)').matches ? 'Drop videos or photos,<br>or click to choose' : 'Choose videos<br>or photos';
    $('footNote').textContent = matchMedia('(pointer: fine)').matches ? 'Nothing leaves your computer.' : 'Nothing leaves your phone.';
  } catch (e) {
    console.error(e);
    $('pickText').textContent = 'Tool unavailable';
    fail($('homeError'), "The tool could not load in this browser. Try an up-to-date Chrome or Safari.");
  }
}

function once(target, ok, bad, ms) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const done = (fn, v) => { clearTimeout(timer); target.removeEventListener(ok, onOk); if (bad) target.removeEventListener(bad, onBad); fn(v); };
    const onOk = () => done(resolve);
    const onBad = () => done(reject, new Error(bad));
    target.addEventListener(ok, onOk);
    if (bad) target.addEventListener(bad, onBad);
    if (ms) timer = setTimeout(() => done(reject, new Error('timeout')), ms);
  });
}

function seekTo(t, ms = 3000) {
  return new Promise((resolve) => {
    let seeked = false, framed = false, finished = false;
    let timer = 0;
    const fin = (ok) => { if (!finished) { finished = true; clearTimeout(timer); video.removeEventListener('seeked', onSeeked); resolve(ok); } };
    const onSeeked = () => {
      seeked = true;
      if (framed) fin(true); else setTimeout(() => fin(true), 15);
    };
    video.addEventListener('seeked', onSeeked);
    if (hasRVFC) video.requestVideoFrameCallback(() => { framed = true; if (seeked) fin(true); });
    timer = setTimeout(() => fin(false), ms);
    video.currentTime = t + S.start;
  });
}

const seekSure = async (t) => (await seekTo(t, 10000)) || seekTo(t, 10000);

async function measureFps() {
  if (!hasRVFC) return 30;
  const times = [];
  let stop = false;
  const cb = (_, meta) => {
    times.push(meta.mediaTime);
    if (!stop) video.requestVideoFrameCallback(cb);
  };
  video.requestVideoFrameCallback(cb);
  video.muted = true;
  try { await video.play(); } catch { return 30; }
  const t0 = performance.now();
  while (times.length < 14 && performance.now() - t0 < 1500) await sleep(30);
  stop = true;
  video.pause();
  const deltas = [];
  for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) deltas.push(times[i] - times[i - 1]);
  if (deltas.length < 4) return 30;
  deltas.sort((a, b) => a - b);
  const fps = 1 / deltas[deltas.length >> 1];
  return Number.isFinite(fps) ? fps : 30;
}

const drawSource = (ctx) => ctx.drawImage(isPhoto() ? S.img : video, 0, 0, S.W, S.H);
const frameTime = (i) => Math.min((i + 0.5) / S.fps, Math.max(0, S.duration - 0.001));
const frameIndex = (t) => clamp(Math.floor(t * S.fps), 0, Math.max(0, S.frames.length - 1));

async function openVideoSource(url) {
  video.src = url;
  await once(video, 'loadedmetadata', 'error', 20000);
  const start = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  if (video.readyState < 2) {
    const frame = once(video, 'loadeddata', 'error', 20000);
    video.currentTime = start + 0.001;
    const late = setTimeout(() => {
      if (video.readyState < 2) video.play().then(() => { video.pause(); video.currentTime = start; }).catch(() => {});
    }, 3000);
    await frame.finally(() => clearTimeout(late));
  }
  if (!Number.isFinite(video.duration)) {
    video.currentTime = 1e7;
    await once(video, 'durationchange', null, 5000).catch(() => {});
  }
  if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('unreadable');
  return start;
}

const KEYS = ['file', 'kind', 'img', 'W', 'H', 'duration', 'fps', 'srcFps', 'start', 'first', 'tracks', 'frames', 'manual', 'raw', 'found', 'nextId', 't', 'srcUrl', 'scanMs', 'seekFallbacks', 'detectMs', 'detectCount', 'size'];

function resetFile() {
  Object.assign(S, {
    file: null, kind: 'video', img: null, W: 0, H: 0, duration: 0, fps: 30, srcFps: 30, start: 0, first: 0,
    tracks: [], base: [], frames: [], manual: [], raw: [], found: [], nextId: 1, t: 0, srcUrl: null, sel: null,
    scanMs: 0, seekFallbacks: 0, detectMs: 0, detectCount: 0, size: SIZE_DEFAULT, live: true,
  });
}

function stash() {
  if (!S.live) return;
  const it = S.items[S.cur] || (S.items[S.cur] = {});
  for (const key of KEYS) it[key] = S[key];
  it.img = null;
}

function leave() {
  if (!S.live) return;
  stash();
  if (S.img) { S.img.close(); S.img = null; }
  S.live = false;
}

function dropFile() {
  if (S.srcUrl) URL.revokeObjectURL(S.srcUrl);
  if (S.img) S.img.close();
  S.img = S.srcUrl = null;
  S.live = false;
}

async function activate(k) {
  leave();
  Object.assign(S, S.items[k]);
  S.cur = k;
  S.sel = null;
  S.split = null;
  $('splitBtn').classList.remove('on');
  if (isPhoto()) S.img = await createImageBitmap(S.file);
  else await openVideoSource(S.srcUrl);
  for (const c of [view, work, preview]) { c.width = S.W; c.height = S.H; }
  S.live = true;
  layoutFrames();
}

async function switchTo(k, t = 0) {
  stopPlay();
  try {
    await activate(k);
  } catch (e) {
    console.error(e);
    goHome();
    fail($('homeError'), 'This file can no longer be opened. Choose it again.');
    return;
  }
  openReview(t);
}

async function prepareFile(file) {
  S.kind = file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name) ? 'photo' : 'video';
  if (!isPhoto() && /Android/.test(navigator.userAgent) && /Firefox\//.test(navigator.userAgent) && !('VideoDecoder' in window)) {
    return 'Firefox on Android cannot process videos. Open anonymizer.nvp.qzz.io in Chrome. Photos work here.';
  }
  S.file = file;
  S.srcUrl = URL.createObjectURL(file);
  let w, h;
  try {
    if (isPhoto()) {
      S.img = await createImageBitmap(file);
      w = S.img.width;
      h = S.img.height;
      S.duration = 0;
    } else {
      S.start = await openVideoSource(S.srcUrl);
      w = video.videoWidth;
      h = video.videoHeight;
      S.duration = video.duration;
      if (S.fast) {
        try {
          const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
          const track = await input.getPrimaryVideoTrack();
          if (track) {
            S.duration = Math.max(S.duration, (await track.computeDuration()) - S.start);
            S.first = Math.max(0, (await track.getFirstTimestamp()) - S.start);
          }
          input.dispose();
        } catch {}
      }
    }
    if (!w || !h) throw new Error('unreadable');
  } catch {
    dropFile();
    return 'Your browser cannot read this file. Try another browser, or save it in another format.';
  }
  const k = Math.min(1, (isPhoto() ? MAX_SIDE_PHOTO : MAX_SIDE) / Math.max(w, h));
  S.W = Math.round(w * k / 2) * 2;
  S.H = Math.round(h * k / 2) * 2;
  for (const c of [view, work, preview]) { c.width = S.W; c.height = S.H; }
  return null;
}

async function loadFiles(list) {
  const files = [...list].slice(0, MAX_FILES);
  if (!files.length) return;
  resetAll();
  const run = S.run;
  $('homeError').hidden = true;
  S.quality = $('quality').checked;
  S.skipped = 0;
  let lastError = '';
  for (let n = 0; n < files.length; n++) {
    S.cur = S.items.length;
    resetFile();
    const bad = await prepareFile(files[n]);
    if (run !== S.run) return;
    if (bad) { lastError = bad; S.skipped++; S.live = false; continue; }
    show('scan');
    $('scanFile').textContent = files.length > 1 ? `File ${n + 1} of ${files.length}` : '';
    $('scanBar').style.height = '0';
    $('scanText').textContent = '0%';
    const res = await scan();
    if (run !== S.run || res.cancel) return;
    if (res.error) { lastError = res.error; S.skipped++; dropFile(); continue; }
    leave();
  }
  if (!S.items.length) {
    goHome();
    fail($('homeError'), lastError);
    return;
  }
  await switchTo(0);
  const notes = [];
  if (S.skipped) notes.push(`${S.skipped} of ${files.length} files could not be processed and were skipped.`);
  if (notes.length) fail($('fatal'), notes.join(' '));
}

async function scan() {
  const job = { cancelled: false };
  S.job = job;
  await keepAwake(true);
  S.srcFps = isPhoto() ? 1 : await measureFps();
  S.fps = isPhoto() ? 1 : ANALYSIS_FPS;
  const total = isPhoto() ? 1 : Math.max(1, Math.ceil(S.duration * S.fps));
  const side = !isPhoto() && $('fast').checked && !S.quality ? DET_SIDE : DET_SIDE_DEEP;
  const results = new Array(total);
  const started = performance.now();
  S.seekFallbacks = 0;
  S.detectMs = 0;
  S.detectCount = 0;
  S.found = [];
  const free = [...S.runners], waiting = [];
  const acquire = () => (free.length ? Promise.resolve(free.pop()) : new Promise((r) => waiting.push(r)));
  const tasks = [];
  let done = 0, error = null, onRelease = null, sent = 0;
  const release = (r) => { if (waiting.length) waiting.shift()(r); else free.push(r); if (onRelease) onRelease(); };
  const progress = () => {
    const pct = Math.floor(done / total * 100);
    $('scanBar').style.height = pct + '%';
    $('scanText').textContent = pct + '%';
  };
  let shown = null;
  const keepForPreview = (canvas) => { if (!shown) { pctx.drawImage(canvas, 0, 0); shown = canvas; } };
  const showPreview = (canvas, boxes) => {
    if (canvas !== shown) return;
    vctx.drawImage(preview, 0, 0);
    vctx.fillStyle = '#000';
    for (const b of boxes.filter(isSure).map(grow)) vctx.fillRect(b.x, b.y, b.w, b.h);
    shown = null;
  };
  let sawPicture = isPhoto();
  const tiny = Object.assign(document.createElement('canvas'), { width: 32, height: 32 });
  const tctx = tiny.getContext('2d', { willReadFrequently: true });
  const checkPicture = (canvas) => {
    tctx.drawImage(canvas, 0, 0, 32, 32);
    const d = tctx.getImageData(0, 0, 32, 32).data;
    let lo = 255, hi = 0;
    for (let p = 0; p < d.length; p += 4) { const l = (d[p] * 3 + d[p + 1] * 6 + d[p + 2]) / 10; if (l < lo) lo = l; if (l > hi) hi = l; }
    if (hi - lo > 24) sawPicture = true;
  };
  const submit = async (canvas, i, j) => {
    try {
      if (!sawPicture) checkPicture(canvas);
      const shot = createImageBitmap(canvas);
      const runner = await acquire();
      if (job.cancelled || error) { release(runner); (await shot).close(); return; }
      const bitmap = await shot;
      const t0 = performance.now();
      const nth = sent++;
      const always = isPhoto() || S.quality || nth % LOW_EVERY === 0;
      tasks.push(runner.detect(bitmap, side, always).then((found) => {
        if (DEBUG) S.found.push({ found: found.map((b) => ({ ...b })), i, j });
        const boxes = judge(found);
        for (const b of boxes) b.at = i;
        S.detectMs += performance.now() - t0;
        S.detectCount++;
        for (let k = i; k <= j; k++) if (!results[k]) { results[k] = boxes; done++; }
        showPreview(canvas, boxes);
        progress();
      }, (e) => { error = e; }).finally(() => release(runner)));
    } catch (e) {
      error = e;
    }
  };
  if (!isPhoto()) await scanByPlayback(job, total, submit, keepForPreview, () => error);
  for (let i = 0; i < total && !job.cancelled && !error; i++) {
    if (results[i]) continue;
    if (!isPhoto()) {
      if (!await seekSure(frameTime(i))) { error = new Error('cannot seek to ' + frameTime(i).toFixed(2) + ' s'); break; }
      S.seekFallbacks++;
    }
    if (job.cancelled || error) break;
    drawSource(wctx);
    keepForPreview(work);
    await submit(work, i, i);
  }
  await Promise.all(tasks);
  await keepAwake(false);
  if (job.cancelled) return { cancel: true };
  S.job = null;
  if (error || results.some((r) => !r)) {
    console.error(error || 'missing frames');
    return { error: 'Analysis failed in this browser. Try an up-to-date Chrome or Safari.' };
  }
  if (!sawPicture) return { error: "This browser cannot display this video's frames, so it cannot find the faces. Try an up-to-date Chrome or Safari." };
  S.raw = results;
  buildTracks(results);
  if (S.quality && !isPhoto()) {
    S.job = job;
    await keepAwake(true);
    $('scanFile').textContent = 'Refining the gaps…';
    if (await rescueGaps(job, results)) buildTracks(results);
    await keepAwake(false);
    S.job = null;
    if (job.cancelled) return { cancel: true };
  }
  S.scanMs = performance.now() - started;
  return {};
}

async function rescueGaps(job, results) {
  const wanted = new Map();
  for (const t of S.tracks) {
    const idx = [...t.dets.keys()];
    for (let q = 0; q + 1 < idx.length; q++) {
      const a = idx[q], b = idx[q + 1];
      if (b - a < 2 || b - a > TRACK.gap) continue;
      for (let j = a + 1; j < b; j++) {
        const list = wanted.get(j) || [];
        list.push(lerp(t.dets.get(a), t.dets.get(b), (j - a) / (b - a)));
        wanted.set(j, list);
      }
    }
  }
  const slots = [...wanted.keys()].sort((x, y) => x - y).slice(0, RESCUE_MAX);
  const pending = new Set();
  let found = 0;
  for (const [n, j] of slots.entries()) {
    if (job.cancelled) break;
    if (!await seekSure(frameTime(j))) continue;
    drawSource(wctx);
    const bitmap = await createImageBitmap(work);
    const task = S.runners[n % S.runners.length].rescue(bitmap, wanted.get(j)).then((boxes) => {
      for (const b of boxes) {
        if (!b || b.s < RESCUE_MIN) continue;
        results[j] = [...results[j], { ...b, sure: true, weak: false, at: j }];
        found++;
      }
    }, () => {}).finally(() => pending.delete(task));
    pending.add(task);
    if (pending.size >= S.runners.length * 2) await Promise.race(pending);
  }
  await Promise.all(pending);
  return found;
}

async function scanByPlayback(job, total, submit, keepForPreview, failed) {
  if (!hasRVFC || document.hidden) return;
  const n = S.runners.length;
  const ring = Array.from({ length: 3 }, () => {
    const c = document.createElement('canvas');
    c.width = S.W;
    c.height = S.H;
    return c;
  });
  const frameDur = 1 / clamp(S.srcFps, 10, 120);
  const firstSlot = (t) => Math.ceil(t * S.fps - 0.5);
  let ringPos = 0, inFlight = 0, prev = null, lastPresented = -1, lastTime = -1, lastSeen = performance.now();
  let paused = false, ended = false, stop = false;
  let rate = 1, sinceSkip = 0;
  const setRate = (r) => { rate = clamp(r, 0.25, 1); try { video.playbackRate = rate; } catch {} };
  const flush = (end) => {
    if (!prev) return;
    const i = Math.max(0, firstSlot(prev.t)), j = Math.min(total - 1, firstSlot(end) - 1);
    const cap = prev;
    prev = null;
    if (j < i) return;
    inFlight++;
    submit(cap.canvas, i, j).finally(() => { inFlight--; });
  };
  const onFrame = (_, meta) => {
    if (stop) return;
    lastSeen = performance.now();
    const t = meta.mediaTime - S.start;
    if (t > lastTime) {
      const skipped = lastPresented >= 0 && (meta.presentedFrames - lastPresented > 1 || (prev && t - prev.t > frameDur * 1.5));
      flush(skipped ? Math.min(t, (prev ? prev.t : t) + frameDur * 1.2) : t);
      if (skipped) { setRate(rate * 0.75); sinceSkip = 0; }
      else if (++sinceSkip >= 10) { sinceSkip = 0; if (inFlight > n) setRate(rate * 0.85); else if (inFlight <= 1) setRate(rate * 1.1); }
      const canvas = ring[ringPos++ % ring.length];
      drawSource(canvas.getContext('2d'));
      keepForPreview(canvas);
      prev = { canvas, t };
      lastTime = t;
      lastPresented = meta.presentedFrames;
      if (inFlight >= 2 * n + 1 && !paused) { paused = true; video.pause(); }
    }
    video.requestVideoFrameCallback(onFrame);
  };
  const resume = () => {
    if (paused && !ended && !stop && !document.hidden && inFlight <= n) { paused = false; video.play().catch(() => {}); }
  };
  const onEnded = () => { ended = true; };
  const onVisibility = () => { if (document.hidden) { paused = true; video.pause(); } else resume(); };
  if (!await seekSure(0)) return;
  video.muted = true;
  setRate(rate);
  video.addEventListener('ended', onEnded);
  document.addEventListener('visibilitychange', onVisibility);
  video.requestVideoFrameCallback(onFrame);
  const timer = setInterval(resume, 50);
  try {
    await video.play();
    while (!ended && !job.cancelled && !failed() && (paused || document.hidden || performance.now() - lastSeen < 4000)) await sleep(50);
  } catch {}
  stop = true;
  clearInterval(timer);
  video.removeEventListener('ended', onEnded);
  document.removeEventListener('visibilitychange', onVisibility);
  video.pause();
  video.playbackRate = 1;
  if (ended && prev) flush(S.duration + 1);
  else prev = null;
}

function grow(b) {
  const edge = Math.max(4, Math.min(S.W, S.H) / 90);
  const w = b.w * S.size + edge, h = b.h * S.size + edge;
  return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
}

function union(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });

function extendBackward(tracks, results) {
  const used = new Set();
  for (const t of tracks) for (const d of t.dets.values()) used.add(d);
  const floor = Math.min(S.W, S.H) * TRACK.minReach;
  for (const t of tracks) {
    const first = Math.min(...t.dets.keys());
    let ref = t.dets.get(first), refIdx = first, added = false;
    for (let i = first - 1; i >= 0 && refIdx - i <= TRACK.gap; i--) {
      let best = null, bestDist = TRACK.lowMatch;
      for (const d of results[i] || []) {
        if (used.has(d) || d.s < SMALL_SCORE) continue;
        if (Math.max(ref.w / d.w, d.w / ref.w) > TRACK.lowGrow) continue;
        const reach = Math.max((ref.w + d.w) / 2, floor) * Math.min(3, 1 + 0.4 * (refIdx - i - 1));
        const dist = Math.hypot(ref.x + ref.w / 2 - d.x - d.w / 2, ref.y + ref.h / 2 - d.y - d.h / 2) / reach;
        if (dist < bestDist) { best = d; bestDist = dist; }
      }
      if (best) { used.add(best); t.dets.set(i, best); ref = best; refIdx = i; added = true; }
    }
    if (added) t.dets = new Map([...t.dets].sort((a, b) => a[0] - b[0]));
  }
}

function buildTracks(results) {
  const N = results.length;
  const tracks = [];
  let active = [];
  const floor = Math.min(S.W, S.H) * TRACK.minReach;
  for (let i = 0; i < N; i++) {
    active = active.filter((t) => i - t.lastIdx <= TRACK.gap);
    const dets = results[i];
    const pairs = [];
    for (const d of dets) {
      for (const t of active) {
        const l = t.last;
        if (Math.max(l.w / d.w, d.w / l.w) > 2.5) continue;
        const reach = Math.max((l.w + d.w) / 2, floor) * Math.min(3, 1 + 0.4 * (i - t.lastIdx - 1));
        const lx = l.x + l.w / 2, ly = l.y + l.h / 2, dx = d.x + d.w / 2, dy = d.y + d.h / 2;
        const ahead = i - t.lastIdx;
        const dist = Math.min(Math.hypot(lx - dx, ly - dy), Math.hypot(lx + t.vx * ahead - dx, ly + t.vy * ahead - dy)) / reach;
        const sure = isSure(d);
        if (!sure && d.w > TRACK.lowGrow * t.sureW) continue;
        if (dist < (sure ? TRACK.match : TRACK.lowMatch) && (sure || i - t.sureIdx <= TRACK.gap)) pairs.push({ d, t, dist });
      }
    }
    pairs.sort((x, y) => x.dist - y.dist);
    const usedT = new Set(), usedD = new Set();
    const assign = (d, t) => {
      usedT.add(t);
      usedD.add(d);
      if (t.last) {
        const dt = i - t.lastIdx;
        t.vx = 0.4 * t.vx + 0.6 * (d.x + d.w / 2 - t.last.x - t.last.w / 2) / dt;
        t.vy = 0.4 * t.vy + 0.6 * (d.y + d.h / 2 - t.last.y - t.last.h / 2) / dt;
      }
      t.dets.set(i, d);
      t.last = d;
      t.lastIdx = i;
      if (isSure(d)) { t.sureIdx = i; t.sureW = d.w; }
    };
    for (const p of pairs) if (!usedT.has(p.t) && !usedD.has(p.d)) assign(p.d, p.t);
    for (const d of dets) {
      if (usedD.has(d) || !isSure(d)) continue;
      if (d.weak && N > 1) {
        const k = (d.at ?? i) - 1;
        if (!(results[k] || []).some((p) => p.s >= SMALL_SCORE && iou(p, d) > 0.3)) continue;
      }
      const t = { id: tracks.length + 1, dets: new Map(), off: [], vx: 0, vy: 0 };
      tracks.push(t);
      active.push(t);
      assign(d, t);
    }
  }
  extendBackward(tracks, results);
  S.tracks = tracks;
  layoutFrames();
}

function gauss(values, sigma) {
  const r = Math.ceil(sigma * 2.5);
  const weights = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  return values.map((_, i) => {
    let sum = 0, total = 0;
    for (let k = -r; k <= r; k++) {
      if (i + k < 0 || i + k >= values.length) continue;
      sum += values[i + k] * weights[k + r];
      total += weights[k + r];
    }
    return sum / total;
  });
}

function layoutFrames() {
  const N = S.raw.length;
  const sigma = S.quality ? 2.6 : 1.8;
  const base = Array.from({ length: N }, () => []);
  for (const t of S.tracks) {
    const idx = [...t.dets.keys()];
    const first = idx[0], last = idx[idx.length - 1];
    const a = Math.max(0, first - TRACK.hold), b = Math.min(N - 1, last + TRACK.hold);
    const path = [];
    let k = 0;
    for (let j = a; j <= b; j++) {
      if (j <= first) path.push(t.dets.get(first));
      else if (j >= last) path.push(t.dets.get(last));
      else {
        while (idx[k + 1] <= j) k++;
        path.push(idx[k] === j ? t.dets.get(j) : lerp(t.dets.get(idx[k]), t.dets.get(idx[k + 1]), (j - idx[k]) / (idx[k + 1] - idx[k])));
      }
    }
    const cx = gauss(path.map((r) => r.x + r.w / 2), sigma), cy = gauss(path.map((r) => r.y + r.h / 2), sigma);
    const sw = gauss(path.map((r) => r.w), sigma), sh = gauss(path.map((r) => r.h), sigma);
    const smooth = path.map((_, i) => ({ x: cx[i] - sw[i] / 2, y: cy[i] - sh[i] / 2, w: sw[i], h: sh[i] }));
    const dev = path.map((r, i) => {
      const s = smooth[i];
      return [Math.max(0, s.x - r.x), Math.max(0, s.y - r.y), Math.max(0, r.x + r.w - s.x - s.w), Math.max(0, r.y + r.h - s.y - s.h)];
    });
    const grown = dev.map((d, i) => d.map((v, c) => Math.max(v, dev[i - 1] ? dev[i - 1][c] : 0, dev[i + 1] ? dev[i + 1][c] : 0)));
    const pad = grown.map((d, i) => d.map((v, c) => ((grown[i - 1] ? grown[i - 1][c] : v) + 2 * v + (grown[i + 1] ? grown[i + 1][c] : v)) / 4));
    for (let j = Math.max(0, a - 1); j <= Math.min(N - 1, b + 1); j++) {
      const i = clamp(j - a, 0, path.length - 1);
      const s = smooth[i], p = pad[i];
      const box = { x: s.x - p[0], y: s.y - p[1], w: s.w + p[0] + p[2], h: s.h + p[1] + p[3] };
      const near = [path[i - 1], path[i], path[i + 1]].filter(Boolean);
      const biggest = Math.max(...near.map((r) => r.w * r.h));
      if (box.w * box.h <= TRACK.unionMax * biggest) base[j].push({ x: box.x, y: box.y, w: box.w, h: box.h, track: t });
      else for (const r of near) base[j].push({ x: r.x, y: r.y, w: r.w, h: r.h, track: t });
    }
  }
  S.base = base;
  applySize();
}

function applySize() {
  S.frames = S.base.map((list) => list.map((b) => ({ ...grow(b), track: b.track })));
  tlDirty = true;
}

function boxesAt(t) {
  const n = S.frames.length;
  if (!n) return [];
  const pos = t * S.fps - 0.5;
  const j0 = clamp(Math.floor(pos), 0, n - 1), j1 = Math.min(n - 1, j0 + 1);
  const k = clamp(pos - j0, 0, 1);
  const here = S.frames[j0];
  if (j1 === j0 || k < 0.001) return here;
  const group = (list) => {
    const m = new Map();
    for (const b of list) m.set(b.track, [...(m.get(b.track) || []), b]);
    return m;
  };
  const from = group(here), to = group(S.frames[j1]);
  const out = [];
  for (const [track, one] of from) {
    const two = to.get(track);
    if (two && one.length === 1 && two.length === 1) out.push({ ...lerp(one[0], two[0], k), track });
    else out.push(...(k < 0.5 || !two ? one : two));
  }
  if (k >= 0.5) for (const [track, two] of to) if (!from.has(track)) out.push(...two);
  return out;
}

function manualPos(m, t) {
  if (!m.path) return [m.cx, m.cy];
  const pts = m.path.pts;
  const pos = clamp(t * S.fps - 0.5 - m.path.i0, 0, pts.length - 1);
  const k = Math.floor(pos), f = pos - k, a = pts[k], b = pts[Math.min(pts.length - 1, k + 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

function manualRect(m, t = S.t) {
  const s = m.size * Math.min(S.W, S.H);
  const [cx, cy] = manualPos(m, t);
  return { x: cx * S.W - s / 2, y: cy * S.H - s / 2, w: s, h: s };
}

const isOff = (tr, j) => { let off = false; for (const e of tr.off) if (e.from <= j) off = e.off; return off; };
const isRemoved = (tr) => tr.off.some((e) => e.off);
function toggleTrack(tr, j) {
  const last = tr.off[tr.off.length - 1];
  if (last && last.at === j) { tr.off.pop(); return; }
  const off = !isOff(tr, j);
  tr.off = tr.off.length ? [...tr.off.filter((e) => e.from < j), { from: j, off, at: j }] : [{ from: 0, off, at: j }];
}

const manualAt = (t) => S.manual.filter((m) => t >= m.t0 - 1e-3 && t <= m.t1 + 1e-3);
const inside = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

const scratch = document.createElement('canvas');
const scratchCtx = scratch.getContext('2d', { willReadFrequently: false });

function blurRect(ctx, r) {
  const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
  const w = Math.min(ctx.canvas.width - x, Math.ceil(r.w) + 1), h = Math.min(ctx.canvas.height - y, Math.ceil(r.h) + 1);
  if (w < 1 || h < 1) return;
  const base = Math.round(15 - 1.25 * S.blurStrength);
  const cols = w <= h ? base : clamp(Math.round(base * w / h), base, base * 2);
  const rows = h <= w ? base : clamp(Math.round(base * h / w), base, base * 2);
  if (scratch.width < w) scratch.width = w;
  if (scratch.height < h) scratch.height = h;
  scratchCtx.imageSmoothingEnabled = true;
  scratchCtx.imageSmoothingQuality = 'high';
  scratchCtx.clearRect(0, 0, w, h);
  scratchCtx.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
  let cw = w, ch = h;
  while (cw / 2 >= cols && ch / 2 >= rows) {
    const nw = Math.ceil(cw / 2), nh = Math.ceil(ch / 2);
    scratchCtx.drawImage(scratch, 0, 0, cw, ch, 0, 0, nw, nh);
    cw = nw;
    ch = nh;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(scratch, 0, 0, cw, ch, x, y, w, h);
}

function paint(ctx, t, edit) {
  const j = frameIndex(t);
  const auto = boxesAt(t);
  const live = auto.filter((b) => !isOff(b.track, j));
  const rects = [...live, ...manualAt(t).map((m) => manualRect(m, t))];
  if (S.style === 'blur') {
    for (const r of rects) blurRect(ctx, r);
  } else {
    ctx.fillStyle = '#000';
    for (const r of rects) ctx.fillRect(Math.floor(r.x), Math.floor(r.y), Math.ceil(r.w) + 1, Math.ceil(r.h) + 1);
  }
  if (S.style === 'emoji') {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const r of rects) {
      const s = Math.min(r.w, r.h);
      ctx.font = `${Math.round(s * 0.82)}px ${EMOJI_FONT}`;
      ctx.fillText(S.emoji, r.x + r.w / 2, r.y + r.h / 2 + s * 0.06);
    }
  }
  if (!edit) return;
  const lw = Math.max(3, Math.min(S.W, S.H) / 180);
  ctx.lineWidth = lw;
  const frame = (r, color, solid) => {
    ctx.strokeStyle = color;
    ctx.setLineDash(solid ? [] : [lw * 3, lw * 2]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  };
  for (const b of auto) {
    const selected = S.sel && S.sel.track === b.track;
    if (isOff(b.track, j)) frame(b, '#ff6b5e', selected);
    else if (selected) frame(b, '#ffffff', true);
  }
  for (const m of manualAt(t)) frame(manualRect(m, t), '#ffffff', S.sel && S.sel.manual === m);
  ctx.setLineDash([]);
}

let seekBusy = false, seekNext = null, seekTarget = 0;

async function goTo(t) {
  if (S.follow) return;
  if (isPhoto()) { S.t = 0; renderReview(); return; }
  seekNext = seekTarget = clamp(t, 0, Math.max(0, S.duration - 0.001));
  if (seekBusy) return;
  seekBusy = true;
  while (seekNext !== null) {
    const x = seekNext;
    seekNext = null;
    await seekTo(x);
    S.t = x;
    renderReview();
  }
  seekBusy = false;
}

function drawSplit() {
  const x = Math.round(S.split * S.W);
  vctx.save();
  vctx.beginPath();
  vctx.rect(x, 0, S.W - x, S.H);
  vctx.clip();
  drawSource(vctx);
  vctx.restore();
  const lw = Math.max(3, Math.min(S.W, S.H) / 180);
  vctx.fillStyle = '#fff';
  vctx.fillRect(x - lw / 2, 0, lw, S.H);
  const size = Math.max(14, Math.round(Math.min(S.W, S.H) / 32));
  vctx.font = `700 ${size}px sans-serif`;
  vctx.textBaseline = 'top';
  for (const [text, left] of [['MASKED', true], ['ORIGINAL', false]]) {
    const w = vctx.measureText(text).width + size;
    const bx = left ? x - lw - w - size / 2 : x + lw + size / 2;
    if (bx < 0 || bx + w > S.W) continue;
    vctx.fillStyle = '#000';
    vctx.fillRect(bx, size / 2, w, size * 1.6);
    vctx.fillStyle = '#fff';
    vctx.fillText(text, bx + size / 2, size / 2 + size * 0.3);
  }
}

function renderReview(light) {
  drawSource(vctx);
  paint(vctx, S.t, S.split == null);
  if (S.split != null) drawSplit();
  $('time').value = S.t;
  drawTimeline();
  if (light) placeMaskBar();
  else refreshPanels();
}

function updateHint() {
  const verb = matchMedia('(pointer: fine)').matches ? 'Click' : 'Tap';
  if (S.split != null) $('hint').textContent = 'Drag to compare. Masked on the left, original on the right.';
  else $('hint').textContent = hasMasks() ? `${verb} a face to hide or unhide its mask. ${verb} elsewhere to add one.` : `No face found. ${verb} where a face is to add a mask.`;
}

const hasMasksOf = (it) => it.manual.length > 0 || it.frames.some((f, j) => f.some((b) => !isOff(b.track, j)));
const hasMasks = () => hasMasksOf(S);

function updateFiles() {
  const many = S.items.length > 1;
  $('files').hidden = !many;
  $('fName').textContent = many ? `${S.cur + 1} / ${S.items.length} · ${S.file.name}` : '';
  $('export').textContent = many ? `Export all (${S.items.length})` : 'Export';
  $('sizeAll').hidden = !many;
  const size = Math.round(S.size * 100);
  $('size').value = size;
  $('sizeOut').textContent = size + '%';
}

function openReview(t) {
  show('review');
  S.emptyOk = false;
  updateFiles();
  const time = $('time');
  time.max = S.duration;
  time.step = 1 / S.fps;
  for (const el of document.querySelectorAll('.videoOnly')) el.hidden = isPhoto();
  updateHint();
  $('stats').hidden = !DEBUG || isPhoto();
  if (DEBUG && !isPhoto()) {
    const n = S.frames.length;
    $('stats').textContent = `${S.W}x${S.H}, ${n} frames, ${Math.round(S.scanMs / 1000)} s (${Math.round(S.scanMs / n)} ms/frame), `
      + `detection ${Math.round(S.detectMs / Math.max(1, S.detectCount))} ms/frame on ${S.parallel || 'page'} threads, `
      + `${S.seekFallbacks} retries, source ${S.srcFps.toFixed(1)} fps, ${navigator.hardwareConcurrency || '?'} cores, ${navigator.deviceMemory || '?'} GB`;
  }
  sizeTimeline();
  refreshPanels();
  goTo(t);
}

function drawnRect() {
  const r = view.getBoundingClientRect();
  const k = Math.min(r.width / S.W, r.height / S.H);
  const w = S.W * k, h = S.H * k;
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w, h, k };
}

function sizeTimeline() {
  const c = $('tracks');
  const r = c.getBoundingClientRect();
  if (!r.width) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(r.width * dpr);
  c.height = Math.round(r.height * dpr);
}

let tlDirty = true;
const tlCache = document.createElement('canvas');

function paintTracks(W, H) {
  const ctx = tlCache.getContext('2d');
  tlCache.width = W;
  tlCache.height = H;
  const N = Math.max(1, S.frames.length);
  const rowH = Math.max(2, Math.floor(H / 6));
  ctx.fillStyle = '#e6e6e6';
  S.tracks.forEach((t, i) => {
    const idx = [...t.dets.keys()];
    const a = Math.max(0, idx[0] - TRACK.hold), b = Math.min(N - 1, idx[idx.length - 1] + TRACK.hold);
    const y = Math.round(H * (0.2 + 0.25 * (i % 3)));
    for (let s = a; s <= b; s++) {
      if (isOff(t, s)) continue;
      let e = s;
      while (e < b && !isOff(t, e + 1)) e++;
      ctx.fillRect(Math.floor(s / N * W), y, Math.max(2, Math.ceil((e - s + 1) / N * W)), rowH);
      s = e;
    }
  });
  ctx.fillStyle = '#ffffff';
  for (const m of S.manual) ctx.fillRect(Math.floor(m.t0 / S.duration * W), Math.round(H * 0.85), Math.max(2, Math.ceil((m.t1 - m.t0) / S.duration * W)), rowH);
}

function drawTimeline() {
  if (isPhoto()) return;
  const c = $('tracks');
  const W = c.width, H = c.height;
  if (!W) return;
  if (tlDirty || tlCache.width !== W || tlCache.height !== H) {
    paintTracks(W, H);
    tlDirty = false;
  }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(tlCache, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(Math.round(S.t / Math.max(0.001, S.duration) * (W - 3)), 0, 3, H);
}

video.addEventListener('ended', () => {
  if (!S.playing) return;
  stopPlay();
  S.t = S.duration;
  renderReview();
});

function stopPlay() {
  if (!S.playing) return;
  S.playing = false;
  video.pause();
  $('play').textContent = '▶';
}

async function togglePlay() {
  if (S.follow) return;
  if (S.playing) { stopPlay(); S.t = video.currentTime - S.start; renderReview(); return; }
  S.playing = true;
  $('play').textContent = '❚❚';
  video.muted = true;
  if (S.t >= S.duration - 0.05) await seekTo(0);
  try { await video.play(); } catch { stopPlay(); return; }
  const tick = (_, meta) => {
    if (!S.playing) return;
    S.t = clamp((meta ? meta.mediaTime : video.currentTime) - S.start, 0, S.duration);
    renderReview(true);
    if (video.ended) { stopPlay(); renderReview(); return; }
    if (hasRVFC) video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  };
  if (hasRVFC) video.requestVideoFrameCallback(tick);
  else requestAnimationFrame(tick);
}

function refreshPanels() {
  const m = S.sel && S.sel.manual;
  const tr = S.sel && S.sel.track;
  $('maskBar').hidden = !m && !tr;
  $('mMinus').hidden = !m;
  $('mPlus').hidden = !m;
  $('mAll').hidden = !m || isPhoto();
  $('mFollow').hidden = !m || isPhoto();
  $('mFollow').classList.toggle('on', !!S.follow || !!(m && m.path));
  $('mAll').classList.toggle('on', !!m && m.t0 <= 0 && m.t1 >= S.duration);
  const j = frameIndex(S.t);
  const off = tr && isOff(tr, j);
  const last = tr && tr.off[tr.off.length - 1];
  const fromHere = tr && tr.off.length && last.at !== j && !isPhoto() ? ' from here on' : '';
  $('mDelete').textContent = off ? '↺' : '×';
  $('mDelete').title = tr ? (off ? 'Restore this mask' : 'Remove this mask') + fromHere : 'Remove';
  const removed = S.tracks.filter(isRemoved).length;
  $('restoreAll').hidden = !removed;
  $('restoreAll').textContent = removed > 1 ? `Restore the ${removed} removed masks` : 'Restore the removed mask';
  placeMaskBar();
}

function selectedRect() {
  if (S.sel && S.sel.manual) return manualAt(S.t).includes(S.sel.manual) ? manualRect(S.sel.manual) : null;
  if (S.sel && S.sel.track) return boxesAt(S.t).find((b) => b.track === S.sel.track) || null;
  return null;
}

function placeMaskBar() {
  const bar = $('maskBar');
  if (bar.hidden) return;
  const r = selectedRect();
  if (!r) { bar.hidden = true; return; }
  const d = drawnRect();
  const stage = $('stage').getBoundingClientRect();
  const bw = bar.offsetWidth || 176, bh = 44;
  let x = d.left + (r.x + r.w / 2) * d.k - bw / 2 - stage.left;
  let y = d.top + (r.y + r.h) * d.k + 8 - stage.top;
  if (y + bh > stage.height - 8) y = d.top + r.y * d.k - bh - 8 - stage.top;
  x = clamp(x, 8, stage.width - bw - 8);
  y = clamp(y, 8, stage.height - bh - 8);
  bar.style.left = x + 'px';
  bar.style.top = y + 'px';
}

function canvasPoint(e) {
  const d = drawnRect();
  return { x: (e.clientX - d.left) / d.w, y: (e.clientY - d.top) / d.h };
}

let drag = null;
const selectedManual = () => S.sel && S.sel.manual;
const deselect = () => { S.sel = null; refreshPanels(); renderReview(); };

view.addEventListener('pointerdown', (e) => {
  if ($('s-review').hidden || S.follow) return;
  e.preventDefault();
  stopPlay();
  const p = canvasPoint(e);
  if (S.split != null) {
    drag = { split: true };
    view.setPointerCapture(e.pointerId);
    S.split = clamp(p.x, 0, 1);
    renderReview();
    return;
  }
  if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) { deselect(); return; }
  const px = p.x * S.W, py = p.y * S.H;
  let m = manualAt(S.t).reverse().find((x) => inside(manualRect(x, S.t), px, py));
  const auto = m ? null : boxesAt(S.t).filter((b) => inside(b, px, py)).sort((a, b) => a.w * a.h - b.w * b.h)[0];
  if (auto) {
    S.sel = { track: auto.track };
    refreshPanels();
    renderReview();
    return;
  }
  if (!m) {
    m = { id: S.nextId++, cx: p.x, cy: p.y, size: 0.12, t0: Math.max(0, S.t - 1), t1: Math.min(S.duration, S.t + 1) };
    S.manual.push(m);
    tlDirty = true;
    updateHint();
  }
  S.sel = { manual: m };
  const [mx, my] = manualPos(m, S.t);
  drag = { m, dx: mx - p.x, dy: my - p.y };
  view.setPointerCapture(e.pointerId);
  refreshPanels();
  renderReview();
});

view.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = canvasPoint(e);
  if (drag.split) {
    S.split = clamp(p.x, 0, 1);
    renderReview();
    return;
  }
  const [mx, my] = manualPos(drag.m, S.t);
  const nx = clamp(p.x + drag.dx, 0, 1), ny = clamp(p.y + drag.dy, 0, 1);
  if (drag.m.path) for (const pt of drag.m.path.pts) { pt[0] = clamp(pt[0] + nx - mx, 0, 1); pt[1] = clamp(pt[1] + ny - my, 0, 1); }
  drag.m.cx = nx;
  drag.m.cy = ny;
  renderReview();
});

for (const ev of ['pointerup', 'pointercancel']) view.addEventListener(ev, () => { drag = null; });

$('mMinus').onclick = () => { const m = selectedManual(); if (!m) return; m.size = clamp(m.size / 1.25, 0.04, 0.9); renderReview(); };
$('mPlus').onclick = () => { const m = selectedManual(); if (!m) return; m.size = clamp(m.size * 1.25, 0.04, 0.9); renderReview(); };
const FOLLOW = { width: 320, keep: 0.5, adapt: 0.75, lost: 8 };

function grayOf(ctx, w, h) {
  const px = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114;
  return g;
}

function patchOf(g, w, h, cx, cy, ts) {
  const x0 = clamp(Math.round(cx - ts / 2), 0, w - ts), y0 = clamp(Math.round(cy - ts / 2), 0, h - ts);
  const p = new Float32Array(ts * ts);
  for (let y = 0; y < ts; y++) for (let x = 0; x < ts; x++) p[y * ts + x] = g[(y0 + y) * w + x0 + x];
  return p;
}

function centred(p, step, ts) {
  let sum = 0, n = 0;
  for (let y = 0; y < ts; y += step) for (let x = 0; x < ts; x += step) { sum += p[y * ts + x]; n++; }
  const mean = sum / n;
  const out = new Float32Array(p.length);
  let norm = 0;
  for (let y = 0; y < ts; y += step) for (let x = 0; x < ts; x += step) { const v = p[y * ts + x] - mean; out[y * ts + x] = v; norm += v * v; }
  return { data: out, norm: Math.sqrt(norm) || 1 };
}

function findPatch(g, w, h, tpl, ts, cx, cy, radius) {
  const step = ts > 24 ? 2 : 1;
  const t = centred(tpl, step, ts);
  const xa = clamp(Math.round(cx - ts / 2 - radius), 0, w - ts), xb = clamp(Math.round(cx - ts / 2 + radius), 0, w - ts);
  const ya = clamp(Math.round(cy - ts / 2 - radius), 0, h - ts), yb = clamp(Math.round(cy - ts / 2 + radius), 0, h - ts);
  const n = Math.ceil(ts / step) ** 2;
  let best = -1, bx = xa, by = ya;
  for (let y0 = ya; y0 <= yb; y0++) {
    for (let x0 = xa; x0 <= xb; x0++) {
      let sf = 0, sff = 0, sft = 0;
      for (let y = 0; y < ts; y += step) {
        const row = (y0 + y) * w + x0, trow = y * ts;
        for (let x = 0; x < ts; x += step) {
          const f = g[row + x];
          sf += f;
          sff += f * f;
          sft += f * t.data[trow + x];
        }
      }
      const spread = Math.sqrt(Math.max(1e-6, sff - sf * sf / n));
      const score = sft / (spread * t.norm);
      if (score > best) { best = score; bx = x0; by = y0; }
    }
  }
  return { score: best, x: bx + ts / 2, y: by + ts / 2 };
}

async function followManual(m) {
  if (S.follow) { S.follow.cancelled = true; return; }
  if (isPhoto()) return;
  stopPlay();
  const job = { cancelled: false };
  S.follow = job;
  const item = S.cur;
  const k = Math.min(1, FOLLOW.width / Math.max(S.W, S.H));
  const w = Math.round(S.W * k), h = Math.round(S.H * k);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const grab = async (i) => {
    if (!await seekSure(frameTime(i))) return null;
    cx.drawImage(video, 0, 0, w, h);
    return grayOf(cx, w, h);
  };
  const last = S.frames.length - 1, i0 = frameIndex(S.t), t0 = S.t;
  const ts = clamp(Math.round(m.size * Math.min(w, h)), 12, 48);
  const radius = Math.max(10, Math.round(ts * 0.8));
  const [sx, sy] = manualPos(m, t0);
  const total = last + 1;
  let done = 0;
  $('mFollow').classList.add('on');
  $('mFollow').textContent = '■';
  $('mFollow').title = 'Stop following';
  const say = () => { $('hint').textContent = `Following… ${Math.round(100 * done / total)}%. Tap ■ to stop.`; };
  say();
  const first = await grab(i0);
  const run = async (dir, limit) => {
    const pts = new Map();
    let tpl = patchOf(first, w, h, sx * w, sy * h, ts), pos = { x: sx * w, y: sy * h }, vel = { x: 0, y: 0 }, bad = 0, good = i0;
    for (let i = i0 + dir; dir > 0 ? i <= limit : i >= limit; i += dir) {
      if (job.cancelled) break;
      const g = await grab(i);
      if (!g) break;
      const r = findPatch(g, w, h, tpl, ts, pos.x + vel.x, pos.y + vel.y, radius);
      if (r.score >= FOLLOW.keep) {
        vel = { x: 0.5 * vel.x + 0.5 * (r.x - pos.x), y: 0.5 * vel.y + 0.5 * (r.y - pos.y) };
        pos = { x: r.x, y: r.y };
        bad = 0;
        good = i;
        if (r.score >= FOLLOW.adapt) {
          const fresh = patchOf(g, w, h, pos.x, pos.y, ts);
          for (let q = 0; q < tpl.length; q++) tpl[q] = 0.85 * tpl[q] + 0.15 * fresh[q];
        }
      } else {
        vel = { x: 0, y: 0 };
        if (++bad >= FOLLOW.lost) break;
      }
      pts.set(i, [pos.x / w, pos.y / h]);
      if (++done % 4 === 0) say();
    }
    return { pts, good };
  };
  const runPlay = () => new Promise((resolve) => {
    const pts = new Map();
    let tpl = patchOf(first, w, h, sx * w, sy * h, ts), pos = { x: sx * w, y: sy * h }, vel = { x: 0, y: 0 }, bad = 0, good = i0, at = i0, over = false, dog = 0;
    const finish = () => {
      if (over) return;
      over = true;
      clearTimeout(dog);
      video.pause();
      video.playbackRate = 1;
      resolve({ pts, good });
    };
    const onFrame = (_, meta) => {
      if (over) return;
      clearTimeout(dog);
      dog = setTimeout(finish, 8000);
      if (job.cancelled) { finish(); return; }
      const i = clamp(Math.floor((meta.mediaTime - S.start) * S.fps), 0, last);
      if (i > at) {
        cx.drawImage(video, 0, 0, w, h);
        const dt = i - at, from = pos, g = grayOf(cx, w, h);
        const r = findPatch(g, w, h, tpl, ts, pos.x + vel.x * dt, pos.y + vel.y * dt, radius * Math.min(3, dt));
        if (r.score >= FOLLOW.keep) {
          vel = { x: 0.5 * vel.x + 0.5 * (r.x - from.x) / dt, y: 0.5 * vel.y + 0.5 * (r.y - from.y) / dt };
          pos = { x: r.x, y: r.y };
          bad = 0;
          good = i;
          if (r.score >= FOLLOW.adapt) {
            const fresh = patchOf(g, w, h, pos.x, pos.y, ts);
            for (let q = 0; q < tpl.length; q++) tpl[q] = 0.85 * tpl[q] + 0.15 * fresh[q];
          }
        } else {
          vel = { x: 0, y: 0 };
          bad += dt;
        }
        for (let s = at + 1; s <= i; s++) {
          const f = (s - at) / dt;
          pts.set(s, [(from.x + (pos.x - from.x) * f) / w, (from.y + (pos.y - from.y) * f) / h]);
        }
        done += dt;
        at = i;
        say();
      }
      if (bad >= FOLLOW.lost || i >= last) finish();
      else video.requestVideoFrameCallback(onFrame);
    };
    dog = setTimeout(finish, 8000);
    video.addEventListener('ended', finish, { once: true });
    video.muted = true;
    video.playbackRate = 2;
    video.play().then(() => video.requestVideoFrameCallback(onFrame), finish);
  });
  let ahead = { pts: new Map(), good: i0 }, behind = { pts: new Map(), good: i0 };
  if (first) {
    ahead = hasRVFC ? await runPlay() : await run(1, last);
    if (!job.cancelled) behind = await run(-1, 0);
  }
  S.follow = null;
  $('mFollow').classList.remove('on');
  $('mFollow').textContent = '⌖';
  $('mFollow').title = 'Follow what is under this mask';
  if (S.cur !== item) return;
  if (!job.cancelled && first) {
    const lo = behind.good, hi = ahead.good;
    const pts = [];
    for (let i = lo; i <= hi; i++) pts.push(i === i0 ? [sx, sy] : (i > i0 ? ahead.pts.get(i) : behind.pts.get(i)) || pts[pts.length - 1] || [sx, sy]);
    m.path = { i0: lo, pts };
    m.cx = pts[0][0];
    m.cy = pts[0][1];
    m.t0 = lo === 0 ? 0 : lo / S.fps;
    m.t1 = hi >= last ? S.duration : Math.min(S.duration, (hi + 1) / S.fps + 0.1);
    tlDirty = true;
  }
  updateHint();
  await goTo(t0);
}

$('mFollow').onclick = () => {
  const m = selectedManual();
  if (m) followManual(m);
  else if (S.follow) S.follow.cancelled = true;
};

$('mAll').onclick = () => {
  const m = selectedManual();
  if (!m || S.follow) return;
  const whole = m.t0 <= 0 && m.t1 >= S.duration;
  if (whole) { m.t0 = Math.max(0, S.t - 1); m.t1 = Math.min(S.duration, S.t + 1); } else { m.t0 = 0; m.t1 = S.duration; }
  tlDirty = true;
  refreshPanels();
  renderReview();
};
$('mDelete').onclick = () => {
  if (S.follow) return;
  tlDirty = true;
  if (S.sel && S.sel.track) { toggleTrack(S.sel.track, frameIndex(S.t)); updateHint(); refreshPanels(); renderReview(); return; }
  S.manual = S.manual.filter((x) => x !== selectedManual());
  updateHint();
  deselect();
};
$('restoreAll').onclick = () => {
  for (const t of S.tracks) t.off = [];
  tlDirty = true;
  updateHint();
  refreshPanels();
  renderReview();
};

$('time').addEventListener('input', (e) => { stopPlay(); goTo(+e.target.value); });
const stepBy = (n) => { stopPlay(); goTo((seekBusy ? seekTarget : S.t) + n / S.fps); };
$('prev').onclick = () => stepBy(-1);
$('next').onclick = () => stepBy(1);
$('play').onclick = togglePlay;

$('sizeAll').onclick = () => {
  stash();
  for (const it of S.items) it.size = S.size;
  $('sizeAll').textContent = 'Done';
  setTimeout(() => { $('sizeAll').textContent = 'Apply to all'; }, 1200);
};

let sizeFrame = 0;
$('size').addEventListener('input', (e) => {
  S.size = e.target.valueAsNumber / 100;
  $('sizeOut').textContent = e.target.value + '%';
  if (sizeFrame) return;
  sizeFrame = requestAnimationFrame(() => {
    sizeFrame = 0;
    applySize();
    renderReview();
  });
});

$('splitBtn').onclick = () => {
  stopPlay();
  S.split = S.split == null ? 0.5 : null;
  S.sel = null;
  $('splitBtn').classList.toggle('on', S.split != null);
  $('splitBtn').setAttribute('aria-pressed', String(S.split != null));
  updateHint();
  renderReview();
};

const EMOJIS = ['😶', '😎', '🤡', '👻', '💀', '🐸', '🐱', '🐶', '🐵', '🦊', '🐼', '🐰', '🦆', '🦄', '🤖', '👽', '🥸', '🙈', '😷', '🥷', '🌚', '🔥', '⭐', '🎭'];
const panel = $('stylePanel');

function updateNote() {
  const blur = S.style === 'blur';
  $('styleNote').hidden = !blur;
  $('blurRow').hidden = !blur;
  $('styleNote').textContent = S.blurStrength <= 4 ? 'Low strength can leave a face recognisable. A solid square hides more.' : 'Blur keeps colours and shape visible. A solid square hides more.';
}

$('blur').addEventListener('input', (e) => {
  S.blurStrength = e.target.valueAsNumber;
  $('blurOut').textContent = e.target.value;
  updateNote();
  renderReview();
});

function pickStyle(style, emoji) {
  S.style = style;
  if (emoji) S.emoji = emoji;
  $('styleBtn').innerHTML = style === 'emoji' ? S.emoji : `<span class="${style === 'blur' ? 'blurIcon' : 'sq'}"></span>`;
  for (const b of panel.children) b.classList.toggle('on', b.dataset.kind === style && (style !== 'emoji' || b.dataset.emoji === S.emoji));
  updateNote();
  panel.hidden = true;
  $('styleBtn').setAttribute('aria-expanded', 'false');
  renderReview();
}

const choices = [{ kind: 'black', label: 'Solid black square', icon: 'sq' }, { kind: 'blur', label: 'Blur', icon: 'blurIcon' }, ...EMOJIS.map((emoji) => ({ kind: 'emoji', emoji, label: 'Mask with ' + emoji }))];
for (const c of choices) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'em' + (c.kind === 'black' ? ' on' : '');
  b.dataset.kind = c.kind;
  b.setAttribute('aria-label', c.label);
  if (c.emoji) { b.dataset.emoji = c.emoji; b.textContent = c.emoji; }
  else b.innerHTML = `<span class="${c.icon}"></span>`;
  b.onclick = () => pickStyle(c.kind, c.emoji);
  panel.append(b);
}

$('styleBtn').onclick = () => {
  panel.hidden = !panel.hidden;
  $('styleBtn').setAttribute('aria-expanded', String(!panel.hidden));
};
document.addEventListener('pointerdown', (e) => {
  if (!reportPanel.hidden && !reportPanel.contains(e.target) && e.target !== $('reportBtn')) closeReport();
  if (!panel.hidden && !panel.contains(e.target) && e.target !== $('styleBtn') && !$('styleBtn').contains(e.target)) { panel.hidden = true; $('styleBtn').setAttribute('aria-expanded', 'false'); } });
const reportPanel = $('reportPanel');
const clock = (sec) => {
  const tenths = Math.round(sec * 10);
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`;
};

function isWeak(t) {
  const best = Math.max(...[...t.dets.values()].map((d) => d.s));
  return best < 0.5 || t.dets.size < Math.min(6, S.frames.length);
}

function reportRows() {
  const weak = S.tracks.filter(isWeak);
  const rows = [['Faces tracked', S.tracks.length + (weak.length ? ` (${weak.length} to double-check)` : '')]];
  rows.push(['Masks added by hand', String(S.manual.length)], ['Faces edited', String(S.tracks.filter((t) => t.off.length).length)]);
  if (isPhoto()) rows.push(['Picture', `${S.W} × ${S.H}`]);
  else {
    const covered = S.frames.reduce((n, f, j) => n + (f.some((b) => !isOff(b.track, j)) || manualAt((j + 0.5) / S.fps).length ? 1 : 0), 0);
    rows.push(['Frames with a mask', `${covered} of ${S.frames.length} (${Math.round(100 * covered / Math.max(1, S.frames.length))}%)`]);
    rows.push(['Analysed', `${S.frames.length} frames at ${S.fps} per second`]);
  }
  rows.push(['Mask size', Math.round(S.size * 100) + '%'], ['Style', S.style === 'emoji' ? 'Emoji ' + S.emoji : S.style === 'blur' ? 'Blur' : 'Black square']);
  if (!isPhoto()) rows.push(['Sound', S.keepAudio ? 'kept' : 'off']);
  return rows;
}

function fillReport(list, rows = reportRows()) {
  list.replaceChildren();
  for (const [label, value] of rows) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    list.append(dt, dd);
  }
}

function openReport() {
  fillReport($('reportList'));
  const jump = $('reportJump');
  jump.replaceChildren();
  if (!isPhoto()) {
    let faces = 0;
    for (const t of S.tracks) {
      const label = `Face ${++faces}`;
      if (!isWeak(t)) continue;
      const first = Math.min(...t.dets.keys());
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tool';
      b.textContent = `${label} · ${clock(first / S.fps)}`;
      b.onclick = () => { closeReport(); stopPlay(); goTo(first / S.fps); };
      jump.append(b);
    }
  }
  jump.hidden = !jump.children.length;
  reportPanel.hidden = false;
  $('reportBtn').setAttribute('aria-expanded', 'true');
}

function closeReport() {
  reportPanel.hidden = true;
  $('reportBtn').setAttribute('aria-expanded', 'false');
}

$('reportBtn').onclick = () => (reportPanel.hidden ? openReport() : closeReport());

$('audioBtn').onclick = () => {
  S.keepAudio = !S.keepAudio;
  $('audioBtn').classList.toggle('on', S.keepAudio);
  $('audioNote').textContent = S.keepAudio ? 'Sound kept. A voice can identify someone too.' : 'Sound off: the video will be silent.';
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !reportPanel.hidden) { closeReport(); return; }
  if (e.key === 'Escape' && !panel.hidden) { panel.hidden = true; $('styleBtn').setAttribute('aria-expanded', 'false'); return; }
  if ($('s-review').hidden || isPhoto() || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); stepBy(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stepBy(1); }
  else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
});
window.addEventListener('resize', () => { if (!$('s-review').hidden) { sizeTimeline(); renderReview(); } });

const sizeLabel = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
const outName = (kind, ext) => (S.items.length > 1 ? `masked-${kind}-${S.cur + 1}.${ext}` : `masked-${kind}.${ext}`);

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

async function crc32(blob) {
  let c = -1;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) c = CRC[(c ^ value[i]) & 255] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

async function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = await crc32(f.blob);
    const size = f.blob.size;
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true);
    head.setUint16(12, 33, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, size, true);
    head.setUint32(22, size, true);
    head.setUint16(26, name.length, true);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(14, 33, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, size, true);
    dir.setUint32(24, size, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    parts.push(head, name, f.blob);
    central.push(dir, name);
    offset += 30 + name.length + f.blob.size;
  }
  const size = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

function clearResults() {
  for (const r of S.results) { URL.revokeObjectURL(r.url); URL.revokeObjectURL(r.previewUrl); }
  if (S.zipUrl) URL.revokeObjectURL(S.zipUrl);
  S.results = [];
  S.zipUrl = S.resultUrl = S.previewUrl = S.resultFile = null;
  $('result').pause();
  $('result').removeAttribute('src');
  $('resultImg').removeAttribute('src');
}

function pickResult(k) {
  const r = S.results[k];
  S.shown = k;
  S.resultFile = r.file;
  S.resultUrl = r.url;
  S.previewUrl = r.previewUrl;
  $('result').hidden = r.photo;
  $('resultImg').hidden = !r.photo;
  $('result').onerror = () => {
    if (r.photo) return;
    $('result').hidden = true;
    $('doneCheck').textContent = "The preview cannot play here. Open the saved video and watch all of it before posting.";
  };
  (r.photo ? $('resultImg') : $('result')).src = r.previewUrl;
  fillReport($('doneReport'), r.rows);
  $('doneCheck').textContent = r.photo ? 'Look at it closely before posting.' : 'Watch all of it before posting.';
  $('doneInfo').textContent = `${r.info}, ${sizeLabel(r.size)}.`;
  for (const [i, row] of [...$('results').children].entries()) row.classList.toggle('on', i === k);
}

async function showResults(list) {
  clearResults();
  for (const res of list) {
    const blob = res.blob;
    S.results.push({
      name: res.name, info: res.info, photo: !!res.photo, rows: res.rows, size: blob.size,
      file: new File([blob], res.name, { type: blob.type }), url: URL.createObjectURL(blob), previewUrl: URL.createObjectURL(blob),
    });
  }
  const many = S.results.length > 1;
  const list2 = $('results');
  list2.replaceChildren();
  list2.hidden = !many;
  S.results.forEach((r, k) => {
    const li = document.createElement('li');
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'pickRes';
    view.textContent = `${k + 1} · ${r.name} · ${sizeLabel(r.size)}`;
    view.onclick = () => pickResult(k);
    const save = document.createElement('a');
    save.className = 'link';
    save.textContent = 'Save';
    save.href = r.url;
    save.download = r.name;
    li.append(view, save);
    list2.append(li);
  });
  if (many) {
    const zip = await makeZip(S.results.map((r) => ({ name: r.name, blob: r.file })));
    S.zipUrl = URL.createObjectURL(zip);
    $('download').href = S.zipUrl;
    $('download').download = 'masked-files.zip';
    $('downloadText').textContent = `Download all (${S.results.length})`;
  } else {
    $('download').href = S.results[0].url;
    $('download').download = S.results[0].name;
    $('downloadText').textContent = 'Download';
  }
  $('share').hidden = !(navigator.canShare && navigator.canShare({ files: S.results.map((r) => r.file) }));
  $('doneTitle').textContent = 'Ready.';
  pickResult(0);
  show('done');
  if (!many) $('download').click();
}

async function exportPhoto() {
  S.sel = null;
  drawSource(vctx);
  paint(vctx, 0, false);
  const blob = await new Promise((r) => view.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) return { fail: 'This browser could not create the photo.' };
  return { blob, name: outName('photo', 'jpg'), info: 'JPEG file', photo: true };
}

async function scrubMp4Dates(blob) {
  const head = new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer());
  const view = new DataView(head.buffer);
  const type = (p) => String.fromCharCode(head[p + 4], head[p + 5], head[p + 6], head[p + 7]);
  const walk = (start, end) => {
    for (let p = start; p + 8 <= end;) {
      const size = view.getUint32(p);
      if (size < 8 || p + size > end) return;
      const t = type(p);
      if (t === 'moov' || t === 'trak' || t === 'mdia' || t === 'minf' || t === 'stbl') walk(p + 8, p + size);
      else if (t === 'mvhd' || t === 'tkhd' || t === 'mdhd') head.fill(0, p + 12, p + 12 + (head[p + 8] === 1 ? 16 : 8));
      else if (t === 'hdlr') head.fill(0, p + 32, p + size);
      else if (t === 'stsd' && size >= 16 + 82 && /^(avc|hvc|hev|vp0|av0)/.test(type(p + 16))) head.fill(0, p + 16 + 50, p + 16 + 82);
      p += size;
    }
  };
  walk(0, head.length);
  return new Blob([head, blob.slice(head.length)], { type: blob.type });
}

function pickMime() {
  if (!window.MediaRecorder) return null;
  const list = [
    'video/mp4;codecs="avc1.640028,mp4a.40.2"',
    'video/mp4;codecs="avc1.42E01F,mp4a.40.2"',
    'video/mp4',
    'video/webm;codecs="vp9,opus"',
    'video/webm;codecs="vp8,opus"',
    'video/webm',
  ];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

async function exportFast() {
  const job = { cancelled: false };
  S.job = job;
  await keepAwake(true);
  let made = null, audioKept = false, hasAudio = true, input = null;
  const mp4 = S.fast === 'avc';
  try {
    input = new MB.Input({ source: new MB.BlobSource(S.file), formats: MB.ALL_FORMATS });
    hasAudio = !!(await input.getPrimaryAudioTrack());
    const output = new MB.Output({ format: mp4 ? new MB.Mp4OutputFormat({ fastStart: 'in-memory' }) : new MB.WebMOutputFormat(), target: new MB.BufferTarget() });
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(S.W, S.H) : Object.assign(document.createElement('canvas'), { width: S.W, height: S.H });
    const ctx = canvas.getContext('2d');
    let first = null;
    const conversion = await MB.Conversion.init({
      input,
      output,
      video: {
        forceTranscode: true,
        allowTransformationMetadata: false,
        width: S.W,
        height: S.H,
        fit: 'fill',
        codec: S.fast,
        bitrate: clamp(S.W * S.H * 4, 2_500_000, 10_000_000),
        process: (sample) => {
          if (first == null) first = sample.timestamp;
          sample.draw(ctx, 0, 0, S.W, S.H);
          paint(ctx, sample.timestamp - first + S.first, false);
          return canvas;
        },
        processedWidth: S.W,
        processedHeight: S.H,
      },
      audio: { discard: !S.keepAudio },
      tags: {},
      showWarnings: false,
    });
    const kept = conversion.utilizedTracks;
    if (!conversion.isValid || kept.filter((t) => t.type === 'video').length !== 1) throw new Error('unsupported video');
    audioKept = kept.some((t) => t.type === 'audio');
    conversion.onProgress = (p) => {
      const pct = Math.floor(clamp(p * 100, 0, 100));
      $('exportBar').style.width = pct + '%';
      $('exportPct').textContent = pct + '%';
    };
    job.cancel = () => conversion.cancel();
    await conversion.execute();
    made = new Blob([output.target.buffer], { type: mp4 ? 'video/mp4' : 'video/webm' });
  } catch (e) {
    if (!job.cancelled) console.error(e);
  }
  if (input) try { input.dispose(); } catch {}
  S.job = null;
  await keepAwake(false);
  if (job.cancelled) return { cancel: true };
  if (!made || !made.size) return null;
  const sound = audioKept ? 'with sound' : !hasAudio ? 'no sound in the original' : S.keepAudio ? 'without sound (it could not be copied)' : 'without sound';
  return { blob: mp4 ? await scrubMp4Dates(made) : made, name: outName('video', mp4 ? 'mp4' : 'webm'), info: `${mp4 ? 'MP4' : 'WebM'} file, ${sound}, fast export` };
}

async function exportOne() {
  if (isPhoto()) return exportPhoto();
  S.sel = null;
  if (!S.fast) return exportSlow();
  const made = await exportFast();
  if (made) return made;
  S.fast = false;
  return { fail: 'Fast export did not work here. Tap Export again: the video will be made at normal speed.' };
}

async function exportSlow() {
  const mime = pickMime();
  if (!mime || !view.captureStream) return { fail: 'This browser cannot create videos. Try an up-to-date Chrome or Safari.' };
  const keepAudio = S.keepAudio;
  let audioDest = null, audioFailed = false;
  if (keepAudio) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      S.audioCtx = S.audioCtx || new AC();
      S.audioCtx.resume();
      S.audioNode = S.audioNode || S.audioCtx.createMediaElementSource(video);
      audioDest = S.audioCtx.createMediaStreamDestination();
      S.audioNode.connect(audioDest);
    } catch (e) {
      console.error(e);
      audioFailed = true;
    }
  }
  video.muted = !keepAudio;
  video.volume = 1;
  const unlock = video.play();
  if (unlock) await unlock.then(() => video.pause(), () => {});
  const job = { cancelled: false };
  S.job = job;
  show('export');
  $('exportBar').style.width = '0';
  $('exportPct').textContent = '0%';
  $('exportText').textContent = audioFailed ? "The sound could not be copied: the video will be silent." : '';
  await keepAwake(true);
  const draw = (t) => {
    vctx.drawImage(video, 0, 0, S.W, S.H);
    paint(vctx, t, false);
  };
  const sought = await seekSure(0);
  if (job.cancelled || !sought) {
    if (audioDest) S.audioNode.disconnect(audioDest);
    video.muted = true;
    S.job = null;
    await keepAwake(false);
    return job.cancelled ? { cancel: true } : { fail: 'Creating the video failed in this browser. Try an up-to-date Chrome or Safari.' };
  }
  draw(0);
  const stream = view.captureStream();
  if (audioDest) for (const tr of audioDest.stream.getAudioTracks()) stream.addTrack(tr);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: clamp(S.W * S.H * 4, 2_500_000, 10_000_000), audioBitsPerSecond: 128_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start();
  draw(0);
  let running = true;
  const frame = (t) => {
    if (!running) return;
    draw(t);
    const pct = Math.floor(clamp(t / S.duration * 100, 0, 100));
    $('exportBar').style.width = pct + '%';
    $('exportPct').textContent = pct + '%';
  };
  const loop = hasRVFC
    ? (_, meta) => { frame(meta.mediaTime - S.start); if (running) video.requestVideoFrameCallback(loop); }
    : () => { frame(video.currentTime - S.start); if (running) requestAnimationFrame(loop); };
  if (hasRVFC) video.requestVideoFrameCallback(loop); else requestAnimationFrame(loop);
  const onHide = () => {
    if (document.hidden) { video.pause(); if (rec.state === 'recording') rec.pause(); }
    else { if (rec.state === 'paused') rec.resume(); video.play().catch(() => {}); }
  };
  document.addEventListener('visibilitychange', onHide);
  let failed = false;
  try {
    const ended = once(video, 'ended', 'error');
    while (document.hidden && !job.cancelled) await sleep(300);
    await video.play();
    job.cancel = () => video.dispatchEvent(new Event('ended'));
    await ended;
  } catch (e) {
    console.error(e);
    failed = true;
  }
  video.pause();
  if (!job.cancelled && !failed) { frame(S.duration); await sleep(200); }
  running = false;
  document.removeEventListener('visibilitychange', onHide);
  if (rec.state !== 'inactive') rec.stop();
  await stopped;
  for (const tr of stream.getTracks()) tr.stop();
  if (audioDest) S.audioNode.disconnect(audioDest);
  video.muted = true;
  S.job = null;
  await keepAwake(false);
  if (job.cancelled) return { cancel: true };
  if (failed || !chunks.length) return { fail: 'Creating the video failed in this browser. Try an up-to-date Chrome or Safari.' };
  const type = (rec.mimeType || mime).split(';')[0];
  const mp4 = type.includes('mp4');
  const made = new Blob(chunks, { type });
  return { blob: mp4 ? await scrubMp4Dates(made) : made, name: outName('video', mp4 ? 'mp4' : 'webm'), info: `${mp4 ? 'MP4' : 'WebM'} file${audioDest ? ', with sound' : ', without sound'}` };
}

async function exportAll() {
  stopPlay();
  S.sel = null;
  $('fatal').hidden = true;
  const back = S.cur, backT = S.t;
  stash();
  const n = S.items.length;
  const out = [];
  let problem = null;
  S.exporting = true;
  S.cancelAll = false;
  show('export');
  for (let k = 0; k < n && !problem && !S.cancelAll; k++) {
    $('exportFile').textContent = n > 1 ? `File ${k + 1} of ${n}` : '';
    $('exportBar').style.width = '0';
    $('exportPct').textContent = '0%';
    $('exportText').textContent = '';
    try {
      await activate(k);
    } catch (e) {
      console.error(e);
      problem = 'A file could not be opened again. Choose the files again.';
      break;
    }
    const r = await exportOne();
    if (r.cancel) S.cancelAll = true;
    else if (r.fail) problem = r.fail;
    else out.push({ ...r, rows: reportRows() });
  }
  S.exporting = false;
  if (S.cancelAll || problem) {
    S.cancelAll = false;
    await switchTo(back, backT);
    if (problem) fail($('fatal'), problem);
    return;
  }
  await showResults(out);
}

$('export').onclick = () => {
  if (S.follow) return;
  stash();
  const empty = S.items.filter((it) => !hasMasksOf(it)).length;
  if (empty && !S.emptyOk) {
    S.emptyOk = true;
    fail($('fatal'), S.items.length > 1 ? `${empty} of ${S.items.length} files have no mask. Tap Export again to save them unchanged.` : 'There is no mask on this file. Tap Export again to save it unchanged.');
    return;
  }
  return exportAll();
};
$('share').onclick = async () => {
  try { await navigator.share({ files: S.results.map((r) => r.file) }); } catch {}
};

$('back').onclick = () => { $('result').pause(); switchTo(0); };
$('fPrev').onclick = () => !S.follow && switchTo((S.cur + S.items.length - 1) % S.items.length);
$('fNext').onclick = () => !S.follow && switchTo((S.cur + 1) % S.items.length);
$('fDrop').onclick = async () => {
  if (S.items.length < 2 || S.follow) return;
  const k = S.cur;
  stopPlay();
  leave();
  const [gone] = S.items.splice(k, 1);
  if (gone.srcUrl) URL.revokeObjectURL(gone.srcUrl);
  await switchTo(Math.min(k, S.items.length - 1));
};

function cancelJob() {
  if (S.exporting) S.cancelAll = true;
  if (!S.job) return;
  S.job.cancelled = true;
  if (S.job.cancel) S.job.cancel();
}

function resetAll() {
  S.run++;
  cancelJob();
  S.job = null;
  stopPlay();
  keepAwake(false);
  clearResults();
  for (const it of S.items) if (it.srcUrl) URL.revokeObjectURL(it.srcUrl);
  dropFile();
  S.items = [];
  S.cur = 0;
  resetFile();
  S.live = false;
  S.split = null;
  $('splitBtn').classList.remove('on');
  $('fatal').hidden = true;
}

function goHome() {
  resetAll();
  video.removeAttribute('src');
  video.load();
  $('file').value = '';
  show('home');
}

$('scanCancel').onclick = goHome;
$('exportCancel').onclick = cancelJob;
$('restart2').onclick = goHome;

for (const ev of ['dragenter', 'dragover']) $('pickLabel').addEventListener(ev, (e) => { e.preventDefault(); $('pickLabel').classList.add('over'); });
for (const ev of ['dragleave', 'drop']) $('pickLabel').addEventListener(ev, (e) => { e.preventDefault(); $('pickLabel').classList.remove('over'); });
for (const ev of ['dragover', 'drop']) window.addEventListener(ev, (e) => e.preventDefault());
$('pickLabel').addEventListener('drop', (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length && !$('file').disabled) loadFiles(files);
});

$('file').addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length) loadFiles(e.target.files);
});

if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)) {
  let waiting = null;
  const nothingCame = () => {
    if (waiting) return;
    waiting = setTimeout(() => {
      waiting = null;
      if (!S.file && !$('s-home').hidden) fail($('homeError'), "No video received: the iPhone photo library does not always pass them on. Save the video to Files (Share, then “Save to Files”), then tap the square and “Choose File”.");
    }, 4000);
  };
  $('file').addEventListener('cancel', nothingCame);
  $('file').addEventListener('click', () => addEventListener('focus', nothingCame, { once: true }));
  $('file').addEventListener('change', () => { clearTimeout(waiting); waiting = null; });
}

if (DEBUG) window.anonymizer = {
  S, frameIndex, boxesAt, manualPos, renderReview,
  retrack: (o) => { Object.assign(TRACK, o); buildTracks(S.raw); },
  rejudge: (o, t = {}, r = {}) => {
    Object.assign(JUDGE, o);
    Object.assign(RULE, r);
    Object.assign(TRACK, t);
    const results = [];
    for (const { found, i, j } of S.found) {
      const boxes = judge(found.map((b) => ({ ...b })));
      for (const b of boxes) b.at = i;
      for (let k = i; k <= j; k++) if (!results[k]) results[k] = boxes;
    }
    for (let k = 0; k < results.length; k++) results[k] ||= [];
    S.raw = results;
    buildTracks(results);
  },
};

$('version').textContent = 'version ' + VERSION;

init();
