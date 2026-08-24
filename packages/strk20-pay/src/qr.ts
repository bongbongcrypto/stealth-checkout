/**
 * A QR encoder, written here rather than installed.
 *
 * IDEA-11 asks for static and dynamic payment QR codes. Every QR package on npm
 * is larger than this and arrives with install scripts, and this repo's rule is
 * that unvetted packages do not run on the machine holding the keys. Byte mode
 * at error-correction level M covers a payment URL, which is all a checkout
 * needs, so the rest of ISO/IEC 18004 is deliberately absent.
 *
 * Correctness is not assumed. `test/qr.test.mjs` reads every matrix back with an
 * independently written decoder and checks the Reed-Solomon syndromes are zero.
 * `test/qr-scan.html` puts the output in front of Chromium's own BarcodeDetector.
 */

/** Versions 1-20 at level M. Larger than a payment URL ever needs. */
const MAX_VERSION = 20;

/** Total codewords (data + error correction) per version. */
const TOTAL_CODEWORDS = [
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
];

/**
 * Level-M block structure per version:
 * [ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords].
 */
type BlockSpec = readonly [number, number, number, number, number];
const BLOCKS_M: readonly BlockSpec[] = [
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51],
  [22, 6, 36, 2, 37],
  [22, 8, 37, 1, 38],
  [24, 4, 40, 5, 41],
  [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46],
  [28, 10, 46, 1, 47],
  [26, 9, 43, 4, 44],
  [26, 3, 44, 11, 45],
  [26, 3, 41, 13, 42],
];

/** Alignment-pattern centre coordinates per version (version 1 has none). */
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
];

// GF(256) with the QR primitive polynomial 0x11D.
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
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** The generator polynomial for `degree` error-correction codewords. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      const coeff = poly[j]!;
      next[j] = next[j]! ^ coeff;
      next[j + 1] = next[j + 1]! ^ gfMul(coeff, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** The Reed-Solomon remainder for one block. */
export function rsRemainder(data: Uint8Array, degree: number): Uint8Array {
  const gen = rsGenerator(degree);
  const out = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ out[0]!;
    out.copyWithin(0, 1);
    out[degree - 1] = 0;
    for (let i = 0; i < degree; i++) out[i] = out[i]! ^ gfMul(gen[i + 1]!, factor);
  }
  return out;
}

/** Data capacity in bits for a version at level M. */
function dataBits(version: number): number {
  const [, g1, d1, g2, d2] = BLOCKS_M[version - 1]!;
  return 8 * (g1 * d1 + g2 * d2);
}

/** Byte mode's character-count indicator is 8 bits below version 10, 16 above. */
const countBits = (version: number): number => (version < 10 ? 8 : 16);

/** The smallest version that holds `len` bytes, or 0 if none does. */
function pickVersion(len: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (4 + countBits(v) + 8 * len <= dataBits(v)) return v;
  }
  return 0;
}

/** Data codewords: mode, length, payload, terminator, padding. */
function buildDataCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const capacity = dataBits(version);
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);

  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(capacity / 8);
  for (let i = 0; i < bits.length; i++) out[i >>> 3] = out[i >>> 3]! | (bits[i]! << (7 - (i & 7)));
  for (let i = bits.length / 8; i < out.length; i++) out[i] = i % 2 === 0 ? 0xec : 0x11;
  return out;
}

/** Split into blocks, add error correction, and interleave as the spec requires. */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const [ecLen, g1, d1, g2, d2] = BLOCKS_M[version - 1]!;
  const blocks: { data: Uint8Array; ec: Uint8Array }[] = [];
  let at = 0;
  for (let i = 0; i < g1 + g2; i++) {
    const size = i < g1 ? d1 : d2;
    const chunk = data.subarray(at, at + size);
    at += size;
    blocks.push({ data: chunk, ec: rsRemainder(chunk, ecLen) });
  }

  const out = new Uint8Array(TOTAL_CODEWORDS[version - 1]!);
  let n = 0;
  const longest = Math.max(d1, d2);
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.data.length) out[n++] = block.data[i]!;
  }
  for (let i = 0; i < ecLen; i++) {
    for (const block of blocks) out[n++] = block.ec[i]!;
  }
  return out;
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

export interface QrMatrix {
  /** Modules per side, excluding the quiet zone. */
  readonly size: number;
  /** `true` is a dark module. Indexed `[row][col]`. */
  readonly modules: readonly (readonly boolean[])[];
  readonly version: number;
  readonly mask: number;
}

class Builder {
  readonly size: number;
  readonly modules: boolean[][];
  readonly fixed: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  /** `noUncheckedIndexedAccess` is on; every read of the grid goes through here. */
  private at(row: number, col: number): boolean {
    return this.modules[row]![col]!;
  }

  private set(row: number, col: number, dark: boolean): void {
    this.modules[row]![col] = dark;
    this.fixed[row]![col] = true;
  }

  drawFunctionPatterns(): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    const finders: [number, number][] = [
      [3, 3],
      [3, n - 4],
      [n - 4, 3],
    ];
    for (const [r, c] of finders) {
      for (let dr = -4; dr <= 4; dr++) {
        for (let dc = -4; dc <= 4; dc++) {
          const y = r + dr;
          const x = c + dc;
          if (y < 0 || y >= n || x < 0 || x >= n) continue;
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          this.set(y, x, dist !== 2 && dist !== 4);
        }
      }
    }

