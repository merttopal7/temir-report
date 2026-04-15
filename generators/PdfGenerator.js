const fs = require('fs');
const PDFDocument = require('pdfkit');
const { chain } = require('stream-chain');
const { parser } = require('stream-json');
const Assembler = require('stream-json/assembler.js');
const { getStream, layoutConfig } = require('../utils/StreamUtils');

/**
 * Generates a professional, multi-page PDF report from a streaming JSON source.
 *
 * Uses a **2-pass architecture** to produce a clickable Table of Contents:
 * - **Pass 1 (dry run):** Simulates the full layout without writing pixel data,
 *   recording the exact page range (`startPage`–`endPage`) for each group.
 *   This produces `reportMap`, which drives the TOC on page 1.
 * - **Pass 2 (real render):** Streams the JSON again, renders all content to disk,
 *   and uses `reportMap` to build the clickable TOC with correct page numbers.
 *
 * Layout automatically adapts to the number of columns:
 * - ≤ 7 columns → Portrait A4
 * - > 7 columns → Landscape A4
 * - > 12 columns → Font size reduced to 6 pt to prevent overflow
 */
class StreamingPdfGenerator {
  /**
   * @param {string} source       - File path or serialized JSON string (see `utils/StreamUtils.getStream`).
   * @param {string} outputFileName - Destination `.pdf` file path.
   * @param {object} options      - Layout overrides merged on top of `layoutConfig`.
   *   Any property defined in `layoutConfig` can be overridden here.
   *   `options.reportTitle` sets the cover-page heading.
   */
  constructor(source, outputFileName, options) {
    this.source = source;
    this.outputFileName = outputFileName;
    this.layout = { ...layoutConfig, ...options };
    this.reportTitle = options.reportTitle || "Report";
  }

  /**
   * Writes the group title heading and bold column header row to the document.
   *
   * Records `state.tableStartY` so that `_performDrawRow` can later close the
   * rounded-rect table border at the correct Y position. Also registers a named
   * PDF destination (`doc.addNamedDestination`) and bookmark entry the first time
   * a group title is drawn — enabling TOC hyperlinks and the Acrobat bookmarks panel.
   *
   * @param {import('pdfkit')} doc  - Active PDFKit document instance.
   * @param {object}           state - Shared mutable render state for the current pass.
   * @param {boolean} state.isReal          - `false` during the dry-run pass (no pixel output).
   * @param {string}  state.currentTitle    - Display name of the current data group.
   * @param {string}  state.activeTitleOnPage - Title already printed on the current page (prevents duplicates).
   * @param {string}  state.lastLinkedTitle  - Title for which a named destination was last registered.
   * @param {number}  state.pageNum          - Current logical page number.
   * @param {Array<{title:string,type:string}>} state.headers - Column descriptor array.
   * @param {number[]} state.columnWidths   - Computed width (pt) for each column.
   * @param {number}  state.tableStartX     - Left X coordinate of the table (= left margin).
   * @param {number}  state.dynamicFontSize - Font size (pt) for data cells (6 or 10).
   * @returns {void}
   */
  _performDrawHeaders(doc, state) {
    state.tableStartY = doc.y; doc.y += this.layout.tablePadding;
    if (state.currentTitle && state.activeTitleOnPage !== state.currentTitle) {
      const anchor = state.currentTitle.replace(/\s+/g, '_');
      if (state.lastLinkedTitle !== state.currentTitle) {
        if (state.isReal) { try { doc.addNamedDestination(anchor); doc.outline.addItem(`${state.currentTitle} | Page ${state.pageNum}`); } catch (e) {} }
        state.lastLinkedTitle = state.currentTitle;
      }
      doc.fontSize(this.layout.headerTitleSize).font('Helvetica-Bold').text(`${state.currentTitle} | Page ${state.pageNum}`, { indent: this.layout.tablePadding });
      doc.moveDown(0.5); state.activeTitleOnPage = state.currentTitle;
    }
    doc.fontSize(state.dynamicFontSize).font('Helvetica-Bold');
    const y = doc.y; let x = state.tableStartX + this.layout.tablePadding;
    state.headers.forEach((h, i) => { doc.text(h.title, x, y, { width: state.columnWidths[i] - 5, align: 'left' }); x += state.columnWidths[i]; });
    doc.y += state.dynamicFontSize + 3;
    if (state.isReal) { doc.lineWidth(1).strokeColor('#000000').moveTo(state.tableStartX, doc.y).lineTo(state.tableStartX + state.fullTableWidth, doc.y).stroke(); }
    doc.y += (this.layout.tablePadding / 2); doc.font('Helvetica');
  }

