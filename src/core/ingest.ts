/**
 * Ingestion: text in, typed column-oriented dataset out.
 *
 * Type inference is deliberately conservative. A column is only called numeric
 * or temporal when nearly every non-blank value parses that way; the leftovers
 * are counted as `invalidCount` and surfaced by the quality analyzer rather
 * than silently coerced.
 */

import type { LogicalType } from './types.js';

export interface ParsedTable {
  columns: string[];
  /** Column-oriented: rows[colIndex][rowIndex]. */
  rows: Array<Array<string | null>>;
  rowCount: number;
  warnings: string[];
}

const NULL_TOKENS = new Set([
  '', 'null', 'NULL', 'Null', 'na', 'NA', 'n/a', 'N/A', 'nan', 'NaN',
  'none', 'None', 'nil', '-', '--', 'undefined',
]);

export function isBlank(v: string | null | undefined): boolean {
  return v === null || v === undefined || NULL_TOKENS.has(v.trim());
}

// ---------------------------------------------------------------------------
// Delimited text
// ---------------------------------------------------------------------------

/** Pick the delimiter whose per-line field count is most consistent. */
export function detectDelimiter(text: string): string {
  const candidates = [',', ';', '\t', '|'];
  const probe = text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 20);
  if (probe.length === 0) return ',';

  let best = ',';
  let bestScore = -Infinity;
  for (const delim of candidates) {
    const counts = probe.map((line) => splitDelimitedLine(line, delim).length);
    const first = counts[0]!;
    if (first < 2) continue;
    // Reward many fields, punish any variation in field count across lines.
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = consistent * 10 + Math.min(first, 30) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }
  return best;
}

/** RFC 4180 style split of a single line, honouring quotes and "" escapes. */
function splitDelimitedLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Full CSV parse. Handles quoted fields containing newlines, which a
 * line-by-line split would mangle.
 */
export function parseDelimited(text: string, delimiter?: string): ParsedTable {
  const warnings: string[] = [];
  let src = text.replace(/^﻿/, ''); // strip BOM
  const delim = delimiter ?? detectDelimiter(src);

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      record.push(field);
      field = '';
    } else if (ch === '\n') {
      record.push(field);
      field = '';
      records.push(record);
      record = [];
    } else if (ch === '\r') {
      // Consume CRLF as one terminator; a bare CR also ends the record.
      if (src[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      records.push(record);
      record = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0]!.trim() === ''));
  if (nonEmpty.length === 0) {
    return { columns: [], rows: [], rowCount: 0, warnings: ['Файл пуст.'] };
  }

  const header = nonEmpty[0]!.map((h, i) => {
    const name = h.trim();
    return name.length > 0 ? name : `column_${i + 1}`;
  });
  const deduped = dedupeNames(header, warnings);
  const body = nonEmpty.slice(1);

  const cols: Array<Array<string | null>> = deduped.map(() => []);
  let ragged = 0;
  for (const row of body) {
    if (row.length !== deduped.length) ragged++;
    for (let c = 0; c < deduped.length; c++) {
      const raw = row[c];
      cols[c]!.push(raw === undefined || isBlank(raw) ? null : raw.trim());
    }
  }
  if (ragged > 0) {
    warnings.push(
      `${ragged} ${plural(ragged, 'строка', 'строки', 'строк')} с числом полей, отличным от заголовка — недостающие поля заполнены пустыми значениями.`,
    );
  }

  return { columns: deduped, rows: cols, rowCount: body.length, warnings };
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** Accepts an array of objects, {data:[...]}, or newline-delimited JSON. */
export function parseJsonTable(text: string): ParsedTable {
  const warnings: string[] = [];
  let records: unknown[];

  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      records = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const arrayKey = ['data', 'rows', 'records', 'items', 'results'].find((k) =>
        Array.isArray(obj[k]),
      );
      if (arrayKey) {
        records = obj[arrayKey] as unknown[];
        warnings.push(`Массив записей взят из поля "${arrayKey}".`);
      } else {
        records = [parsed];
      }
    } else {
      throw new Error('JSON верхнего уровня не является объектом или массивом.');
    }
  } catch {
    // Try newline-delimited JSON before giving up.
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const parsedLines: unknown[] = [];
    for (const line of lines) {
      try {
        parsedLines.push(JSON.parse(line));
      } catch {
        throw new Error('Не удалось разобрать JSON: это не валидный JSON и не NDJSON.');
      }
    }
    records = parsedLines;
    warnings.push('Данные прочитаны как NDJSON (по одному объекту на строку).');
  }

  const objects = records.filter(
    (r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r),
  );
  if (objects.length === 0) {
    return { columns: [], rows: [], rowCount: 0, warnings: ['В JSON не найдено объектов-записей.'] };
  }
  if (objects.length < records.length) {
    warnings.push(`${records.length - objects.length} записей пропущено: не объекты.`);
  }

  // Union of keys, preserving first-seen order. Nested values are flattened
  // one level so {"user":{"id":1}} becomes a "user.id" column.
  const keys: string[] = [];
  const seen = new Set<string>();
  const flat = objects.map((o) => flattenObject(o));
  for (const row of flat) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }

  const cols: Array<Array<string | null>> = keys.map(() => []);
  for (const row of flat) {
    keys.forEach((k, ci) => {
      const v = row[k];
      cols[ci]!.push(v === undefined || v === null || isBlank(String(v)) ? null : String(v));
    });
  }

  return { columns: keys, rows: cols, rowCount: flat.length, warnings };
}

