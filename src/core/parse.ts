/**
 * Turning bytes into candidate records.
 *
 * This module is deliberately dumb about *meaning*. Its only job is to split a
 * payload into individual candidate records and hand each one to validation
 * with its original text attached. It never throws: a payload that cannot be
 * parsed produces records carrying a `parseError`, which the pipeline then
 * quarantines exactly like a validation failure. A parser that throws would
 * take a whole 50,000 row file down over one bad line.
 */

/** A single candidate record, before validation. */
export interface RawRecord {
  /** The parsed value. Meaningless when `parseError` is set. */
  value: unknown;
  /** The original text, preserved verbatim so quarantined rows stay diagnosable. */
  rawText: string;
  /** Provenance, e.g. `s3://bucket/key#L42`. */
  source: string;
  /** Set when this record could not be parsed at all. */
  parseError?: string;
}

export type PayloadFormat = 'csv' | 'ndjson' | 'json';

const BOM = '﻿';

/**
 * Column names that belong at the top level of a record. Every other CSV column
 * is nested under `telemetryData`, which is what lets a flat spreadsheet export
 * and a nested JSON message converge on the same shape before validation.
 */
const TOP_LEVEL_COLUMNS: ReadonlySet<string> = new Set([
  'eventId',
  'droneId',
  'timestamp',
  'eventType',
  'statusCode',
  'telemetryData',
]);

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * Prefer the file extension, fall back to sniffing the content. Extensions lie
 * often enough that content wins when they disagree in an obvious way.
 */
export function detectFormat(key: string, body: string): PayloadFormat {
  const lower = key.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.ndjson') || lower.endsWith('.jsonl')) return 'ndjson';
  if (lower.endsWith('.json')) return 'json';

  const trimmed = body.replace(BOM, '').trimStart();
  if (trimmed.startsWith('[')) return 'json';
  if (trimmed.startsWith('{')) {
    // One object per line is NDJSON; a single pretty-printed object is JSON.
    return trimmed.includes('}\n{') || /\}\s*\n\s*\{/.test(trimmed) ? 'ndjson' : 'json';
  }
  return 'csv';
}

// ---------------------------------------------------------------------------
// CSV
//
// Hand-written rather than pulled from a dependency, for two reasons: it is
// core logic worth unit testing directly, and the behaviour that matters here
// (never throw, report ragged rows precisely, keep the original line) is
// exactly the behaviour most CSV libraries make hard to get at.
//
// Implements the RFC 4180 essentials: quoted fields, embedded commas and
// newlines, and "" as an escaped quote.
// ---------------------------------------------------------------------------

interface CsvRow {
  cells: string[];
  /** 1-indexed line number of the row's first character, for provenance. */
  line: number;
  rawText: string;
}

export function parseCsv(input: string): { header: string[]; rows: CsvRow[] } {
  const text = input.startsWith(BOM) ? input.slice(1) : input;

  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let rowStartIndex = 0;
  let sawAnyChar = false;

  const endRow = (endIndex: number): void => {
    cells.push(field);
    const rawText = text.slice(rowStartIndex, endIndex);
    // Skip rows that are entirely blank: trailing newlines are normal, not corrupt.
    if (!(cells.length === 1 && cells[0]?.trim() === '')) {
      rows.push({ cells, line: rowStartLine, rawText });
    }
    cells = [];
    field = '';
    sawAnyChar = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (!sawAnyChar) {
      rowStartLine = line;
      rowStartIndex = i;
      sawAnyChar = true;
    }

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(field);
      field = '';
    } else if (char === '\n') {
      endRow(i);
      line += 1;
    } else if (char === '\r') {
      // Swallowed; the following \n terminates the row.
    } else {
      field += char;
    }
  }

  if (sawAnyChar || field !== '' || cells.length > 0) {
    endRow(text.length);
  }

  const headerRow = rows.shift();
  const header = (headerRow?.cells ?? []).map((h) => h.trim());
  return { header, rows };
}

function csvRowToRecord(
  header: string[],
  row: CsvRow,
  sourcePrefix: string,
): RawRecord {
  const source = `${sourcePrefix}#L${row.line}`;

  if (row.cells.length !== header.length) {
    return {
      value: undefined,
      rawText: row.rawText,
      source,
      parseError: `malformed CSV row: expected ${header.length} columns, found ${row.cells.length}`,
    };
  }

  const record: Record<string, unknown> = {};
  const telemetry: Record<string, unknown> = {};

  header.forEach((column, index) => {
    const cell = row.cells[index] ?? '';
    if (column === '') return;
    if (TOP_LEVEL_COLUMNS.has(column)) {
      record[column] = cell;
    } else {
      telemetry[column] = cell;
    }
  });

  // An explicit telemetryData column wins over flattened columns; merging the
  // two would make precedence ambiguous for no practical gain.
  if (record['telemetryData'] === undefined && Object.keys(telemetry).length > 0) {
    record['telemetryData'] = telemetry;
  }

  return { value: record, rawText: row.rawText, source };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ParseOptions {
  /** Provenance prefix, e.g. `s3://bucket/key` or `sqs:<messageId>`. */
  sourcePrefix: string;
  /** Overrides detection. */
  format?: PayloadFormat;
  /**
   * Hard ceiling on records taken from a single payload. A malformed or hostile
   * upload should not be able to exhaust the processor's memory; anything above
   * this belongs in a streaming path, not a batch one.
   */
  maxRecords?: number;
}

export function parsePayload(body: string, options: ParseOptions): RawRecord[] {
  const format = options.format ?? detectFormat(options.sourcePrefix, body);
  const max = options.maxRecords ?? Number.POSITIVE_INFINITY;

  switch (format) {
    case 'csv': {
      const { header, rows } = parseCsv(body);
      if (header.length === 0) return [];
      return rows.slice(0, max).map((row) => csvRowToRecord(header, row, options.sourcePrefix));
    }

    case 'ndjson': {
      const text = body.startsWith(BOM) ? body.slice(1) : body;
      const records: RawRecord[] = [];
      const lines = text.split('\n');
      for (let index = 0; index < lines.length && records.length < max; index += 1) {
        const rawText = (lines[index] ?? '').replace(/\r$/, '');
        if (rawText.trim() === '') continue;
        records.push(parseJsonLine(rawText, `${options.sourcePrefix}#L${index + 1}`));
      }
      return records;
    }

    case 'json': {
      const text = body.startsWith(BOM) ? body.slice(1) : body;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        return [
          {
            value: undefined,
            rawText: text,
            source: options.sourcePrefix,
            parseError: `invalid JSON: ${(error as Error).message}`,
          },
        ];
      }

      const items = Array.isArray(parsed) ? parsed : [parsed];
      return items.slice(0, max).map((item, index) => ({
        value: item,
        rawText: safeStringify(item),
        source: Array.isArray(parsed)
          ? `${options.sourcePrefix}#${index}`
          : options.sourcePrefix,
      }));
    }
  }
}

function parseJsonLine(rawText: string, source: string): RawRecord {
  try {
    return { value: JSON.parse(rawText), rawText, source };
  } catch (error) {
    return {
      value: undefined,
      rawText,
      source,
      parseError: `invalid JSON: ${(error as Error).message}`,
    };
  }
}

/** JSON.stringify throws on circular structures; quarantine text must never fail. */
export function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
