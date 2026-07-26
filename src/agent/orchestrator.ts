/**
 * The data-to-insight loop.
 *
 * plan → profile → semantic model → quality gate → hypothesise → test →
 * verify → rank → narrate
 *
 * Two design commitments run through it:
 *
 *  - The agent generates *hypotheses*, not answers. Each one is tested by the
 *    deterministic code in ../analysis, so what reaches the user is a claim
 *    that survived a statistical check, not a plausible-sounding sentence.
 *  - The verification stage rejects, and says why. The rejection tally is part
 *    of the run summary, because "we tested 84 things and 6 held up" is the
 *    fact that makes the 6 trustworthy.
 *
 * Every phase yields an event, so the UI can show the loop working rather than
 * a spinner over a black box.
 */

import { analyzeAnomalies } from '../analysis/anomaly.js';
import { analyzeComparison } from '../analysis/comparison.js';
import { analyzeConcentration } from '../analysis/concentration.js';
import { analyzeCorrelation } from '../analysis/correlation.js';
import { analyzeDrivers } from '../analysis/drivers.js';
import { assessQuality, type QualityReport } from '../analysis/quality.js';
import { benjaminiHochberg } from '../core/stats.js';
import type {
  AgentEvent,
  AgentPhase,
  Dataset,
  Hypothesis,
  Insight,
  NextStep,
  RunSummary,
  TimeGrain,
} from '../core/types.js';
import { analyzeTrend } from '../analysis/trend.js';
import { narrateRun, type LlmClient } from './llm.js';

export interface RunOptions {
  /** Cap on hypotheses tested, to bound runtime on wide datasets. */
  maxHypotheses?: number;
  /** Cap on insights returned after ranking. */
  maxInsights?: number;
  /** Minimum score for an insight to be reported. */
  minScore?: number;
  /** Optional LLM for narration. Absent means the run is fully deterministic. */
  llm?: LlmClient | null;
  /** Focus the run on a question in natural language. */
  focus?: string;
}

const DEFAULTS = {
  maxHypotheses: 220,
  maxInsights: 14,
  minScore: 0.04,
};