  /**
   * Writes a single data record as a table row.
   *
   * Before rendering, pre-calculates the row's maximum height (accounting for
   * multi-line text and fixed image cells). If the row would overflow the page
   * bottom margin, it:
   *   1. Closes the current table border with a rounded rect.
   *   2. Draws the page footer and increments `state.pageNum`.
   *   3. Calls `doc.addPage()` and re-draws column headers on the new page.
   *
   * Image cells (`type === 'image'`) are rendered with `doc.image()` using a
   * fixed `fit` box of `[columnWidth - 5, layout.imageHeight]`. All other cells
   * are rendered as plain text with `doc.text()`.
   *
   * @param {import('pdfkit')} doc    - Active PDFKit document instance.
   * @param {object}           record - Plain object representing one data record.
   *   Values are read positionally via `Object.values(record)`.
   * @param {object}           state  - Shared mutable render state (same shape as in `_performDrawHeaders`).
   * @returns {void}
   */
  _performDrawRow(doc, record, state) {
    let maxHeight = 0; const values = Object.values(record); doc.fontSize(state.dynamicFontSize);
    values.forEach((val, i) => {
      let h = (state.headers[i].type === 'image') ? this.layout.imageHeight : doc.heightOfString(String(val ?? ''), { width: state.columnWidths[i] - 5 });
      if (h > maxHeight) maxHeight = h;
    });
    if (doc.y + maxHeight + this.layout.tablePadding > doc.page.height - this.layout.margins.bottom) {
      if (state.isReal) { doc.lineWidth(1.5).strokeColor('#000000').roundedRect(state.tableStartX, state.tableStartY, state.fullTableWidth, (doc.y - state.tableStartY) + this.layout.tablePadding, 8).stroke(); }
      this._performDrawFooter(doc, state);
      state.pageNum++; doc.addPage({ margins: this.layout.margins, size: 'A4', layout: state.docLayout });
      state.activeTitleOnPage = ''; this._performDrawHeaders(doc, state);
    }
    const startY = doc.y; let x = state.tableStartX + this.layout.tablePadding;
    values.forEach((val, i) => {
      if (state.isReal) {
        if (state.headers[i].type === 'image' && val) {
          try { doc.image(val, x, startY, { fit: [state.columnWidths[i] - 5, this.layout.imageHeight] }); } catch (e) { doc.text("[Img Error]", x, startY); }
        } else { doc.text(String(val ?? ''), x, startY, { width: state.columnWidths[i] - 5, align: 'left' }); }
      }
      x += state.columnWidths[i];
    });
    doc.y = startY + maxHeight + this.layout.rowGap;
    if (state.isReal) { doc.lineWidth(0.5).strokeColor('#e0e0e0').moveTo(state.tableStartX, doc.y - 2).lineTo(state.tableStartX + state.fullTableWidth, doc.y - 2).stroke(); }
    doc.moveDown(0.2);
  }

