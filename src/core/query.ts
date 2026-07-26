/**
 * Query execution against the semantic model.
 *
 * There is no raw-SQL entry point anywhere in this system. Agents — local or
 * remote over MCP — express questions as a {@link SemanticQuery}, which can
 * only name measures and dimensions the semantic layer has declared. That
 * removes a whole class of confidently-wrong answers: the agent cannot invent
 * a column, cannot sum a ratio, and cannot group by a free-text field with a
 * million distinct values.
 */

import { bucketKey, formatBucket } from './profile.js';
import { findDimension, findMeasure, findTimeDimension, resolveAggregation } from './semantic.js';
import { median } from './stats.js';
import type {
  Aggregation,
  Dataset,
  QueryFilter,
  QueryResult,
  SemanticQuery,
  TimeGrain,
} from './types.js';

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 5000;

export class QueryError extends Error {
  constructor(message: string, readonly suggestions: string[] = []) {
    super(message);
    this.name = 'QueryError';
  }
}

interface ResolvedMetric {
  label: string;
  aggregation: Aggregation;
  /** -1 for the row-count pseudo-measure. */
  columnIndex: number;
}

interface ResolvedGroup {
  label: string;
  columnIndex: number;
  isTime: boolean;
  grain: TimeGrain;
}

export function executeQuery(dataset: Dataset, query: SemanticQuery): QueryResult {
  const model = dataset.semantic;
  const notes: string[] = [];

  // --- resolve metrics -----------------------------------------------------
  if (!query.metrics || query.metrics.length === 0) {
    throw new QueryError('Запрос должен содержать хотя бы одну метрику.', [
      `Доступные метрики: ${model.measures.map((m) => m.name).join(', ')}`,
    ]);
  }

  const metrics: ResolvedMetric[] = query.metrics.map((req) => {
    const measure = findMeasure(model, req.measure);
    if (!measure) {
      throw new QueryError(
        `Метрика «${req.measure}» отсутствует в семантической модели.`,
        [`Доступные метрики: ${model.measures.map((m) => m.name).join(', ')}`],
      );
    }
    const { aggregation, note } = resolveAggregation(measure, req.aggregation);
    if (note) notes.push(note);
    const columnIndex = measure.column === '*' ? -1 : dataset.columns.indexOf(measure.column);
    if (measure.column !== '*' && columnIndex < 0) {
      throw new QueryError(`Колонка «${measure.column}» не найдена в наборе данных.`);
    }
    return {
      label: `${aggregation}(${measure.name})`,
      aggregation: measure.column === '*' ? 'count' : aggregation,
      columnIndex,
    };
  });

  // --- resolve grouping ----------------------------------------------------
  const groups: ResolvedGroup[] = [];
  for (const name of query.groupBy ?? []) {
    const time = findTimeDimension(model, name);
    if (time) {
      const idx = dataset.columns.indexOf(time.column);
      if (idx < 0) throw new QueryError(`Колонка «${time.column}» не найдена.`);
      groups.push({
        label: name,
        columnIndex: idx,
        isTime: true,
        grain: query.timeGrain ?? time.grain,
      });
      continue;
    }
    const dim = findDimension(model, name);
    if (!dim) {
      throw new QueryError(`Измерение «${name}» отсутствует в семантической модели.`, [
        `Доступные измерения: ${model.dimensions.map((d) => d.name).join(', ')}`,
        model.timeDimensions.length
          ? `Временные оси: ${model.timeDimensions.map((t) => t.name).join(', ')}`
          : '',
      ].filter(Boolean));
    }
    const idx = dataset.columns.indexOf(dim.column);
    if (idx < 0) throw new QueryError(`Колонка «${dim.column}» не найдена.`);
    if (!dim.groupable) {
      notes.push(
        `«${dim.name}» имеет ${dim.cardinality} значений — результат ограничен топ-значениями.`,
      );
    }
    groups.push({ label: name, columnIndex: idx, isTime: false, grain: 'day' });
  }

  // --- filter --------------------------------------------------------------
  const mask = buildFilterMask(dataset, query.filters ?? []);
  let scanned = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) scanned++;

  // --- aggregate -----------------------------------------------------------
  interface Bucket {
    keys: Array<string | number>;
    display: string[];
    /** Raw values per metric, kept so median/count_distinct stay exact. */
    acc: Array<{ sum: number; count: number; min: number; max: number; values: number[]; distinct: Set<string> }>;
  }

  const buckets = new Map<string, Bucket>();
  const needsValues = metrics.some((m) => m.aggregation === 'median');
  const needsDistinct = metrics.some((m) => m.aggregation === 'count_distinct');

  for (let r = 0; r < dataset.rowCount; r++) {
    if (!mask[r]) continue;

    const keys: Array<string | number> = [];
    const display: string[] = [];
    let skip = false;
    for (const g of groups) {
      if (g.isTime) {
        const t = dataset.timeCache[g.columnIndex]?.[r];
        if (t === undefined || isNaN(t)) { skip = true; break; }
        const b = bucketKey(t, g.grain);
        keys.push(b);
        display.push(formatBucket(b, g.grain));
      } else {
        const v = dataset.values[g.columnIndex]?.[r] ?? null;
        const s = v === null ? '(пусто)' : v;
        keys.push(s);
        display.push(s);
      }
    }
    if (skip) continue;

    const key = keys.join('');
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        keys,
        display,
        acc: metrics.map(() => ({
          sum: 0, count: 0, min: Infinity, max: -Infinity,
          values: [], distinct: new Set<string>(),
        })),
      };
      buckets.set(key, bucket);
    }

    for (let m = 0; m < metrics.length; m++) {
      const metric = metrics[m]!;
      const a = bucket.acc[m]!;
      if (metric.columnIndex < 0) {
        a.count++;
        continue;
      }
      if (metric.aggregation === 'count_distinct') {
        const raw = dataset.values[metric.columnIndex]?.[r] ?? null;
        if (raw !== null) { a.distinct.add(raw); a.count++; }
        continue;
      }
      const num = dataset.numericCache[metric.columnIndex]?.[r];
      if (num === undefined || isNaN(num)) continue;
      a.sum += num;
      a.count++;
      if (num < a.min) a.min = num;
      if (num > a.max) a.max = num;
      if (needsValues) a.values.push(num);
      if (needsDistinct) a.distinct.add(String(num));
    }
  }

  // --- shape output --------------------------------------------------------
  const columns = [...groups.map((g) => g.label), ...metrics.map((m) => m.label)];
  let rows: Array<Array<string | number | null>> = Array.from(buckets.values()).map((b) => {
    const out: Array<string | number | null> = [...b.display];
    for (let m = 0; m < metrics.length; m++) {
      out.push(finalise(metrics[m]!.aggregation, b.acc[m]!));
    }
    return out;
  });

  // Sort: by requested field, else chronologically for time, else by the
  // first metric descending — the ordering a human would ask for anyway.
  const sortIndex = query.orderBy ? columns.indexOf(query.orderBy.field) : -1;
  if (sortIndex >= 0) {
    const dir = query.orderBy!.direction === 'asc' ? 1 : -1;
    rows.sort((a, b) => compareCells(a[sortIndex], b[sortIndex]) * dir);
  } else if (groups.length > 0 && groups[0]!.isTime) {
    rows.sort((a, b) => compareCells(a[0], b[0]));
  } else if (groups.length > 0 && metrics.length > 0) {
    const mi = groups.length;
    rows.sort((a, b) => compareCells(b[mi], a[mi]));
  }

  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const truncated = rows.length > limit;
  if (truncated) rows = rows.slice(0, limit);

  return {
    columns,
    rows,
    rowCount: rows.length,
    scanned,
    explanation: explain(dataset, metrics, groups, query, notes, scanned),
    truncated,
  };
}

