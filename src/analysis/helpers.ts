/**
 * Shared machinery for the analyzers: pulling series out of a dataset,
 * scoring findings, and formatting numbers for narration.
 */

import { bucketKey, formatBucket } from '../core/profile.js';
import { median } from '../core/stats.js';
import type {
  Aggregation,
  Dataset,
  DimensionDef,
  Insight,
  MeasureDef,
  TimeDimensionDef,
  TimeGrain,
} from '../core/types.js';

export interface TimeSeries {
  /** Bucket start timestamps, ascending. */
  buckets: number[];
  labels: string[];
  /** Aggregated measure value per bucket. */
  values: number[];
  /** Rows contributing to each bucket — small buckets get less trust. */
  counts: number[];
  grain: TimeGrain;
  /** Boundary buckets removed as incomplete, for disclosure in the trace. */
  trimmed: { leading: boolean; trailing: boolean };
}

/**
 * Volume below this share of the typical bucket marks a boundary period as
 * incomplete rather than collapsed.
 */
const PARTIAL_BUCKET_RATIO = 0.5;

/**
 * Drop leading and trailing buckets that are obviously incomplete.
 *
 * A dataset almost never ends exactly on a period boundary, so the final
 * bucket usually holds a few days of a week or a few weeks of a month. Charted
 * naively it reads as a catastrophic drop — and because it affects *every*
 * measure at once, an anomaly detector will faithfully report a cliff in each
 * one on the same date. It is the single most common false alarm in real
 * dashboards, and it is entirely an artifact of where the export happened to
 * stop.
 *
 * Interior buckets are never trimmed: a gap in the middle is real missing
 * data, and the quality gate reports it as such.
 */
function trimPartialBuckets(series: TimeSeries): TimeSeries {
  const n = series.counts.length;
  if (n < 5) return series;

  const interior = series.counts.slice(1, -1).filter((c) => c > 0);
  if (interior.length < 3) return series;
  const typical = median(interior);
  if (typical <= 0) return series;

  let start = 0;
  let end = n;
  const leading = series.counts[0]! > 0 && series.counts[0]! < typical * PARTIAL_BUCKET_RATIO;
  const trailing = series.counts[n - 1]! > 0 && series.counts[n - 1]! < typical * PARTIAL_BUCKET_RATIO;
  if (leading) start = 1;
  if (trailing) end = n - 1;
  if (start === 0 && end === n) return series;

  return {
    buckets: series.buckets.slice(start, end),
    labels: series.labels.slice(start, end),
    values: series.values.slice(start, end),
    counts: series.counts.slice(start, end),
    grain: series.grain,
    trimmed: { leading, trailing },
  };
}

/**
 * Aggregate a measure into equally spaced time buckets.
 *
 * Empty interior buckets are materialised with a value of 0 for additive
 * measures (no orders really does mean zero revenue) but skipped entirely for
 * non-additive ones, where a missing average is unknown rather than zero.
 */
export function buildTimeSeries(
  dataset: Dataset,
  measure: MeasureDef,
  time: TimeDimensionDef,
  grain: TimeGrain,
  aggregation?: Aggregation,
  mask?: Uint8Array,
): TimeSeries {
  const agg = aggregation ?? measure.defaultAggregation;
  const timeIdx = dataset.columns.indexOf(time.column);
  const measureIdx = measure.column === '*' ? -1 : dataset.columns.indexOf(measure.column);
  const times = dataset.timeCache[timeIdx];
  const nums = measureIdx >= 0 ? dataset.numericCache[measureIdx] : null;

  const acc = new Map<number, { sum: number; count: number; values: number[] }>();
  const needValues = agg === 'median';

  for (let r = 0; r < dataset.rowCount; r++) {
    if (mask && !mask[r]) continue;
    const t = times?.[r];
    if (t === undefined || isNaN(t)) continue;
    const key = bucketKey(t, grain);

    let entry = acc.get(key);
    if (!entry) {
      entry = { sum: 0, count: 0, values: [] };
      acc.set(key, entry);
    }

    if (measureIdx < 0) {
      entry.count++;
      continue;
    }
    const v = nums?.[r];
    if (v === undefined || isNaN(v)) continue;
    entry.sum += v;
    entry.count++;
    if (needValues) entry.values.push(v);
  }

  const keys = Array.from(acc.keys()).sort((a, b) => a - b);
  const noTrim = { leading: false, trailing: false };
  if (keys.length === 0) {
    return { buckets: [], labels: [], values: [], counts: [], grain, trimmed: noTrim };
  }

  // Fill interior gaps so a trend fit is not distorted by uneven spacing.
  const filled: number[] = [];
  if (grain !== 'irregular') {
    let cursor = keys[0]!;
    const last = keys[keys.length - 1]!;
    let guard = 0;
    while (cursor <= last && guard++ < 20000) {
      filled.push(cursor);
      cursor = nextBucket(cursor, grain);
    }
  }
  const axis = filled.length >= keys.length ? filled : keys;

  const buckets: number[] = [];
  const labels: string[] = [];
  const values: number[] = [];
  const counts: number[] = [];

  for (const k of axis) {
    const entry = acc.get(k);
    if (!entry) {
      if (!measure.additive) continue; // unknown, not zero
      buckets.push(k);
      labels.push(formatBucket(k, grain));
      values.push(0);
      counts.push(0);
      continue;
    }
    buckets.push(k);
    labels.push(formatBucket(k, grain));
    values.push(finaliseAgg(agg, entry));
    counts.push(entry.count);
  }

  return trimPartialBuckets({ buckets, labels, values, counts, grain, trimmed: noTrim });
}

