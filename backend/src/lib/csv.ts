import Papa from 'papaparse';

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const STRICT_EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export interface ParsedLeads {
  emails: string[];
  totalFound: number;
  duplicatesRemoved: number;
  invalidRows: number;
}

export const isValidEmail = (value: string) => STRICT_EMAIL_RE.test(value.trim());

/**
 * Extracts recipient addresses from an uploaded CSV or plain-text file.
 *
 * Deliberately permissive: real lead lists arrive with a header row or without,
 * with the address in any column, or as a bare newline-separated list. Rather
 * than demand a fixed shape we scan every cell for something email-shaped, then
 * de-duplicate case-insensitively while preserving first-seen order (which the
 * scheduler later relies on for send ordering).
 */
export function parseLeadFile(content: string): ParsedLeads {
  const result = Papa.parse<string[]>(content, {
    skipEmptyLines: true,
    header: false,
  });

  const ordered: string[] = [];
  const seen = new Set<string>();
  let totalFound = 0;
  let invalidRows = 0;

  const consider = (raw: string) => {
    const candidate = raw.trim().replace(/^["'<]+|["'>]+$/g, '');
    if (!isValidEmail(candidate)) return false;
    totalFound += 1;
    const key = candidate.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
    ordered.push(key);
    return true;
  };

  for (const row of result.data) {
    if (!Array.isArray(row)) continue;
    let rowMatched = false;
    for (const cell of row) {
      if (typeof cell !== 'string') continue;
      if (consider(cell)) {
        rowMatched = true;
        continue;
      }
      // Cell holds more than just an address (e.g. "Jane Doe <jane@x.com>").
      const inline = cell.match(EMAIL_RE);
      if (inline) {
        for (const match of inline) {
          if (consider(match)) rowMatched = true;
        }
      }
    }
    if (!rowMatched) invalidRows += 1;
  }

  return {
    emails: ordered,
    totalFound,
    duplicatesRemoved: totalFound - ordered.length,
    invalidRows,
  };
}
