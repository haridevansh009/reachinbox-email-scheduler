import Papa from 'papaparse';

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const STRICT_EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export interface LocalParseResult {
  emails: string[];
  duplicatesRemoved: number;
}

/**
 * Client-side parse, used ONLY to show an instant "N addresses detected" count
 * while the file is still local. The backend re-parses the same file with the
 * same rules and its number is authoritative.
 */
export async function parseLeadsLocally(file: File): Promise<LocalParseResult> {
  const text = await file.text();
  const result = Papa.parse<string[]>(text, { skipEmptyLines: true, header: false });

  const seen = new Set<string>();
  const emails: string[] = [];
  let totalFound = 0;

  const consider = (raw: string) => {
    const candidate = raw.trim().replace(/^["'<]+|["'>]+$/g, '');
    if (!STRICT_EMAIL_RE.test(candidate)) return false;
    totalFound += 1;
    const key = candidate.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      emails.push(key);
    }
    return true;
  };

  for (const row of result.data) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      if (typeof cell !== 'string') continue;
      if (consider(cell)) continue;
      const inline = cell.match(EMAIL_RE);
      if (inline) inline.forEach(consider);
    }
  }

  return { emails, duplicatesRemoved: totalFound - emails.length };
}
