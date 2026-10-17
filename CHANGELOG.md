# Changelog

## 0.6.0

- New `how.html` page: step-by-step explanation of how Anonymizer finds, follows and hides faces, with the real thresholds and numbers.
- Mask style picker: 24 emojis instead of 3, in a small panel. The black square is still painted under every emoji.
- Tracking runs in both directions: each confirmed face also pulls in the weaker detections just before it (same place, similar size, within 20 frames), so faces entering the frame or turning towards the camera are masked earlier.
- Fast export also works with VP9 (WebM) when the device has no H.264 encoder, instead of falling back to real-time recording, which dropped frames on slow devices.
- Blur style (opt-in, labelled as less safe): the face area is reduced to about 6 by 6 cells and scaled back up, so detail is truly removed. Black square stays the default.
- Scan report: a Report button in the review step and a summary on the final screen. It lists faces tracked, faces to double-check (with a jump button), masks added by hand, faces edited and the share of frames with a mask.
- Margin setting (Tight, Normal, Wide) in the review step. Masks are laid out again from the tracks, so removed or restored faces stay as they were.
- Compare button: drag a divider between the masked picture and the original, on screen only.
- Exporting a file with no mask at all now asks for a second tap, and the review screen says that no face was found.
- Fixed: stepping image by image with fast repeated keys or taps lost steps; cancelling an export sent you back to the start of the video; a French file name on fast-export results; export errors not being awaited; leftover internal French strings; one visibility listener added per worker.
- Fixed: the finished, scan and export screens ran off the bottom on phones held sideways, and the review controls left almost no room for the picture; both now use a two-column layout.
- Fixed: the legal notice page had lost its margins and centred layout, because of a leftover CSS block.
- Fixed: a video with no audio track was reported as "without sound (it could not be copied)"; it now says there is no sound in the original.
- Fixed: dropping a file outside the picker opened it in the browser tab and left the app.
- Fixed: overlapping labels in the tracking diagram of `how.html`.
- Hardening: `Cross-Origin-Resource-Policy: same-origin` and `X-Permitted-Cross-Domain-Policies: none` added to `_headers`.
- Slightly cheaper brightness check before detection.

## 0.5

- English interface, grey palette, no cookie or stored data, website only.
