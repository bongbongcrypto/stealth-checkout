// A QR code that does not scan is worse than no QR code, because nobody finds
// out until a customer is standing at the counter holding a phone.
//
// So the encoder is checked three ways, and the first two do not share code
// with it:
//   1. `qr-reader.mjs`, a decoder written from the spec, which rebuilds the
//      function-module map itself and checks every Reed-Solomon syndrome.
//   2. Fixed points published in ISO/IEC 18004: the Annex I worked example for
//      the error-correction codewords, and Annex C's format-information table.
//   3. Direct geometry: finders, separators, timing, alignment, the dark module.
//
// The pixel-level check (matrix, SVG, browser rasteriser, back again) lives in
// `qr-scan.html`, because it needs a browser to draw the SVG.
import { test } from "node:test";
import assert from "node:assert/strict";
import { QR_MAX_BYTES, encodeQr, qrSvg, qrDataUri, qrCodeSvg, qrFits, rsRemainder } from "../dist/qr.js";
import { decodeMatrix, legalFormats } from "./qr-reader.mjs";

/** The most a version-20 level-M code holds in byte mode. */
const LARGEST = 666;

const SAMPLES = [
  "A",
  "https://bongbongcrypto.github.io/stealth-checkout/apps/pay-live/index.html?to=0x1&amount=1",
  "https://bongbongcrypto.github.io/stealth-checkout/apps/pay-live/index.html" +
    "?to=0x04ea15bf342c3f4b8b9c2d1e0f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6" +
    "&amount=25.5&id=inv_2026_08_24_0007&memo=Order%20%23412%20two%20coffees",
  "x".repeat(200),
  "결제 링크: 25 STRK", // multi-byte, to prove the length field counts bytes
];

test("every code this encoder produces reads back as the text that went in", () => {
  for (const text of SAMPLES) {
    const matrix = encodeQr(text);
    const out = decodeMatrix(matrix);
    assert.equal(out.text, text, `round trip failed for ${text.slice(0, 40)}`);
    assert.equal(out.version, matrix.version, "the decoder must agree on the version");
    assert.equal(out.mask, matrix.mask, "and on the mask that was applied");
  }
});

test("every version from 1 to 20 round-trips, including the 16-bit length field", () => {
  // Each version has its own block layout, and versions 7 and up carry version
  // information as well. Testing one size proves almost nothing about the rest.
  const seen = new Set();
  for (let bytes = 1; bytes <= LARGEST; bytes += 7) {
    const text = "p".repeat(bytes);
    const matrix = encodeQr(text);
    seen.add(matrix.version);
    assert.equal(decodeMatrix(matrix).text, text, `failed at ${bytes} bytes (version ${matrix.version})`);
  }
  for (let v = 1; v <= 20; v++) assert.ok(seen.has(v), `version ${v} was never exercised`);
});

test("the capacity boundary is exact in both directions", () => {
  // Version 20-M holds 669 data codewords: 5352 bits, less 4 for the mode and
  // 16 for the length, is 666 bytes. One more must be refused rather than
  // quietly dropped, and 666 itself must still come back whole.
  const full = "z".repeat(LARGEST);
  const matrix = encodeQr(full);
  assert.equal(matrix.version, 20);
  assert.equal(decodeMatrix(matrix).text, full);
  assert.throws(() => encodeQr("z".repeat(LARGEST + 1)), /667 bytes is more than a version-20 QR holds/);
});

test("qrFits agrees with encodeQr exactly, or it is not a guard", () => {
  // A caller asks qrFits before drawing a QR out of a URL whose length someone
  // else controls. If the two disagree by one byte, the guard passes something
  // the encoder then throws on, and a crafted link blanks the checkout. That
  // happened: a 600-digit `?amount=` took the whole payer page off the air.
  for (let n = QR_MAX_BYTES - 3; n <= QR_MAX_BYTES + 3; n++) {
    const text = "z".repeat(n);
    const fits = qrFits(text);
    let encoded = true;
    try {
      encodeQr(text);
    } catch {
      encoded = false;
    }
    assert.equal(fits, encoded, `qrFits says ${fits} at ${n} bytes, encodeQr says ${encoded}`);
  }
});

test("qrFits counts bytes, not characters", () => {
  // Hangul is three bytes in UTF-8. Counting characters would wave through a
  // string three times too big and put the throw back.
  const korean = "가".repeat(230); // 690 bytes
  assert.equal(korean.length <= QR_MAX_BYTES, true, "the character count looks fine");
  assert.equal(qrFits(korean), false, "but it does not fit, and qrFits must say so");
  assert.throws(() => encodeQr(korean));
  assert.equal(qrFits("가".repeat(222)), true, "666 bytes exactly still fits");
});

test("the version grows with the payload and never overshoots", () => {
  assert.equal(encodeQr("A").version, 1);
  assert.equal(encodeQr("x".repeat(14)).version, 1, "16 data codewords hold 14 bytes at version 1");
  assert.equal(encodeQr("x".repeat(15)).version, 2, "one byte more needs version 2");
  assert.ok(encodeQr("x".repeat(300)).version >= 10, "a 16-bit length field is its own branch");
});

test("a payload larger than a version-20 code is refused, not silently truncated", () => {
  assert.throws(() => encodeQr("x".repeat(1000)), /more than a version-20 QR holds/);
});

test("the error-correction codewords match the worked example in ISO/IEC 18004", () => {
  // A fixed point from the standard rather than from this implementation: the
  // 16 data codewords of the version 1-M example produce these 10 EC codewords.
  const data = Uint8Array.from([
    0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
  ]);
  assert.deepEqual(
    Array.from(rsRemainder(data, 10)),
    [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55],
  );
});

