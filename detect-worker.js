import { createDetector, detectBoth } from './detector.js';

let detect = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      detect = await createDetector(new URL('.', self.location.href).href);
      await detect(new OffscreenCanvas(64, 64), 64, 64, 64, 0.5);
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'detect') {
      let boxes;
      try { boxes = await detectBoth(detect, m.bitmap, m.w, m.h, m.maxSide, m.minScore, m.always, m.rule); } finally { m.bitmap.close(); }
      self.postMessage({ type: 'done', id: m.id, boxes });
    } else if (m.type === 'rescue') {
      const boxes = [];
      try { for (const h of m.hints) boxes.push(await detect.zoomFind(m.bitmap, h, 4, 0.2)); } finally { m.bitmap.close(); }
      self.postMessage({ type: 'found', id: m.id, boxes });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
