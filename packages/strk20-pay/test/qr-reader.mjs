// A QR reader, written from the spec rather than from `src/qr.ts`, so that a
// mistake in the encoder shows up as a failure here instead of as two files
// agreeing with each other.
//
// It rebuilds the function-module map itself, recovers the format information
// by Hamming distance over all 32 legal values, un-masks, walks the zigzag,
// de-interleaves the blocks and checks every Reed-Solomon syndrome. Wrong
// codewords cannot produce zero syndromes, so a placement error cannot pass.
//
// `decodeImage` starts from rendered pixels instead of a matrix: it finds the
// symbol, measures the module size off the top-left finder, and samples. That
// covers the SVG path, the quiet zone, the scale and the colour polarity, none
// of which `decodeMatrix` can see.

const BLOCKS_M = [
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37], [26, 4, 43, 1, 44], [30, 1, 50, 4, 51], [22, 6, 36, 2, 37],
  [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42], [28, 7, 45, 3, 46],
  [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42],
];
const ALIGNMENT = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
  [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82],
  [6, 30, 58, 86], [6, 34, 62, 90],
];
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

class UnreadableCode extends Error {}
const fail = (message) => {
  throw new UnreadableCode(message);
};

/** Which modules carry no data, derived from the spec, not from the encoder. */
export function functionMap(version) {
  const n = version * 4 + 17;
  const fixed = Array.from({ length: n }, () => new Array(n).fill(false));
  const mark = (r, c) => {
    if (r >= 0 && r < n && c >= 0 && c < n) fixed[r][c] = true;
  };

  for (let i = 0; i < n; i++) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [r, c] of [[3, 3], [3, n - 4], [n - 4, 3]]) {
    for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) mark(r + dr, c + dc);
  }
  for (const r of ALIGNMENT[version - 1]) {
    for (const c of ALIGNMENT[version - 1]) {
      if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }
  mark(n - 8, 8);
  for (let i = 0; i <= 8; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    mark(8, n - 1 - i);
    mark(n - 1 - i, 8);
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        mark(i, n - 11 + j);
        mark(n - 11 + j, i);
      }
    }
  }
  return fixed;
}

/** All 32 legal format strings: 5 data bits, BCH(15,5), masked with 0x5412. */
export function legalFormats() {
  const out = [];
  for (let data = 0; data < 32; data++) {
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    out.push({ data, bits: (((data << 10) | rem) ^ 0x5412) & 0x7fff });
  }
  return out;
}

function readFormat(modules) {
  const at = [];
  for (let i = 0; i <= 5; i++) at.push(modules[i][8]);
  at.push(modules[7][8], modules[8][8], modules[8][7]);
  for (let i = 9; i <= 14; i++) at.push(modules[8][14 - i]);

  let read = 0;
  for (let i = 0; i < 15; i++) if (at[i]) read |= 1 << i;

  let best = null;
  let distance = 99;
  for (const candidate of legalFormats()) {
    let d = 0;
    let diff = candidate.bits ^ read;
    while (diff) {
      d += diff & 1;
      diff >>>= 1;
    }
    if (d < distance) {
      distance = d;
      best = candidate;
    }
  }
  return { ecLevel: best.data >> 3, mask: best.data & 7, distance };
}

/**
 * Read a matrix back to the text that produced it.
 * Throws `UnreadableCode` with the reason if anything does not line up.
 */