test("the format-information strings match the published table", () => {
  // Annex C of the standard lists all 32. They are reproduced here so that a
  // wrong BCH generator or a wrong XOR mask fails against the spec, not against
  // this repo's own arithmetic. Order is level L, M, Q, H, masks 0 to 7.
  const PUBLISHED = {
    0b01: [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976], // L
    0b00: [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0], // M
    0b11: [0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed], // Q
    0b10: [0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b], // H
  };
  const computed = new Map(legalFormats().map((f) => [f.data, f.bits]));
  for (const [level, row] of Object.entries(PUBLISHED)) {
    row.forEach((expected, mask) => {
      const key = (Number(level) << 3) | mask;
      assert.equal(
        computed.get(key),
        expected,
        `level ${Number(level).toString(2).padStart(2, "0")} mask ${mask}`,
      );
    });
  }
});

test("the finder patterns and their separators are where a scanner looks", () => {
  const { modules: m, size: n } = encodeQr("https://example.com/pay");
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    for (let dr = 0; dr < 7; dr++) {
      for (let dc = 0; dc < 7; dc++) {
        const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        assert.equal(m[r0 + dr][c0 + dc], ring || core, `finder at ${r0},${c0} wrong at ${dr},${dc}`);
      }
    }
  }
  for (let i = 0; i < 8; i++) {
    assert.equal(m[7][i], false, "separator under the top-left finder");
    assert.equal(m[i][7], false, "separator right of the top-left finder");
    assert.equal(m[7][n - 1 - i], false, "separator under the top-right finder");
    assert.equal(m[n - 1 - i][7], false, "separator right of the bottom-left finder");
  }
});

test("the timing patterns alternate across the whole code", () => {
  const { modules, size } = encodeQr("https://example.com/pay/timing");
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0, `horizontal timing wrong at ${i}`);
    assert.equal(modules[i][6], i % 2 === 0, `vertical timing wrong at ${i}`);
  }
});

test("the alignment patterns and the dark module are placed", () => {
  // Version 7 and up carry alignment patterns away from the finders; a scanner
  // uses them to correct for a phone held at an angle.
  const matrix = encodeQr("x".repeat(160)); // large enough to need them
  assert.ok(matrix.version >= 7, `expected version 7 or more, got ${matrix.version}`);
  const { modules: m, size: n } = matrix;

  assert.equal(m[n - 8][8], true, "the always-dark module below the bottom-left finder");

  // The centre of an alignment pattern is dark, ringed by light, ringed by dark.
  const centre = [n - 7, n - 7]; // the bottom-right one exists at every version >= 2
  const [ar, ac] = centre;
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      assert.equal(
        m[ar + dr][ac + dc],
        Math.max(Math.abs(dr), Math.abs(dc)) !== 1,
        `alignment pattern wrong at ${dr},${dc}`,
      );
    }
  }
});

test("flipping one module is caught, so the syndrome check is not decorative", () => {
  // Without this, a decoder that quietly agreed with a broken encoder would
  // still report every test green.
  const matrix = encodeQr("https://example.com/pay/tamper");
  const copy = matrix.modules.map((row) => [...row]);
  copy[matrix.size - 2][matrix.size - 2] = !copy[matrix.size - 2][matrix.size - 2];
  assert.throws(
    () => decodeMatrix({ ...matrix, modules: copy }),
    /syndrome/,
    "a corrupted data module must not decode as clean",
  );
});

test("corrupting the format information is caught too", () => {
  const matrix = encodeQr("https://example.com/pay/format");
  const copy = matrix.modules.map((row) => [...row]);
  copy[0][8] = !copy[0][8];
  copy[2][8] = !copy[2][8];
  assert.throws(() => decodeMatrix({ ...matrix, modules: copy }), /format information is 2 bits off/);
});

test("the SVG carries the quiet zone a scanner needs", () => {
  const matrix = encodeQr("https://example.com/pay/quiet");
  const svg = qrSvg(matrix, { scale: 4 });
  const span = matrix.size + 8;
  assert.match(svg, new RegExp(`viewBox="0 0 ${span} ${span}"`), "4 modules of margin on each side");
  assert.match(svg, new RegExp(`width="${span * 4}"`));
  // Asking for less than the spec's margin does not get you less.
  assert.match(qrSvg(matrix, { margin: 0 }), new RegExp(`viewBox="0 0 ${span} ${span}"`));
  // An opaque light background, because a transparent one scans badly on dark pages.
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#fff"\/>/);
});

test("a hostile label or colour cannot break out of the SVG", () => {
  const svg = qrCodeSvg("https://example.com/pay", {
    label: '"><script>alert(1)</script>',
    dark: '"><script>bad()</script>',
  });
  assert.doesNotMatch(svg, /<script/, "no element may be injected through an attribute");
  assert.match(svg, /&quot;&gt;&lt;script&gt;/);
});

test("the data URI round-trips to the same SVG", () => {
  const matrix = encodeQr("https://example.com/pay/uri");
  const uri = qrDataUri(matrix, { scale: 3 });
  assert.match(uri, /^data:image\/svg\+xml;charset=utf-8,/);
  const decoded = decodeURIComponent(uri.slice("data:image/svg+xml;charset=utf-8,".length));
  assert.equal(decoded, qrSvg(matrix, { scale: 3 }));
  assert.doesNotMatch(uri, /[<>#"]/, "an unescaped angle bracket or hash breaks the img src");
});

test("the label defaults to something a screen reader can use", () => {
  assert.match(qrCodeSvg("https://example.com/pay"), /aria-label="QR code for https:\/\/example.com\/pay"/);
  assert.match(qrSvg(encodeQr("x")), /aria-label="QR code"/);
});
