/**
 * Correlation between two measures.
 *
 * The hard part is not computing r — it is refusing to report the ones that
 * will mislead. Three guards run here:
 *
 *  1. Pearson and Spearman are both computed. A large gap between them means
 *     the linear correlation is being carried by a few extreme points.
 *  2. Trivially related pairs (a column against its own derivative, e.g.
 *     `revenue` vs `revenue_usd`) are suppressed by an |r| ceiling.
 *  3. Every reported correlation ships with the confounding caveat attached,
 *     because a correlation in observational data is a question, not a finding.
 */

import { pearson, spearman } from '../core/stats.js';
import type { Dataset, Insight, MeasureDef } from '../core/types.js';
import {
  baseInsight,
  confidenceFrom,
  formatNumber,
  formatP,
  impactFrom,
  pairedValues,
  qualityOf,
} from './helpers.js';

const MIN_PAIRS = 20;
/** Below this the relationship is too weak to act on, whatever the p-value. */
const MIN_ABS_R = 0.35;
/** At or above this the pair is almost certainly the same quantity twice. */
const TRIVIAL_ABS_R = 0.995;

export function analyzeCorrelation(
  dataset: Dataset,
  a: MeasureDef,
  b: MeasureDef,
): Insight | null {
  if (a.column === '*' || b.column === '*') return null;
  if (a.column === b.column) return null;

  const { xs, ys } = pairedValues(dataset, a, b);
  if (xs.length < MIN_PAIRS) return null;

  const p = pearson(xs, ys);
  const s = spearman(xs, ys);
  const trace: string[] = [];

  trace.push(
    `Пар с непустыми значениями «${a.name}» и «${b.name}»: ${xs.length} ` +
    `из ${dataset.rowCount} строк.`,
  );
  trace.push(`Корреляция Пирсона r = ${p.r.toFixed(3)} (${formatP(p.pValue)}).`);
  trace.push(`Корреляция Спирмена ρ = ${s.r.toFixed(3)} (${formatP(s.pValue)}).`);

  if (Math.abs(p.r) >= TRIVIAL_ABS_R) {
    trace.push(`|r| ≥ ${TRIVIAL_ABS_R}: колонки почти тождественны — вероятно, одна производна от другой. Находка отклонена.`);
    return null;
  }
  if (Math.abs(p.r) < MIN_ABS_R && Math.abs(s.r) < MIN_ABS_R) return null;
  if (p.pValue > 0.01 && s.pValue > 0.01) return null;

  // Rank correlation is robust to outliers; a big gap tells us which one to
  // trust and how loudly to caveat.
  const divergence = Math.abs(p.r - s.r);
  const outlierDriven = divergence > 0.25;
  if (outlierDriven) {
    trace.push(
      `Расхождение |r − ρ| = ${divergence.toFixed(2)} превышает 0,25 — ` +
      'линейная связь во многом обеспечена отдельными экстремальными точками.',
    );
  }

  // Report the weaker of the two: it is the claim that survives either reading.
  const headline = Math.abs(p.r) <= Math.abs(s.r) ? p : s;
  const headlineName = Math.abs(p.r) <= Math.abs(s.r) ? 'Пирсона' : 'Спирмена';
  const r2 = headline.r * headline.r;

  const direction = headline.r > 0 ? 'прямая' : 'обратная';
  const strength =
    Math.abs(headline.r) >= 0.7 ? 'сильная' :
    Math.abs(headline.r) >= 0.5 ? 'умеренная' : 'слабая';

  const quality = qualityOf(dataset, [a.column, b.column]);
  const coverage = xs.length / Math.max(1, dataset.rowCount);

  return baseInsight({
    datasetId: dataset.id,
    kind: 'correlation',
    title: `${cap(strength)} ${direction} связь: «${a.name}» и «${b.name}» (r = ${headline.r.toFixed(2)})`,
    narrative:
      `Между «${a.name}» и «${b.name}» обнаружена ${strength} ${direction} связь ` +
      `(корреляция ${headlineName} = ${headline.r.toFixed(3)}, ${formatP(headline.pValue)}, n = ${xs.length}). ` +
      `Совместная изменчивость объясняет около ${(r2 * 100).toFixed(0)}% разброса. ` +
      (outlierDriven
        ? `Пирсон (${p.r.toFixed(2)}) и Спирмен (${s.r.toFixed(2)}) заметно расходятся: ` +
          'связь во многом держится на нескольких экстремальных наблюдениях, ' +
          'и на типичных значениях она слабее, чем выглядит.'
        : `Пирсон (${p.r.toFixed(2)}) и Спирмен (${s.r.toFixed(2)}) согласуются — ` +
          'связь монотонна и не сводится к влиянию выбросов.') +
      ' Это наблюдательная зависимость: она не устанавливает направление влияния.',
    impact: impactFrom({
      relativeEffect: Math.abs(headline.r),
      coverage,
      shareOfTotal: r2 * 0.5,
    }),
    confidence: confidenceFrom({
      pValue: headline.pValue,
      sampleSize: xs.length,
      minSample: MIN_PAIRS,
      dataQuality: quality,
      semanticReviewed: dataset.semantic.reviewed,
      penalty: outlierDriven ? 0.65 : 1,
    }),
    evidence: {
      statistic: headline.r,
      statisticLabel: `Корреляция ${headlineName}`,
      pValue: headline.pValue,
      effectSize: r2,
      effectSizeLabel: 'r² (доля совместной изменчивости)',
      sampleSize: xs.length,
      facts: [
        { label: 'Пирсон r', value: `${p.r.toFixed(3)} (${formatP(p.pValue)})` },
        { label: 'Спирмен ρ', value: `${s.r.toFixed(3)} (${formatP(s.pValue)})` },
        { label: 'Пар наблюдений', value: `${xs.length} из ${dataset.rowCount}` },
        { label: 'r²', value: r2.toFixed(3) },
        { label: `Диапазон «${a.name}»`, value: `${formatNumber(Math.min(...xs), a.unit)} … ${formatNumber(Math.max(...xs), a.unit)}` },
        { label: `Диапазон «${b.name}»`, value: `${formatNumber(Math.min(...ys), b.unit)} … ${formatNumber(Math.max(...ys), b.unit)}` },
        { label: 'Расхождение r и ρ', value: divergence.toFixed(3) },
      ],
    },
    trace,
    caveats: [
      'Корреляция не означает причинную связь: возможен общий скрытый фактор или обратное направление влияния.',
      outlierDriven
        ? 'Связь чувствительна к выбросам — при их удалении коэффициент заметно изменится.'
        : '',
      coverage < 0.8
        ? `Связь посчитана на ${(coverage * 100).toFixed(0)}% строк: в остальных одна из метрик пуста, и отсутствие может быть неслучайным.`
        : '',
      'Обе метрики могут расти во времени независимо друг от друга — на временных рядах это частая причина ложной корреляции.',
    ].filter(Boolean),
    nextSteps: [
      {
        type: 'investigate',
        action: `Проверить связь внутри отдельных сегментов`,
        rationale:
          'Если внутри каждого сегмента связь исчезает или меняет знак, корреляция в целом — ' +
          'артефакт различий между сегментами (парадокс Симпсона), а не реальная зависимость.',
        query: dataset.semantic.dimensions.filter((d) => d.groupable).length > 0
          ? {
              datasetId: dataset.id,
              metrics: [{ measure: a.name, aggregation: 'avg' }, { measure: b.name, aggregation: 'avg' }],
              groupBy: [dataset.semantic.dimensions.find((d) => d.groupable)!.name],
            }
          : undefined,
      },
      {
        type: 'investigate',
        action: dataset.semantic.timeDimensions.length > 0
          ? 'Проверить, не объясняется ли связь общим трендом во времени'
          : 'Уточнить, есть ли фактор, влияющий на обе метрики одновременно',
        rationale:
          'Две метрики, растущие вместе со временем, коррелируют даже при полном отсутствии связи между собой.',
      },
      {
        type: 'act',
        action: `Спланировать проверку: изменить «${a.name}» контролируемо и измерить отклик «${b.name}»`,
        rationale: 'Направление влияния устанавливается вмешательством, а не наблюдением.',
      },
    ],
    chart: {
      type: 'scatter',
      xLabel: a.name,
      yLabel: b.name,
      unit: b.unit,
      series: [{
        name: `${a.name} × ${b.name}`,
        // Cap the plotted points; the statistics above use every pair.
        points: samplePoints(xs, ys, 400),
      }],
    },
    subjects: [a.name, b.name],
  });
}

/** Even-stride subsample, preserving the shape of the cloud. */
function samplePoints(xs: number[], ys: number[], max: number): Array<{ x: number; y: number }> {
  const n = xs.length;
  if (n <= max) return xs.map((x, i) => ({ x, y: ys[i]! }));
  const stride = n / max;
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.floor(i * stride);
    out.push({ x: xs[idx]!, y: ys[idx]! });
  }
  return out;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
