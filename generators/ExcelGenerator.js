const fs = require('fs');
const ExcelJS = require('exceljs');
const { chain } = require('stream-chain');
const { parser } = require('stream-json');
const Assembler = require('stream-json/assembler.js');
const { getStream, USE_SHARP } = require('../utils/StreamUtils');
// sharp is only loaded when USE_SHARP is enabled to avoid native binary errors
const sharp = USE_SHARP ? require('sharp') : null;

class ExcelGenerator {
  constructor(source, outputFileName) { this.source = source; this.outputFileName = outputFileName; }
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
