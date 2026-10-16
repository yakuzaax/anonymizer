#!/usr/bin/env bash
set -e
ici=$(pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
ok=0

compare() {
  if cmp -s "$ici/$1" "$2"; then echo "identical    $3"; else echo "DIFFERENT    $3"; ok=1; fi
}

npm pack onnxruntime-web@1.30.0 mediabunny@1.61.0 --silent > /dev/null
mkdir ort mb
tar -xzf onnxruntime-web-1.30.0.tgz -C ort
tar -xzf mediabunny-1.61.0.tgz -C mb
compare vendor/ort/ort-wasm-simd-threaded.wasm ort/package/dist/ort-wasm-simd-threaded.wasm "ONNX Runtime : ort-wasm-simd-threaded.wasm"
compare vendor/ort/ort-wasm-simd-threaded.mjs ort/package/dist/ort-wasm-simd-threaded.mjs "ONNX Runtime : ort-wasm-simd-threaded.mjs"
sed 's/^\/\/# sourceMappingURL=.*$//' ort/package/dist/ort.wasm.min.mjs > ort.wasm.min.mjs
compare vendor/ort/ort.wasm.min.mjs ort.wasm.min.mjs "ONNX Runtime : ort.wasm.min.mjs (sourceMappingURL line emptied)"
compare vendor/mediabunny/mediabunny.min.mjs mb/package/dist/bundles/mediabunny.min.mjs "Mediabunny : mediabunny.min.mjs"

exit $ok
