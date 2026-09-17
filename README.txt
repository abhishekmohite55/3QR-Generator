3QR — Magnet + NFC QR Block Generator
======================================

HOW TO USE
1. Open 3qr.html in any modern browser (double-click it, or drag it into a
   browser window). It works fully offline except for three small libraries
   loaded from cdnjs.cloudflare.com (three.js for the 3D preview,
   qrcode-generator for the QR encoding, and jszip for the 3MF export) —
   so you'll need an internet connection the first time it loads, even
   though no data is uploaded anywhere. Everything runs in your browser.

2. Fill in:
   - Link: the URL to encode as a QR code
   - Block footprint: the outer size of the printed block
   - Base floor: "flush" (magnet pocket open to the bed) or a custom
     floor thickness
   - Magnet sheet: length / width / thickness
   - Spacer (magnet -> NFC): solid fill thickness that seals the magnet
     pocket
   - NFC tag: rectangular/square (L/W/T) or circular (radius/T)
   - Cap (NFC -> QR surface): solid fill thickness that seals the NFC
     pocket and becomes the QR's black background
   - QR relief height: how tall the white pillars stand

3. The 3D preview updates live. Drag to orbit, scroll to zoom.

4. The "print pause / filament-change schedule" panel gives you the exact
   Z heights to:
   - pause and insert the magnet
   - pause and insert the NFC tag
   - swap filament from black to white for the QR relief
   Punch these into your slicer's pause-at-height / color-change feature.

5. Download the STL (single mesh, for slicing) or the 3MF (black body and
   white QR as separate colored objects, if your slicer reads 3MF colors).

NOTE ON THE MESH
The model is built by stacking individually-sealed slabs rather than true
CAD boolean subtraction. It's geometrically accurate (volumes check out to
well under 0.1% of the expected values) but has some redundant coincident
internal faces at slab boundaries. This is a common, harmless pattern for
FDM 3D printing — slicers handle it fine — but if your slicer's mesh-repair
ever complains, running it through PrusaSlicer's built-in "fix mesh" or
Meshmixer will clean it up trivially.