function finalise(
  agg: Aggregation,
  a: { sum: number; count: number; min: number; max: number; values: number[]; distinct: Set<string> },
): number | null {
  switch (agg) {
    case 'count': return a.count;
    case 'count_distinct': return a.distinct.size;
    case 'sum': return a.count === 0 ? null : round(a.sum);
    case 'avg': return a.count === 0 ? null : round(a.sum / a.count);
    case 'min': return a.count === 0 ? null : round(a.min);
    case 'max': return a.count === 0 ? null : round(a.max);
    case 'median': return a.values.length === 0 ? null : round(median(a.values));
    default: return null;
  }
}

/** Keep six significant decimals; enough for money and rates, no float noise. */
function round(v: number): number {
  if (!isFinite(v)) return 0;
  return Math.round(v * 1e6) / 1e6;
}

function compareCells(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'ru');
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Row bitmask of which rows survive every filter. */
export function buildFilterMask(dataset: Dataset, filters: QueryFilter[]): Uint8Array {
  const mask = new Uint8Array(dataset.rowCount).fill(1);
  for (const f of filters) {
    const ci = resolveFilterColumn(dataset, f.field);
    const raw = dataset.values[ci]!;
    const nums = dataset.numericCache[ci];
    const times = dataset.timeCache[ci];

    for (let r = 0; r < dataset.rowCount; r++) {
      if (!mask[r]) continue;
      if (!matches(f, raw[r] ?? null, nums?.[r], times?.[r])) mask[r] = 0;
    }
  }
  return mask;
}

