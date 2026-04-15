const fs = require('fs');
const { chain } = require('stream-chain');
const { parser } = require('stream-json');
const Assembler = require('stream-json/assembler.js');
const { getStream, USE_SHARP } = require('../utils/StreamUtils');
// sharp is only loaded when USE_SHARP is enabled to avoid native binary errors
const sharp = USE_SHARP ? require('sharp') : null;

/**
 * Generates a self-contained, interactive HTML dashboard from a streaming JSON source.
 *
 * The output is a single `.html` file with no external dependencies. All CSS,
 * JavaScript, and images are embedded inline. It supports:
 *   - **Dark / Light theme** — toggled in the UI, persisted via `localStorage`.
 *   - **Collapsible sidebar** — auto-populated navigation links for every group.
 *   - **Virtual grid / JIT rendering** — only the visible page slice (default: 50 rows)
 *     is ever written to the DOM, keeping the browser responsive even for 100,000+ records.
 *   - **Real-time search** — filters operate on the in-memory JS array, not the DOM.
 *   - **Smart pagination** — configurable rows-per-page (10/25/50/100/250), persisted.
 *   - **Print mode** — `@media print` hides UI chrome and paginates groups for paper output.
 *
 * **Image compression strategy (server-side, at generation time):**
 * When `USE_SHARP` is `true`, each unique image path is compressed once to WebP
 * at 300×300 px / 80% quality, base64-encoded, and injected as a CSS class
 * (`.img-asset-N { content: url("data:image/webp;base64,...") }`). The class name
 * is then embedded in the JSON data for that row. All subsequent rows referencing
 * the same file reuse the same CSS class — the image bytes are in the document
 * only once. This can reduce file size by up to 1400× compared to per-row inline `src`.
 *
 * When `USE_SHARP` is `false`, the raw file bytes are base64-encoded directly
 * and embedded using the original file extension as the MIME type.
 *
 * **Script-splitting trick:**
 * Because image `<style>` blocks must be injected between JSON chunks inside a
 * `<script type="application/json">` tag (which the browser treats as opaque text),
 * the generator closes the active `<script>` tag, writes the `<style>` block, then
 * immediately opens a new `<script class="group-data-store">` to continue the JSON
 * stream. The client-side bootstrap reassembles all chunks by joining their
 * `textContent` before calling `JSON.parse()`.
 */
class StreamingHtmlGenerator {
    /**
     * @param {string} source          - File path or serialized JSON string (see `utils/StreamUtils.getStream`).
     * @param {string} outputFileName  - Destination `.html` file path.
     * @param {object} [options={}]    - Generator options.
     * @param {string} [options.reportTitle='Streaming Report']
     *   Title shown in the browser tab (`<title>`) and top-navigation `<h1>`.
     */
    constructor(source, outputFileName, options = {}) {
        this.source = source;
        this.outputFileName = outputFileName;
        this.reportTitle = options.reportTitle || 'Streaming Report';
        /** @type {Map<string, string|null>} Maps absolute image file paths to their assigned CSS class name. */
        this.imageCache = new Map();
        /** @type {number} Monotonically increasing counter used to generate unique CSS class names. */
        this.imageOrderId = 0;
    }