function flattenObject(obj: Record<string, unknown>, prefix = '', depth = 0): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && depth < 2) {
      Object.assign(out, flattenObject(v as Record<string, unknown>, key, depth + 1));
    } else if (Array.isArray(v)) {
      out[key] = v.map((x) => (x === null ? '' : String(x))).join('; ');
    } else if (v !== null && v !== undefined) {
      out[key] = String(v);
    }
  }
  return out;
}

/** Dispatch on content shape; `hint` may be a filename or a format name. */
export function parseAny(text: string, hint?: string): ParsedTable {
  const lower = (hint ?? '').toLowerCase();
  const trimmed = text.trimStart();
  const looksJson = trimmed.startsWith('[') || trimmed.startsWith('{');
  if (lower.endsWith('.json') || lower.endsWith('.ndjson') || lower === 'json' || looksJson) {
    return parseJsonTable(text);
  }
  if (lower.endsWith('.tsv') || lower === 'tsv') return parseDelimited(text, '\t');
  return parseDelimited(text);
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

/**
 * Parse a number, tolerating thousands separators, currency symbols,
 * percentages, and parenthesised negatives. Returns null if unparseable.
 */
export function coerceNumber(raw: string | null): number | null {
  if (raw === null) return null;
  let s = raw.trim();
  if (s.length === 0) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  let scale = 1;
  if (s.endsWith('%')) {
    scale = 0.01;
    s = s.slice(0, -1).trim();
  }

  // Strip currency symbols and spaces used as thousands separators (incl. NBSP).
  s = s.replace(/[$€£¥₽₴₸]/g, '').replace(/[\s  ]/g, '').trim();
  if (s.length === 0) return null;

  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  // Disambiguate , and . as decimal vs thousands separator.
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // The rightmost separator is the decimal one.
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (hasComma) {
    const parts = s.split(',');
    // "1,234" and "1,234,567" are thousands; "1,23" is a decimal comma.
    const allGroupsOfThree = parts.length > 1 && parts.slice(1).every((p) => /^\d{3}$/.test(p));
    s = allGroupsOfThree ? parts.join('') : s.replace(',', '.');
  }

  if (!/^\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!isFinite(n)) return null;
  return (negative ? -n : n) * scale;
}

const DATE_PATTERNS: Array<{ re: RegExp; build: (m: RegExpMatchArray) => number | null }> = [
  // ISO 8601, with or without time and zone.
  {
    re: /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?(Z|[+-]\d{2}:?\d{2})?$/,
    build: (m) => {
      const iso = m[4]
        ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${m[7] ?? 'Z'}`
        : `${m[1]}-${m[2]}-${m[3]}T00:00:00Z`;
      const t = Date.parse(iso);
      return isNaN(t) ? null : t;
    },
  },
  // Slash or dot separated: DD/MM/YYYY and MM/DD/YYYY are resolved by the
  // caller using whole-column evidence, so here we return both readings.
  {
    re: /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
    build: () => null, // handled by parseAmbiguousDate
  },
  // YYYY/MM/DD
  {
    re: /^(\d{4})[./](\d{1,2})[./](\d{1,2})$/,
    build: (m) => Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!),
  },
  // YYYY-MM (month grain)
  {
    re: /^(\d{4})-(\d{1,2})$/,
    build: (m) => Date.UTC(+m[1]!, +m[2]! - 1, 1),
  },
];

/**
 * Parse a timestamp. `dayFirst` resolves the DD/MM vs MM/DD ambiguity and is
 * decided once per column by {@link detectDayFirst}.
 */
export function coerceDate(raw: string | null, dayFirst = false): number | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (s.length === 0) return null;

  // Bare epoch seconds/milliseconds, within a plausible range.
  if (/^\d{10}$/.test(s)) {
    const t = Number(s) * 1000;
    if (t > Date.UTC(1990, 0, 1) && t < Date.UTC(2100, 0, 1)) return t;
  }
  if (/^\d{13}$/.test(s)) {
    const t = Number(s);
    if (t > Date.UTC(1990, 0, 1) && t < Date.UTC(2100, 0, 1)) return t;
  }

  const slash = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (slash) {
    const a = +slash[1]!, b = +slash[2]!;
    const day = dayFirst ? a : b;
    const month = dayFirst ? b : a;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return Date.UTC(+slash[3]!, month - 1, day, +(slash[4] ?? 0), +(slash[5] ?? 0), +(slash[6] ?? 0));
  }

  for (const { re, build } of DATE_PATTERNS) {
    const m = s.match(re);
    if (m) {
      const t = build(m);
      if (t !== null) return t;
    }
  }
  return null;
}

/**
 * Decide whether a column of D/M/Y-shaped strings is day-first. Any value with
 * a first component above 12 settles it; otherwise assume month-first, which
 * matches the majority of machine-exported data.
 */
export function detectDayFirst(values: Array<string | null>): boolean {
  let firstOver12 = 0;
  let secondOver12 = 0;
  for (const v of values) {
    if (v === null) continue;
    const m = v.trim().match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
    if (!m) continue;
    if (+m[1]! > 12) firstOver12++;
    if (+m[2]! > 12) secondOver12++;
  }
  if (firstOver12 > 0 && secondOver12 === 0) return true;
  if (secondOver12 > 0 && firstOver12 === 0) return false;
  return false;
}

const TRUE_TOKENS = new Set(['true', 'yes', 'y', '1', 'да', 't']);
const FALSE_TOKENS = new Set(['false', 'no', 'n', '0', 'нет', 'f']);

export function coerceBoolean(raw: string | null): boolean | null {
  if (raw === null) return null;
  const s = raw.trim().toLowerCase();
  if (TRUE_TOKENS.has(s)) return true;
  if (FALSE_TOKENS.has(s)) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

export interface InferenceResult {
  type: LogicalType;
  /** Non-blank values that failed to parse as `type`. */
  invalidCount: number;
  dayFirst: boolean;
}

/**
 * Infer a column's logical type. A type is accepted when at least 90% of the
 * non-blank values parse cleanly — high enough to reject genuinely mixed
 * columns, low enough to tolerate a scattering of dirty rows.
 */
export function inferType(name: string, values: Array<string | null>): InferenceResult {
  const nonBlank = values.filter((v): v is string => v !== null);
  const total = nonBlank.length;
  if (total === 0) return { type: 'unknown', invalidCount: 0, dayFirst: false };

  const threshold = 0.9;
  const dayFirst = detectDayFirst(nonBlank);

  let boolOk = 0, numOk = 0, dateOk = 0, intOk = 0, hasTime = false;
  for (const v of nonBlank) {
    if (coerceBoolean(v) !== null) boolOk++;
    const n = coerceNumber(v);
    if (n !== null) {
      numOk++;
      if (Number.isInteger(n)) intOk++;
    }
    const d = coerceDate(v, dayFirst);
    if (d !== null) {
      dateOk++;
      if (/[T ]\d{1,2}:\d{2}/.test(v) || /^\d{10,13}$/.test(v.trim())) hasTime = true;
    }
  }

  // Date is checked before number so that 8-digit YYYYMMDD-ish columns and
  // epoch stamps are not swallowed by the numeric branch.
  if (dateOk / total >= threshold && dateOk >= 2) {
    return {
      type: hasTime ? 'datetime' : 'date',
      invalidCount: total - dateOk,
      dayFirst,
    };
  }
  if (boolOk / total >= threshold) {
    return { type: 'boolean', invalidCount: total - boolOk, dayFirst };
  }
  if (numOk / total >= threshold) {
    const distinct = new Set(nonBlank).size;
    const isInt = intOk / Math.max(1, numOk) >= 0.99;
    // An all-distinct integer column named like a key is an identifier, not a
    // measure — summing order_id is never meaningful.
    if (isInt && distinct === total && total >= 3 && looksLikeIdName(name)) {
      return { type: 'identifier', invalidCount: total - numOk, dayFirst };
    }
    return { type: isInt ? 'integer' : 'number', invalidCount: total - numOk, dayFirst };
  }

  const distinct = new Set(nonBlank).size;
  const ratio = distinct / total;
  /*
   * An all-distinct column whose name says "id" is an identifier even in a
   * tiny table. The row-count floor exists to stop a genuinely categorical
   * column from being mistaken for a key in a small sample, but a name like
   * `order_id` is evidence in its own right and shouldn't need 20 rows to be
   * believed — otherwise small datasets get their keys treated as segments.
   */
  if (distinct === total && total >= 3 && looksLikeIdName(name)) {
    return { type: 'identifier', invalidCount: 0, dayFirst };
  }
  // Low cardinality, or few enough distinct values to be worth grouping by.
  if (ratio <= 0.5 || distinct <= 50) {
    return { type: 'category', invalidCount: 0, dayFirst };
  }
  return { type: 'text', invalidCount: 0, dayFirst };
}

export function looksLikeIdName(name: string): boolean {
  return /(^|[_\s.-])(id|uuid|guid|key|code|no|num|number|ключ|код|номер)$/i.test(name)
    || /^(id|uuid|guid)$/i.test(name);
}

function dedupeNames(names: string[], warnings: string[]): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const n of names) {
    const count = seen.get(n) ?? 0;
    seen.set(n, count + 1);
    if (count === 0) {
      out.push(n);
    } else {
      out.push(`${n}_${count + 1}`);
      warnings.push(`Дублирующийся заголовок "${n}" переименован в "${n}_${count + 1}".`);
    }
  }
  return out;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
