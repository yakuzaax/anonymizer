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

const LOW_EVERY = 3;
const GROW = 1.3;
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

const VERSION = '2026-10-17.0';
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
  frames: [],
  manual: [],
  sel: null,
  nextId: 1,
  t: 0,
  style: 'black',
  emoji: '😶',
  keepAudio: true,
  job: null,
  playing: false,
  file: null,
  fast: false,
  srcUrl: null,
  resultUrl: null,
  resultFile: null,
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
  } catch {  }
}

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

    let shownAt = performance.now();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) shownAt = performance.now(); });
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
        w.postMessage({ type: 'detect', id, bitmap, w: bitmap.width, h: bitmap.height, maxSide, minScore: KEEP_SCORE, always, rule: RULE }, [bitmap]);
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
      if (m.type === 'done') p.ok(m.boxes); else p.ko(new Error(m.message));
    };
    w.onerror = (e) => { clearTimeout(giveUp); resolve(null); breakDown('worker failed'); };
    w.postMessage({ type: 'init' });
  });
}

async function localRunner() {
  const detect = await createDetector(new URL('.', location.href).href);
  return {
    detect: async (bitmap, maxSide, always) => {
      const boxes = await detectBoth(detect, bitmap, bitmap.width, bitmap.height, maxSide, KEEP_SCORE, always, RULE);
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

    S.fast = (await VideoEncoder.isConfigSupported({ codec: 'avc1.42001f', width: 1280, height: 720, bitrate: 4e6 })).supported === true;
  } catch (e) {
    console.error(e);
  }
}

async function init() {
  try {
    const cores = navigator.hardwareConcurrency || 2;

    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const wanted = clamp(cores - 1, 1, ios ? 2 : 3);
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
    $('pickText').innerHTML = matchMedia('(pointer: fine)').matches ? 'Drop a video or photo,<br>or click to choose' : 'Choose a video<br>or a photo';
    $('footNote').textContent = matchMedia('(pointer: fine)').matches ? 'Nothing leaves your computer.' : 'Nothing leaves your phone.';
  } catch (e) {
    console.error(e);
    $('pickText').textContent = 'Tool unavailable';
    fail($('homeError'), "The tool could not load in this browser. Try an up-to-date Chrome or Safari.");
  }
}

function once(target, ok, bad, ms) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { target.removeEventListener(ok, onOk); if (bad) target.removeEventListener(bad, onBad); fn(v); };
    const onOk = () => done(resolve);
    const onBad = () => done(reject, new Error(bad));
    target.addEventListener(ok, onOk);
    if (bad) target.addEventListener(bad, onBad);
    if (ms) setTimeout(() => done(reject, new Error('timeout')), ms);
  });
}

function seekTo(t, ms = 3000) {
  return new Promise((resolve) => {
    let seeked = false, framed = false, finished = false;
    const fin = (ok) => { if (!finished) { finished = true; video.removeEventListener('seeked', onSeeked); resolve(ok); } };
    const onSeeked = () => {
      seeked = true;
      if (framed) fin(true); else setTimeout(() => fin(true), 15);
    };
    video.addEventListener('seeked', onSeeked);
    if (hasRVFC) video.requestVideoFrameCallback(() => { framed = true; if (seeked) fin(true); });
    setTimeout(() => fin(false), ms);
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

async function loadFile(file) {
  resetAll();
  $('homeError').hidden = true;
  S.kind = file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name) ? 'photo' : 'video';

  if (!isPhoto() && /Android/.test(navigator.userAgent) && /Firefox\//.test(navigator.userAgent) && !('VideoDecoder' in window)) {
    fail($('homeError'), "Firefox on Android cannot process videos. Open anonymizer.nvp.qzz.io in Chrome. Photos work here.");
    return;
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
      video.src = S.srcUrl;
      await once(video, 'loadedmetadata', 'error', 20000);
      S.start = Number.isFinite(video.currentTime) ? video.currentTime : 0;

      if (video.readyState < 2) {
        const frame = once(video, 'loadeddata', 'error', 20000);
        video.currentTime = S.start + 0.001;
        const late = setTimeout(() => {
          if (video.readyState < 2) video.play().then(() => { video.pause(); video.currentTime = S.start; }).catch(() => {});
        }, 3000);
        await frame.finally(() => clearTimeout(late));
      }
      if (!Number.isFinite(video.duration)) {

        video.currentTime = 1e7;
        await once(video, 'durationchange', null, 5000).catch(() => {});
      }
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('illisible');
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
        } catch {  }
      }
    }
    if (!w || !h) throw new Error('illisible');
  } catch (e) {
    fail($('homeError'), "Your browser cannot read this file. Try another browser, or save it in another format.");
    return;
  }

  const k = Math.min(1, (isPhoto() ? MAX_SIDE_PHOTO : MAX_SIDE) / Math.max(w, h));
  S.W = Math.round(w * k / 2) * 2;
  S.H = Math.round(h * k / 2) * 2;
  for (const c of [view, work, preview]) { c.width = S.W; c.height = S.H; }

  show('scan');
  $('scanBar').style.height = '0';
  $('scanText').textContent = '0%';
  await scan();
}