function finaliseAgg(agg: Aggregation, e: { sum: number; count: number; values: number[] }): number {
  switch (agg) {
    case 'count': return e.count;
    case 'avg': return e.count === 0 ? 0 : e.sum / e.count;
    case 'median': return e.values.length === 0 ? 0 : median(e.values);
    default: return e.sum;
  }
}

export function nextBucket(epochMs: number, grain: TimeGrain): number {
  const d = new Date(epochMs);
  switch (grain) {
    case 'hour': return epochMs + 3600_000;
    case 'day': return epochMs + 86400_000;
    case 'week': return epochMs + 7 * 86400_000;
    case 'month': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    case 'quarter': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1);
    case 'year': return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
    default: return epochMs + 86400_000;
  }
}

export interface GroupAggregate {
  value: string;
  sum: number;
  count: number;
  mean: number;
  /** Raw values, retained for significance testing between segments. */
  values: number[];
}

/**
 * Aggregate a measure by a dimension. `maxGroups` caps the result at the
 * largest segments so a high-cardinality field cannot blow up the run.
 */
export function buildGroupAggregates(
  dataset: Dataset,
  measure: MeasureDef,
  dimension: DimensionDef,
  maxGroups = 60,
  mask?: Uint8Array,
): { groups: GroupAggregate[]; truncatedGroups: number; totalRows: number } {
  const dimIdx = dataset.columns.indexOf(dimension.column);
  const measureIdx = measure.column === '*' ? -1 : dataset.columns.indexOf(measure.column);
  const dimValues = dataset.values[dimIdx];
  const nums = measureIdx >= 0 ? dataset.numericCache[measureIdx] : null;

  const acc = new Map<string, GroupAggregate>();
  let totalRows = 0;

  for (let r = 0; r < dataset.rowCount; r++) {
    if (mask && !mask[r]) continue;
    const raw = dimValues?.[r] ?? null;
    const key = raw === null ? '(пусто)' : raw;

    let entry = acc.get(key);
    if (!entry) {
      entry = { value: key, sum: 0, count: 0, mean: 0, values: [] };
      acc.set(key, entry);
    }

    if (measureIdx < 0) {
      entry.count++;
      entry.values.push(1);
      totalRows++;
      continue;
    }
    const v = nums?.[r];
    if (v === undefined || isNaN(v)) continue;
    entry.sum += v;
    entry.count++;
    entry.values.push(v);
    totalRows++;
  }

  for (const g of acc.values()) g.mean = g.count === 0 ? 0 : g.sum / g.count;

  const all = Array.from(acc.values()).sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum));
  return {
    groups: all.slice(0, maxGroups),
    truncatedGroups: Math.max(0, all.length - maxGroups),
    totalRows,
  };
}

