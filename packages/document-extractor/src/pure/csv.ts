import { type ExtractionResult, ExtractionResultSchema } from "../types";

export interface CsvInput {
  text: string;
  /** Detected delimiter. Defaults to "," but TSV input passes "\t". */
  delimiter?: "," | "\t";
}

/**
 * CSV/TSV -> a markdown table. We don't try to be clever about quoting;
 * the spec calls for a "thin wrapper", and the downstream LLM will
 * tolerate slight quote artefacts.
 */
export function extractCsv(input: CsvInput): ExtractionResult {
  const warnings: string[] = [];
  const delimiter = input.delimiter ?? detectDelimiter(input.text);
  const rows = parseRows(input.text, delimiter, warnings);

  if (rows.length === 0) {
    warnings.push("empty CSV input");
    return ExtractionResultSchema.parse({
      markdown: "",
      warnings,
      confidence: "low",
      extractionMethod: "csv_native",
      needsReview: true,
    });
  }

  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const md = renderMarkdownTable(header, body);
  return ExtractionResultSchema.parse({
    markdown: md,
    summary: `${header.length} columns x ${body.length} rows`,
    warnings,
    confidence: warnings.length === 0 ? "high" : "medium",
    extractionMethod: "csv_native",
    needsReview: warnings.length > 0,
  });
}

function detectDelimiter(text: string): "," | "\t" {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const tabCount = (firstLine.match(/\t/g) ?? []).length;
  return tabCount > commaCount ? "\t" : ",";
}

function parseRows(text: string, delimiter: string, warnings: string[]): string[][] {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length > 0);
  const rows: string[][] = [];
  let columnCount = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const cells = parseLine(lines[i] ?? "", delimiter);
    if (columnCount < 0) {
      columnCount = cells.length;
    } else if (cells.length !== columnCount) {
      warnings.push(
        `row ${i + 1} has ${cells.length} cells, expected ${columnCount}`,
      );
    }
    rows.push(cells);
  }
  return rows;
}

function parseLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        buf += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function renderMarkdownTable(header: string[], body: string[][]): string {
  if (header.length === 0) return "";
  const head = `| ${header.map(escape).join(" | ")} |`;
  const sep = `| ${header.map(() => "---").join(" | ")} |`;
  const rows = body.map((r) => `| ${r.map(escape).join(" | ")} |`);
  return [head, sep, ...rows].join("\n");
}

function escape(cell: string): string {
  return cell.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