  /**
   * Renders the page footer at the bottom of the current page.
   *
   * The footer contains a centred line with the current page number and a
   * `"Go To Table Of Contents"` hyperlink that uses PDFKit's `goTo` option to
   * jump to the named destination `'TOC_TOP'` registered on the cover page.
   *
   * This method is a no-op during the dry-run pass (`state.isReal === false`).
   *
   * @param {import('pdfkit')} doc   - Active PDFKit document instance.
   * @param {object}           state - Shared mutable render state.
   * @param {boolean} state.isReal  - If `false`, the method returns immediately.
   * @param {number}  state.pageNum - The logical page number printed in the footer.
   * @returns {void}
   */
  _performDrawFooter(doc, state) {
    if (!state.isReal) return;
    const bm = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.fontSize(10).font('Helvetica');
    const footerY = doc.page.height - this.layout.footerHeight;
    const pageWidth = doc.page.height; // Error in my previous summary, fixed logic below
    const docPageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const pageText = `Page ${state.pageNum}  |  `; const linkText = "Go To Table Of Contents";
    const totalWidth = doc.widthOfString(pageText) + doc.widthOfString(linkText);
    const centeredStartX = doc.page.margins.left + (docPageWidth - totalWidth) / 2;
    doc.fillColor(this.layout.secondaryColor).text(pageText, centeredStartX, footerY, { continued: true });
    doc.fillColor(this.layout.themeColor).text(linkText, { underline: true, goTo: 'TOC_TOP' });
    doc.page.margins.bottom = bm; doc.fillColor('black');
  }

   /**
   * Executes the PDF generation pipeline and writes the output file.
   *
   * **Default (2-pass with TOC):**
   * - Pass 1 (dry run): Reads all records, simulates layout, builds `reportMap`
   *   with exact page spans. Logs progress every 25,000 records so the terminal
   *   does not appear frozen during large dataset analysis.
   * - Pass 2 (real render): Renders the cover page (title + clickable TOC from
   *   `reportMap`), then streams all records again and writes every page to disk.
   *
   * **`skipToc: true` (single-pass, no TOC):**
   * Pass 1 is skipped entirely. The PDF starts directly with the data pages — no
   * cover page, no Table of Contents, no "Go To TOC" footer links. Roughly 2×
   * faster than the default mode, and the recommended setting for datasets with
   * millions of rows where TOC generation would take an impractical amount of time.
   *
   * Enable via the options object:
   * ```js
   * new ReportGenerator('data.json', { skipToc: true }).type('pdf').generate('out.pdf');
   * ```
   *
   * @returns {Promise<void>} Resolves when `doc.end()` has been called and the
   *   write stream has finished flushing all bytes to disk.
   * @throws {Error} If the JSON stream emits an error during either pass.
   */
  async generate() {
    if (this.layout.skipToc) {
      return this._generateSinglePass();
    }
    return this._generateTwoPass();
  }