    const centres = ALIGNMENT[this.version - 1]!;
    for (const r of centres) {
      for (const c of centres) {
        // The three that would sit on a finder pattern are omitted.
        if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            this.set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
          }
        }
      }
    }

    this.set(n - 8, 8, true); // the always-dark module
    this.drawFormat(0); // reserve the format areas; the real mask is written later
    if (this.version >= 7) this.drawVersion();
  }

  drawFormat(mask: number): void {
    const data = (0b00 << 3) | mask; // level M is 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const n = this.size;

    for (let i = 0; i <= 5; i++) this.set(i, 8, bit(i));
    this.set(7, 8, bit(6));
    this.set(8, 8, bit(7));
    this.set(8, 7, bit(8));
    for (let i = 9; i <= 14; i++) this.set(8, 14 - i, bit(i));

    for (let i = 0; i <= 7; i++) this.set(8, n - 1 - i, bit(i));
    for (let i = 8; i <= 14; i++) this.set(n - 15 + i, 8, bit(i));
  }

  private drawVersion(): void {
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(b, a, dark);
      this.set(a, b, dark);
    }
  }

  /** The two-column zigzag, bottom-right upward, skipping the timing column. */
  drawCodewords(codewords: Uint8Array): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const col = right - j;
          const upward = ((right + 1) & 2) === 0;
          const row = upward ? this.size - 1 - vert : vert;
          if (!this.fixed[row]![col] && i < codewords.length * 8) {
            this.modules[row]![col] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    const fn = MASKS[mask]!;
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (!this.fixed[r]![c] && fn(r, c)) this.modules[r]![c] = !this.at(r, c);
      }
    }
  }

  /** The four penalty rules. Lower is better. */
  penalty(): number {
    const n = this.size;
    let score = 0;

    for (const byRow of [true, false]) {
      for (let a = 0; a < n; a++) {
        let run = 1;
        for (let b = 1; b < n; b++) {
          const cur = byRow ? this.at(a, b) : this.at(b, a);
          const prev = byRow ? this.at(a, b - 1) : this.at(b - 1, a);
          if (cur === prev) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score += 1;
          } else run = 1;
        }
      }
    }

    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const v = this.at(r, c);
        if (v === this.at(r, c + 1) && v === this.at(r + 1, c) && v === this.at(r + 1, c + 1)) {
          score += 3;
        }
      }
    }

    const FINDER = [true, false, true, true, true, false, true];
    const runsFinder = (line: boolean[], at: number): boolean => {
      for (let i = 0; i < 7; i++) if (line[at + i] !== FINDER[i]) return false;
      return true;
    };
    const quiet = (line: boolean[], from: number, to: number): boolean => {
      for (let i = from; i < to; i++) if (i >= 0 && i < line.length && line[i]) return false;
      return true;
    };
    for (const byRow of [true, false]) {
      for (let a = 0; a < n; a++) {
        const line: boolean[] = [];
        for (let b = 0; b < n; b++) line.push(byRow ? this.at(a, b) : this.at(b, a));
        for (let at = 0; at + 7 <= n; at++) {
          if (!runsFinder(line, at)) continue;
          if (quiet(line, at - 4, at) || quiet(line, at + 7, at + 11)) score += 40;
        }
      }
    }

    let dark = 0;
    for (const row of this.modules) for (const m of row) if (m) dark++;
    const percent = (dark * 100) / (n * n);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;
    return score;
  }
}

/** Encode text as a QR matrix at error-correction level M. */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  if (version === 0) {
    throw new RangeError(`${bytes.length} bytes is more than a version-${MAX_VERSION} QR holds`);
  }

  const codewords = interleave(buildDataCodewords(bytes, version), version);
  let best: Builder | null = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    const b = new Builder(version);
    b.drawFunctionPatterns();
    b.drawCodewords(codewords);
    b.applyMask(mask);
    b.drawFormat(mask);
    const score = b.penalty();
    if (score < bestScore) {
      bestScore = score;
      best = b;
      bestMask = mask;
    }
  }

  const chosen = best as Builder;
  return { size: chosen.size, modules: chosen.modules, version, mask: bestMask };
}

export interface QrSvgOptions {
  /** Pixels per module. Default 6, which prints and scans well on a phone. */
  scale?: number;
  /** Quiet-zone modules. The spec requires 4; going below it breaks scanners. */
  margin?: number;
  /** Dark colour. Default `#000`. */
  dark?: string;
  /** Light colour. Default `#fff`. A transparent background will not scan reliably. */
  light?: string;
  /** Accessible name for the image. */
  label?: string;
}

/**
 * Render as SVG. One `<path>` of rectangles, so it stays sharp at any size and
 * carries no script.
 */
export function qrSvg(matrix: QrMatrix, options: QrSvgOptions = {}): string {
  const scale = Math.max(1, Math.round(options.scale ?? 6));
  const margin = Math.max(4, Math.round(options.margin ?? 4));
  const dark = options.dark ?? "#000";
  const light = options.light ?? "#fff";
  const span = matrix.size + margin * 2;
  const px = span * scale;

  let path = "";
  for (let r = 0; r < matrix.size; r++) {
    const row = matrix.modules[r]!;
    for (let c = 0; c < matrix.size; c++) {
      if (row[c]) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }

  const label = escapeXml(options.label ?? "QR code");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="0 0 ${span} ${span}" role="img" aria-label="${label}" shape-rendering="crispEdges">` +
    `<rect width="${span}" height="${span}" fill="${escapeXml(light)}"/>` +
    `<path d="${path}" fill="${escapeXml(dark)}"/>` +
    `</svg>`
  );
}

/** The same SVG as a `data:` URI, for an `<img src>` or a print stylesheet. */
export function qrDataUri(matrix: QrMatrix, options: QrSvgOptions = {}): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(matrix, options))}`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&apos;",
  );
}

/** Convenience: text straight to SVG. */
export function qrCodeSvg(text: string, options: QrSvgOptions = {}): string {
  return qrSvg(encodeQr(text), { label: options.label ?? `QR code for ${text}`, ...options });
}
