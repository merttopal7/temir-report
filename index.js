const StreamingPdfGenerator = require('./generators/PdfGenerator');
const ExcelGenerator = require('./generators/ExcelGenerator');
const StreamingHtmlGenerator = require('./generators/HtmlGenerator');

/**
 * @fileoverview ReportGenerator — the public API facade for temir-report.
 *
 * Provides a single, fluent entry-point for generating professional reports
 * in PDF, Excel (XLSX) and interactive HTML formats from arbitrarily large
 * JSON datasets. Internally it delegates to three specialised generators:
 *   - {@link StreamingHtmlGenerator} — single-file HTML dashboard with virtual grid rendering
 *   - {@link StreamingPdfGenerator}  — 2-pass PDF with clickable Table of Contents
 *   - {@link ExcelGenerator}         — multi-sheet XLSX workbook with embedded photos
 *
 * @module temir-report
 * @example
 * const ReportGenerator = require('temir-report');
 *
 * await new ReportGenerator()
 *   .source('data.json')
 *   .setTitle('Q2 Sales Report')
 *   .type(ReportGenerator.PDF)
 *   .generate('report.pdf');
 */

/**
 * Facade that orchestrates PDF, Excel and HTML report generation
 * from a streaming JSON data source.
 *
 * All instance methods return `this`, so calls can be chained:
 * ```js
 * await generator.source('data.json').setTitle('My Report').type('pdf').generate('out.pdf');
 * ```
 */
class ReportGenerator {
  /**
   * Format constant for HTML dashboard output.
   * Pass to {@link ReportGenerator#type} or compare with `this.reportFormat`.
   * @type {string}
   */
  static PDF = 'pdf';

  /**
   * Format constant for Excel (XLSX) workbook output.
   * Pass to {@link ReportGenerator#type} or compare with `this.reportFormat`.
   * @type {string}
   */
  static EXCEL = 'excel';

  /**
   * Format constant for interactive HTML dashboard output.
   * Pass to {@link ReportGenerator#type} or compare with `this.reportFormat`.
   * @type {string}
   */
  static HTML = 'html';

  /**
   * Creates a new ReportGenerator instance.
   *
   * All parameters are optional — they can be set (or overridden) later via
   * the fluent chainable methods before calling {@link ReportGenerator#generate}.
   *
   * @param {string} [source] - Absolute/relative path to a JSON file, **or** a
   *   raw serialized JSON string. Can be overridden with {@link ReportGenerator#source}.
   * @param {object} [options={}] - Optional layout overrides merged on top of the
   *   defaults defined in `utils/StreamUtils.layoutConfig`. Any key from
   *   `layoutConfig` can be overridden here (e.g. `themeColor`, `margins`, `tablePadding`).
   */
  constructor(source, options = {}) {
    this.dataSource = source;
    this.options = options;
    this.reportTitle = 'Global Report Title';
    this.reportFormat = ReportGenerator.PDF;
  }

  /**
   * Sets the JSON data source for this report.
   *
   * Accepts either:
   * - An **absolute or relative file path** to a `.json` file. The file is opened
   *   as a streaming `ReadStream`, keeping memory usage constant regardless of
   *   file size (suitable for 10 GB+ datasets).
   * - A **raw JSON string** already in memory. This is wrapped in a `Readable.from()`
   *   stream. The entire string must fit in RAM, so use this only for small datasets
   *   (e.g. API responses, test fixtures).
   *
   * @param {string} data - File path or serialized JSON string.
   * @returns {this} The current instance, for method chaining.
   */
  source(data) { this.dataSource = data; return this; }

  /**
   * Sets the report title displayed in the generated output.
   *
   * - **HTML**: rendered as the `<h1>` in the top navigation bar and as `<title>`.
   * - **PDF**: printed as a large heading on the cover/TOC page.
   * - **Excel**: not currently used in sheet content, but stored in the instance.
   *
   * @param {string} title - The human-readable report title.
   * @returns {this} The current instance, for method chaining.
   */
  setTitle(title) { this.reportTitle = title; return this; }

  /**
   * Sets the output format for the report.
   *
   * Use the static constants for type safety:
   * - `ReportGenerator.PDF`   → `'pdf'`
   * - `ReportGenerator.EXCEL` → `'excel'`
   * - `ReportGenerator.HTML`  → `'html'`
   *
   * @param {string} format - The desired output format (case-insensitive).
   * @returns {this} The current instance, for method chaining.
   * @throws {Error} Indirectly — an unsupported format string will cause
   *   {@link ReportGenerator#generate} to throw.
   */
  type(format) { this.reportFormat = format.toLowerCase(); return this; }

  /**
   * Triggers report generation and writes the output to disk.
   *
   * Delegates to the appropriate internal generator based on the format set
   * via {@link ReportGenerator#type}:
   * - `'html'`  → {@link StreamingHtmlGenerator}
   * - `'pdf'`   → {@link StreamingPdfGenerator} (2-pass: dry-run layout + real render)
   * - `'excel'` → {@link ExcelGenerator}
   *
   * @param {string} outputFileName - Destination file path (absolute or relative to `cwd`).
   *   The file extension should match the chosen format (`.html`, `.pdf`, `.xlsx`).
   * @returns {Promise<void>} Resolves when the file has been fully written and flushed.
   * @throws {Error} If no data source has been set.
   * @throws {Error} If the format string is not one of `'pdf'`, `'excel'`, or `'html'`.
   *
   * @example
   * await generator.source('data.json').type('html').generate('report.html');
   */
  async generate(outputFileName) {
    if (!this.dataSource) throw new Error("Data source required.");
    const opts = { ...this.options, reportTitle: this.reportTitle };

    if (this.reportFormat === ReportGenerator.PDF) {
      await new StreamingPdfGenerator(this.dataSource, outputFileName, opts).generate();
    } else if (this.reportFormat === ReportGenerator.EXCEL) {
      await new ExcelGenerator(this.dataSource, outputFileName).generate();
    } else if (this.reportFormat === ReportGenerator.HTML) {
      await new StreamingHtmlGenerator(this.dataSource, outputFileName, opts).generate();
    } else {
      throw new Error(`Unsupported format: ${this.reportFormat}`);
    }
  }
}

// ---------------------------------------------------------------------------
// EXECUTION BLOCK — only runs when this file is called directly via Node.js
// (e.g. `node index.js`). When the module is required by another file, this
// block is silently skipped and only the class export is used.
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    try {
      const generator = new ReportGenerator();

      console.log("Generating HTML Dashboard...");
      await generator
        .source('data.json')
        .setTitle("Executive Dynamic Web Report")
        .type(ReportGenerator.HTML)
        .generate('executive_report.html');

      console.log("Generating PDF Report...");
      await generator
        .source('data.json')
        .setTitle("Executive Dynamic PDF Report")
        .type(ReportGenerator.PDF)
        .generate('executive_report.pdf');

      console.log("Generating Excel Report...");
      await generator
        .source('data.json')
        .setTitle("Executive Dynamic Excel Report")
        .type(ReportGenerator.EXCEL)
        .generate('executive_report.xlsx');

      console.log("\nAll reports generated successfully!");
    } catch (err) {
      console.error("Generation failed:", err);
    }
  })();
}

module.exports = ReportGenerator;