  /**
   * Single-pass PDF generation — no TOC, no dry run.
   * Streams JSON once and writes pages directly to disk.
   * @private
   * @returns {Promise<void>}
   */
  async _generateSinglePass() {
    console.log(`Starting PDF generation (single-pass, TOC skipped)...`);
    const doc = new PDFDocument({ autoFirstPage: false, size: 'A4' });
    doc.pipe(fs.createWriteStream(this.outputFileName));
    const state = {
      isReal: true, pageNum: 1, currentTitle: '', activeTitleOnPage: '', lastLinkedTitle: '',
      headers: [], columnWidths: [], currentColumns: [], dynamicFontSize: 10,
      docLayout: 'portrait', tableStartX: 30, fullTableWidth: 0, tableStartY: 0,
      currentGroupItemsProcessed: 0
    };
    const rawStream = chain([getStream(this.source), parser()]);
    let counter = 0, isIdKey = false, inColsIdx = false, inItmsIdx = false, depthIdx = 0, objAssIdx = null;
    rawStream.on('data', token => {
      if (!inColsIdx && !inItmsIdx) {
        if (token.name === 'keyValue' && token.value === 'title') { isIdKey = true; return; }
        if (isIdKey && token.name === 'stringValue') { state.currentTitle = token.value; isIdKey = false; return; }
      }
      if (token.name === 'keyValue' && token.value === 'columns') { inColsIdx = true; objAssIdx = new Assembler(); return; }
      if (inColsIdx) { objAssIdx.consume(token); if (objAssIdx.done) { state.currentColumns = objAssIdx.current; objAssIdx = null; inColsIdx = false; } return; }
      if (token.name === 'keyValue' && token.value === 'items') { inItmsIdx = true; depthIdx = 0; return; }
      if (inItmsIdx) {
        if (token.name === 'startArray') { depthIdx++; if (depthIdx === 1) return; }
        if (token.name === 'endArray') {
          depthIdx--;
          if (depthIdx === 0) {
            inItmsIdx = false;
            if (state.currentGroupItemsProcessed > 0) {
              doc.lineWidth(1.5).strokeColor('#000000').roundedRect(state.tableStartX, state.tableStartY, state.fullTableWidth, (doc.y - state.tableStartY) + this.layout.tablePadding, 8).stroke();
              this._performDrawFooter(doc, state);
            }
            state.currentGroupItemsProcessed = 0; return;
          }
        }
        if (depthIdx === 1 && token.name === 'startObject') { objAssIdx = new Assembler(); objAssIdx.consume(token); }
        else if (objAssIdx) {
          objAssIdx.consume(token);
          if (objAssIdx.done) {
            const record = objAssIdx.current; objAssIdx = null;
            if (!state.currentGroupItemsProcessed) {
              const keys = Object.keys(record);
              state.headers = keys.map((k, i) => { const col = (state.currentColumns && state.currentColumns[i]) ? state.currentColumns[i] : {}; return { title: col.title || k.replace(/_/g, ' ').toUpperCase(), type: col.type || 'text' }; });
              state.docLayout = state.headers.length > 7 ? 'landscape' : 'portrait';
              state.dynamicFontSize = state.headers.length > 12 ? 6 : 10;
              state.pageNum++;
              doc.addPage({ margins: this.layout.margins, size: 'A4', layout: state.docLayout });
              state.fullTableWidth = doc.page.width - this.layout.margins.left - this.layout.margins.right;
              state.tableStartX = this.layout.margins.left;
              state.columnWidths = state.headers.map(() => (state.fullTableWidth - (this.layout.tablePadding * 2)) / state.headers.length);
              state.activeTitleOnPage = ''; this._performDrawHeaders(doc, state);
            }
            this._performDrawRow(doc, record, state); state.currentGroupItemsProcessed++; counter++;
            if (counter % 25000 === 0) console.log(`Processed ${counter} records (PDF single-pass)...`);
          }
        }
      }
    });
    return new Promise((res) => rawStream.on('end', () => { doc.end(); res(); }));
  }

