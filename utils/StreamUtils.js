const fs = require('fs');
const { Readable } = require('stream');

function getStream(source) {
  if (!source) throw new Error("No data source provided.");
  if (typeof source === 'string' && fs.existsSync(source)) return fs.createReadStream(source);
  return Readable.from([source]);
}

const layoutConfig = {
  margins: { top: 30, bottom: 50, left: 30, right: 30 },
  tablePadding: 12, imageHeight: 40, rowGap: 4.2, footerHeight: 25,
  headerTitleSize: 14, themeColor: '#0066cc', secondaryColor: '#333333', dotColor: '#999999'
};

module.exports = { getStream, layoutConfig };
