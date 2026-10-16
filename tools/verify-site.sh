#!/usr/bin/env bash
set -e
site=${SITE:-https://anonymizer.nvp.qzz.io}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
ok=0

files="index.html legal.html verify.html 404.html _headers favicon.ico style.css app.js detector.js detect-worker.js icons/mark.png
  models/yunet.onnx models/LICENSE-yunet.txt vendor/fonts/fonts.css vendor/fonts/archivo-latin.woff2 vendor/fonts/archivo-latin-ext.woff2
  vendor/fonts/jetbrains-mono-latin.woff2 vendor/fonts/jetbrains-mono-latin-ext.woff2 vendor/fonts/LICENSE.txt
  vendor/ort/ort.wasm.min.mjs vendor/ort/ort-wasm-simd-threaded.mjs vendor/ort/ort-wasm-simd-threaded.wasm vendor/ort/LICENSE.txt
  vendor/mediabunny/mediabunny.min.mjs vendor/mediabunny/LICENSE.txt"

echo "Commit $(git rev-parse --short HEAD) compared with $site"
for f in $files; do
  if [ "$f" = index.html ]; then url="$site/"; else url="$site/$f"; fi
  git show "HEAD:$f" > "$tmp/repo"
  if ! curl -sSL --compressed "$url" -o "$tmp/site"; then echo "INJOIGNABLE  $f"; ok=1; continue; fi
  if cmp -s "$tmp/repo" "$tmp/site"; then echo "identical    $f"; else echo "DIFFERENT    $f"; ok=1; fi
done

expected=$(git show HEAD:_headers | sed -n 's/^ *Content-Security-Policy: *//p' | tr -d '\r')
received=$(curl -sSI "$site/" | sed -n 's/^[Cc]ontent-[Ss]ecurity-[Pp]olicy: *//p' | tr -d '\r')
if [ "$expected" = "$received" ]; then echo "identical    header Content-Security-Policy"; else echo "DIFFERENT    header Content-Security-Policy"; ok=1; fi

exit $ok
