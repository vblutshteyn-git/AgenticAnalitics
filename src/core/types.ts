/**
 * Core domain types.
 *
 * The design rule that runs through this file: numbers are produced by code,
 * language is produced by the model. Every Insight therefore carries the
 * evidence and the computation trace that produced it, so a reader can audit
 * the claim without trusting the narration.
 */

export type LogicalType =
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'category'
  | 'text'
  | 'identifier'
  | 'unknown';

/** How the semantic layer lets an agent use a column. */
export type SemanticRole =
  | 'measure'
  | 'dimension'
  | 'time'
  | 'identifier'
  | 'ignored';

export type Aggregation = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct' | 'median';

export interface ColumnProfile {
  name: string;
  index: number;
  logicalType: LogicalType;
  /** Fraction of rows that are null/blank, 0..1 */
  nullRate: number;
  distinctCount: number;
  /** distinctCount / rowCount, 0..1 */
  cardinalityRatio: number;
  /** Set for numeric columns. */
  numeric?: NumericStats;
  /** Set for date/datetime columns. */
  temporal?: TemporalStats;
  /** Most frequent values, for category-ish columns. */
  topValues?: Array<{ value: string; count: number; share: number }>;
  /** Values that could not be coerced into logicalType. */
  invalidCount: number;
  sample: string[];
}

export interface NumericStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  stdev: number;
  /** Median absolute deviation, scaled to be a robust stdev estimate. */
  mad: number;
  p05: number;
  p25: number;
  p75: number;
  p95: number;
  sum: number;
  zeroCount: number;
  negativeCount: number;
}

export interface TemporalStats {
  min: string;
  max: string;
  /** Detected spacing of observations. */
  grain: TimeGrain;
  /** Number of distinct periods at the detected grain. */
  periods: number;
  /** Periods with no rows, at the detected grain. */
  gaps: number;
}

export type TimeGrain = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year' | 'irregular';

/**
 * The semantic layer. Gartner's 2026 market guide predicts most MCP-only
 * agentic analytics projects fail for want of exactly this: a stable,
 * inspectable contract about what the columns *mean*. Agents query through
 * this model, never against raw column names they guessed at.
 */
export interface SemanticModel {
  datasetId: string;
  /** What one row represents, e.g. "one order". */
  grainDescription: string;
  measures: MeasureDef[];
  dimensions: DimensionDef[];
  timeDimensions: TimeDimensionDef[];
  identifiers: string[];
  /** Columns deliberately excluded from analysis, with the reason. */
  ignored: Array<{ column: string; reason: string }>;
  /** True once a human has reviewed the auto-generated model. */
  reviewed: boolean;
}

export interface MeasureDef {
  name: string;
  column: string;
  defaultAggregation: Aggregation;
  /** Additive over every dimension (revenue) vs not (a ratio, a running balance). */
  additive: boolean;
  /** Higher is better / lower is better / unknown. Drives how insights are framed. */
  polarity: 'higher_is_better' | 'lower_is_better' | 'neutral';
  unit?: string;
  description: string;
}

export interface DimensionDef {
  name: string;
  column: string;
  cardinality: number;
  /** Suitable for grouping. High-cardinality dims are grouped by top-N only. */
  groupable: boolean;
  description: string;
}

export interface TimeDimensionDef {
  name: string;
  column: string;
  grain: TimeGrain;
  min: string;
  max: string;
  description: string;
}

export interface Dataset {
  id: string;
  name: string;
  source: 'mcp' | 'upload' | 'sample';
  createdAt: string;
  rowCount: number;
  columns: string[];
  /** Column-oriented storage: values[colIndex][rowIndex]. */
  values: Array<Array<string | null>>;
  /** Parsed numeric projection per column, null where not numeric. */
  numericCache: Array<Float64Array | null>;
  /** Parsed epoch-ms projection per column, null where not temporal. */
  timeCache: Array<Float64Array | null>;
  profiles: ColumnProfile[];
  semantic: SemanticModel;
  notes?: string;
}

