# Inventory Count

A phone web page for a physical inventory count. Scan product
barcodes (UPC/EAN, Code 128, GS1 DataMatrix including rectangular, QR / Micro QR / rMQR, GS1 Digital
Link, with lot and expiry) and fill in QuickBooks Online's
Physical Inventory Worksheet.

- Runs in Safari (iPhone) and Chrome (Android). No app install.
- Everything stays on the phone. Count files are opened from the phone and shared with its share
  sheet; nothing is uploaded.
- Works offline once loaded.

This repository holds **only the page's code**. Count sheets, counts, item data and barcode lists
are never committed (see `.gitignore`).

Barcode reading: [barcode-detector](https://github.com/Sec-ant/barcode-detector) /
[zxing-wasm](https://github.com/Sec-ant/zxing-wasm), bundled in `vendor/` (see `vendor/NOTICE.md`).
