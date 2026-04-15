#!/usr/bin/env node
'use strict';

const path = require('path');
const ReportGenerator = require('../index');

const VALID_TYPES = ['pdf', 'excel', 'html'];
const HELP = `
Usage: temir-report generate [options]

Options:
  --source,  -s  <path>    Path to JSON data source file (required)
  --output,  -o  <path>    Output file path            (required)
  --type,    -t  <format>  Report format: pdf | excel | html  (default: pdf)
  --title,   -T  <string>  Report title                (default: "Report")
  --help,    -h            Show this help message

Examples:
  temir-report generate -s data.json -t pdf    -o report.pdf  -T "Sales Report"
  temir-report generate -s data.json -t excel  -o report.xlsx
  temir-report generate -s data.json -t html   -o report.html -T "Dashboard"
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--source':  case '-s': args.source = val; i++; break;
      case '--output':  case '-o': args.output = val; i++; break;
      case '--type':    case '-t': args.type   = val; i++; break;
      case '--title':   case '-T': args.title  = val; i++; break;
      case '--help':    case '-h': args.help   = true; break;
    }
  }
  return args;
}

(async () => {
  const [,, command, ...rest] = process.argv;

  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  if (command !== 'generate') {
    console.error(`Unknown command: "${command}". Run temir-report --help for usage.`);
    process.exit(1);
  }

  const args = parseArgs(rest);

  if (args.help) { console.log(HELP); process.exit(0); }

  if (!args.source) { console.error('Error: --source (-s) is required.'); process.exit(1); }
  if (!args.output) { console.error('Error: --output (-o) is required.'); process.exit(1); }

  const type = (args.type || 'pdf').toLowerCase();
  if (!VALID_TYPES.includes(type)) {
    console.error(`Error: Invalid type "${type}". Must be one of: ${VALID_TYPES.join(', ')}`);
    process.exit(1);
  }

  const sourcePath = path.resolve(process.cwd(), args.source);
  const outputPath = path.resolve(process.cwd(), args.output);
  const title = args.title || 'Report';

  console.log(`\n📊 temir-report`);
  console.log(`   Source : ${sourcePath}`);
  console.log(`   Format : ${type.toUpperCase()}`);
  console.log(`   Output : ${outputPath}`);
  console.log(`   Title  : ${title}\n`);

  try {
    await new ReportGenerator()
      .source(sourcePath)
      .setTitle(title)
      .type(type)
      .generate(outputPath);

    console.log(`\n✅ Done! Report saved to: ${outputPath}`);
  } catch (err) {
    console.error('\n❌ Generation failed:', err.message);
    process.exit(1);
  }
})();
