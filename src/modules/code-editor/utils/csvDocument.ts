// Parsing and editing of delimiter-separated text (CSV, TSV, semicolon CSV from a Dutch Excel) for the table view.
// A row the table never touched is written back byte for byte from its original text, so editing one cell changes
// one line of the file and leaves every other row's quoting, spacing and line ending exactly as it was.

export type CsvRow = {
  cells: string[];
  // The row's text as it appeared in the file, without its line ending; null once an edit makes it stale.
  raw: string | null;
  // The line ending that followed the row: '\r\n', '\n', '\r', or '' for a last row without one.
  ending: string;
};

export type CsvDocument = {
  delimiter: string;
  rows: CsvRow[];
  // The file's most common line ending, used for rows the table adds.
  newline: string;
};

export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;

export const isCsvFileName = (fileName: string): boolean => /\.(csv|tsv|tab)$/i.test(fileName);

// Counts each candidate delimiter outside quotes on the first lines and picks the one that splits them most
// consistently; a .tsv/.tab file is tab-separated by name.
export const detectDelimiter = (text: string, fileName = ''): string => {
  if (/\.(tsv|tab)$/i.test(fileName)) return '\t';
  const sample = text.slice(0, 64 * 1024);
  let best = ',';
  let bestScore = 0;
  for (const candidate of CSV_DELIMITERS) {
    const counts = countPerLine(sample, candidate, 20);
    if (counts.length === 0 || counts[0] === 0) continue;
    const consistent = counts.filter((count) => count === counts[0]).length;
    const score = consistent * 1000 + counts[0];
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
};

const countPerLine = (text: string, delimiter: string, maxLines: number): number[] => {
  const counts: number[] = [];
  let count = 0;
  let inQuotes = false;
  for (let index = 0; index < text.length && counts.length < maxLines; index++) {
    const char = text[index];
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char === delimiter) count++;
    else if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      counts.push(count);
      count = 0;
    }
  }
  if (counts.length < maxLines && count > 0) counts.push(count);
  return counts;
};

// RFC 4180, read leniently: quotes only count at the start of a field, `""` inside one is a literal quote, and text
// after a closing quote is kept rather than rejected. A final line ending does not start an empty last row.
export const parseCsv = (text: string, delimiter: string): CsvDocument => {
  const rows: CsvRow[] = [];
  const endingCounts: Record<string, number> = {};
  let cells: string[] = [];
  let field = '';
  let rowStart = 0;
  let index = 0;
  let atFieldStart = true;
  let inQuotes = false;

  const endRow = (rowEnd: number, ending: string) => {
    cells.push(field);
    rows.push({ cells, raw: text.slice(rowStart, rowEnd), ending });
    if (ending) endingCounts[ending] = (endingCounts[ending] ?? 0) + 1;
    cells = [];
    field = '';
    atFieldStart = true;
  };

  while (index < text.length) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (char === '"') inQuotes = false;
      else field += char;
      index++;
      continue;
    }
    if (char === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      index++;
      continue;
    }
    if (char === delimiter) {
      cells.push(field);
      field = '';
      atFieldStart = true;
      index++;
      continue;
    }
    if (char === '\r' || char === '\n') {
      const ending = char === '\r' && text[index + 1] === '\n' ? '\r\n' : char;
      endRow(index, ending);
      index += ending.length;
      rowStart = index;
      continue;
    }
    field += char;
    atFieldStart = false;
    index++;
  }
  if (rowStart < text.length) endRow(text.length, '');

  const newline = Object.entries(endingCounts).sort((left, right) => right[1] - left[1])[0]?.[0] ?? '\n';
  return { delimiter, rows, newline };
};

const encodeCell = (value: string, delimiter: string): string => (
  value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
);

export const serializeCsv = (csv: CsvDocument): string => csv.rows
  .map((row) => (row.raw ?? row.cells.map((cell) => encodeCell(cell, csv.delimiter)).join(csv.delimiter)) + row.ending)
  .join('');

// A blank line parses as one empty cell; column edits leave it blank instead of filling it with delimiters.
export const isBlankRow = (row: CsvRow): boolean => row.cells.length === 1 && row.cells[0] === '';

export const getColumnCount = (csv: CsvDocument): number => csv.rows.reduce((max, row) => Math.max(max, row.cells.length), 0);

const withCell = (cells: string[], columnIndex: number, value: string): string[] => {
  const next = cells.slice();
  while (next.length <= columnIndex) next.push('');
  next[columnIndex] = value;
  return next;
};

// Writes a block of values with its top-left corner at the given cell, adding rows past the end as needed; one value
// is a 1x1 block. Returns the same document when nothing changes, so a no-op edit leaves the buffer clean.
export const setCells = (csv: CsvDocument, rowIndex: number, columnIndex: number, block: string[][]): CsvDocument => {
  const rows = csv.rows.slice();
  let changed = false;
  block.forEach((values, rowOffset) => {
    const targetRow = rowIndex + rowOffset;
    while (rows.length <= targetRow) {
      appendEmptyRow(rows, csv.newline);
      changed = true;
    }
    values.forEach((value, columnOffset) => {
      const targetColumn = columnIndex + columnOffset;
      if ((rows[targetRow].cells[targetColumn] ?? '') === value) return;
      rows[targetRow] = { ...rows[targetRow], cells: withCell(rows[targetRow].cells, targetColumn, value), raw: null };
      changed = true;
    });
  });
  return changed ? { ...csv, rows } : csv;
};

const appendEmptyRow = (rows: CsvRow[], newline: string) => {
  const last = rows[rows.length - 1];
  if (last && !last.ending) rows[rows.length - 1] = { ...last, ending: newline };
  rows.push({ cells: [''], raw: null, ending: last && !last.ending ? '' : newline });
};

// Inserts an empty row before `rowIndex`; `rowIndex === rows.length` appends one.
export const insertRow = (csv: CsvDocument, rowIndex: number): CsvDocument => {
  const rows = csv.rows.slice();
  if (rowIndex >= rows.length) {
    appendEmptyRow(rows, csv.newline);
  } else {
    rows.splice(rowIndex, 0, { cells: [''], raw: null, ending: csv.newline });
  }
  return { ...csv, rows };
};

export const deleteRow = (csv: CsvDocument, rowIndex: number): CsvDocument => {
  const rows = csv.rows.slice();
  const [removed] = rows.splice(rowIndex, 1);
  // The last row's ending says whether the file ends in a newline, so the new last row inherits it.
  if (removed && rowIndex === rows.length && rows.length > 0) rows[rows.length - 1] = { ...rows[rows.length - 1], ending: removed.ending };
  return { ...csv, rows };
};

export const insertColumn = (csv: CsvDocument, columnIndex: number): CsvDocument => ({
  ...csv,
  rows: csv.rows.map((row) => {
    if (isBlankRow(row) || row.cells.length < columnIndex) return row;
    const cells = row.cells.slice();
    cells.splice(columnIndex, 0, '');
    return { ...row, cells, raw: null };
  }),
});

export const deleteColumn = (csv: CsvDocument, columnIndex: number): CsvDocument => ({
  ...csv,
  rows: csv.rows.map((row) => {
    if (row.cells.length <= columnIndex) return row;
    const cells = row.cells.slice();
    cells.splice(columnIndex, 1);
    return { ...row, cells: cells.length ? cells : [''], raw: null };
  }),
});
