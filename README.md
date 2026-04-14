# Temir Enterprise Report Generator

A high-performance, memory-efficient reporting system designed to generate PDF, Excel, and interactive HTML dashboards from massive JSON datasets (10GB+).

## 🚀 Key Features

### 1. Unified Generation Architecture
- **Streaming Pipeline**: Uses `stream-json` and `chain` to process data line-by-line. Never loads the entire dataset into memory.
- **Multicformat Support**: Generate high-quality PDFs, Excel spreadsheets with embedded photos, and interactive HTML dashboards using a single source.
- **Performance**: Capable of processing 100,000+ records with a fixed memory footprint (< 100MB RAM).

### 2. Advanced HTML Dashboard
- **Virtual Grid Architecture**: Instead of rendering 10,000+ DOM nodes, the dashboard uses "Just-In-Time" (JIT) rendering. Only the visible page slice (e.g., 50 rows) is ever present in the DOM.
- **Image Cache Optimization**: Reduces file size by up to 1400x. Images are base64-encoded once and reused via CSS classes across the entire dashboard.
- **Ultra-Fast Search**: Filtering happens directly in a native JavaScript data array, providing instantaneous results even with tens of thousands of records.
- **Zero-Latency Navigation**: Pagination and group switching are liquid-smooth because the browser only processes a small DocumentFragment for the current view.
- **Persistence**: Remembers user preferences (Theme, Sidebar State, Rows per page) using `localStorage`.

### 3. Professional PDF & Excel
- **PDF**: Automatic page numbering, group headers, and memory-efficient image embedding.
- **Excel**: High-speed row generation with support for embedded image thumbnails in cells.

---

## 📂 Project Structure
```text
temir-report/
├── generators/
│   ├── HtmlGenerator.js  # Virtual Grid & JIT engine
│   ├── PdfGenerator.js   # 2-pass streaming PDF engine
│   └── ExcelGenerator.js # Photo-enabled spreadsheet engine
├── utils/
│   └── StreamUtils.js    # Shared streaming & layout logic
├── index.js              # Main Facade & Entry point
└── data.json             # Large-scale data source
```

---

## 🛠 Usage

### Basic Implementation
```javascript
const { ReportGenerator } = require('./index.js');

(async () => {
  const generator = new ReportGenerator();
  
  await generator
    .source('data.json')           // Path to massive JSON source
    .setTitle("Executive Report")  // Global report title
    .type(ReportGenerator.HTML)    // 'html', 'pdf', or 'excel'
    .generate('report.html');      // Output filename
})();
```

### JSON Data Structure
The generator expects a JSON file with the following structure:
```json
[
  {
    "title": "Group Name",
    "columns": [
      { "title": "Name", "type": "text" },
      { "title": "Status", "type": "text" },
      { "title": "Photo", "type": "image" }
    ],
    "items": [
      { "name": "Item 1", "status": "Active", "photo": "./assets/img1.jpg" },
      ...
    ]
  }
]
```

---

## 🏗 Architecture Details

### Virtual Grid & JIT Rendering
The HTML generator no longer writes static `<tr>` tags for thousands of records. Instead:
1. It streams record data into `<script type="application/json">` chunks.
2. The client-side engine reassembles these chunks into a high-performance data model.
3. Only the metadata and visible rows are rendered into the DOM, keeping memory usage extremely low.

### Image Caching & Streaming
The `StreamingHtmlGenerator` implements a unique dual-pass caching mechanism:
1. It scans image paths and converts unique assets to Base64 in a `<style>` block.
2. These style blocks are injected between data chunks during streaming, maintaining the single-file portability.
3. The renderer maps the `className` from the data store to these cached styles for instant display.

---

## 📦 Dependencies
- `pdfkit`: For streaming PDF generation.
- `exceljs`: For high-speed Excel creation.
- `sharp`: For intelligent image compression & optimization.
- `stream-json` & `stream-chain`: For memory-efficient JSON parsing and processing.
- `fs`: Native file system streams.

---

## 📜 Professional Printing
The HTML dashboard includes a specific `@media print` CSS block that:
- Hides all navigation, filters, and interactive controls.
- Expands sections to their full height.
- Handles page breaks between groups automatically.
- Ensures the report looks like a professionally formatted document on paper/PDF.