export async function* runAgent(
  dataset: Dataset,
  options: RunOptions = {},
): AsyncGenerator<AgentEvent, void, undefined> {
  const runId = `run-${Date.now().toString(36)}`;
  const started = Date.now();
  const opts = { ...DEFAULTS, ...options };
  let step = 0;

  const emit = (
    phase: AgentPhase,
    message: string,
    progress: number,
    extra: Partial<AgentEvent> = {},
  ): AgentEvent => ({
    runId,
    phase,
    step: ++step,
    message,
    progress,
    timestamp: new Date().toISOString(),
    ...extra,
  });

  try {
    // --- ingest ------------------------------------------------------------
    yield emit(
      'ingest',
      `Набор «${dataset.name}» принят: ${dataset.rowCount} строк, ${dataset.columns.length} колонок.`,
      0.03,
      { detail: dataset.semantic.grainDescription },
    );

    // --- profile -----------------------------------------------------------
    const typeCounts = new Map<string, number>();
    for (const p of dataset.profiles) {
      typeCounts.set(p.logicalType, (typeCounts.get(p.logicalType) ?? 0) + 1);
    }
    yield emit(
      'profile',
      'Профилирование колонок завершено.',
      0.1,
      {
        detail: Array.from(typeCounts.entries())
          .map(([t, c]) => `${t}: ${c}`)
          .join(', '),
      },
    );

    // --- semantic model ----------------------------------------------------
    const model = dataset.semantic;
    yield emit(
      'semantic',
      `Семантическая модель: ${model.measures.length} метрик, ${model.dimensions.length} измерений, ` +
      `${model.timeDimensions.length} временных осей.`,
      0.16,
      {
        detail: model.reviewed
          ? 'Модель подтверждена пользователем.'
          : 'Модель сгенерирована автоматически и не подтверждена — уверенность всех выводов ограничена сверху.',
      },
    );

    if (model.measures.length === 0) {
      yield emit('error', 'В наборе нет ни одной пригодной метрики — анализировать нечего.', 1);
      return;
    }

    // --- quality gate ------------------------------------------------------
    const quality = assessQuality(dataset);
    yield emit(
      'quality_gate',
      `Проверка качества данных: ${(quality.score * 100).toFixed(0)}%.`,
      0.22,
      {
        detail:
          quality.issues.length === 0
            ? 'Замечаний не найдено.'
            : `${quality.issues.length} замечаний, из них критичных: ` +
              `${quality.issues.filter((i) => i.severity === 'high').length}.`,
      },
    );

    for (const qi of quality.insights) {
      yield emit('quality_gate', qi.title, 0.24, { insight: qi });
    }

    // --- hypothesise -------------------------------------------------------
    const hypotheses = generateHypotheses(dataset, opts.focus).slice(0, opts.maxHypotheses);
    yield emit(
      'hypothesize',
      `Сформировано ${hypotheses.length} гипотез для проверки.`,
      0.3,
      { detail: summariseHypotheses(hypotheses) },
    );

    // --- test --------------------------------------------------------------
    const confirmed: Insight[] = [];
    const rejectionReasons: Record<string, number> = {};
    let tested = 0;

    const noteRejection = (reason: string) => {
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    };

    for (const h of hypotheses) {
      tested++;
      const insight = runHypothesis(dataset, h, quality);

      // Yield progress periodically rather than per hypothesis: at 200+
      // hypotheses an event each would flood the stream.
      if (tested % 15 === 0 || tested === hypotheses.length) {
        yield emit(
          'test',
          `Проверено гипотез: ${tested} из ${hypotheses.length}. Подтверждено: ${confirmed.length}.`,
          0.3 + 0.45 * (tested / Math.max(1, hypotheses.length)),
        );
      }

      if (!insight) {
        noteRejection('Статистика не подтвердила эффект или данных недостаточно');
        continue;
      }
      confirmed.push(insight);
    }

    // --- verify ------------------------------------------------------------
    yield emit('verify', `Верификация ${confirmed.length} предварительных находок.`, 0.78);

    const verified = verify(confirmed, opts.minScore, noteRejection);
    const rejected = confirmed.length - verified.length;
    yield emit(
      'verify',
      `Отклонено при верификации: ${rejected}. Осталось: ${verified.length}.`,
      0.84,
      {
        detail: Object.entries(rejectionReasons)
          .map(([r, c]) => `${r}: ${c}`)
          .join('; ') || 'Причин отклонения нет.',
      },
    );

    // --- rank --------------------------------------------------------------
    const ranked = rank(verified).slice(0, opts.maxInsights);
    yield emit(
      'rank',
      `Отобрано ${ranked.length} находок по совокупности значимости и влияния.`,
      0.88,
    );

    for (const insight of ranked) {
      yield emit('rank', insight.title, 0.9, { insight });
    }

    // --- narrate -----------------------------------------------------------
    let headline = deterministicHeadline(dataset, ranked, quality);
    let llmUsed = false;

    if (opts.llm) {
      yield emit('narrate', 'Формирование итогового вывода с помощью языковой модели.', 0.93);
      try {
        const narrated = await narrateRun(opts.llm, dataset, ranked, quality, opts.focus);
        if (narrated) {
          headline = narrated;
          llmUsed = true;
        }
      } catch (err) {
        // Narration is a nicety; the numbers stand without it.
        yield emit(
          'narrate',
          'Языковая модель недоступна — использован детерминированный вывод.',
          0.95,
          { detail: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    const summary: RunSummary = {
      runId,
      datasetId: dataset.id,
      hypothesesGenerated: hypotheses.length,
      hypothesesTested: tested,
      insightsConfirmed: ranked.length,
      insightsRejected: hypotheses.length - ranked.length,
      rejectionReasons,
      durationMs: Date.now() - started,
      llmUsed,
      headline,
      nextSteps: consolidateNextSteps(ranked, quality),
    };

    yield emit('done', 'Анализ завершён.', 1, { summary });
  } catch (err) {
    yield emit(
      'error',
      `Ошибка при анализе: ${err instanceof Error ? err.message : String(err)}`,
      1,
    );
  }
}

// ---------------------------------------------------------------------------
// Hypothesis generation
// ---------------------------------------------------------------------------

/**
 * Enumerate what is worth asking of this dataset, ordered by expected payoff.
 *
 * The combinatorics are real — every measure against every dimension against
 * every time axis — so pairs are prioritised rather than merely truncated: an
 * additive measure with clear business polarity against a low-cardinality
 * dimension is a far better bet than an unnamed float against a 180-value one.
 */
export function generateHypotheses(dataset: Dataset, focus?: string): Hypothesis[] {
  const model = dataset.semantic;
  const out: Hypothesis[] = [];
  let seq = 0;
  const id = (kind: string) => `${kind}-${++seq}`;

  const focusTerms = (focus ?? '')
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter((t) => t.length > 2);

  /** Boost hypotheses whose subjects match the user's question. */
  const focusBoost = (...names: string[]): number => {
    if (focusTerms.length === 0) return 0;
    const hay = names.join(' ').toLowerCase();
    const hits = focusTerms.filter((t) => hay.includes(t)).length;
    return hits === 0 ? 0 : Math.min(0.5, 0.2 + 0.15 * hits);
  };

  const measurePriority = (name: string): number => {
    const m = model.measures.find((x) => x.name === name);
    if (!m) return 0;
    let p = 0.5;
    if (m.polarity !== 'neutral') p += 0.2; // a measure someone cares about
    if (m.additive) p += 0.1;
    if (m.column === '*') p += 0.05; // row counts are always interpretable
    return Math.min(1, p);
  };

  const dimensionPriority = (cardinality: number): number => {
    // Sweet spot is 2–20 values: enough to compare, few enough to read.
    if (cardinality < 2) return 0;
    if (cardinality <= 20) return 1;
    if (cardinality <= 60) return 0.7;
    if (cardinality <= 200) return 0.4;
    return 0.15;
  };

  const groupable = model.dimensions.filter((d) => d.groupable && d.cardinality >= 2);
  const timeAxes = model.timeDimensions.slice(0, 2);

  // --- time-based: trend and anomaly ---------------------------------------
  for (const time of timeAxes) {
    const grains = candidateGrains(time.grain);
    for (const measure of model.measures) {
      for (const grain of grains) {
        const base = measurePriority(measure.name) * 0.9;
        out.push({
          id: id('trend'),
          kind: 'trend',
          question: `Есть ли устойчивое изменение «${measure.name}» по оси «${time.name}» (шаг ${grain})?`,
          priority: Math.min(1, base + focusBoost(measure.name, time.name, 'тренд', 'динамика')),
          params: { measure: measure.name, time: time.name, grain },
        });
        out.push({
          id: id('anomaly'),
          kind: 'anomaly',
          question: `Есть ли аномальные периоды в «${measure.name}» по «${time.name}» (шаг ${grain})?`,
          priority: Math.min(1, base * 0.85 + focusBoost(measure.name, 'аномал', 'выброс')),
          params: { measure: measure.name, time: time.name, grain },
        });
      }
    }
  }

  // --- drivers: what moved the number --------------------------------------
  for (const time of timeAxes.slice(0, 1)) {
    for (const measure of model.measures) {
      for (const dim of groupable) {
        out.push({
          id: id('driver'),
          kind: 'driver',
          question: `Какие значения «${dim.name}» определяют изменение «${measure.name}»?`,
          priority: Math.min(
            1,
            // Driver analysis answers the most common real question, so it is
            // weighted above the rest at equal input quality.
            measurePriority(measure.name) * dimensionPriority(dim.cardinality) * 1.0 +
              focusBoost(measure.name, dim.name, 'почему', 'драйвер', 'причин'),
          ),
          params: { measure: measure.name, dimension: dim.name, time: time.name },
        });
      }
    }
  }

  // --- segment comparison ---------------------------------------------------
  for (const measure of model.measures) {
    if (measure.column === '*') continue;
    for (const dim of groupable) {
      out.push({
        id: id('comparison'),
        kind: 'comparison',
        question: `Различается ли «${measure.name}» между значениями «${dim.name}»?`,
        priority: Math.min(
          1,
          measurePriority(measure.name) * dimensionPriority(dim.cardinality) * 0.8 +
            focusBoost(measure.name, dim.name, 'сравн', 'различ'),
        ),
        params: { measure: measure.name, dimension: dim.name },
      });
    }
  }

  // --- concentration --------------------------------------------------------
  for (const measure of model.measures) {
    if (!measure.additive && measure.column !== '*') continue;
    for (const dim of model.dimensions) {
      if (dim.cardinality < 5) continue;
      out.push({
        id: id('concentration'),
        kind: 'concentration',
        question: `Насколько «${measure.name}» сконцентрирована в отдельных значениях «${dim.name}»?`,
        priority: Math.min(
          1,
          measurePriority(measure.name) * 0.7 +
            focusBoost(measure.name, dim.name, 'концентр', 'риск', 'зависим'),
        ),
        params: { measure: measure.name, dimension: dim.name },
      });
    }
  }

  // --- correlation ----------------------------------------------------------
  const numericMeasures = model.measures.filter((m) => m.column !== '*');
  for (let i = 0; i < numericMeasures.length; i++) {
    for (let j = i + 1; j < numericMeasures.length; j++) {
      const a = numericMeasures[i]!;
      const b = numericMeasures[j]!;
      out.push({
        id: id('correlation'),
        kind: 'correlation',
        question: `Связаны ли «${a.name}» и «${b.name}»?`,
        priority: Math.min(
          1,
          // Correlations are the easiest thing to compute and the easiest to
          // over-read, so they sit below the rest by default.
          (measurePriority(a.name) + measurePriority(b.name)) / 2 * 0.55 +
            focusBoost(a.name, b.name, 'связ', 'влия', 'корреля'),
        ),
        params: { a: a.name, b: b.name },
      });
    }
  }

  return out.sort((x, y) => y.priority - x.priority);
}

/**
 * Which time grains to try. Rolling up to a coarser grain often exposes a
 * trend that daily noise buries, so one level up is always attempted.
 */
function candidateGrains(natural: TimeGrain): TimeGrain[] {
  const ladder: TimeGrain[] = ['hour', 'day', 'week', 'month', 'quarter', 'year'];
  const idx = ladder.indexOf(natural);
  if (idx < 0) return ['day'];
  const out: TimeGrain[] = [natural];
  if (idx + 1 < ladder.length) out.push(ladder[idx + 1]!);
  return out;
}

function summariseHypotheses(hypotheses: Hypothesis[]): string {
  const counts = new Map<string, number>();
  for (const h of hypotheses) counts.set(h.kind, (counts.get(h.kind) ?? 0) + 1);
  const label: Record<string, string> = {
    trend: 'тренды',
    anomaly: 'аномалии',
    driver: 'драйверы изменений',
    comparison: 'сравнение сегментов',
    concentration: 'концентрация',
    correlation: 'взаимосвязи',
  };
  return Array.from(counts.entries())
    .map(([k, c]) => `${label[k] ?? k}: ${c}`)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Hypothesis execution
// ---------------------------------------------------------------------------

function runHypothesis(
  dataset: Dataset,
  h: Hypothesis,
  quality: QualityReport,
): Insight | null {
  const model = dataset.semantic;
  const p = h.params as Record<string, string>;

  try {
    switch (h.kind) {
      case 'trend': {
        const measure = model.measures.find((m) => m.name === p['measure']);
        const time = model.timeDimensions.find((t) => t.name === p['time']);
        if (!measure || !time) return null;
        return withQuality(analyzeTrend(dataset, measure, time, p['grain'] as TimeGrain), quality);
      }
      case 'anomaly': {
        const measure = model.measures.find((m) => m.name === p['measure']);
        const time = model.timeDimensions.find((t) => t.name === p['time']);
        if (!measure || !time) return null;
        return withQuality(analyzeAnomalies(dataset, measure, time, p['grain'] as TimeGrain), quality);
      }
      case 'driver': {
        const measure = model.measures.find((m) => m.name === p['measure']);
        const dim = model.dimensions.find((d) => d.name === p['dimension']);
        const time = model.timeDimensions.find((t) => t.name === p['time']);
        if (!measure || !dim || !time) return null;
        return withQuality(analyzeDrivers(dataset, measure, dim, time), quality);
      }
      case 'comparison': {
        const measure = model.measures.find((m) => m.name === p['measure']);
        const dim = model.dimensions.find((d) => d.name === p['dimension']);
        if (!measure || !dim) return null;
        return withQuality(analyzeComparison(dataset, measure, dim), quality);
      }
      case 'concentration': {
        const measure = model.measures.find((m) => m.name === p['measure']);
        const dim = model.dimensions.find((d) => d.name === p['dimension']);
        if (!measure || !dim) return null;
        return withQuality(analyzeConcentration(dataset, measure, dim), quality);
      }
      case 'correlation': {
        const a = model.measures.find((m) => m.name === p['a']);
        const b = model.measures.find((m) => m.name === p['b']);
        if (!a || !b) return null;
        return withQuality(analyzeCorrelation(dataset, a, b), quality);
      }
      default:
        return null;
    }
  } catch {
    // A single analyzer failing on odd data must not abort the run.
    return null;
  }
}

/** Fold the dataset-level quality score into an insight's confidence. */
function withQuality(insight: Insight | null, quality: QualityReport): Insight | null {
  if (!insight) return null;
  insight.confidence = insight.confidence * (0.6 + 0.4 * quality.score);
  insight.score = insight.impact * insight.confidence;
  if (quality.score < 0.7) {
    insight.caveats.push(
      `Общее качество данных оценено в ${(quality.score * 100).toFixed(0)}% — ` +
      'уверенность в этой находке снижена соответственно.',
    );
  }
  return insight;
}

// ---------------------------------------------------------------------------
// Verification and ranking
// ---------------------------------------------------------------------------

/**
 * The gate between "computed something" and "willing to tell a human".
 *
 * Applies a false-discovery-rate correction across every p-value in the run.
 * Testing 200 hypotheses at α = 0.05 yields about ten false positives by
 * construction; without this step the product would reliably invent findings.
 */
export function verify(
  insights: Insight[],
  minScore: number,
  noteRejection: (reason: string) => void,
): Insight[] {
  if (insights.length === 0) return [];

  const withP = insights.filter((i) => i.evidence.pValue !== undefined);
  if (withP.length > 1) {
    const q = benjaminiHochberg(withP.map((i) => i.evidence.pValue!));
    withP.forEach((insight, i) => {
      const qValue = q[i]!;
      (insight as Insight & { qValue?: number }).qValue = qValue;
      // Downweight rather than delete: a driver contribution is exact
      // arithmetic even when its significance test is marginal.
      if (qValue > 0.1) {
        insight.confidence *= 0.5;
        insight.caveats.push(
          `После поправки на множественность проверок (${withP.length} тестов) ` +
          `q = ${qValue.toFixed(3)} — находка может быть случайной.`,
        );
      }
      insight.score = insight.impact * insight.confidence;
    });
  }

  const kept: Insight[] = [];
  for (const insight of insights) {
    if (insight.confidence < 0.25 && insight.kind !== 'quality') {
      noteRejection('Низкая уверенность после поправки на множественность');
      continue;
    }
    if (insight.score < minScore && insight.kind !== 'quality') {
      noteRejection('Влияние слишком мало, чтобы о нём сообщать');
      continue;
    }
    kept.push(insight);
  }
  return kept;
}

/**
 * Rank by score, then suppress near-duplicates.
 *
 * Without this the top of the list fills with the same finding at three time
 * grains. An insight is redundant when it shares its subjects and kind with
 * something already selected.
 */
export function rank(insights: Insight[]): Insight[] {
  const sorted = insights.slice().sort((a, b) => {
    // Quality findings lead: they change how everything below should be read.
    if (a.kind === 'quality' && b.kind !== 'quality') return -1;
    if (b.kind === 'quality' && a.kind !== 'quality') return 1;
    return b.score - a.score;
  });

  const selected: Insight[] = [];
  const seen: Array<{ kind: string; subjects: Set<string> }> = [];

  for (const insight of sorted) {
    const subjects = new Set(insight.subjects);
    const duplicate = seen.some(
      (s) => s.kind === insight.kind && jaccard(s.subjects, subjects) >= 0.65,
    );
    if (duplicate) continue;

    // A second finding about the same measure is fine, but it should not
    // outrank a first finding about an untouched one.
    const familiarity = seen.filter((s) => jaccard(s.subjects, subjects) > 0.3).length;
    if (familiarity > 0) {
      insight.score *= Math.pow(0.8, familiarity);
    }

    selected.push(insight);
    seen.push({ kind: insight.kind, subjects });
  }

  return selected.sort((a, b) => {
    if (a.kind === 'quality' && b.kind !== 'quality') return -1;
    if (b.kind === 'quality' && a.kind !== 'quality') return 1;
    return b.score - a.score;
  });
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

// ---------------------------------------------------------------------------
// Narration fallback
// ---------------------------------------------------------------------------

/**
 * The headline when no LLM is configured. Deliberately complete on its own:
 * the product must be fully usable without an API key, and the language model
 * is an upgrade to the prose, never a source of the facts.
 */
export function deterministicHeadline(
  dataset: Dataset,
  insights: Insight[],
  quality: QualityReport,
): string {
  const nonQuality = insights.filter((i) => i.kind !== 'quality');
  if (nonQuality.length === 0) {
    return (
      `В наборе «${dataset.name}» (${dataset.rowCount} строк) статистически устойчивых закономерностей ` +
      `не обнаружено. Это тоже результат: либо данные однородны, либо ряд слишком короткий, ` +
      `либо ключевые разрезы отсутствуют в выгрузке. ` +
      (quality.score < 0.8
        ? `Качество данных оценено в ${(quality.score * 100).toFixed(0)}% — начните с устранения замечаний.`
        : 'Попробуйте добавить измерения для сегментации или увеличить период наблюдения.')
    );
  }

  const top = nonQuality[0]!;
  const byKind = new Map<string, number>();
  for (const i of nonQuality) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);

  const kindNames: Record<string, string> = {
    trend: 'трендов',
    anomaly: 'аномалий',
    driver: 'драйверов изменений',
    comparison: 'различий между сегментами',
    concentration: 'зон концентрации',
    correlation: 'взаимосвязей',
  };
  const breakdown = Array.from(byKind.entries())
    .map(([k, c]) => `${kindNames[k] ?? k}: ${c}`)
    .join(', ');

  return (
    `Главное: ${top.title.charAt(0).toLowerCase()}${top.title.slice(1)}. ` +
    `Всего подтверждено находок — ${nonQuality.length} (${breakdown}). ` +
    `Качество данных: ${(quality.score * 100).toFixed(0)}%. ` +
    `Уверенность в главной находке ${(top.confidence * 100).toFixed(0)}%, ` +
    `оценка влияния ${(top.impact * 100).toFixed(0)}%. ` +
    `Первый шаг: ${top.nextSteps[0]?.action ?? 'изучить детали находки'}.`
  );
}

/**
 * Merge the per-insight next steps into a run-level plan, strongest first,
 * with data fixes promoted — there is no point acting on findings whose inputs
 * are known to be broken.
 */
export function consolidateNextSteps(insights: Insight[], quality: QualityReport): NextStep[] {
  const steps: Array<NextStep & { weight: number }> = [];
  const seen = new Set<string>();

  for (const insight of insights) {
    for (const step of insight.nextSteps) {
      const key = step.action.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      const typeWeight = step.type === 'fix_data' ? 1.15 : step.type === 'act' ? 1.0 : 0.85;
      steps.push({ ...step, weight: insight.score * typeWeight });
    }
  }

  if (quality.score < 0.8) {
    steps.push({
      type: 'fix_data',
      action: `Поднять качество данных с ${(quality.score * 100).toFixed(0)}% — это ограничивает уверенность всех выводов`,
      rationale: quality.issues
        .filter((i) => i.severity === 'high')
        .slice(0, 2)
        .map((i) => i.message)
        .join(' ') || 'Накопились замечания среднего уровня.',
      weight: 10,
    });
  }

  return steps
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 7)
    .map(({ weight: _weight, ...step }) => step);
}