export interface DatasetSummary {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  rowCount: number;
  columnCount: number;
  measures: number;
  dimensions: number;
  hasTime: boolean;
  insightCount: number;
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

export type InsightKind =
  | 'trend'
  | 'anomaly'
  | 'driver'
  | 'correlation'
  | 'concentration'
  | 'comparison'
  | 'quality';

/**
 * A finding the agent is prepared to defend. `evidence` holds the numbers,
 * `trace` holds how they were computed, `caveats` holds what would falsify it.
 */
export interface Insight {
  id: string;
  datasetId: string;
  kind: InsightKind;
  title: string;
  /** One-paragraph plain-language reading of the evidence. */
  narrative: string;
  /** 0..1 — how much of the business quantity this touches. */
  impact: number;
  /** 0..1 — statistical strength, sample adequacy, data quality combined. */
  confidence: number;
  /** impact * confidence, adjusted for redundancy against other insights. */
  score: number;
  evidence: Evidence;
  /** Human-readable record of the computation, in order. */
  trace: string[];
  /** Conditions under which this finding would not hold. */
  caveats: string[];
  nextSteps: NextStep[];
  chart?: ChartSpec;
  /** Fields the insight is about, for dedup and cross-linking. */
  subjects: string[];
  createdAt: string;
}

export interface Evidence {
  /** Primary statistic, e.g. slope, z-score, correlation. */
  statistic: number;
  statisticLabel: string;
  /** Probability of seeing this under the null hypothesis, where defined. */
  pValue?: number;
  /** Standardised effect size, where defined. */
  effectSize?: number;
  effectSizeLabel?: string;
  sampleSize: number;
  /** Supporting numbers keyed by label, rendered as a table in the UI. */
  facts: Array<{ label: string; value: string }>;
}

export interface NextStep {
  action: string;
  rationale: string;
  /** 'investigate' asks a follow-up question, 'act' changes something. */
  type: 'investigate' | 'act' | 'monitor' | 'fix_data';
  /** A ready-to-run query the user can execute to dig in. */
  query?: SemanticQuery;
}

export interface ChartSpec {
  type: 'line' | 'bar' | 'scatter' | 'hbar';
  xLabel: string;
  yLabel: string;
  /**
   * Unit of the plotted values, so the renderer can format them sensibly.
   * Without it a rate of 0.0144 renders as "0,01" and the chart says nothing.
   */
  unit?: string;
  series: Array<{
    name: string;
    points: Array<{ x: number | string; y: number; annotation?: string }>;
  }>;
  /** Reference line, e.g. a fitted trend or a control limit. */
  reference?: { label: string; points: Array<{ x: number | string; y: number }> };
}

// ---------------------------------------------------------------------------
// Semantic query — the only way agents read data
// ---------------------------------------------------------------------------

/**
 * A structured query against the semantic model. There is deliberately no
 * raw-SQL path: the agent can only express questions the semantic layer has
 * declared meaningful, which is what keeps its answers auditable.
 */
export interface SemanticQuery {
  datasetId: string;
  /** Measure names from the semantic model, with the aggregation to apply. */
  metrics: Array<{ measure: string; aggregation?: Aggregation }>;
  /** Dimension or time-dimension names to group by. */
  groupBy?: string[];
  /** Bucket a time dimension before grouping. */
  timeGrain?: TimeGrain;
  filters?: QueryFilter[];
  orderBy?: { field: string; direction: 'asc' | 'desc' };
  limit?: number;
}

export interface QueryFilter {
  field: string;
  operator: 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'is_null' | 'not_null' | 'contains';
  value?: string | number | Array<string | number>;
}

export interface QueryResult {
  columns: string[];
  rows: Array<Array<string | number | null>>;
  rowCount: number;
  /** Rows scanned before aggregation — surfaced so cost is visible. */
  scanned: number;
  /** Plain-language restatement of what was executed. */
  explanation: string;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Agent run
// ---------------------------------------------------------------------------

export type AgentPhase =
  | 'ingest'
  | 'profile'
  | 'semantic'
  | 'quality_gate'
  | 'hypothesize'
  | 'test'
  | 'verify'
  | 'rank'
  | 'narrate'
  | 'done'
  | 'error';

export interface AgentEvent {
  runId: string;
  phase: AgentPhase;
  /** Monotonic step number within the run. */
  step: number;
  message: string;
  detail?: string;
  /** 0..1 overall progress estimate. */
  progress: number;
  timestamp: string;
  /** Emitted as insights are confirmed, so the UI can stream them in. */
  insight?: Insight;
  /** Set on the terminal event. */
  summary?: RunSummary;
}

export interface RunSummary {
  runId: string;
  datasetId: string;
  hypothesesGenerated: number;
  hypothesesTested: number;
  insightsConfirmed: number;
  insightsRejected: number;
  rejectionReasons: Record<string, number>;
  durationMs: number;
  llmUsed: boolean;
  /** Headline read on the dataset as a whole. */
  headline: string;
  nextSteps: NextStep[];
}

export interface Hypothesis {
  id: string;
  kind: InsightKind;
  /** The question in words, e.g. "Is revenue trending over time?" */
  question: string;
  /** Priority 0..1 used to spend the testing budget where it pays. */
  priority: number;
  params: Record<string, unknown>;
}
