const fs = require('fs');
const { Readable } = require('stream');

/**
 * Global killswitch for sharp-based image processing.
 *
 * Set to `true` (default) to resize and compress images with `sharp` before
 * embedding them into generated reports. This produces significantly smaller
 * output files but requires the `sharp` native binary (node-gyp) to be installed.
 *
 * Set to `false` to skip all `sharp` processing. Images are read from disk
 * with `fs.readFileSync()` and embedded as-is. No native binary is required.
 * Useful in restricted CI environments, unsupported platforms, or when
 * generation speed is more important than output file size.
 *
 * @type {boolean}
 */
const USE_SHARP = true;

/**
 * Resolves a data source into a Node.js Readable stream.
 *
 * Distinguishes between three kinds of input:
 *
 * 1. **Existing file path** — any string that does NOT start with `[` or `{`
 *    and refers to a file that exists on disk. Opened as an `fs.ReadStream`
 *    for constant-memory streaming (suitable for 10 GB+ files).
 *
 * 2. **Missing file path** — a string that looks like a file path (does not
 *    start with `[` or `{`) but does not exist on disk. Throws immediately
 *    with a descriptive message so the error is surfaced at call-time rather
 *    than as a cryptic JSON parse failure inside the generator.
 *
 * 3. **Inline JSON string** — a string whose first non-whitespace character
 *    is `[` or `{`. Wrapped in `Readable.from()` and streamed from memory.
 *    Use only for small datasets (API responses, test fixtures) that
 *    comfortably fit in RAM.
 *
 * @param {string} source - An absolute or relative file path, or a serialized JSON string.
 * @returns {import('stream').Readable} A readable stream of the raw JSON data.
 * @throws {Error} If `source` is falsy (null, undefined, empty string).
 * @throws {Error} If `source` looks like a file path but the file does not exist.
 *
 * @example
 * // From a file (memory-efficient streaming)
 * const stream = getStream('/data/large.json');
 *
 * @example
 * // From an inline JSON string (held in RAM)
 * const stream = getStream(JSON.stringify([{ title: 'Demo', columns: [], items: [] }]));
 */
function getStream(source) {
  if (!source) throw new Error('No data source provided.');

  if (typeof source === 'string') {
    const trimmed = source.trimStart();

    // Inline JSON strings always begin with '[' or '{'.
    // Anything else is treated as a file path.
    const looksLikeJson = trimmed.startsWith('[') || trimmed.startsWith('{');

    if (!looksLikeJson) {
      // It's a file path — verify it exists before opening.
      if (!fs.existsSync(source)) {
        throw new Error(
          `Source file not found: "${source}"\n` +
          `Make sure the path is correct and the file exists before calling generate().`
        );
      }
      return fs.createReadStream(source);
    }
  }

  // Raw JSON string — stream it from memory.
  return Readable.from([source]);
}

/**
 * Default layout configuration for PDF report generation.
 *
 * All numeric values are in PDF points (pt), where 1 pt ≈ 0.353 mm.
 * These values are merged with any `options` object passed to
 * `ReportGenerator` or `StreamingPdfGenerator`, so individual properties
 * can be overridden per-report without affecting the defaults.
 *
 * @type {object}
 * @property {{ top: number, bottom: number, left: number, right: number }} margins
 *   Page margins in points. `bottom` must be large enough to accommodate the
 *   footer, which is rendered at `page.height - footerHeight`.
 * @property {number} tablePadding - Inner padding between the table border and cell content (pt).
 * @property {number} imageHeight  - Maximum height for image cells in PDF rows (pt).
 * @property {number} rowGap       - Extra vertical space added below each data row (pt).
 * @property {number} footerHeight - Height of the reserved footer area at the page bottom (pt).
 * @property {number} headerTitleSize - Font size (pt) for the group/section title printed above each table.
 * @property {string} themeColor     - Primary accent colour (hex). Used for hyperlinks and TOC entries.
 * @property {string} secondaryColor - Secondary text colour (hex). Used for footer page numbers and TOC page ranges.
 * @property {string} dotColor       - Colour (hex) of the dot-leader line in the Table of Contents.
 */
const layoutConfig = {
  margins: { top: 30, bottom: 50, left: 30, right: 30 },
  tablePadding: 12, imageHeight: 40, rowGap: 4.2, footerHeight: 25,
  headerTitleSize: 14, themeColor: '#0066cc', secondaryColor: '#333333', dotColor: '#999999'
};

module.exports = { getStream, layoutConfig, USE_SHARP };
