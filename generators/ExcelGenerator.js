const fs = require('fs');
const ExcelJS = require('exceljs');
const { chain } = require('stream-chain');
const { parser } = require('stream-json');
const Assembler = require('stream-json/assembler.js');
const { getStream, USE_SHARP } = require('../utils/StreamUtils');
// sharp is only loaded when USE_SHARP is enabled to avoid native binary errors
const sharp = USE_SHARP ? require('sharp') : null;

/**
 * Generates a multi-sheet Excel (XLSX) workbook from a streaming JSON source.
 *
 * Each top-level group object in the JSON maps to a separate worksheet. Sheet
 * names are automatically derived from the group's `title` field and truncated
 * to 31 characters to comply with Excel's sheet-name limit.
 *
 * When `USE_SHARP` is `true`, image columns are compressed to 120×120 px JPEG
 * at 75% quality before being embedded as thumbnail photos. Each unique image
 * path is processed only once — subsequent rows reuse the cached workbook image
 * ID, preventing redundant disk reads and re-compression.
 *
 * When `USE_SHARP` is `false`, raw file bytes are embedded directly using the
 * file's original extension. No resizing or re-encoding is performed.
 */
class ExcelGenerator {
  /**
   * @param {string} source         - File path or serialized JSON string (see `utils/StreamUtils.getStream`).
   * @param {string} outputFileName - Destination `.xlsx` file path.
   */
  constructor(source, outputFileName) { this.source = source; this.outputFileName = outputFileName; }
  /**
   * Streams the JSON source and builds the Excel workbook record-by-record.
   *
   * **Streaming state machine:**
   * The JSON stream emits `stream-json` token objects. A set of boolean flags
   * (`isTitleKey`, `inColumnsArr`, `inItemsArr`) tracks which part of a group
   * object is currently being read. `stream-json/assembler` buffers `columns`
   * and individual `items` records into plain JS objects; the outer array is
   * never fully buffered.
   *
   * **Per-group processing:**
   * When the first record of a group is encountered, a new `ExcelJS.Worksheet`
   * is created with bold column headers. Column titles come from the `columns`
   * metadata array; if a title is missing, the record key is used as a fallback
   * (snake_case converted to UPPER CASE).
   *
   * **Image handling:**
   * For cells whose column `type` is `'image'` and whose value is a path to an
   * existing file:
   * - `USE_SHARP = true`: resizes to 120×120 px JPEG via `sharp`, registers with
   *   `workbook.addImage()`, and places the thumbnail with `sheet.addImage()`.
   * - `USE_SHARP = false`: reads raw bytes with `fs.readFileSync()`, normalises
   *   `'jpg'` to `'jpeg'` for ExcelJS compatibility, and embeds without resizing.
   * In both cases the image ID is cached in `imageCache` (keyed by file path)
   * so each unique image is processed only once.
   *
   * Back-pressure is respected: the stream is paused while async image
   * compression runs and resumed immediately after.
   *
   * @returns {Promise<void>} Resolves after `workbook.xlsx.writeFile()` completes.
   * @throws {Error} If the JSON stream emits an error, or if a critical image
   *   operation fails outside the per-cell try/catch.
   */
  async generate() {
    console.log(`Starting Excel generation with Photos...`);
    const workbook = new ExcelJS.Workbook();
    const rawStream = chain([getStream(this.source), parser()]);
    let currentSheet = null, isTitleKey = false, inColumnsArr = false, inItemsArr = false, arrayDepth = 0, objAss = null;
    let currentColumns = [], currentGroupTitle = 'Sheet', counter = 0, currentGroupItemsProcessed = 0;
    const imageCache = new Map();

    await new Promise((resolve, reject) => {
      rawStream.on('data', async token => {
        try {
          if (!inColumnsArr && !inItemsArr) {
            if (token.name === 'keyValue' && token.value === 'title') { isTitleKey = true; return; }
            if (isTitleKey && token.name === 'stringValue') { currentGroupTitle = token.value; isTitleKey = false; return; }
          }
          if (token.name === 'keyValue' && token.value === 'columns') { inColumnsArr = true; objAss = new Assembler(); return; }
          if (inColumnsArr) { objAss.consume(token); if (objAss.done) { currentColumns = objAss.current; objAss = null; inColumnsArr = false; } return; }
          if (token.name === 'keyValue' && token.value === 'items') { inItemsArr = true; arrayDepth = 0; return; }
          if (inItemsArr) {
            if (token.name === 'startArray') { arrayDepth++; if (arrayDepth === 1) return; }
            if (token.name === 'endArray') { arrayDepth--; if (arrayDepth === 0) { inItemsArr = false; currentGroupItemsProcessed = 0; return; } }
            if (arrayDepth === 1 && token.name === 'startObject') { objAss = new Assembler(); objAss.consume(token); }
            else if (objAss) {
              objAss.consume(token);
              if (objAss.done) {
                rawStream.pause();
                const record = objAss.current; objAss = null;
                if (currentGroupItemsProcessed === 0) {
                  const keysExc = Object.keys(record); 
                  const excHeaders = keysExc.map((k, i) => { 
                    const col = (currentColumns && currentColumns[i]) ? currentColumns[i] : {}; 
                    return { header: col.title || k.replace(/_/g, ' ').toUpperCase(), key: k, width: 25 }; 
                  });
                  currentSheet = workbook.addWorksheet(currentGroupTitle.substring(0, 31)); 
                  currentSheet.columns = excHeaders; 
                  currentSheet.getRow(1).font = { bold: true };
                }
                const row = currentSheet.addRow(record); 
                row.height = 50;
                const entries = Object.entries(record);
                for (let idx = 0; idx < entries.length; idx++) {
                  const [key, value] = entries[idx];
                  const colInfo = currentColumns[idx] || {};
                  if (colInfo.type === 'image' && value && fs.existsSync(value)) {
                    try {
                      let imgId;
                      if (imageCache.has(value)) {
                        imgId = imageCache.get(value);
                      } else if (USE_SHARP) {
                        // --- sharp path: resize to thumbnail before embedding ---
                        const buffer = await sharp(value)
                          .resize(120, 120, { fit: 'inside' })
                          .jpeg({ quality: 75 })
                          .toBuffer();
                        imgId = workbook.addImage({ buffer, extension: 'jpeg' });
                        imageCache.set(value, imgId);
                      } else {
                        // --- no-sharp path: embed raw file bytes ---
                        const buffer = fs.readFileSync(value);
                        const ext = value.split('.').pop().toLowerCase();
                        // ExcelJS supports: jpeg, png, gif, bmp, tiff
                        const extension = ext === 'jpg' ? 'jpeg' : ext;
                        imgId = workbook.addImage({ buffer, extension });
                        imageCache.set(value, imgId);
                      }
                      currentSheet.addImage(imgId, { tl: { col: idx, row: row.number - 1 }, ext: { width: 60, height: 60 }, editAs: 'oneCell' });
                      row.getCell(idx + 1).value = "";
                    } catch (e) { 
                      row.getCell(idx + 1).value = "[Error]"; 
                    }
                  }
                }
                currentGroupItemsProcessed++; counter++; 
                if (counter % 1000 === 0) console.log(`Processed ${counter} records (Excel/Photos)...`);
                rawStream.resume();
              }
            }
          }
        } catch (e) { reject(e); }
      });
      rawStream.on('end', resolve); rawStream.on('error', reject);
    });
    await workbook.xlsx.writeFile(this.outputFileName);
    console.log(`Excel report with photos saved to ${this.outputFileName}`);
  }
}

module.exports = ExcelGenerator;
