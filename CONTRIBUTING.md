# Contributing to Anonymizer

Thanks for helping. Anonymizer protects people who appear in videos: every change is reviewed, and some are
refused even when the idea is good. This file says what to expect so you do not spend hours on a PR that cannot
be accepted.

## Before you start

- **Small fix** (typo, obvious bug, unclear text): open a PR directly.
- **New feature or big change**: open an issue first so we can check it fits the project.

## Refused outright

- **Partial protection presented as full protection.** The blur option is allowed because it is opt-in and labelled as hiding less. Any new effect that leaves part of the face must be labelled the same way and must never become the default.
- **Any request after the page has loaded.** No analytics, no font, script or file loaded from another site, no
  server. Nothing may leave the phone. The `Content-Security-Policy` (`index.html` and `_headers`) is never relaxed.
- **A detection setting changed without measurements.** Thresholds (`MIN_SCORE`, `TRACK`...) come from
  measurements. Use [`eval-faces.py`](https://github.com/Nctrn17/vesky/tree/main/entrainement/eval-faces.py) (annotated photos) and
  [`eval-reel.mjs`](https://github.com/Nctrn17/vesky/tree/main/entrainement/eval-reel.mjs) (real videos) from the original repository, and put
  the numbers before and after in the PR. Missing one more face costs more than drawing one extra mask.
- **A modified file in `vendor/`.** They must stay identical to the originals (`bash test/verify-vendor.sh`).

## Making a PR easy to review

- **One topic per PR**, as short as possible.
- **No reformatting.** No Prettier or similar on whole files. Keep the style of the file: single quotes, long
  lines accepted, no comments.
- **Start from the latest `main`** and check your merge does not undo recent changes.
- **Explain why** in the description: which problem, on which phone and browser, how you checked.

## Tests

They must pass before any PR that touches the site:

```bash
node tools/dev-server.mjs
python test/make-test-video.py
node test/run-test.mjs
python test/make-faces-pair.py
node test/test-no-trace.mjs
```

The server runs in a separate terminal. Automated tests only run on desktop Chrome: if your change touches video
playback, sound or export, also try it on a real phone (Android and, if possible, iPhone browsers) and say so in the PR.
Safari on iPhone has its own rules, notably for starting a video with sound.

Do not edit an existing test to make it pass: if you think it is wrong, explain why.

## Displayed text

- Short sentences, simple words: many people use the app in a hurry, on a phone.
- No em dash.
- Never promise more than the tool does. What it does not hide (clothes, tattoos, place, voice) must stay stated clearly.

## Licence

Anonymizer is under the [AGPL-3.0](LICENSE). By submitting a PR you agree your code is published under the same licence.