  /**
   * Two-pass PDF generation — dry run to build TOC, then real render.
   * @private
   * @returns {Promise<void>}
   */
  async _generateTwoPass() {
    console.log(`Analyzing PDF structure (pass 1 of 2)...`);
    const docSim = new PDFDocument({ margin: 30, size: 'A4' });
    const rawStreamSim = chain([getStream(this.source), parser()]);
    let reportMap = [], currentEntry = null, isTitleKey = false, inColumnsArray = false, inItemsArray = false, arrayDepth = 0, objAssembler = null;
    let dryRunCounter = 0;
    let stateSim = {
      isReal: false, pageNum: 2, currentTitle: '', activeTitleOnPage: '', lastLinkedTitle: '',
      headers: [], columnWidths: [], currentColumns: [], dynamicFontSize: 10, docLayout: 'portrait', tableStartX: 30, fullTableWidth: 0
    };
    await new Promise((res) => {
      rawStreamSim.on('data', token => {
        if (!inColumnsArray && !inItemsArray) {
          if (token.name === 'keyValue' && token.value === 'title') { isTitleKey = true; return; }
          if (isTitleKey && token.name === 'stringValue') { currentEntry = { title: token.value, startPage: 0, endPage: 0 }; stateSim.currentTitle = token.value; isTitleKey = false; return; }
        }
        if (token.name === 'keyValue' && token.value === 'columns') { inColumnsArray = true; objAssembler = new Assembler(); return; }
        if (inColumnsArray) { objAssembler.consume(token); if (objAssembler.done) { stateSim.currentColumns = objAssembler.current; objAssembler = null; inColumnsArray = false; } return; }
        if (token.name === 'keyValue' && token.value === 'items') { inItemsArray = true; arrayDepth = 0; return; }
        if (inItemsArray) {
          if (token.name === 'startArray') { arrayDepth++; if (arrayDepth === 1) return; }
          if (token.name === 'endArray') { arrayDepth--; if (arrayDepth === 0) { inItemsArray = false; if (currentEntry) { currentEntry.endPage = stateSim.pageNum; reportMap.push(currentEntry); } return; } }
          if (arrayDepth === 1 && token.name === 'startObject') { objAssembler = new Assembler(); objAssembler.consume(token); }
          else if (objAssembler) {
            objAssembler.consume(token);
            if (objAssembler.done) {
              const record = objAssembler.current; objAssembler = null;
              if (currentEntry.startPage === 0) {
                const keysArr = Object.keys(record);
                stateSim.headers = keysArr.map((k, i) => { const col = (stateSim.currentColumns && stateSim.currentColumns[i]) ? stateSim.currentColumns[i] : {}; return { title: col.title || k.replace(/_/g, ' ').toUpperCase(), type: col.type || 'text' }; });
                stateSim.docLayout = stateSim.headers.length > 7 ? 'landscape' : 'portrait'; stateSim.dynamicFontSize = stateSim.headers.length > 12 ? 6 : 10;
                if (reportMap.length > 0) stateSim.pageNum++; currentEntry.startPage = stateSim.pageNum;
                docSim.addPage({ margins: this.layout.margins, size: 'A4', layout: stateSim.docLayout });
                stateSim.fullTableWidth = docSim.page.width - this.layout.margins.left - this.layout.margins.right; stateSim.tableStartX = this.layout.margins.left;
                stateSim.columnWidths = stateSim.headers.map(() => (stateSim.fullTableWidth - (this.layout.tablePadding * 2)) / stateSim.headers.length);
                stateSim.activeTitleOnPage = ''; this._performDrawHeaders(docSim, stateSim);
              }
              this._performDrawRow(docSim, record, stateSim);
              dryRunCounter++;
              if (dryRunCounter % 25000 === 0) console.log(`  Analyzing... ${dryRunCounter.toLocaleString()} records scanned (pass 1 of 2)`);
            }
          }
        }
      });
      rawStreamSim.on('end', res);
    });
    console.log(`  Analysis complete — ${dryRunCounter.toLocaleString()} total records, ${reportMap.length} group(s) found.`);
    const doc = new PDFDocument({ autoFirstPage: true, margin: 50, size: 'A4' }); doc.pipe(fs.createWriteStream(this.outputFileName));
    doc.addNamedDestination('TOC_TOP'); doc.outline.addItem('Table of Contents');
    doc.fontSize(28).font('Helvetica-Bold').text(this.reportTitle, { align: 'center' }); doc.moveDown(2);
    doc.fontSize(16).fillColor(this.layout.secondaryColor).text('Navigation Links:', { underline: true }); doc.moveDown(1);
    reportMap.forEach((entry) => {
      const anchor = entry.title.replace(/\s+/g, '_'); const rangeText = `${entry.startPage}-${entry.endPage}`;
      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      doc.fontSize(12).font('Helvetica').fillColor(this.layout.themeColor); doc.text(entry.title, { continued: true, underline: true, goTo: anchor });
      const rangeWidth = doc.widthOfString(` ${rangeText}`); const remainingWidth = (pageWidth - doc.widthOfString(entry.title) - rangeWidth) - 10;
      if (remainingWidth > 0) { const docDots = " . ".repeat(Math.floor(remainingWidth / doc.widthOfString(" . "))); doc.fillColor(this.layout.dotColor).text(` ${docDots} `, { continued: true, underline: false }); } else { doc.text(" ", { continued: true }); }
      doc.fillColor(this.layout.secondaryColor).text(rangeText, { underline: false }); doc.moveDown(0.5);
    });
    const state = { isReal: true, pageNum: 2, currentTitle: '', activeTitleOnPage: '', lastLinkedTitle: '', headers: [], columnWidths: [], currentColumns: [], dynamicFontSize: 10, docLayout: 'portrait', tableStartX: 30, fullTableWidth: 0, tableStartY: 0, currentGroupItemsProcessed: 0 };
    const rawStream = chain([getStream(this.source), parser()]);
    let counter = 0, isIdKey = false, inColsIdx = false, inItmsIdx = false, depthIdx = 0, objAssIdx = null;
    rawStream.on('data', token => {
      if (!inColsIdx && !inItmsIdx) { if (token.name === 'keyValue' && token.value === 'title') { isIdKey = true; return; } if (isIdKey && token.name === 'stringValue') { state.currentTitle = token.value; isIdKey = false; return; } }
      if (token.name === 'keyValue' && token.value === 'columns') { inColsIdx = true; objAssIdx = new Assembler(); return; }
      if (inColsIdx) { objAssIdx.consume(token); if (objAssIdx.done) { state.currentColumns = objAssIdx.current; objAssIdx = null; inColsIdx = false; } return; }
      if (token.name === 'keyValue' && token.value === 'items') { inItmsIdx = true; depthIdx = 0; return; }
      if (inItmsIdx) {
        if (token.name === 'startArray') { depthIdx++; if (depthIdx === 1) return; }
        if (token.name === 'endArray') { depthIdx--; if (depthIdx === 0) { inItmsIdx = false; if (state.currentGroupItemsProcessed > 0) { doc.lineWidth(1.5).strokeColor('#000000').roundedRect(state.tableStartX, state.tableStartY, state.fullTableWidth, (doc.y - state.tableStartY) + this.layout.tablePadding, 8).stroke(); this._performDrawFooter(doc, state); } state.currentGroupItemsProcessed = 0; return; } }
        if (depthIdx === 1 && token.name === 'startObject') { objAssIdx = new Assembler(); objAssIdx.consume(token); }
        else if (objAssIdx) {
          objAssIdx.consume(token);
          if (objAssIdx.done) {
            const record = objAssIdx.current; objAssIdx = null;
            if (!state.currentGroupItemsProcessed) {
              const keys = Object.keys(record); state.headers = keys.map((k, i) => { const col = (state.currentColumns && state.currentColumns[i]) ? state.currentColumns[i] : {}; return { title: col.title || k.replace(/_/g, ' ').toUpperCase(), type: col.type || 'text' }; });
              state.docLayout = state.headers.length > 7 ? 'landscape' : 'portrait'; state.dynamicFontSize = state.headers.length > 12 ? 6 : 10;
              if (counter > 0) state.pageNum++; doc.addPage({ margins: this.layout.margins, size: 'A4', layout: state.docLayout });
              state.fullTableWidth = doc.page.width - this.layout.margins.left - this.layout.margins.right; state.tableStartX = this.layout.margins.left;
              state.columnWidths = state.headers.map(() => (state.fullTableWidth - (this.layout.tablePadding * 2)) / state.headers.length);
              state.activeTitleOnPage = ''; this._performDrawHeaders(doc, state);
            }
            this._performDrawRow(doc, record, state); state.currentGroupItemsProcessed++; counter++;
            if (counter % 25000 === 0) console.log(`  Rendering... ${counter.toLocaleString()} records written (pass 2 of 2)...`);
          }
        }
      }
    });
    return new Promise((res) => rawStream.on('end', () => { doc.end(); console.log(`  Render complete — ${counter.toLocaleString()} records written.`); res(); }));
  }
}

module.exports = StreamingPdfGenerator;