    /**
     * Runs the streaming HTML generation pipeline and writes the output file.
     *
     * **Server-side pipeline (generation time):**
     * 1. Opens a `WriteStream` to `this.outputFileName`.
     * 2. Writes the HTML shell: `<!DOCTYPE html>`, `<head>` with all CSS, and
     *    the static `<aside>` sidebar and `<header>` markup.
     * 3. Streams the JSON source token-by-token via `stream-json` + `stream-chain`.
     *    For each group:
     *    - On the first record: writes the `<section>`, table headers, and opens
     *      a `<script type="application/json">` data store tag.
     *    - For every record: serialises the row as a JSON array element. Image
     *      columns are compressed (or read raw) and injected as CSS classes using
     *      the script-splitting technique; cell values are replaced with
     *      `{ isImg: true, className: 'img-asset-N' }` descriptors.
     *    - On group end: closes the `</script></section>` block.
     * 4. Writes the client-side `<script>` bootstrap (virtual grid engine, search,
     *    pagination, theme/sidebar persistence) and closes `</body></html>`.
     *
     * **Back-pressure:** The stream is paused before any async `sharp` call and
     * resumed immediately after, preventing out-of-order writes.
     *
     * @returns {Promise<void>} Resolves when `out.end()` has been called and all
     *   bytes have been written to disk.
     * @throws {Error} If the JSON stream emits an error or an image read fails
     *   outside of the per-cell try/catch guard.
     */
    async generate() {
        console.log("Starting Streaming HTML generation with Nav & Page Control...");
        const out = fs.createWriteStream(this.outputFileName);
        out.write(`<!DOCTYPE html>
<html>
<head>
    <title>${this.reportTitle}</title>
    <style>
        :root { 
            --primary: #0066cc; 
            --bg: #f8fafc; 
            --card: #ffffff; 
            --text: #1e293b; 
            --text-light: #64748b;
            --border: #e2e8f0; 
            --sidebar-width: 280px; 
            --sidebar-collapsed: 80px;
            --header-bg: #ffffff;
            --table-hover: #fbfcfe;
            --hover-bg: #f1f5f9;
        }
        
        [data-theme="dark"] {
            --bg: #0f172a;
            --card: #1e293b;
            --text: #f1f5f9;
            --text-light: #94a3b8;
            --border: #334155;
            --header-bg: #1e293b;
            --table-hover: #1e293b;
            --hover-bg: #334155;
        }

        * { box-sizing: border-box; }
        body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; display: flex; height: 100vh; overflow: hidden; transition: background 0.3s; }
        
        /* Sidebar Styles */
        aside { 
            width: var(--sidebar-width); 
            background: var(--card); 
            border-right: 1px solid var(--border); 
            height: 100vh; 
            padding: 24px 16px; 
            display: flex; 
            flex-direction: column; 
            flex-shrink: 0; 
            transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
        }
        body.collapsed aside { width: var(--sidebar-collapsed); }
        
        .logo-area { display: flex; align-items: center; gap: 12px; margin-bottom: 32px; overflow: hidden; white-space: nowrap; }
        .logo-icon { width: 40px; height: 40px; background: var(--primary); border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .logo-text { font-size: 1.15rem; font-weight: 800; color: var(--text); padding-right: 20px; }
        body.collapsed .logo-text { opacity: 0; pointer-events: none; }
        
        aside h2 { font-size: 0.65rem; text-transform: uppercase; color: var(--text-light); letter-spacing: 0.1em; margin-bottom: 12px; padding-left: 12px; overflow: hidden; white-space: nowrap; transition: 0.2s; }
        body.collapsed aside h2 { opacity: 0; }
        
        #sidebar-nav { flex: 1; overflow-y: auto; overflow-x: hidden; }
        #sidebar-nav a { display: flex; align-items: center; gap: 12px; padding: 12px; color: var(--text-light); text-decoration: none; border-radius: 10px; font-size: 0.9rem; margin-bottom: 4px; transition: all 0.2s; white-space: nowrap; border: 1px solid transparent; }
        #sidebar-nav a:hover { background: var(--hover-bg); color: var(--primary); }
        #sidebar-nav a.active { background: #eff6ff; color: var(--primary); font-weight: 600; border-color: #dbeafe; }
        [data-theme="dark"] #sidebar-nav a.active { background: #1e293b; border-color: var(--primary); }
        
        .nav-icon { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        body.collapsed #sidebar-nav a { padding: 12px 14px; }
        body.collapsed .nav-text { opacity: 0; pointer-events: none; width: 0; }
        
        /* Main Content Styles */
        main { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; background: var(--bg); }
        
        .top-nav { height: 72px; padding: 0 40px; border-bottom: 1px solid var(--border); background: var(--header-bg); display: flex; justify-content: space-between; align-items: center; z-index: 50; }
        .nav-controls-left { display: flex; align-items: center; gap: 20px; }
        .nav-controls-right { display: flex; align-items: center; gap: 24px; }
        
        .icon-btn { width: 40px; height: 40px; border: 1px solid var(--border); background: var(--card); border-radius: 10px; cursor: pointer; color: var(--text); display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
        .icon-btn:hover { background: var(--hover-bg); border-color: var(--primary); }
        
        h1 { margin: 0; color: var(--text); font-size: 1.15rem; font-weight: 800; letter-spacing: -0.01em; }
        
        .content-body { flex: 1; position: relative; overflow: hidden; padding: 24px; }
        section.report-group { position: absolute; inset: 24px; display: none; flex-direction: column; background: var(--card); border-radius: 16px; border: 1px solid var(--border); box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); overflow: hidden; }
        section.report-group.active { display: flex; }
        
        .group-header { padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; background: var(--card); border-bottom: 1px solid var(--border); }
        h2.section-title { margin: 0; font-size: 1rem; color: var(--text); font-weight: 700; display: flex; align-items: center; gap: 12px; }
        .record-count { font-size: 0.7rem; font-weight: 600; color: var(--primary); background: rgba(0, 102, 204, 0.1); padding: 4px 10px; border-radius: 6px; }
        
        .search-wrap { position: relative; width: 280px; }
        .search-input { width: 100%; padding: 8px 12px 8px 36px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-size: 0.85rem; outline: none; transition: border-color 0.2s; }
        .search-input:focus { border-color: var(--primary); }
        .search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-light); pointer-events: none; }

        .table-container { flex: 1; overflow: auto; }
        table { width: 100%; border-collapse: separate; border-spacing: 0; }
        th { text-align: left; padding: 14px 24px; background: var(--card); font-weight: 600; text-transform: uppercase; font-size: 0.7rem; color: var(--text-light); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; box-shadow: inset 0 -1px 0 var(--border); }
        td { padding: 14px 24px; border-bottom: 1px solid var(--border); font-size: 0.85rem; color: var(--text); transition: background 0.15s; }
        tr:hover td { background: var(--table-hover); }
        .img-cell img { width: 44px; height: 44px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); }
        
        /* Pagination Bar */
        .pagination-bar { padding: 16px 24px; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--card); }
        .pagination-left { display: flex; align-items: center; }
        .page-btn { padding: 8px 14px; border: 1px solid var(--border); background: var(--card); border-radius: 6px; cursor: pointer; font-size: 0.8rem; font-weight: 600; color: var(--text); transition: all 0.2s; display: flex; align-items: center; gap: 6px; }
        .page-btn:hover:not(:disabled) { border-color: var(--primary); background: var(--hover-bg); }
        .page-btn:disabled { opacity: 0.3; cursor: not-allowed; }
        .page-info { font-size: 0.8rem; color: var(--text-light); min-width: 100px; text-align: center; font-weight: 500; }
        
        .page-size-wrap { display: flex; align-items: center; gap: 10px; }
        .page-size-select { padding: 8px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); color: var(--text); font-size: 0.8rem; font-weight: 600; cursor: pointer; outline: none; }
        .page-size-select:focus { border-color: var(--primary); }

        /* Theming Icons */
        .sun-icon { display: block; }
        .moon-icon { display: none; }
        [data-theme="dark"] .sun-icon { display: none; }
        [data-theme="dark"] .moon-icon { display: block; }

        @media print { body { height: auto; overflow: visible; } aside, .top-nav, .group-header .search-wrap { display: none; } main { height: auto; display: block; overflow: visible; } section.report-group { position: static; display: block; height: auto; page-break-after: always; border: none; } .pagination-bar { display: none; } }
    </style>
</head>
<body>
    <aside id="main-sidebar">
        <div class="logo-area">
            <div class="logo-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
            </div>
            <span class="logo-text"></span>
        </div>
        
        <h2>Reports</h2>
        <nav id="sidebar-nav"></nav>
        
        <div style="margin-top: auto; padding-top: 20px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 10px;">
           <div style="font-size: 0.65rem; color: var(--text-light); font-weight: 700;">Report</div>
        </div>
    </aside>
    <main>
        <div class="top-nav">
            <div class="nav-controls-left">
                <button class="icon-btn" id="sidebar-toggle">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                </button>
                <h1>${this.reportTitle}</h1>
            </div>
            <div class="nav-controls-right">
                <div class="page-size-wrap">
                    <span style="font-size: 0.75rem; color: var(--text-light); font-weight: 600;">ROWS PER PAGE</span>
                    <select id="global-page-size" class="page-size-select">
                        <option value="10">10</option>
                        <option value="25">25</option>
                        <option value="50" selected>50</option>
                        <option value="100">100</option>
                        <option value="250">250</option>
                    </select>
                </div>
                <div style="width: 1px; height: 32px; background: var(--border);"></div>
                <button class="icon-btn" id="theme-toggle">
                    <span class="sun-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></span>
                    <span class="moon-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></span>
                </button>
            </div>
        </div>
        <div class="content-body" id="main-content">
`);

        const rawStream = chain([getStream(this.source), parser()]);
        let isTitleKey = false, inColumnsArr = false, inItemsArr = false, arrayDepth = 0, objAss = null;
        let currentColumns = [], currentGroupTitle = 'Group', counter = 0, currentGroupItemsProcessed = 0;

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
                        if (token.name === 'endArray') {
                            arrayDepth--;
                            if (arrayDepth === 0) {
                                inItemsArr = false;
                                out.write(`]</script></section>`);
                                currentGroupItemsProcessed = 0; return;
                            }
                        }
                        if (arrayDepth === 1 && token.name === 'startObject') { objAss = new Assembler(); objAss.consume(token); }
                        else if (objAss) {
                            objAss.consume(token);
                            if (objAss.done) {
                                rawStream.pause();
                                const record = objAss.current; objAss = null;
                                if (currentGroupItemsProcessed === 0) {
                                    const keys = Object.keys(record);
                                    out.write(`
<section id="${currentGroupTitle.replace(/\s+/g, '_')}" class="report-group" data-title="${currentGroupTitle}">
    <div class="group-header">
        <h2 class="section-title">${currentGroupTitle} <span class="record-count">Loading...</span></h2>
        <div class="search-wrap">
            <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" class="search-input" placeholder="Search records...">
        </div>
    </div>
    <div class="table-container">
        <table>
            <thead><tr>`);
                                    keys.forEach((k, i) => {
                                        const col = (currentColumns && currentColumns[i]) ? currentColumns[i] : {};
                                        out.write(`<th>${col.title || k.replace(/_/g, ' ').toUpperCase()}</th>`);
                                    });
                                    out.write(`</tr></thead><tbody></tbody></table></div>
      <div class="pagination-bar"></div>
      <script class="group-data-store" type="application/json">[`);
                                }

                                const rowData = [];
                                const entries = Object.entries(record);
                                for (let idx = 0; idx < entries.length; idx++) {
                                    const [key, value] = entries[idx];
                                    const colInfo = currentColumns[idx] || {};
                                    if (colInfo.type === 'image' && value && fs.existsSync(value)) {
                                        if (!this.imageCache.has(value)) {
                                            this.imageOrderId++;
                                            const imgClass = `img-asset-${this.imageOrderId}`;

                                            if (USE_SHARP) {
                                                // --- sharp path: resize + convert to WebP ---
                                                try {
                                                    const compressed = await sharp(value)
                                                        .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
                                                        .webp({ quality: 80 })
                                                        .toBuffer();
                                                    const b64 = compressed.toString('base64');
                                                    out.write(`</script><style>.${imgClass} { content: url("data:image/webp;base64,${b64}"); }</style><script class="group-data-store" type="application/json">`);
                                                    this.imageCache.set(value, imgClass);
                                                } catch (sErr) {
                                                    const b64Raw = fs.readFileSync(value).toString('base64');
                                                    const ext = value.split('.').pop();
                                                    out.write(`</script><style>.${imgClass} { content: url("data:image/${ext};base64,${b64Raw}"); }</style><script class="group-data-store" type="application/json">`);
                                                    this.imageCache.set(value, imgClass);
                                                }
                                            } else {
                                                // --- no-sharp path: embed raw file bytes ---
                                                try {
                                                    const b64Raw = fs.readFileSync(value).toString('base64');
                                                    const ext = value.split('.').pop().toLowerCase();
                                                    out.write(`</script><style>.${imgClass} { content: url("data:image/${ext};base64,${b64Raw}"); }</style><script class="group-data-store" type="application/json">`);
                                                    this.imageCache.set(value, imgClass);
                                                } catch (readErr) {
                                                    // file unreadable — skip image embedding for this path
                                                    this.imageCache.set(value, null);
                                                }
                                            }
                                        }
                                        const registeredClass = this.imageCache.get(value);
                                        rowData.push({ isImg: true, className: registeredClass });
                                    } else {
                                        rowData.push(value ?? '');
                                    }
                                }

                                out.write((currentGroupItemsProcessed > 0 ? ',' : '') + JSON.stringify(rowData));

                                currentGroupItemsProcessed++; counter++;
                                if (counter % 1000 === 0) console.log(`Processed ${counter} records (HTML)...`);
                                rawStream.resume();
                            }
                        }
                    }
                } catch (err) { reject(err); }
            });
            rawStream.on('end', resolve);
            rawStream.on('error', reject);
        });

        // Write Final Script with Virtual Rendering & Persistence
        out.write(`</script>
    </div>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const sidebarNav = document.getElementById('sidebar-nav');
            const globalSelector = document.getElementById('global-page-size');
            const themeToggle = document.getElementById('theme-toggle');
            const sidebarToggle = document.getElementById('sidebar-toggle');
            const groups = document.querySelectorAll('.report-group');
            
            const groupControllers = [];
            let activeId = null;

            // Load Persistent Settings
            const savedTheme = localStorage.getItem('theme') || 'light';
            document.documentElement.setAttribute('data-theme', savedTheme);
            
            const savedSidebar = localStorage.getItem('sidebar-collapsed') === 'true';
            if (savedSidebar) document.body.classList.add('collapsed');

            const savedPageSize = localStorage.getItem('page-size') || '50';
            globalSelector.value = savedPageSize;

            themeToggle.onclick = () => {
                const current = document.documentElement.getAttribute('data-theme');
                const next = current === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', next);
                localStorage.setItem('theme', next);
            };

            sidebarToggle.onclick = () => {
                document.body.classList.toggle('collapsed');
                localStorage.setItem('sidebar-collapsed', document.body.classList.contains('collapsed'));
            };

            globalSelector.onchange = () => {
                localStorage.setItem('page-size', globalSelector.value);
                groupControllers.forEach(c => c.reset());
            };

            function switchToGroup(id) {
                groupControllers.forEach(c => {
                    if (c.id === id) c.activate();
                    else c.deactivate();
                });
                activeId = id;
            }

            groups.forEach((group, index) => {
                const title = group.dataset.title;
                const id = group.id;
                const tbody = group.querySelector('tbody');
                const countSpan = group.querySelector('.record-count');
                const paginationBar = group.querySelector('.pagination-bar');
                const searchInput = group.querySelector('.search-input');
                
                // DATA REASSEMBLY: Collect all chunks split by style tags
                const chunks = Array.from(group.querySelectorAll('.group-data-store'));
                const fullJsonString = chunks.map(c => c.textContent).join('');
                const rawData = JSON.parse(fullJsonString);
                
                let filteredData = rawData;
                let currentPage = 1;

                const navLink = document.createElement('a');
                navLink.href = '#' + id;
                navLink.innerHTML = \`<span class="nav-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2zM6 6h3M6 10h12M6 14h12M6 18h3"/></svg></span><span class="nav-text">\${title}</span>\`;
                navLink.addEventListener('click', (e) => { e.preventDefault(); switchToGroup(id); });
                sidebarNav.appendChild(navLink);

                const controller = {
                    id: id,
                    renderPage: (dataSlice) => {
                        const fragment = document.createDocumentFragment();
                        dataSlice.forEach(record => {
                            const tr = document.createElement('tr');
                            record.forEach(cell => {
                                const td = document.createElement('td');
                                if (cell && typeof cell === 'object' && cell.isImg) {
                                    td.className = 'img-cell';
                                    const img = document.createElement('img');
                                    img.className = cell.className;
                                    img.loading = 'lazy';
                                    img.decoding = 'async';
                                    td.appendChild(img);
                                } else {
                                    td.textContent = cell || '';
                                }
                                tr.appendChild(td);
                            });
                            fragment.appendChild(tr);
                        });
                        tbody.innerHTML = '';
                        tbody.appendChild(fragment);
                    },
                    update: () => {
                        const pageSize = parseInt(globalSelector.value);
                        const pageCount = Math.ceil(filteredData.length / pageSize);
                        if (currentPage > pageCount) currentPage = 1;

                        const start = (currentPage - 1) * pageSize;
                        const end = start + pageSize;
                        const slice = filteredData.slice(start, end);
                        
                        controller.renderPage(slice);
                        
                        countSpan.textContent = filteredData.length.toLocaleString() + ' Records' + (filteredData.length !== rawData.length ? ' (Filtered)' : '');
                        renderControls(pageCount);
                    },
                    reset: () => { currentPage = 1; controller.update(); },
                    activate: () => { 
                        group.classList.add('active'); 
                        navLink.classList.add('active'); 
                        controller.update(); 
                    },
                    deactivate: () => { 
                        group.classList.remove('active'); 
                        navLink.classList.remove('active'); 
                    }
                };

                searchInput.addEventListener('input', (e) => {
                    const term = e.target.value.toLowerCase();
                    if (!term) {
                        filteredData = rawData;
                    } else {
                        filteredData = rawData.filter(record => 
                            record.some(val => 
                                (typeof val === 'string' || typeof val === 'number') && 
                                String(val).toLowerCase().includes(term)
                            )
                        );
                    }
                    currentPage = 1;
                    controller.update();
                });

                function renderControls(pageCount) {
                    const pgValue = parseInt(globalSelector.value);
                    paginationBar.innerHTML = \`
                        <div class="pagination-left">
                            <button class="page-btn prev-btn" \${currentPage === 1 ? 'disabled' : ''}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 18l-6-6 6-6"/></svg> <span>Previous</span>
                            </button>
                            <span class="page-info">Page \${currentPage} / \${pageCount || 1}</span>
                            <button class="page-btn next-btn" \${currentPage >= pageCount ? 'disabled' : ''}>
                                <span>Next</span> <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
                            </button>
                        </div>
                        <div style="font-size: 0.75rem; color: var(--text-light); font-weight: 500;">
                            Showing \${filteredData.length === 0 ? 0 : (currentPage-1)*pgValue+1} - \${Math.min(currentPage*pgValue, filteredData.length)} of \${filteredData.length}
                        </div>
                    \`;
                    paginationBar.querySelector('.prev-btn').onclick = () => { currentPage--; controller.update(); };
                    paginationBar.querySelector('.next-btn').onclick = () => { currentPage++; controller.update(); };
                }

                groupControllers.push(controller);
                if (index === 0) switchToGroup(id);
            });
        });
    </script>
</body>
</html>`);
        out.end();
        console.log(`HTML dashboard (Premium UI v2.5) saved to ${this.outputFileName}`);
    }
}

module.exports = StreamingHtmlGenerator;