export function decodeMatrix(matrix) {
  const { size: n, modules } = matrix;
  const version = (n - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 20) fail(`size ${n} is not a QR size`);

  const format = readFormat(modules);
  if (format.distance !== 0) fail(`format information is ${format.distance} bits off any legal value`);
  if (format.ecLevel !== 0b00) fail(`expected level M, read level bits ${format.ecLevel}`);

  const fixed = functionMap(version);
  const maskFn = MASKS[format.mask];

  const bits = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? n - 1 - vert : vert;
        if (fixed[row][col]) continue;
        bits.push(modules[row][col] !== maskFn(row, col) ? 1 : 0);
      }
    }
  }

  const [ecLen, g1, d1, g2, d2] = BLOCKS_M[version - 1];
  const total = ecLen * (g1 + g2) + g1 * d1 + g2 * d2;
  const stream = new Uint8Array(total);
  for (let i = 0; i < total * 8; i++) stream[i >>> 3] |= bits[i] << (7 - (i & 7));

  const blocks = Array.from({ length: g1 + g2 }, () => ({ data: [], ec: [] }));
  let taken = 0;
  for (let i = 0; i < Math.max(d1, d2); i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < (b < g1 ? d1 : d2)) blocks[b].data.push(stream[taken++]);
    }
  }
  for (let i = 0; i < ecLen; i++) for (const block of blocks) block.ec.push(stream[taken++]);
  if (taken !== total) fail(`consumed ${taken} of ${total} codewords`);

  blocks.forEach((block, index) => {
    const full = [...block.data, ...block.ec];
    for (let s = 0; s < ecLen; s++) {
      let acc = 0;
      for (const byte of full) acc = mul(acc, EXP[s]) ^ byte;
      if (acc !== 0) fail(`block ${index} syndrome ${s} is ${acc}, not zero`);
    }
  });

  const payload = blocks.flatMap((b) => b.data);
  const stream2 = [];
  for (const byte of payload) for (let i = 7; i >= 0; i--) stream2.push((byte >> i) & 1);
  let cursor = 0;
  const take = (width) => {
    let v = 0;
    for (let i = 0; i < width; i++) v = (v << 1) | stream2[cursor++];
    return v;
  };

  const mode = take(4);
  if (mode !== 0b0100) fail(`mode indicator ${mode.toString(2)} is not byte mode`);
  const length = take(version < 10 ? 8 : 16);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = take(8);
  return { text: new TextDecoder().decode(bytes), version, mask: format.mask };
}

/**
 * Read a code out of rendered pixels: find the symbol, measure the module size
 * off the top-left finder, sample module centres, then decode.
 *
 * `isDark(x, y)` answers for one pixel. Nothing about how the image was
 * produced is assumed, so a wrong scale, a missing quiet zone or an inverted
 * palette all fail here.
 */
export function decodeImage(isDark, width, height) {
  let top = -1;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isDark(x, y)) continue;
      if (top === -1) top = y;
      bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (top === -1) fail("the image has no dark pixels at all");

  const span = right - left + 1;
  if (bottom - top + 1 !== span) fail(`the symbol is ${span} by ${bottom - top + 1}, not square`);

  // The top row of a QR symbol starts with the finder pattern's top edge:
  // exactly seven modules of dark. That gives the module size.
  let run = 0;
  while (left + run <= right && isDark(left + run, top)) run++;
  if (run % 7 !== 0) fail(`the top-left finder is ${run} pixels wide, which is not 7 modules`);
  const moduleSize = run / 7;

  const size = span / moduleSize;
  if (!Number.isInteger(size)) fail(`${span} pixels is ${size} modules, which is not a whole number`);

  const modules = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) {
      const x = Math.floor(left + (c + 0.5) * moduleSize);
      const y = Math.floor(top + (r + 0.5) * moduleSize);
      row.push(isDark(x, y));
    }
    modules.push(row);
  }

  const quietLeft = left;
  const quietTop = top;
  const quietRight = width - 1 - right;
  const quietBottom = height - 1 - bottom;
  const needed = 4 * moduleSize;
  if (Math.min(quietLeft, quietTop, quietRight, quietBottom) < needed) {
    fail(
      `the quiet zone is ${Math.min(quietLeft, quietTop, quietRight, quietBottom)} px, ` +
        `and the spec wants ${needed}`,
    );
  }

  return { ...decodeMatrix({ size, modules }), moduleSize, quiet: quietLeft / moduleSize };
}

export { UnreadableCode };
