const fs = require('fs');
const { Readable } = require('stream');

/**
 * Global killswitch for sharp-based image processing.
 *
 * true  (default) — images are resized and compressed with sharp before
 *                   being embedded. Produces smaller output files and
 *                   requires the sharp native binary to be installed.
 *
 * false           — images are read from disk as-is and embedded without
 *                   any resizing or re-encoding. Useful when sharp is not
 *                   available (e.g. certain CI environments) or when you
 *                   want maximum generation speed and do not care about
 *                   output file size.
 */
const USE_SHARP = true;

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

module.exports = { getStream, layoutConfig, USE_SHARP };
