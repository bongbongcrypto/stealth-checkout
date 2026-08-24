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
/** The Reed-Solomon remainder for one block. */
export declare function rsRemainder(data: Uint8Array, degree: number): Uint8Array;
export interface QrMatrix {
    /** Modules per side, excluding the quiet zone. */
    readonly size: number;
    /** `true` is a dark module. Indexed `[row][col]`. */
    readonly modules: readonly (readonly boolean[])[];
    readonly version: number;
    readonly mask: number;
}
/** Encode text as a QR matrix at error-correction level M. */
export declare function encodeQr(text: string): QrMatrix;
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
export declare function qrSvg(matrix: QrMatrix, options?: QrSvgOptions): string;
/** The same SVG as a `data:` URI, for an `<img src>` or a print stylesheet. */
export declare function qrDataUri(matrix: QrMatrix, options?: QrSvgOptions): string;
/**
 * The most a version-20 level-M code holds in byte mode: 669 data codewords is
 * 5352 bits, less 4 for the mode indicator and 16 for the length.
 */
export declare const QR_MAX_BYTES = 666;
/**
 * Whether `encodeQr` will take this text.
 *
 * Callers should ask before building a QR out of anything they did not write
 * themselves. A payment link carries a URL whose length someone else may
 * control, and a checkout that throws while drawing an optional convenience is
 * a checkout that a crafted link can take off the air.
 */
export declare function qrFits(text: string): boolean;
/** Convenience: text straight to SVG. */
export declare function qrCodeSvg(text: string, options?: QrSvgOptions): string;
