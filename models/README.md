# Detection model: YuNet_n retrained for night (BSD-3)

Base: YuNet_n from [libfacedetection.train](https://github.com/ShiqiYu/libfacedetection.train) (Shiqi Yu, BSD-3,
`LICENSE-yunet.txt`), same family and same outputs as OpenCV's YuNet.

`yunet.onnx` starts from the published weights (`weights/yunet_n.pth`) and was retrained for 40 epochs on WIDER FACE
(daytime photos) and DARK FACE (night photos). Full recipe in the original repository:
[`entrainer-nuit.sh`](https://github.com/Nctrn17/vesky/tree/main/entrainement/entrainer-nuit.sh) after
[`prepare-darkface.py`](https://github.com/Nctrn17/vesky/tree/main/entrainement/prepare-darkface.py). 1,000 DARK FACE photos
([`darkface-split.json`](https://github.com/Nctrn17/vesky/tree/main/entrainement/darkface-split.json)) were never used for training and serve for measurement.

Measured with the site's rule ([`eval-faces.py`](https://github.com/Nctrn17/vesky/tree/main/entrainement/eval-faces.py)), against the previous model (OpenCV Zoo YuNet 2023mar):

| | Missed faces at night (1,287) | Missed faces by day (14,954) | Large masks without a face, day |
|---|---|---|---|
| Previous model | 185 | 1,016 | 326 |
| This one | 64 | 938 | 332 |

Output decoding (in `detector.js`) follows OpenCV's `modules/objdetect/src/face_detect.cpp`.