async function scan() {
  const job = { cancelled: false };
  S.job = job;
  await keepAwake(true);

  S.srcFps = isPhoto() ? 1 : await measureFps();
  S.fps = isPhoto() ? 1 : ANALYSIS_FPS;
  const total = isPhoto() ? 1 : Math.max(1, Math.ceil(S.duration * S.fps));
  const side = !isPhoto() && $('fast').checked ? DET_SIDE : DET_SIDE_DEEP;
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
    if (!sawPicture) checkPicture(canvas);

    const shot = createImageBitmap(canvas);
    const runner = await acquire();
    if (job.cancelled || error) { release(runner); (await shot).close(); return; }
    const bitmap = await shot;
    const t0 = performance.now();
    const always = isPhoto() || sent++ % LOW_EVERY === 0;
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
  if (job.cancelled) return;
  S.job = null;
  if (error || results.some((r) => !r)) {

    console.error(error || 'missing frames');
    goHome();
    fail($('homeError'), "Analysis failed in this browser. Try an up-to-date Chrome or Safari.");
    return;
  }
  if (!sawPicture) {

    goHome();
    fail($('homeError'), "This browser cannot display this video's frames, so it cannot find the faces. Try an up-to-date Chrome or Safari.");
    return;
  }
  S.scanMs = performance.now() - started;
  S.raw = results;
  buildTracks(results);
  openReview(0);
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
  const setRate = (r) => { rate = clamp(r, 0.25, 1); try { video.playbackRate = rate; } catch {  } };

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
  } catch {  }
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
  const w = b.w * GROW + edge, h = b.h * GROW + edge;
  return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
}

function union(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });

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
        const dist = Math.hypot(l.x + l.w / 2 - d.x - d.w / 2, l.y + l.h / 2 - d.y - d.h / 2) / reach;

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
      const t = { id: tracks.length + 1, dets: new Map(), off: [] };
      tracks.push(t);
      active.push(t);
      assign(d, t);
    }
  }

  const frames = Array.from({ length: N }, () => []);
  for (const t of tracks) {
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
    for (let j = Math.max(0, a - 1); j <= Math.min(N - 1, b + 1); j++) {
      const near = [path[j - a - 1], path[j - a], path[j - a + 1]].filter(Boolean);
      const box = near.reduce(union);
      const biggest = Math.max(...near.map((r) => r.w * r.h));

      if (box.w * box.h <= TRACK.unionMax * biggest) frames[j].push({ ...grow(box), track: t });
      else for (const r of near) frames[j].push({ ...grow(r), track: t });
    }
  }
  S.tracks = tracks;
  S.frames = frames;
}

