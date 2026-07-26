/**
 * Column profiling: the agent's first read of unfamiliar data.
 *
 * Produces per-column statistics plus the numeric and temporal projections
 * that every later analysis reuses, so parsing happens exactly once.
 */

import {
  coerceDate,
  coerceNumber,
  detectDayFirst,
  inferType,
} from './ingest.js';
import { mad, mean, median, percentile, stdev } from './stats.js';
import type {
  ColumnProfile,
  LogicalType,
  NumericStats,
  TemporalStats,
  TimeGrain,
} from './types.js';

export interface ProfileOutput {
  profiles: ColumnProfile[];
  numericCache: Array<Float64Array | null>;
  timeCache: Array<Float64Array | null>;
}

const NUMERIC_TYPES = new Set<LogicalType>(['number', 'integer']);
const TEMPORAL_TYPES = new Set<LogicalType>(['date', 'datetime']);

export function profileTable(
  columns: string[],
  values: Array<Array<string | null>>,
  rowCount: number,
): ProfileOutput {
  const profiles: ColumnProfile[] = [];
  const numericCache: Array<Float64Array | null> = [];
  const timeCache: Array<Float64Array | null> = [];

  columns.forEach((name, ci) => {
    const col = values[ci] ?? [];
    const inference = inferType(name, col);
    let type = inference.type;

    const nullCount = col.reduce((acc, v) => acc + (v === null ? 1 : 0), 0);
    const distinct = new Set(col.filter((v): v is string => v !== null));

    let numeric: Float64Array | null = null;
    let temporal: Float64Array | null = null;

    if (NUMERIC_TYPES.has(type)) {
      numeric = new Float64Array(rowCount);
      for (let r = 0; r < rowCount; r++) {
        const n = coerceNumber(col[r] ?? null);
        numeric[r] = n === null ? NaN : n;
      }
    }

    if (TEMPORAL_TYPES.has(type)) {
      const dayFirst = inference.dayFirst;
      temporal = new Float64Array(rowCount);
      for (let r = 0; r < rowCount; r++) {
        const t = coerceDate(col[r] ?? null, dayFirst);
        temporal[r] = t === null ? NaN : t;
      }
    }

    // Booleans get a 0/1 numeric projection so they can act as rate measures.
    if (type === 'boolean') {
      numeric = new Float64Array(rowCount);
      for (let r = 0; r < rowCount; r++) {
        const v = col[r];
        if (v === null || v === undefined) {
          numeric[r] = NaN;
        } else {
          const s = v.trim().toLowerCase();
          numeric[r] = ['true', 'yes', 'y', '1', 'да', 't'].includes(s) ? 1 : 0;
        }
      }
    }

    const profile: ColumnProfile = {
      name,
      index: ci,
      logicalType: type,
      nullRate: rowCount === 0 ? 0 : nullCount / rowCount,
      distinctCount: distinct.size,
      cardinalityRatio: rowCount === 0 ? 0 : distinct.size / rowCount,
      invalidCount: inference.invalidCount,
      sample: Array.from(distinct).slice(0, 5),
    };

    if (numeric) {
      const stats = computeNumericStats(numeric);
      if (stats) profile.numeric = stats;
    }
    if (temporal) {
      const stats = computeTemporalStats(temporal);
      if (stats) profile.temporal = stats;
    }
    if (type === 'category' || type === 'boolean' || distinct.size <= 60) {
      profile.topValues = computeTopValues(col, rowCount);
    }

    profiles.push(profile);
    numericCache.push(numeric);
    timeCache.push(temporal);
  });

  return { profiles, numericCache, timeCache };
}

export function computeNumericStats(values: Float64Array): NumericStats | null {
  const clean: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!isNaN(v) && isFinite(v)) clean.push(v);
  }
  if (clean.length === 0) return null;

  let zeroCount = 0;
  let negativeCount = 0;
  let total = 0;
  for (const v of clean) {
    if (v === 0) zeroCount++;
    else if (v < 0) negativeCount++;
    total += v;
  }

  return {
    count: clean.length,
    min: Math.min(...clean),
    max: Math.max(...clean),
    mean: mean(clean),
    median: median(clean),
    stdev: stdev(clean),
    mad: mad(clean),
    p05: percentile(clean, 0.05),
    p25: percentile(clean, 0.25),
    p75: percentile(clean, 0.75),
    p95: percentile(clean, 0.95),
    sum: total,
    zeroCount,
    negativeCount,
  };
}