/** Numeric pairs for two measures, keeping only rows where both are present. */
export function pairedValues(
  dataset: Dataset,
  a: MeasureDef,
  b: MeasureDef,
): { xs: number[]; ys: number[] } {
  const ai = dataset.columns.indexOf(a.column);
  const bi = dataset.columns.indexOf(b.column);
  const an = dataset.numericCache[ai];
  const bn = dataset.numericCache[bi];
  const xs: number[] = [];
  const ys: number[] = [];
  if (!an || !bn) return { xs, ys };
  for (let r = 0; r < dataset.rowCount; r++) {
    const x = an[r]!;
    const y = bn[r]!;
    if (isNaN(x) || isNaN(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  return { xs, ys };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Turn a p-value and a sample size into a 0..1 confidence.
 *
 * Significance alone is not enough: with 100k rows almost everything is
 * "significant", so small samples are penalised and the semantic model being
 * unreviewed caps the ceiling. This is the main defence against the failure
 * mode the market keeps hitting — a fluent agent narrating noise.
 */
export function confidenceFrom(opts: {
  pValue?: number;
  sampleSize: number;
  minSample: number;
  /** 0..1 quality of the underlying columns (1 = clean). */
  dataQuality?: number;
  semanticReviewed?: boolean;
  /** Extra multiplier for analyzer-specific doubts. */
  penalty?: number;
}): number {
  const { pValue, sampleSize, minSample } = opts;

  let statistical = 0.5;
  if (pValue !== undefined) {
    if (pValue <= 0.001) statistical = 1.0;
    else if (pValue <= 0.01) statistical = 0.9;
    else if (pValue <= 0.05) statistical = 0.75;
    else if (pValue <= 0.1) statistical = 0.5;
    else statistical = 0.25;
  }

  // Ramp from 0.4 at the bare minimum sample to 1.0 at 4x that.
  const ratio = sampleSize / Math.max(1, minSample);
  const sampleFactor = ratio < 1 ? 0.3 : Math.min(1, 0.4 + 0.6 * Math.log10(1 + 9 * Math.min(1, (ratio - 1) / 3)));

  const quality = opts.dataQuality ?? 1;
  const reviewFactor = opts.semanticReviewed === false ? 0.9 : 1;
  const penalty = opts.penalty ?? 1;

  return clamp01(statistical * sampleFactor * quality * reviewFactor * penalty);
}

/**
 * Impact on a 0..1 scale from the share of a total a finding accounts for,
 * and the relative size of the effect. Log-compressed so a 500% swing does
 * not drown out everything else in the ranking.
 */
export function impactFrom(opts: {
  /** Share of the dataset total this touches, 0..1. */
  shareOfTotal?: number;
  /** Relative magnitude of the change, e.g. 0.3 for a 30% move. */
  relativeEffect?: number;
  /** Share of rows involved, 0..1. */
  coverage?: number;
}): number {
  const share = clamp01(opts.shareOfTotal ?? 0);
  const effect = Math.min(1, Math.log10(1 + 9 * Math.min(1, Math.abs(opts.relativeEffect ?? 0))));
  const coverage = clamp01(opts.coverage ?? 0);
  // Weighted so "big slice of the business" outranks "big percentage of nothing".
  const raw = 0.45 * share + 0.35 * effect + 0.2 * coverage;
  return clamp01(raw);
}

export function clamp01(v: number): number {
  if (!isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** Overall data quality for a set of columns, 0..1. */
export function qualityOf(dataset: Dataset, columns: string[]): number {
  let worst = 1;
  for (const col of columns) {
    if (col === '*') continue;
    const p = dataset.profiles.find((x) => x.name === col);
    if (!p) continue;
    const nullPenalty = 1 - Math.min(0.6, p.nullRate);
    const invalidPenalty = 1 - Math.min(0.4, p.invalidCount / Math.max(1, dataset.rowCount));
    worst = Math.min(worst, nullPenalty * invalidPenalty);
  }
  return clamp01(worst);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const nfCompact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });

export function formatNumber(v: number, unit?: string): string {
  if (!isFinite(v)) return '—';
  if (unit === '%') return `${nf.format(v <= 1 && v >= -1 ? v * 100 : v)}%`;
  const abs = Math.abs(v);
  const text = abs >= 1_000_000 ? nfCompact.format(v) : nf.format(v);
  return unit ? `${text} ${unit}` : text;
}

export function formatPercent(fraction: number, digits = 1): string {
  if (!isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatSigned(fraction: number, digits = 1): string {
  if (!isFinite(fraction)) return '—';
  const sign = fraction > 0 ? '+' : '';
  return `${sign}${(fraction * 100).toFixed(digits)}%`;
}

export function formatP(p: number | undefined): string {
  if (p === undefined || !isFinite(p)) return '—';
  if (p < 0.0001) return 'p < 0,0001';
  return `p = ${p.toFixed(4).replace('.', ',')}`;
}

/** Direction word coloured by whether the measure wants to go up or down. */
export function polarityVerdict(measure: MeasureDef, direction: 'up' | 'down'): string {
  if (measure.polarity === 'neutral') return '';
  const good =
    (measure.polarity === 'higher_is_better' && direction === 'up') ||
    (measure.polarity === 'lower_is_better' && direction === 'down');
  return good ? ' Это движение в благоприятную сторону.' : ' Это движение в неблагоприятную сторону.';
}

let insightCounter = 0;

export function makeInsightId(kind: string): string {
  insightCounter += 1;
  return `${kind}-${Date.now().toString(36)}-${insightCounter}`;
}

export function baseInsight(fields: Omit<Insight, 'id' | 'score' | 'createdAt'>): Insight {
  return {
    ...fields,
    id: makeInsightId(fields.kind),
    score: fields.impact * fields.confidence,
    createdAt: new Date().toISOString(),
  };
}
