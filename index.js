const StreamingPdfGenerator = require('./generators/PdfGenerator');
const ExcelGenerator = require('./generators/ExcelGenerator');
const StreamingHtmlGenerator = require('./generators/HtmlGenerator');

/**
 * MASTER GENERATOR (Facade)
 * Provides a clean API to generate professional reports in multiple formats.
 */
class ReportGenerator {
  static PDF = 'pdf';
  static EXCEL = 'excel';
  static HTML = 'html';

  constructor(source, options = {}) {
    this.dataSource = source;
    this.options = options;
    this.reportTitle = 'Global Report Title';
    this.reportFormat = ReportGenerator.PDF;
  }

  source(data) { this.dataSource = data; return this; }
  setTitle(title) { this.reportTitle = title; return this; }
  type(format) { this.reportFormat = format.toLowerCase(); return this; }

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

// EXECUTION BLOCK (Demonstration)
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
