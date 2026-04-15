# Temir Enterprise Report Generator

> A high-performance, memory-efficient Node.js reporting engine that generates professional **PDF**, **Excel**, and **interactive HTML dashboards** from arbitrarily large JSON datasets — including 10 GB+ files — using a constant-memory streaming pipeline.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Project Structure](#project-structure)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Data Format](#data-format)
  - [Passing a JSON String directly](#passing-a-json-string-directly)
- [Output Formats](#output-formats)
- [Architecture Deep-Dive](#architecture-deep-dive)
- [Configuration Reference](#configuration-reference)
  - [USE_SHARP — Image Processing Flag](#use_sharp--image-processing-flag)
- [Dependencies](#dependencies)
- [Performance Notes](#performance-notes)
- [Troubleshooting](#troubleshooting)

---

## Overview

Temir Report Generator is built around a single core principle: **never load the entire dataset into memory**. It uses Node.js readable streams combined with `stream-json`'s token-level JSON parser to process each record one at a time, writing output incrementally. This means a 100 MB JSON file and a 10 GB JSON file are handled with exactly the same ~100 MB RAM footprint.

The entry-point (`index.js`) exposes a fluent `ReportGenerator` Facade that delegates to three specialized generators:

| Generator | Output | Strategy |
|---|---|---|
| `StreamingHtmlGenerator` | `.html` | Stream JSON → write HTML incrementally → inject base64 images via CSS |
| `StreamingPdfGenerator` | `.pdf` | 2-pass stream (dry-run layout → real render with TOC) |
| `ExcelGenerator` | `.xlsx` | Stream JSON → ExcelJS workbook built row-by-row |

---

## Key Features

### ⚡ Zero-Copy Streaming Pipeline
- Token-level JSON parsing via `stream-json` + `stream-chain` — no `JSON.parse()` of the whole file.
- Back-pressure is respected: the stream is paused while async image compression runs, then resumed.
- Constant memory footprint regardless of dataset size.

### 📊 Interactive HTML Dashboard
- **Virtual Grid / JIT Rendering** — data is embedded as JSON inside `<script type="application/json">` tags. The client-side engine renders only the visible page slice (e.g., 50 rows) into the DOM as a `DocumentFragment`. 10,000+ records produce zero layout thrash.
- **Instant Search** — filtering operates on the in-memory JavaScript array, not the DOM. Results appear as you type.
- **Smart Pagination** — configurable rows-per-page (10 / 25 / 50 / 100 / 250), persistent via `localStorage`.
- **Collapsible Sidebar Navigation** — auto-generated links for every data group. Sidebar collapsed state is persisted.
- **Dark / Light Theme** — toggle persisted via `localStorage`.
- **Image Embedding with CSS Caching** — images are compressed to WebP at 300×300 px / 80% quality with `sharp`, base64-encoded **once**, and injected as a CSS class. Subsequent rows referencing the same image reuse the class — reducing file size by up to **1400×** compared to per-row inline `src`.
- **Print Mode** — `@media print` block hides all UI chrome, expands all groups, and inserts page breaks between groups for professional paper output.

### 📄 Professional PDF Generation
- **2-Pass Architecture** — Pass 1 is a dry-run (no pixel output) that simulates layout and builds the `reportMap` (title → page range). Pass 2 renders the real document, using `reportMap` to build a clickable Table of Contents on page 1.
- **Dynamic Layout** — auto-switches to landscape for wide tables (> 7 columns), shrinks font size for very wide tables (> 12 columns, font drops to 6 pt).
- **PDF Outline** — `doc.outline.addItem()` populates the PDF bookmark panel in Acrobat/browsers.
- **Named Destinations & Hyperlinks** — each group section registers a named anchor; the TOC entries are clickable links (`goTo`). Every page footer contains a "Go To Table of Contents" hyperlink.
- **Rounded Table Borders**, separator lines, and professional typography (Helvetica / Helvetica-Bold).
- **Image support** — `pdfkit`'s `doc.image()` renders local image files directly into cells.

### 📑 Excel with Embedded Photos
- Each data group becomes a separate worksheet (name truncated to 31 chars per Excel's limit).
- Column headers are auto-generated from the `columns` metadata; first row is bold.
- `sharp` resizes image columns to 120×120 px JPEG at 75% quality before embedding via `workbook.addImage()`.
- Image deduplication cache — each unique file path is processed only once.
- Row height is fixed at 50 pt to accommodate image cells.

---

## Project Structure

```text
temir-report/
├── bin/
│   └── cli.js             # CLI entry point  (temir-report generate …)
├── generators/
│   ├── HtmlGenerator.js   # Streaming HTML + Virtual Grid engine
│   ├── PdfGenerator.js    # 2-pass streaming PDF + TOC engine
│   └── ExcelGenerator.js  # Streaming Excel + embedded photos engine
├── utils/
│   └── StreamUtils.js     # getStream() helper + shared PDF layout config
├── index.js               # ReportGenerator facade (programmatic API)
├── package.json
└── .gitignore
```

---

## Installation

**Prerequisites:** Node.js ≥ 18 and npm.

### As an npm package (recommended)

```bash
npm install temir-report
```

### Global CLI install

```bash
npm install -g temir-report

# Verify
temir-report --help
```

### From source

```bash
git clone https://github.com/merttopal7/temir-report.git
cd temir-report
npm install
```

> **Note:** `sharp` has native bindings and requires compilation tools (`node-gyp`). On Windows, install the [Visual C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) if the install fails.
>
> If you cannot install `sharp` (unsupported platform, restricted CI environment, etc.), set [`USE_SHARP = false`](#use_sharp--image-processing-flag) in `utils/StreamUtils.js`. Sharp will not be `require()`d at all and no gyp or native binary error will occur.

---

## Quick Start

### CLI (after global install)

```bash
# PDF
temir-report generate -s data.json -t pdf -o report.pdf -T "Q2 Executive Report"

# Excel
temir-report generate -s data.json -t excel -o report.xlsx

# HTML Dashboard
temir-report generate -s data.json -t html -o dashboard.html -T "Sales Dashboard"
```

### Programmatic API

```javascript
const ReportGenerator = require('temir-report');

(async () => {
  const generator = new ReportGenerator();

  // Generate an HTML Dashboard
  await generator
    .source('data.json')           // absolute or relative path to a JSON file
    .setTitle('Q2 Executive Report')
    .type(ReportGenerator.HTML)    // 'html' | 'pdf' | 'excel'
    .generate('report.html');

  // Generate a PDF
  await generator
    .source('data.json')
    .setTitle('Q2 Executive Report')
    .type(ReportGenerator.PDF)
    .generate('report.pdf');

  // Generate an Excel workbook
  await generator
    .source('data.json')
    .setTitle('Q2 Executive Report')
    .type(ReportGenerator.EXCEL)
    .generate('report.xlsx');
})();
```

### Run the built-in demo (from source only)

```bash
node index.js
```

This generates three files from `data.json` (must exist in the project root):
- `executive_report.html`
- `executive_report.pdf`
- `executive_report.xlsx`

### Use as a module — inline JSON string source

If the data is already in memory (e.g. fetched from an API, built programmatically, or small enough to hold in RAM), pass the **raw JSON string** directly to `.source()` instead of a file path. The generator detects that the value is not an existing file path and wraps it in a `Readable.from()` stream automatically.

```javascript
const ReportGenerator = require('./index.js');

(async () => {
  // Build or fetch your data as a plain JavaScript value
  const data = [
    {
      title: 'Sales Q2',
      columns: [
        { title: 'Region', type: 'text' },
        { title: 'Revenue', type: 'text' },
      ],
      items: [
        { region: 'North', revenue: '$1.2M' },
        { region: 'South', revenue: '$0.9M' },
      ],
    },
  ];

  // Serialize to a JSON string and pass it as the source
  const jsonString = JSON.stringify(data);

  await new ReportGenerator()
    .source(jsonString)            // ← raw JSON string, not a file path
    .setTitle('Sales Report')
    .type(ReportGenerator.HTML)
    .generate('sales_report.html');
})();
```

> **Note:** When passing a JSON string, the entire payload is held in memory. Only use this for datasets that comfortably fit in RAM. For large datasets (100 MB+) always prefer a file path so the streaming pipeline can process the data incrementally.

---

## CLI Reference

```
Usage: temir-report generate [options]

Options:
  --source,  -s  <path>    Path to JSON data source file  (required)
  --output,  -o  <path>    Output file path               (required)
  --type,    -t  <format>  pdf | excel | html             (default: pdf)
  --title,   -T  <string>  Report title                   (default: "Report")
  --help,    -h            Show this help message
```

---

## API Reference

### `new ReportGenerator(source?, options?)`

| Parameter | Type | Default | Description |
|---|---|---|---|
| `source` | `string` | `undefined` | File path **or raw JSON string**. Can be overridden with `.source()`. |
| `options` | `object` | `{}` | Optional layout overrides (see [Configuration Reference](#configuration-reference)). |

### Instance Methods (Fluent / Chainable)

| Method | Argument | Description |
|---|---|---|
| `.source(data)` | `string` | File path to a JSON file **or a raw serialized JSON string**. If the value is a path to an existing file, a read stream is opened; otherwise the string itself is streamed as-is. |
| `.setTitle(title)` | `string` | Set the global report title (used in HTML `<h1>`, PDF cover page). |
| `.type(format)` | `string` | Set output format. Use the static constants below. |
| `.generate(outputFileName)` | `string` | Trigger generation. Returns a `Promise<void>`. |

### Static Constants

```javascript
ReportGenerator.HTML  // → 'html'
ReportGenerator.PDF   // → 'pdf'
ReportGenerator.EXCEL // → 'excel'
```

---

## Data Format

The generator expects the data source to be a **JSON array of group objects**. Each group produces one HTML section, one PDF chapter, and one Excel worksheet.

```json
[
  {
    "title": "Employees",
    "columns": [
      { "title": "Photo",       "type": "image" },
      { "title": "Employee ID", "type": "text"  },
      { "title": "Full Name",   "type": "text"  },
      { "title": "Department",  "type": "text"  }
    ],
    "items": [
      {
        "photo":  "C:\\images\\emp001.png",
        "id":     1001,
        "name":   "Alice Johnson",
        "dept":   "Engineering"
      },
      {
        "photo":  "C:\\images\\emp002.png",
        "id":     1002,
        "name":   "Bob Smith",
        "dept":   "Finance"
      }
    ]
  },
  {
    "title": "Products",
    "columns": [
      { "title": "SKU",   "type": "text" },
      { "title": "Name",  "type": "text" },
      { "title": "Price", "type": "text" }
    ],
    "items": [
      { "sku": "P-001", "name": "Widget A", "price": "$9.99" }
    ]
  }
]
```

### Field Reference

| Field | Required | Description |
|---|---|---|
| `title` | ✅ | Group/section name. Used as the HTML section ID, PDF chapter anchor, and Excel sheet name. |
| `columns` | ✅ | Array of column descriptors. Order must match the keys in `items` records. |
| `columns[].title` | ✅ | Display name rendered in table headers. |
| `columns[].type` | ✅ | `"text"` for plain values, `"image"` to treat the value as a local absolute file path and embed the image. |
| `items` | ✅ | Array of record objects. Keys must appear in the same positional order as `columns`. |

> **Important for image columns:** The value must be an **absolute filesystem path** to an image file that exists at generation time (e.g., `C:\\Users\\me\\photos\\avatar.png`). Relative paths and URLs are not supported.

### Passing a JSON String directly

The `.source()` method accepts either a **file path** or a **serialized JSON string**. The decision is made by `utils/StreamUtils.js → getStream()`:

```javascript
function getStream(source) {
  // If the value is a path to an existing file → open a read stream (memory-efficient)
  if (typeof source === 'string' && fs.existsSync(source)) return fs.createReadStream(source);
  // Otherwise treat the value as raw content and wrap it in a readable stream
  return Readable.from([source]);
}
```

| Source type | How it is handled | Best for |
|---|---|---|
| File path (`'data.json'`) | `fs.createReadStream()` — reads the file chunk by chunk | Large files, 10 GB+ datasets |
| JSON string (`'[{"title":…}]'`) | `Readable.from([string])` — the whole string is in RAM | Small datasets, API responses, test fixtures |

---

## Output Formats

### HTML Dashboard

The HTML output is a single self-contained file (no external assets). Open it in any modern browser.

**UI Features:**
| Feature | Details |
|---|---|
| Sidebar Navigation | Auto-built from group titles. Collapsible (icon-only mode). |
| Search | Real-time search within the active group's data. |
| Pagination | Previous / Next buttons with configurable rows-per-page dropdown. |
| Dark Mode | Toggle in the top-right header. Remembered across page reloads. |
| Print | Use `Ctrl+P` (or browser print). UI chrome is hidden; groups paginate naturally. |

**Performance Characteristics:**
| Dataset Size | DOM Nodes at Any Time | Memory Usage |
|---|---|---|
| 1,000 records | ~50 rows (one page) | Minimal |
| 100,000 records | ~50 rows (one page) | Minimal |
| 1,000,000 records | ~50 rows (one page) | Proportional to data array |

### PDF Report

The PDF begins with a **Table of Contents** page listing each group with its page range and a clickable navigation link. Every subsequent page has:
- A group title header (printed on first occurrence per page)
- A page number footer with a "Go To Table of Contents" link
- The PDF bookmark panel is fully populated

**Layout Rules:**
| Condition | Behavior |
|---|---|
| ≤ 7 columns | Portrait A4 layout |
| > 7 columns | Landscape A4 layout |
| > 12 columns | Font size reduced to 6 pt |
| Image column | Image rendered inline in the PDF cell |

### Excel Workbook

Each group in the JSON becomes a separate worksheet. Sheet names are limited to 31 characters (Excel constraint). Image columns render as embedded thumbnail photos (60×60 px in the cell).

---

## Architecture Deep-Dive

### Streaming Pipeline (`utils/StreamUtils.js`)

```
JSON file on disk
      │
      ▼
fs.createReadStream()   ← or Readable.from(string)
      │
      ▼
stream-json parser()    ← emits token objects: startObject, keyValue, stringValue, endArray, …
      │
      ▼
stream-chain chain()    ← composes transforms
      │
      ▼
Generator data handler  ← consumes tokens one at a time
```

**Token handling state machine (all three generators share this pattern):**

```
root array
├── object (group)
│   ├── key "title"    → capture group title
│   ├── key "columns"  → assemble full columns array with Assembler
│   └── key "items"
│       └── array
│           └── object (record) → assemble with Assembler → process → write output
└── … next group
```

`stream-json`'s `Assembler` is used for `columns` and each `items` record because they are small enough to fully buffer in memory, while the outer array (which could contain millions of records) is never buffered.

---

### HTML Generator (`generators/HtmlGenerator.js`)

**Server-side (generation time):**

1. Open write stream to output file.
2. Write the complete HTML shell (DOCTYPE → `<body>`), CSS, and static sidebar markup.
3. For each record:
   - If it's the first record in a group: write the `<section>`, table headers, `<tbody>`, and open a `<script type="application/json">` block.
   - For image columns: compress with `sharp` → WebP 300×300 / quality 80 → base64 → inject as a `<style>` block with a unique CSS class (`.img-asset-N`). Close and re-open the `<script>` block to preserve streaming structure.
   - Write the record as a JSON array element inside the `<script>` block.
   - Pause the stream, process the record, then resume.
4. Close the final `</script></section>`, write the client-side JavaScript, close `</body></html>`.

**Client-side (browser runtime):**

```javascript
// Data reassembly: multiple <script> chunks are joined (split by <style> injections)
const chunks    = group.querySelectorAll('.group-data-store');
const rawData   = JSON.parse(chunks.map(c => c.textContent).join(''));

// Rendering: only the visible page slice is ever in the DOM
const slice     = filteredData.slice(start, end);
const fragment  = document.createDocumentFragment();
slice.forEach(record => {
  const tr = document.createElement('tr');
  record.forEach(cell => {
    const td = document.createElement('td');
    if (cell?.isImg) {
      const img = document.createElement('img');
      img.className = cell.className; // e.g. "img-asset-3" → CSS provides the image
      img.loading   = 'lazy';
      td.appendChild(img);
    } else {
      td.textContent = cell;
    }
    tr.appendChild(td);
  });
  fragment.appendChild(tr);
});
tbody.innerHTML = '';
tbody.appendChild(fragment); // single reflow
```

---

### PDF Generator (`generators/PdfGenerator.js`)

**Pass 1 — Dry Run (`isReal: false`)**

- Creates a `PDFDocument` that is never piped to disk.
- Simulates all layout operations (draw headers, draw rows, page breaks) to calculate the exact page span of each group.
- Stores `{ title, startPage, endPage }` in `reportMap`.

**Pass 2 — Real Render (`isReal: true`)**

- Creates the final `PDFDocument`, pipes it to the output file.
- Page 1: title + TOC from `reportMap` with clickable `goTo` links.
- Pages 2+: streams through the JSON again, rendering actual content.
- Guard in `_performDrawRow`: if the next row would overflow the page, close the current table border, draw the footer, call `doc.addPage()`, and re-draw the column headers.

**Key PDFKit methods used:**

| Method | Purpose |
|---|---|
| `doc.addNamedDestination(anchor)` | Register a named jump target |
| `doc.outline.addItem(label)` | Add entry to PDF bookmark panel |
| `doc.text(..., { goTo: anchor })` | Render text as a hyperlink |
| `doc.text(..., { continued: true })` | Continue on same line |
| `doc.image(path, x, y, { fit })` | Embed local image |
| `doc.roundedRect(...).stroke()` | Draw table border |
| `doc.addPage({ layout })` | Add page with portrait/landscape |

---

### Excel Generator (`generators/ExcelGenerator.js`)

- Uses `ExcelJS.Workbook` (streaming-compatible API).
- Worksheets are added on demand as each group's first record is encountered.
- `workbook.addImage({ buffer, extension })` registers the compressed image buffer; `sheet.addImage(imgId, { tl, ext })` places it in the cell at a precise column/row anchor.
- After all groups are processed, `workbook.xlsx.writeFile(outputFileName)` serializes the workbook asynchronously.

---

## Configuration Reference

Pass an `options` object to `new ReportGenerator(source, options)` to override the PDF layout defaults (defined in `utils/StreamUtils.js`):

| Option | Default | Description |
|---|---|---|
| `reportTitle` | `'Global Report Title'` | Title shown on the PDF cover page and HTML `<h1>`. |
| `margins.top` | `30` | PDF page top margin (points). |
| `margins.bottom` | `50` | PDF page bottom margin (points). |
| `margins.left` | `30` | PDF page left margin (points). |
| `margins.right` | `30` | PDF page right margin (points). |
| `tablePadding` | `12` | Inner padding (points) within table cells and borders. |
| `imageHeight` | `40` | Max height (points) for image cells in PDF. |
| `rowGap` | `4.2` | Vertical gap added after each row in PDF. |
| `footerHeight` | `25` | Height reserved for the page footer area. |
| `headerTitleSize` | `14` | Font size (pt) for group title headings in PDF. |
| `themeColor` | `'#0066cc'` | Primary accent color (hyperlinks, active nav, TOC links). |
| `secondaryColor` | `'#333333'` | Secondary text color (footer page numbers, TOC ranges). |
| `dotColor` | `'#999999'` | Color of the dot leader in the PDF TOC. |

**Example:**
```javascript
const generator = new ReportGenerator('data.json', {
  reportTitle:  'Annual Financial Report',
  themeColor:   '#1a472a',
  margins:      { top: 40, bottom: 60, left: 40, right: 40 },
  tablePadding: 8,
});
await generator.type('pdf').generate('financial_report.pdf');
```

---

### `USE_SHARP` — Image Processing Flag

Defined in `utils/StreamUtils.js`. It is the **single place** to control whether `sharp` is used anywhere in the project.

```javascript
// utils/StreamUtils.js
const USE_SHARP = true; // ← change to false to disable sharp entirely
```

| Value | Behaviour |
|---|---|
| `true` *(default)* | `sharp` is `require()`d and used to resize + compress images before embedding. Produces the smallest output files. Requires the `sharp` native binary (node-gyp). |
| `false` | `sharp` is **never loaded** — no `require('sharp')` call is made at all. Images are read from disk with `fs.readFileSync()` and embedded as-is. No native binary or node-gyp involvement. |

**Per-generator behaviour when `USE_SHARP = false`:**

| Generator | Image handling without sharp |
|---|---|
| `HtmlGenerator` | Raw file bytes → base64 → CSS `content: url("data:image/ext;base64,…")`. The CSS class deduplication cache still applies. |
| `ExcelGenerator` | Raw file bytes transferred directly to `workbook.addImage()`. Extension is inferred from the file name (`jpg` is normalized to `jpeg` for ExcelJS). |
| `PdfGenerator` | **Unaffected** — PDFKit's `doc.image()` reads local files natively and never calls `sharp`. |

**When to set `USE_SHARP = false`:**
- Your environment cannot compile native Node.js addons (restricted CI, certain Docker images, shared hosting).
- You are running on an architecture not supported by the current `sharp` release.
- Generation speed is more important than output file size.
- You are working with images that are already correctly sized and do not need resizing.

> ⚠️ **File size warning:** Embedding uncompressed images significantly increases the size of `.html` and `.xlsx` outputs. A single 4 MB PNG will add 4 MB to the report versus ~30 KB when processed by sharp.

---

## Dependencies

| Package | Version | Role |
|---|---|---|
| [`pdfkit`](https://pdfkit.org/) | `^0.18.0` | PDF document generation with native streaming support |
| [`exceljs`](https://github.com/exceljs/exceljs) | `^4.4.0` | Excel `.xlsx` creation with image embedding |
| [`sharp`](https://sharp.pixelplumbing.com/) | `^0.34.5` | High-performance image resizing and WebP/JPEG compression |
| [`stream-json`](https://github.com/uhop/stream-json) | `^2.1.0` | Token-level streaming JSON parser (no full parse) |
| [`stream-chain`](https://github.com/uhop/stream-chain) | `^3.6.1` | Utility to compose Node.js transform streams |

All runtime dependencies are listed in `package.json`. Node.js built-in modules (`fs`, `stream`) require no installation.

---

## Performance Notes

- **Memory**: Fixed at roughly the size of one record plus one compressed image buffer. The outer dataset array is never held in memory.
- **CPU**: Image compression (`sharp`) is the most CPU-intensive step. It runs asynchronously but the stream is paused during compression to prevent out-of-order writes. For datasets with thousands of unique images, generation time is dominated by this step.
- **Image Caching**: Both the HTML and Excel generators use a `Map` keyed by file path. Each unique image path is compressed exactly once; subsequent references reuse the cached class name or buffer ID.
- **PDF 2-Pass Overhead**: The dry run re-reads the entire JSON file. For very large files over slow disks, this doubles I/O time. This is a trade-off for an accurate TOC with correct page numbers.
- **Throughput Benchmark** (approximate, hardware-dependent):
  - Text-only data: **~50,000 records/second**
  - Data with many unique images: **~500–2,000 records/second** (bottlenecked by `sharp`)

---

## Troubleshooting

### `Error: No data source provided.`
You called `.generate()` without first calling `.source(path)` or passing a source to the constructor.

### `sharp` install fails on Windows
Install Visual C++ Build Tools:
```powershell
npm install --global windows-build-tools
```
Or install the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) package.

### Images not appearing in output
- Confirm the path in your JSON is an **absolute path** to a file that exists.
- The path must use escaped backslashes on Windows: `"C:\\Users\\me\\photo.png"`.
- The generator logs `[Img Error]` / uses a fallback when `sharp` fails; check the console for errors.

### PDF TOC page numbers are wrong
This should not happen with the 2-pass architecture, but if it does, verify that `layoutConfig.margins` are the same between both passes (they must be — both use the same `this.layout` object).

### Excel sheet names are truncated
Excel limits sheet names to 31 characters. The generator calls `.substring(0, 31)` on the group title. If two groups produce the same 31-character prefix, ExcelJS will throw a duplicate sheet name error. Ensure group titles are unique in the first 31 characters.

### Out-of-memory crash
This indicates the stream back-pressure is not being respected, or there is a very large single record (e.g., a 500 MB base64 string in one field). The generators are designed for typical tabular records with external image file paths, not for records with giant inline payloads.

---

## License

MIT
