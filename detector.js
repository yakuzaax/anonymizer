import * as ort from './vendor/ort/ort.wasm.min.mjs';

const STRIDES = [8, 16, 32];
const NMS_IOU = 0.3;

const DARK = 40;
const NIGHT_LUT = Float32Array.from({ length: 256 }, (_, v) => Math.floor(Math.sqrt(v / 255) * 255));

function overlap(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

export function neededScore(d, short, r) {
  if (d.w / short < r.from) return r.small;
  return r.min + (r.big - r.min) * Math.min(1, Math.max(0, (d.w / short - r.from) / (r.to - r.from)));
}

export const LOW_FACTOR = 3;
export async function detectBoth(detect, source, sw, sh, maxSide, minScore, always, r) {
  const boxes = await detect(source, sw, sh, maxSide, minScore);
  const short = Math.min(sw, sh);
  if (!always && !boxes.some((d) => d.s >= r.min && d.s < neededScore(d, short, r))) return boxes;
  const low = await detect(source, sw, sh, Math.round(Math.min(maxSide, Math.max(sw, sh)) / LOW_FACTOR), minScore);
  return boxes.concat(low.map((b) => ({ ...b, lo: true })));
}

export async function createDetector(base) {
  ort.env.wasm.wasmPaths = base + 'vendor/ort/';
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(base + 'models/yunet.onnx', { executionProviders: ['wasm'] });

  const sizes = new Map();
  const space = (pw, ph) => {
    const key = pw + 'x' + ph;
    let sp = sizes.get(key);
    if (sp) sizes.delete(key);
    else {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(pw, ph) : Object.assign(document.createElement('canvas'), { width: pw, height: ph });
      sp = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }), buffer: new Float32Array(3 * pw * ph) };
    }
    sizes.set(key, sp);
    for (const [k, old] of sizes) {
      if (sizes.size <= 2) break;
      old.canvas.width = old.canvas.height = 0;
      sizes.delete(k);
    }
    return sp;
  };

  return async function detect(source, sw, sh, maxSide, minScore) {
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));

    const pw = Math.ceil(dw / 32) * 32, ph = Math.ceil(dh / 32) * 32;
    const { ctx, buffer } = space(pw, ph);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, pw, ph);
    ctx.drawImage(source, 0, 0, dw, dh);
    const rgba = ctx.getImageData(0, 0, pw, ph).data;
    const n = pw * ph;

    let sum = 0, count = 0;
    for (let y = 0; y < dh; y += 4) for (let x = 0, p = y * pw * 4; x < dw; x += 4, p += 16) { sum += rgba[p] + rgba[p + 1] + rgba[p + 2]; count++; }
    const passes = sum / (3 * count) < DARK ? [null, NIGHT_LUT] : [null];
    const found = [];
    for (const lut of passes) {
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        buffer[i] = lut ? lut[rgba[p + 2]] : rgba[p + 2];
        buffer[n + i] = lut ? lut[rgba[p + 1]] : rgba[p + 1];
        buffer[2 * n + i] = lut ? lut[rgba[p]] : rgba[p];
      }
      const out = await session.run({ input: new ort.Tensor('float32', buffer, [1, 3, ph, pw]) });
      for (const st of STRIDES) {
        const cols = pw / st;
        const cls = out['cls_' + st].data, obj = out['obj_' + st].data, box = out['bbox_' + st].data;
        for (let i = 0; i < cls.length; i++) {
          const s = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
          if (s < minScore) continue;
          const w = Math.exp(box[i * 4 + 2]) * st, h = Math.exp(box[i * 4 + 3]) * st;
          const cx = ((i % cols) + box[i * 4]) * st, cy = (Math.floor(i / cols) + box[i * 4 + 1]) * st;
          found.push({ x: (cx - w / 2) / scale, y: (cy - h / 2) / scale, w: w / scale, h: h / scale, s });
        }
      }
    }

    found.sort((a, b) => b.s - a.s);
    const kept = [];
    for (const b of found) if (!kept.some((k) => overlap(k, b) > NMS_IOU)) kept.push(b);
    return kept;
  };
}
