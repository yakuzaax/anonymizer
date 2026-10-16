# Anonymizer

**Anonymizer** — by NovaPulse Studio, part of the NVP app suite. No data collection, no trace.

Hide the faces in a video or photo before posting it, right in the phone's browser.
Nothing is sent to a server: no account, no analytics, no third-party file loaded from another site.

Live at [anonymizer.nvp.qzz.io](https://anonymizer.nvp.qzz.io).
## Origin

Anonymizer is a rework of **[vesky](https://github.com/Nctrn17/vesky)** (Nctrn17), released under the same AGPL-3.0 licence.
Detection, tracking, export and the privacy guarantees come from that project.
## Why

Videos of protests and blockades are used to identify the people filmed. A blur or a mosaic
can be undone by AI. A solid box cannot: there is no image left underneath.

## What it does

1. You pick a video or a photo.
2. The video is analysed 30 times per second, and a black box (or an emoji on a black box) is placed on every face, on every frame.
3. You check: add a mask where a face was missed, remove one placed by mistake.
4. The file is fully re-encoded: the location, date and phone model stored in the original file are gone.

## What it does not do

- It does not hide clothes, tattoos, voices or places.
- It can miss a face. Checking by eye before posting is still required.
- It does not promise complete protection.

## How to verify it

You don't have to take our word for it. Each point below can be checked without special tools.

- **Website: airplane mode.** Open anonymizer.nvp.qzz.io once with a connection, switch to airplane mode, then process a video:
  everything works. With no network, nothing can leave.
- **Website: the browser's Network tab.** On a computer, open the developer tools (F12), Network tab, then process a video.
  Once the page has loaded, no request appears during analysis or export.
- **Website: the security policy.** Every file is served with a `Content-Security-Policy` header (`_headers`),
  visible in the Network tab. `connect-src 'self'` forbids the browser from connecting to any other site.
  anonymizer.nvp.qzz.io itself only serves static files: there is no server-side code that could receive a video.
- **The automated test** (see "Testing") fails if a single request goes out after the page has loaded.
- **The code is public.** Network calls can be found in seconds: `grep -rn "fetch(" app.js`.
- **The website serves this code.** `bash tools/verify-site.sh` downloads every file from anonymizer.nvp.qzz.io and compares it,
  byte for byte, with the latest commit of the repository (see "Testing").

## How it works

- Static site, no build step for the code: `index.html`, `style.css`, `app.js`.
- Face detection: the YuNet_n model, retrained to see better at night (`models/README.md`), run by ONNX Runtime Web (`detector.js`, `detect-worker.js`),
  on several cores in parallel. Very dark frames are analysed twice, as is and brightened, and the results are merged.
- Tracking: one box per face from frame to frame, enlarged by 30%, extended a few frames before and after.
- Fast export: the original file is decoded frame by frame, each frame is masked then re-encoded
  by the phone's encoder (WebCodecs, through Mediabunny). Faster than real time.
- Fallback export, when the browser cannot do the fast one: the masked image is recorded while it plays
  (canvas + MediaRecorder). Add `?slow` to the URL to force this mode.
- Photos: JPEG.
- No cookie, no `localStorage`, no `sessionStorage`, no IndexedDB, no service worker, no cache written by the code:
  opening the page creates nothing on the device, and closing the tab leaves nothing behind.
- Everything is served by the site itself, and a security policy (`_headers`) forbids the browser
  from connecting to any other site.

## Known limitations

- With the fallback export, exporting takes as long as the video.
- Analysis is slow on long videos.
- Automated test on desktop Chrome. Tested by hand on Android and iPhone browsers.

## Third-party components

- [YuNet_n](https://github.com/ShiqiYu/libfacedetection.train), BSD-3 licence, retrained on WIDER FACE and DARK FACE (`models/`).
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime), MIT licence (`vendor/ort/`).
- [Mediabunny](https://github.com/Vanilagy/mediabunny), MPL-2.0 licence (`vendor/mediabunny/`).
- Archivo and JetBrains Mono fonts, SIL OFL 1.1 licence (`vendor/fonts/`).
- [vesky](https://github.com/Nctrn17/vesky)

## Licence

Code under the [AGPL-3.0](LICENSE). You may copy, modify and host it,
as long as you publish the code of your version under the same licence, even if it is only served as a website.

**Do not load anything from another site.** People use this tool to protect faces, sometimes at protests.
A Google Fonts stylesheet, an analytics script or an image hosted elsewhere is enough to send their IP address
to a third party as soon as they open the page. Keep everything on your own server, as in `vendor/`,
and do not loosen the security policy in `_headers`. If you change `app.js` or `_headers`, say so clearly.
