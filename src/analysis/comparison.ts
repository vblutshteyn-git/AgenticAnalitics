/**
 * Segment comparison: does a measure genuinely differ between the values of a
 * dimension, and by enough to matter?
 *
 * Reports the widest significant gap, but leads with Cohen's d rather than the
 * p-value. On a large dataset a 0.5% difference between segments will clear
 * p < 0.001 while being operationally meaningless; effect size is what tells
 * the reader whether to care.
 */

import { benjaminiHochberg, welchTTest } from '../core/stats.js';
import type { Dataset, DimensionDef, Insight, MeasureDef } from '../core/types.js';
import {
  baseInsight,
  buildGroupAggregates,
  confidenceFrom,
  formatNumber,
  formatP,
  formatPercent,
  formatSigned,
  impactFrom,
  qualityOf,
} from './helpers.js';

const MIN_GROUP_ROWS = 8;
/** Cohen's d below this is a difference nobody would notice in practice. */
const MIN_COHENS_D = 0.3;

export function analyzeComparison(
  dataset: Dataset,
  measure: MeasureDef,
  dimension: DimensionDef,
): Insight | null {
  if (measure.column === '*') return null;

  const { groups, truncatedGroups, totalRows } = buildGroupAggregates(dataset, measure, dimension, 40);
  const usable = groups.filter((g) => g.count >= MIN_GROUP_ROWS);
  if (usable.length < 2) return null;

  const trace: string[] = [];
  trace.push(
    `Метрика «${measure.name}» сгруппирована по «${dimension.name}»: ` +
    `${usable.length} сегментов с не менее чем ${MIN_GROUP_ROWS} строками ` +
    `(из ${groups.length} найденных).`,
  );

  // Compare every segment against the pooled rest, rather than pairwise: that
  // is the question a reader actually has ("is this segment different?") and
  // it keeps the number of tests linear in the number of segments.
  const allValues: number[] = [];
  for (const g of usable) allValues.push(...g.values);

  const tests = usable.map((g) => {
    const others: number[] = [];
    for (const h of usable) {
      if (h.value === g.value) continue;
      others.push(...h.values);
    }
    const res = welchTTest(g.values, others);
    return { group: g, res, othersCount: others.length };
  });

  // Many segments means many tests; without an FDR correction the largest
  // group of a noisy dataset would always look "significantly different".
  const adjusted = benjaminiHochberg(tests.map((t) => t.res.pValue));
  tests.forEach((t, i) => { (t as { q?: number }).q = adjusted[i]!; });
  trace.push(
    `Проведено ${tests.length} сравнений «сегмент против остальных» (тест Уэлча), ` +
    'p-значения скорректированы процедурой Бенджамини–Хохберга для контроля доли ложных открытий.',
  );

  const candidates = tests
    .map((t, i) => ({ ...t, q: adjusted[i]! }))
    .filter((t) => t.q <= 0.05 && Math.abs(t.res.cohensD) >= MIN_COHENS_D)
    .sort((a, b) => Math.abs(b.res.cohensD) - Math.abs(a.res.cohensD));

  if (candidates.length === 0) {
    trace.push(`Ни один сегмент не прошёл оба порога (q ≤ 0,05 и |d| ≥ ${MIN_COHENS_D}).`);
    return null;
  }

  const top = candidates[0]!;
  const g = top.group;
  const restMean = top.res.meanB;
  const relative = restMean === 0 ? 1 : (g.mean - restMean) / Math.abs(restMean);
  const higher = g.mean > restMean;

  trace.push(
    `Сильнейшее различие: «${g.value}» со средним ${formatNumber(g.mean, measure.unit)} ` +
    `против ${formatNumber(restMean, measure.unit)} у остальных ` +
    `(d Коэна = ${top.res.cohensD.toFixed(2)}, q = ${top.q.toFixed(4)}, n = ${g.count} против ${top.othersCount}).`,
  );

  const dMagnitude =
    Math.abs(top.res.cohensD) >= 0.8 ? 'большой' :
    Math.abs(top.res.cohensD) >= 0.5 ? 'средний' : 'небольшой';

  const quality = qualityOf(dataset, [measure.column, dimension.column]);
  const share = totalRows === 0 ? 0 : g.count / totalRows;

  const runnerUp = candidates[1];

  return baseInsight({
    datasetId: dataset.id,
    kind: 'comparison',
    title:
      `${dimension.name} = «${g.value}» ${higher ? 'выше' : 'ниже'} остальных ` +
      `по «${measure.name}» на ${formatSigned(relative)}`,
    narrative:
      `В разрезе «${dimension.name}» сегмент «${g.value}» отличается от всех остальных: ` +
      `среднее ${formatNumber(g.mean, measure.unit)} против ${formatNumber(restMean, measure.unit)} ` +
      `(${formatSigned(relative)}). Различие статистически устойчиво (${formatP(top.res.pValue)}, ` +
      `q = ${top.q.toFixed(4)} после поправки на множественность) и имеет ${dMagnitude} размер эффекта: ` +
      `d Коэна = ${top.res.cohensD.toFixed(2)}. ` +
      `Сегмент охватывает ${formatPercent(share)} строк (${g.count} из ${totalRows}).` +
      (runnerUp
        ? ` Следующее по силе отличие — «${runnerUp.group.value}» (d = ${runnerUp.res.cohensD.toFixed(2)}).`
        : ''),
    impact: impactFrom({
      shareOfTotal: share,
      relativeEffect: relative,
      coverage: share,
    }),
    confidence: confidenceFrom({
      pValue: top.q,
      sampleSize: Math.min(g.count, top.othersCount),
      minSample: MIN_GROUP_ROWS,
      dataQuality: quality,
      semanticReviewed: dataset.semantic.reviewed,
    }),
    evidence: {
      statistic: g.mean - restMean,
      statisticLabel: 'Разница средних',
      pValue: top.q,
      effectSize: top.res.cohensD,
      effectSizeLabel: 'd Коэна',
      sampleSize: g.count + top.othersCount,
      facts: [
        { label: 'Сегмент', value: `${dimension.name} = ${g.value}` },
        { label: `Среднее в сегменте`, value: formatNumber(g.mean, measure.unit) },
        { label: 'Среднее у остальных', value: formatNumber(restMean, measure.unit) },
        { label: 'Разница', value: `${formatNumber(g.mean - restMean, measure.unit)} (${formatSigned(relative)})` },
        { label: 'd Коэна', value: `${top.res.cohensD.toFixed(2)} (${dMagnitude})` },
        { label: 'Строк в сегменте / остальных', value: `${g.count} / ${top.othersCount}` },
        { label: 'p (сырое)', value: formatP(top.res.pValue) },
        { label: 'q (после поправки)', value: top.q.toFixed(4) },
        { label: 'Всего сравнений', value: String(tests.length) },
      ],
    },
    trace,
    caveats: [
      'Сегменты сравнивались наблюдательно: различие может объясняться другим признаком, коррелирующим с этим измерением.',
      truncatedGroups > 0
        ? `${truncatedGroups} мелких сегментов не участвовали в сравнении.`
        : '',
      groups.length - usable.length > 0
        ? `${groups.length - usable.length} сегментов отброшено: менее ${MIN_GROUP_ROWS} строк.`
        : '',
      Math.abs(top.res.cohensD) < 0.5
        ? 'Размер эффекта небольшой — различие устойчиво, но практическая значимость требует отдельной оценки.'
        : '',
    ].filter(Boolean),
    nextSteps: [
      {
        type: 'investigate',
        action: `Проверить, чем ещё «${g.value}» отличается от остальных сегментов`,
        rationale:
          'Прежде чем считать это свойством самого сегмента, нужно исключить сопутствующие различия — ' +
          'состав, период, канал.',
        query: {
          datasetId: dataset.id,
          metrics: [{ measure: measure.name }, { measure: 'Количество строк' }],
          groupBy: [dimension.name],
          orderBy: { field: `${measure.defaultAggregation}(${measure.name})`, direction: 'desc' },
        },
      },
      {
        type: higher && measure.polarity === 'higher_is_better' ? 'act' : 'investigate',
        action: higher && measure.polarity === 'higher_is_better'
          ? `Разобрать практику сегмента «${g.value}» и проверить её переносимость на остальные`
          : `Определить, что удерживает «${g.value}» на другом уровне`,
        rationale:
          `Сегмент даёт ${formatPercent(share)} объёма при отличии в ${formatSigned(relative)} — ` +
          'это заметный резерв, если механизм различия удастся воспроизвести или устранить.',
      },
      {
        type: 'monitor',
        action: `Следить за разрывом между «${g.value}» и остальными по «${measure.name}»`,
        rationale: 'Сужение разрыва подтвердит, что различие управляемо, а не структурно.',
      },
    ],
    chart: {
      type: 'hbar',
      xLabel: `${measure.defaultAggregation === 'sum' ? 'Среднее' : 'Среднее'} «${measure.name}»`,
      yLabel: dimension.name,
      unit: measure.unit,
      series: [{
        name: measure.name,
        points: usable
          .slice()
          .sort((a, b) => b.mean - a.mean)
          .slice(0, 12)
          .map((x) => ({
            x: x.value,
            y: Number(x.mean.toFixed(4)),
            annotation: x.value === g.value ? `n = ${x.count}` : undefined,
          })),
      }],
      reference: {
        label: 'Среднее по остальным',
        points: usable.slice(0, 12).map((x) => ({ x: x.value, y: Number(restMean.toFixed(4)) })),
      },
    },
    subjects: [measure.name, dimension.name],
  });
}