function resolveFilterColumn(dataset: Dataset, field: string): number {
  const direct = dataset.columns.indexOf(field);
  if (direct >= 0) return direct;

  const model = dataset.semantic;
  const measure = findMeasure(model, field);
  if (measure && measure.column !== '*') {
    const i = dataset.columns.indexOf(measure.column);
    if (i >= 0) return i;
  }
  const dim = findDimension(model, field);
  if (dim) {
    const i = dataset.columns.indexOf(dim.column);
    if (i >= 0) return i;
  }
  const time = findTimeDimension(model, field);
  if (time) {
    const i = dataset.columns.indexOf(time.column);
    if (i >= 0) return i;
  }
  throw new QueryError(`Поле фильтра «${field}» не найдено.`, [
    `Доступные поля: ${dataset.columns.join(', ')}`,
  ]);
}

function matches(
  f: QueryFilter,
  raw: string | null,
  num: number | undefined,
  time: number | undefined,
): boolean {
  switch (f.operator) {
    case 'is_null': return raw === null;
    case 'not_null': return raw !== null;
    case 'eq': return raw !== null && String(raw) === String(f.value);
    case 'neq': return raw === null || String(raw) !== String(f.value);
    case 'contains':
      return raw !== null && raw.toLowerCase().includes(String(f.value ?? '').toLowerCase());
    case 'in': {
      const set = new Set((Array.isArray(f.value) ? f.value : [f.value]).map(String));
      return raw !== null && set.has(String(raw));
    }
    case 'gt': case 'gte': case 'lt': case 'lte': case 'between': {
      const left = pickComparable(num, time, raw);
      if (left === null) return false;
      const bounds = comparableBounds(f, time !== undefined && !isNaN(time));
      if (bounds === null) return false;
      switch (f.operator) {
        case 'gt': return left > bounds[0]!;
        case 'gte': return left >= bounds[0]!;
        case 'lt': return left < bounds[0]!;
        case 'lte': return left <= bounds[0]!;
        case 'between': return left >= bounds[0]! && left <= bounds[1]!;
      }
      return false;
    }
    default: return true;
  }
}

function pickComparable(num: number | undefined, time: number | undefined, raw: string | null): number | null {
  if (time !== undefined && !isNaN(time)) return time;
  if (num !== undefined && !isNaN(num)) return num;
  if (raw === null) return null;
  const parsed = Number(raw);
  return isNaN(parsed) ? null : parsed;
}

function comparableBounds(f: QueryFilter, temporal: boolean): [number, number] | null {
  const toNum = (v: unknown): number | null => {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return null;
    if (temporal) {
      const t = Date.parse(v);
      if (!isNaN(t)) return t;
    }
    const n = Number(v);
    return isNaN(n) ? null : n;
  };

  if (f.operator === 'between') {
    if (!Array.isArray(f.value) || f.value.length < 2) return null;
    const a = toNum(f.value[0]);
    const b = toNum(f.value[1]);
    return a === null || b === null ? null : [Math.min(a, b), Math.max(a, b)];
  }
  const a = toNum(f.value);
  return a === null ? null : [a, a];
}

// ---------------------------------------------------------------------------
// Explanation
// ---------------------------------------------------------------------------

function explain(
  dataset: Dataset,
  metrics: ResolvedMetric[],
  groups: ResolvedGroup[],
  query: SemanticQuery,
  notes: string[],
  scanned: number,
): string {
  const parts: string[] = [];
  parts.push(`Рассчитано ${metrics.map((m) => m.label).join(', ')}`);
  if (groups.length > 0) {
    const g = groups.map((x) => (x.isTime ? `${x.label} (шаг: ${x.grain})` : x.label));
    parts.push(`в разрезе ${g.join(' × ')}`);
  }
  if (query.filters && query.filters.length > 0) {
    parts.push(`с фильтрами: ${query.filters.map(describeFilter).join('; ')}`);
  }
  parts.push(`по ${scanned} из ${dataset.rowCount} строк набора «${dataset.name}»`);
  let text = parts.join(' ') + '.';
  if (notes.length > 0) text += ' ' + notes.join(' ');
  return text;
}

function describeFilter(f: QueryFilter): string {
  const ops: Record<string, string> = {
    eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
    in: 'входит в', between: 'между', contains: 'содержит',
    is_null: 'пусто', not_null: 'не пусто',
  };
  const op = ops[f.operator] ?? f.operator;
  if (f.operator === 'is_null' || f.operator === 'not_null') return `${f.field} ${op}`;
  const val = Array.isArray(f.value) ? f.value.join(', ') : String(f.value);
  return `${f.field} ${op} ${val}`;
}
