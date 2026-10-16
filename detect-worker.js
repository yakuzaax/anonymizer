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
      const boxes = await detectBoth(detect, m.bitmap, m.w, m.h, m.maxSide, m.minScore, m.always, m.rule);
      m.bitmap.close();
      self.postMessage({ type: 'done', id: m.id, boxes });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
