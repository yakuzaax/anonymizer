import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const files = [
  'index.html', 'legal.html', 'verify.html', '404.html', '_headers', 'favicon.ico',
  'style.css', 'app.js', 'detector.js', 'detect-worker.js', 'icons/mark.png',
  'models/yunet.onnx', 'models/LICENSE-yunet.txt',
  'vendor/fonts/fonts.css', 'vendor/fonts/archivo-latin.woff2', 'vendor/fonts/archivo-latin-ext.woff2',
  'vendor/fonts/jetbrains-mono-latin.woff2', 'vendor/fonts/jetbrains-mono-latin-ext.woff2', 'vendor/fonts/LICENSE.txt',
  'vendor/ort/ort.wasm.min.mjs', 'vendor/ort/ort-wasm-simd-threaded.mjs', 'vendor/ort/ort-wasm-simd-threaded.wasm', 'vendor/ort/LICENSE.txt',
  'vendor/mediabunny/mediabunny.min.mjs', 'vendor/mediabunny/LICENSE.txt',
];

rmSync(dist, { recursive: true, force: true });
for (const f of new Set(files)) {
  const from = join(root, f);
  if (!existsSync(from)) throw new Error('missing file: ' + f);
  mkdirSync(dirname(join(dist, f)), { recursive: true });
  cpSync(from, join(dist, f));
}
console.log(`${new Set(files).size} files copied to dist/`);