export function computeTemporalStats(values: Float64Array): TemporalStats | null {
  const clean: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!isNaN(v) && isFinite(v)) clean.push(v);
  }
  if (clean.length === 0) return null;
  clean.sort((a, b) => a - b);

  const min = clean[0]!;
  const max = clean[clean.length - 1]!;
  const grain = detectGrain(clean);
  const buckets = new Set(clean.map((t) => bucketKey(t, grain)));
  const expected = expectedPeriods(min, max, grain);

  return {
    min: new Date(min).toISOString(),
    max: new Date(max).toISOString(),
    grain,
    periods: buckets.size,
    gaps: Math.max(0, expected - buckets.size),
  };
}

/**
 * Infer the natural spacing of a timestamp column from the median gap between
 * consecutive distinct observations. The median resists the long gaps that
 * weekends and holidays introduce.
 */
export function detectGrain(sortedTimes: number[]): TimeGrain {
  const distinct = Array.from(new Set(sortedTimes)).sort((a, b) => a - b);
  if (distinct.length < 2) return 'day';

  const gaps: number[] = [];
  for (let i = 1; i < distinct.length; i++) gaps.push(distinct[i]! - distinct[i - 1]!);
  const g = median(gaps);

  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  if (g < 2 * HOUR) return 'hour';
  if (g < 2 * DAY) return 'day';
  if (g < 10 * DAY) return 'week';
  if (g < 45 * DAY) return 'month';
  if (g < 130 * DAY) return 'quarter';
  if (g < 500 * DAY) return 'year';
  return 'irregular';
}

/** Truncate a timestamp to the start of its period, as an epoch-ms number. */
export function truncateTo(epochMs: number, grain: TimeGrain): number {
  const d = new Date(epochMs);
  switch (grain) {
    case 'hour':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
    case 'day':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    case 'week': {
      // ISO weeks start on Monday.
      const day = d.getUTCDay();
      const offset = (day + 6) % 7;
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset);
    }
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    case 'quarter':
      return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
    case 'year':
      return Date.UTC(d.getUTCFullYear(), 0, 1);
    default:
      return epochMs;
  }
}

export function bucketKey(epochMs: number, grain: TimeGrain): number {
  return truncateTo(epochMs, grain);
}

/** Label a bucket start for display at the given grain. */
export function formatBucket(epochMs: number, grain: TimeGrain): string {
  const d = new Date(epochMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  switch (grain) {
    case 'hour':
      return `${yyyy}-${mm}-${dd} ${hh}:00`;
    case 'day':
    case 'week':
      return `${yyyy}-${mm}-${dd}`;
    case 'month':
      return `${yyyy}-${mm}`;
    case 'quarter':
      return `${yyyy}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    case 'year':
      return `${yyyy}`;
    default:
      return d.toISOString().slice(0, 10);
  }
}

/** How many periods a range spans, used to count missing buckets. */
export function expectedPeriods(min: number, max: number, grain: TimeGrain): number {
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  const span = max - min;
  switch (grain) {
    case 'hour':
      return Math.floor(span / HOUR) + 1;
    case 'day':
      return Math.floor(span / DAY) + 1;
    case 'week':
      return Math.floor(span / (7 * DAY)) + 1;
    case 'month': {
      const a = new Date(min), b = new Date(max);
      return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
    }
    case 'quarter': {
      const a = new Date(min), b = new Date(max);
      return Math.floor(
        ((b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())) / 3,
      ) + 1;
    }
    case 'year': {
      const a = new Date(min), b = new Date(max);
      return b.getUTCFullYear() - a.getUTCFullYear() + 1;
    }
    default:
      return 0;
  }
}

function computeTopValues(
  col: Array<string | null>,
  rowCount: number,
): Array<{ value: string; count: number; share: number }> {
  const counts = new Map<string, number>();
  for (const v of col) {
    if (v === null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([value, count]) => ({
      value,
      count,
      share: rowCount === 0 ? 0 : count / rowCount,
    }));
}