function manualRect(m) {
  const s = m.size * Math.min(S.W, S.H);
  return { x: m.cx * S.W - s / 2, y: m.cy * S.H - s / 2, w: s, h: s };
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

function paint(ctx, t, edit) {
  const j = frameIndex(t);
  const auto = S.frames[j] || [];
  const rects = [...auto.filter((b) => !isOff(b.track, j)), ...manualAt(t).map(manualRect)];

  ctx.fillStyle = '#000';
  for (const r of rects) ctx.fillRect(Math.floor(r.x), Math.floor(r.y), Math.ceil(r.w) + 1, Math.ceil(r.h) + 1);

  if (S.style === 'emoji') {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const r of rects) {
      const s = Math.min(r.w, r.h);
      ctx.font = `${Math.round(s * 0.82)}px serif`;
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
  for (const m of manualAt(t)) frame(manualRect(m), '#ffffff', S.sel && S.sel.manual === m);
  ctx.setLineDash([]);
}

let seekBusy = false, seekNext = null;

async function goTo(t) {
  if (isPhoto()) { S.t = 0; renderReview(); return; }
  seekNext = clamp(t, 0, Math.max(0, S.duration - 0.001));
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

function renderReview() {
  drawSource(vctx);
  paint(vctx, S.t, true);
  $('time').value = S.t;
  drawTimeline();
  refreshPanels();
}

function openReview(t) {
  show('review');
  const time = $('time');
  time.max = S.duration;
  time.step = 1 / S.fps;
  for (const el of document.querySelectorAll('.videoOnly')) el.hidden = isPhoto();
  $('hint').textContent = (matchMedia('(pointer: fine)').matches ? 'Click' : 'Tap') + ' a face to hide or unhide its mask.';
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

function drawTimeline() {
  if (isPhoto()) return;
  const c = $('tracks');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  if (!W) return;
  ctx.clearRect(0, 0, W, H);
  const N = Math.max(1, S.frames.length);
  const rows = 3, rowH = Math.max(2, Math.floor(H / 6));
  ctx.fillStyle = '#e6e6e6';
  S.tracks.forEach((t, i) => {
    const idx = [...t.dets.keys()];
    const a = Math.max(0, idx[0] - TRACK.hold), b = Math.min(N - 1, idx[idx.length - 1] + TRACK.hold);
    const y = Math.round(H * (0.2 + 0.25 * (i % rows)));

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
  const x = Math.round(S.t / Math.max(0.001, S.duration) * (W - 3));
  ctx.fillRect(x, 0, 3, H);
}

function stopPlay() {
  if (!S.playing) return;
  S.playing = false;
  video.pause();
  $('play').textContent = '▶';
}

async function togglePlay() {
  if (S.playing) { stopPlay(); S.t = video.currentTime - S.start; renderReview(); return; }
  S.playing = true;
  $('play').textContent = '❚❚';
  video.muted = true;
  if (S.t >= S.duration - 0.05) await seekTo(0);
  try { await video.play(); } catch { stopPlay(); return; }
  const tick = () => {
    if (!S.playing) return;
    S.t = Math.min(video.currentTime - S.start, S.duration);
    renderReview();
    if (video.ended) { stopPlay(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function refreshPanels() {
  const m = S.sel && S.sel.manual;
  const tr = S.sel && S.sel.track;
  $('maskBar').hidden = !m && !tr;
  $('mMinus').hidden = !m;
  $('mPlus').hidden = !m;
  $('mAll').hidden = !m || isPhoto();
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
  if (S.sel && S.sel.track) return (S.frames[frameIndex(S.t)] || []).find((b) => b.track === S.sel.track) || null;
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
  if ($('s-review').hidden) return;
  e.preventDefault();
  stopPlay();
  const p = canvasPoint(e);
  if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) { deselect(); return; }
  const px = p.x * S.W, py = p.y * S.H;

  let m = manualAt(S.t).reverse().find((x) => inside(manualRect(x), px, py));

  const auto = m ? null : (S.frames[frameIndex(S.t)] || []).filter((b) => inside(b, px, py)).sort((a, b) => a.w * a.h - b.w * b.h)[0];
  if (auto) {
    S.sel = { track: auto.track };
    refreshPanels();
    renderReview();
    return;
  }

  if (!m) {
    m = { id: S.nextId++, cx: p.x, cy: p.y, size: 0.12, t0: Math.max(0, S.t - 1), t1: Math.min(S.duration, S.t + 1) };
    S.manual.push(m);
  }
  S.sel = { manual: m };
  drag = { m, dx: m.cx - p.x, dy: m.cy - p.y };
  view.setPointerCapture(e.pointerId);
  refreshPanels();
  renderReview();
});

view.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = canvasPoint(e);
  drag.m.cx = clamp(p.x + drag.dx, 0, 1);
  drag.m.cy = clamp(p.y + drag.dy, 0, 1);
  renderReview();
});

for (const ev of ['pointerup', 'pointercancel']) view.addEventListener(ev, () => { drag = null; });

$('mMinus').onclick = () => { const m = selectedManual(); if (!m) return; m.size = clamp(m.size / 1.25, 0.04, 0.9); renderReview(); };
$('mPlus').onclick = () => { const m = selectedManual(); if (!m) return; m.size = clamp(m.size * 1.25, 0.04, 0.9); renderReview(); };
$('mAll').onclick = () => {
  const m = selectedManual();
  if (!m) return;
  const whole = m.t0 <= 0 && m.t1 >= S.duration;
  if (whole) { m.t0 = Math.max(0, S.t - 1); m.t1 = Math.min(S.duration, S.t + 1); } else { m.t0 = 0; m.t1 = S.duration; }
  refreshPanels();
  renderReview();
};
$('mDelete').onclick = () => {
  if (S.sel && S.sel.track) { toggleTrack(S.sel.track, frameIndex(S.t)); refreshPanels(); renderReview(); return; }
  S.manual = S.manual.filter((x) => x !== selectedManual());
  deselect();
};
$('restoreAll').onclick = () => {
  for (const t of S.tracks) t.off = [];
  refreshPanels();
  renderReview();
};

$('time').addEventListener('input', (e) => { stopPlay(); goTo(+e.target.value); });
$('prev').onclick = () => { stopPlay(); goTo(S.t - 1 / S.fps); };
$('next').onclick = () => { stopPlay(); goTo(S.t + 1 / S.fps); };
$('play').onclick = togglePlay;

const STYLES = [['black', ''], ['emoji', '😶'], ['emoji', '💀'], ['emoji', '🐸']];
$('styleBtn').onclick = () => {
  const i = STYLES.findIndex(([st, em]) => st === S.style && (st === 'black' || em === S.emoji));
  const [st, em] = STYLES[(i + 1) % STYLES.length];
  S.style = st;
  if (em) S.emoji = em;
  $('styleBtn').innerHTML = st === 'black' ? '<span class="sq"></span>' : em;
  renderReview();
};
$('audioBtn').onclick = () => {
  S.keepAudio = !S.keepAudio;
  $('audioBtn').classList.toggle('on', S.keepAudio);
  $('audioNote').textContent = S.keepAudio ? 'Sound kept. A voice can identify someone too.' : 'Sound off: the video will be silent.';
};
document.addEventListener('keydown', (e) => {
  if ($('s-review').hidden || isPhoto() || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); stopPlay(); goTo(S.t - 1 / S.fps); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stopPlay(); goTo(S.t + 1 / S.fps); }
  else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
});
window.addEventListener('resize', () => { if (!$('s-review').hidden) { sizeTimeline(); renderReview(); } });



async function finish(blob, name, info) {
  if (S.resultUrl) URL.revokeObjectURL(S.resultUrl);
  if (S.previewUrl) URL.revokeObjectURL(S.previewUrl);

  blob = new Blob([await blob.arrayBuffer()], { type: blob.type });
  S.resultUrl = URL.createObjectURL(blob);
  S.previewUrl = URL.createObjectURL(blob);
  S.resultFile = new File([blob], name, { type: blob.type });
  $('result').hidden = isPhoto();
  $('resultImg').hidden = !isPhoto();

  $('result').onerror = () => {
    if (isPhoto() || !S.previewUrl) return;
    $('result').hidden = true;
    $('doneCheck').textContent = "The preview cannot play here. Open the saved video and watch all of it before posting.";
  };
  (isPhoto() ? $('resultImg') : $('result')).src = S.previewUrl;
  $('download').href = S.resultUrl;
  $('download').download = name;
  $('share').hidden = !(navigator.canShare && navigator.canShare({ files: [S.resultFile] }));
  $('doneTitle').textContent = 'Ready.';
  $('doneCheck').textContent = isPhoto() ? 'Look at it closely before posting.' : 'Watch all of it before posting.';
  $('doneInfo').textContent = `${info}, ${blob.size >= 1e6 ? (blob.size / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(blob.size / 1e3)) + ' KB'}.`;
  show('done');

  $('download').click();
}

async function exportPhoto() {
  S.sel = null;
  $('fatal').hidden = true;
  drawSource(vctx);
  paint(vctx, 0, false);
  const blob = await new Promise((r) => view.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) { fail($('fatal'), "This browser could not create the photo."); return; }
  finish(blob, 'masked-photo.jpg', 'JPEG file');
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
  $('fatal').hidden = true;
  show('export');
  $('exportBar').style.width = '0';
  $('exportPct').textContent = '0%';
  $('exportText').textContent = '';
  await keepAwake(true);

  let made = null, audioKept = false, input = null;
  try {
    input = new MB.Input({ source: new MB.BlobSource(S.file), formats: MB.ALL_FORMATS });
    const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
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
        codec: 'avc',
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
    made = new Blob([output.target.buffer], { type: 'video/mp4' });
  } catch (e) {
    if (!job.cancelled) console.error(e);
  }
  if (input) try { input.dispose(); } catch {  }
  S.job = null;
  await keepAwake(false);

  if (job.cancelled) { openReview(0); return true; }
  if (!made || !made.size) return false;
  const sound = audioKept ? 'with sound' : S.keepAudio ? 'without sound (it could not be copied)' : 'without sound';
  finish(await scrubMp4Dates(made), 'video-masquee.mp4', `MP4 file, ${sound}, fast export`);
  return true;
}

async function exportVideo() {
  stopPlay();
  S.sel = null;
  if (S.fast) {
    if (await exportFast()) return;

    S.fast = false;
    openReview(0);
    fail($('fatal'), "Fast export did not work here. Tap Export again: the video will be made at normal speed.");
    return;
  }
  const mime = pickMime();
  if (!mime || !view.captureStream) {
    fail($('fatal'), "This browser cannot create videos. Try an up-to-date Chrome or Safari.");
    return;
  }
  $('fatal').hidden = true;

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
    openReview(0);
    if (!job.cancelled) fail($('fatal'), "Creating the video failed in this browser. Try an up-to-date Chrome or Safari.");
    return;
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

  if (job.cancelled) { openReview(0); return; }
  if (failed || !chunks.length) {
    openReview(0);
    fail($('fatal'), "Creating the video failed in this browser. Try an up-to-date Chrome or Safari.");
    return;
  }

  const type = (rec.mimeType || mime).split(';')[0];
  const mp4 = type.includes('mp4');
  const made = new Blob(chunks, { type });
  finish(mp4 ? await scrubMp4Dates(made) : made, 'masked-video.' + (mp4 ? 'mp4' : 'webm'), `${mp4 ? 'MP4' : 'WebM'} file${audioDest ? ', with sound' : ', without sound'}`);
}

$('export').onclick = () => (isPhoto() ? exportPhoto() : exportVideo());
$('share').onclick = async () => {
  try { await navigator.share({ files: [S.resultFile] }); } catch {  }
};

$('back').onclick = () => { $('result').pause(); openReview(S.t); };

function cancelJob() {
  if (!S.job) return;
  S.job.cancelled = true;
  if (S.job.cancel) S.job.cancel();
}

function resetAll() {
  cancelJob();
  S.job = null;
  stopPlay();
  keepAwake(false);
  $('result').pause();
  $('result').removeAttribute('src');
  $('resultImg').removeAttribute('src');
  if (S.srcUrl) URL.revokeObjectURL(S.srcUrl);
  if (S.resultUrl) URL.revokeObjectURL(S.resultUrl);
  if (S.previewUrl) URL.revokeObjectURL(S.previewUrl);
  S.srcUrl = S.resultUrl = S.previewUrl = S.resultFile = S.img = S.file = null;
  S.tracks = [];
  S.frames = [];
  S.raw = [];
  S.manual = [];
  S.sel = null;
  S.t = 0;
  S.start = S.first = 0;
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
$('pickLabel').addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && !$('file').disabled) loadFile(f);
});

$('file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadFile(f);
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
  S, frameIndex,
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
