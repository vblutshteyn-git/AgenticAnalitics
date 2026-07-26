/**
 * Concentration analysis: how much of a measure sits in how few segments.
 *
 * Concentration is a risk statement, not a curiosity. "62% of revenue comes
 * from three clients" is usually the most consequential sentence you can say
 * about a dataset, and no dashboard surfaces it because every chart is sorted
 * descending and the shape looks normal.
 */

import { gini, herfindahl } from '../core/stats.js';
import type { Dataset, DimensionDef, Insight, MeasureDef } from '../core/types.js';
import {
  baseInsight,
  buildGroupAggregates,
  confidenceFrom,
  formatNumber,
  formatPercent,
  impactFrom,
  qualityOf,
} from './helpers.js';

const MIN_SEGMENTS = 5;
/** Report only when the top decile holds materially more than its even share. */
const CONCENTRATION_TRIGGER = 0.5;

export function analyzeConcentration(
  dataset: Dataset,
  measure: MeasureDef,
  dimension: DimensionDef,
): Insight | null {
  // Concentration of an average is not meaningful — only totals concentrate.
  if (!measure.additive && measure.column !== '*') return null;

  const { groups, truncatedGroups } = buildGroupAggregates(dataset, measure, dimension, 5000);
  const positive = groups.filter((g) => g.sum > 0);
  if (positive.length < MIN_SEGMENTS) return null;

  const sorted = positive.slice().sort((a, b) => b.sum - a.sum);
  const total = sorted.reduce((acc, g) => acc + g.sum, 0);
  if (total <= 0) return null;

  const shares = sorted.map((g) => g.sum / total);
  const n = sorted.length;
  const trace: string[] = [];

  trace.push(
    `«${measure.name}» просуммирована по ${n} значениям измерения «${dimension.name}». ` +
    `Итого: ${formatNumber(total, measure.unit)}.`,
  );

  // How many segments are needed to reach 80% of the total.
  let cumulative = 0;
  let segmentsTo80 = 0;
  for (const s of shares) {
    cumulative += s;
    segmentsTo80++;
    if (cumulative >= 0.8) break;
  }

  const topCount = Math.max(1, Math.ceil(n * 0.1));
  const top10Share = shares.slice(0, topCount).reduce((a, b) => a + b, 0);
  const topOneShare = shares[0]!;
  const hhi = herfindahl(shares);
  const giniCoef = gini(sorted.map((g) => g.sum));
  const evenShare = 1 / n;

  trace.push(
    `Топ-${topCount} (${formatPercent(topCount / n, 0)} сегментов) держат ${formatPercent(top10Share)} суммы; ` +
    `при равномерном распределении было бы ${formatPercent(topCount / n)}.`,
  );
  trace.push(
    `80% суммы приходится на ${segmentsTo80} из ${n} сегментов ` +
    `(${formatPercent(segmentsTo80 / n)}).`,
  );
  trace.push(
    `Индекс Херфиндаля–Хиршмана = ${hhi.toFixed(4)} ` +
    `(равномерно было бы ${evenShare.toFixed(4)}); коэффициент Джини = ${giniCoef.toFixed(3)}.`,
  );

  if (top10Share < CONCENTRATION_TRIGGER || giniCoef < 0.4) {
    trace.push('Распределение достаточно ровное — концентрация не является риском.');
    return null;
  }

  const quality = qualityOf(dataset, [measure.column, dimension.column]);
  const leaders = sorted.slice(0, 5);
  // Concentration is a property of the whole table, computed exactly. The
  // sample backing it is the row count, not the number of segments — scoring
  // it by segment count would penalise the clearest possible finding ("three
  // categories hold everything") for having only three categories.
  const backingRows = groups.reduce((acc, g) => acc + g.count, 0);

  // HHI has a conventional reading from competition analysis; reuse it.
  const hhiVerdict =
    hhi >= 0.25 ? 'высокая концентрация' :
    hhi >= 0.15 ? 'умеренная концентрация' : 'слабая концентрация';

  return baseInsight({
    datasetId: dataset.id,
    kind: 'concentration',
    title:
      `${formatPercent(top10Share, 0)} «${measure.name}» приходится на ${topCount} ` +
      `${plural(topCount, 'значение', 'значения', 'значений')} «${dimension.name}» из ${n}`,
    narrative:
      `Распределение «${measure.name}» по «${dimension.name}» сильно неравномерно. ` +
      `На топ-${topCount} (${formatPercent(topCount / n, 0)} от числа сегментов) приходится ` +
      `${formatPercent(top10Share)} суммы, а 80% дают всего ${segmentsTo80} ` +
      `${plural(segmentsTo80, 'сегмент', 'сегмента', 'сегментов')} из ${n}. ` +
      `Крупнейший — «${leaders[0]!.value}» с долей ${formatPercent(topOneShare)} ` +
      `(${formatNumber(leaders[0]!.sum, measure.unit)}). ` +
      `Коэффициент Джини ${giniCoef.toFixed(2)}, индекс Херфиндаля ${hhi.toFixed(3)} — ${hhiVerdict}. ` +
      `Практический смысл: результат по «${measure.name}» зависит от небольшого числа сегментов, ` +
      `и потеря любого из них не компенсируется остальными.`,
    impact: impactFrom({
      shareOfTotal: top10Share,
      relativeEffect: giniCoef,
      coverage: 1,
    }),
    confidence: confidenceFrom({
      // Concentration is measured, not inferred: no sampling uncertainty to test.
      pValue: 0.001,
      sampleSize: backingRows,
      minSample: 30,
      dataQuality: quality,
      semanticReviewed: dataset.semantic.reviewed,
      penalty: truncatedGroups > 0 ? 0.9 : 1,
    }),
    evidence: {
      statistic: top10Share,
      statisticLabel: `Доля топ-${topCount} сегментов`,
      effectSize: giniCoef,
      effectSizeLabel: 'Коэффициент Джини',
      sampleSize: backingRows,
      facts: [
        { label: 'Всего сегментов', value: String(n) },
        { label: 'Крупнейший сегмент', value: `${leaders[0]!.value} — ${formatPercent(topOneShare)}` },
        { label: 'Сегментов до 80% суммы', value: `${segmentsTo80} из ${n}` },
        { label: 'Индекс Херфиндаля (HHI)', value: `${hhi.toFixed(4)} (${hhiVerdict})` },
        { label: 'Коэффициент Джини', value: giniCoef.toFixed(3) },
        { label: 'Итого по метрике', value: formatNumber(total, measure.unit) },
        ...leaders.slice(0, 5).map((l, i) => ({
          label: `№${i + 1} ${l.value}`,
          value: `${formatNumber(l.sum, measure.unit)} (${formatPercent(l.sum / total)})`,
        })),
      ],
    },
    trace,
    caveats: [
      'Концентрация — свойство текущего среза данных; за другой период картина может отличаться.',
      truncatedGroups > 0 ? `${truncatedGroups} сегментов не вошли в расчёт из-за ограничения на число групп.` : '',
      'Отрицательные значения метрики исключены из расчёта долей — иначе доли теряют смысл.',
      dataset.semantic.timeDimensions.length > 0
        ? 'Расчёт сделан по всему периоду сразу; концентрация могла усиливаться или ослабевать со временем.'
        : '',
    ].filter(Boolean),
    nextSteps: [
      {
        type: 'act',
        action: `Оценить риск потери «${leaders[0]!.value}»: это ${formatPercent(topOneShare)} «${measure.name}»`,
        rationale:
          'Зависимость такого масштаба обычно не отражена ни в одном плане — ' +
          'её стоит либо признать осознанно принятой, либо снижать.',
      },
      {
        type: 'investigate',
        action: dataset.semantic.timeDimensions.length > 0
          ? 'Посмотреть, как доля топ-сегментов менялась во времени'
          : 'Сопоставить концентрацию с другими измерениями',
        rationale:
          'Растущая концентрация — это накопление риска. Снижающаяся означает, что диверсификация работает.',
        query: dataset.semantic.timeDimensions.length > 0
          ? {
              datasetId: dataset.id,
              metrics: [{ measure: measure.name }],
              groupBy: [dataset.semantic.timeDimensions[0]!.name, dimension.name],
              timeGrain: dataset.semantic.timeDimensions[0]!.grain,
              filters: [{
                field: dimension.name,
                operator: 'in',
                value: leaders.slice(0, 5).map((l) => l.value),
              }],
            }
          : undefined,
      },
      {
        type: 'investigate',
        action:
          `Изучить длинный хвост: ${n - segmentsTo80} ` +
          `${plural(n - segmentsTo80, 'сегмент даёт', 'сегмента дают', 'сегментов дают')} лишь 20% суммы`,
        rationale:
          'Хвост либо содержит недоработанный потенциал, либо стоит дороже, чем приносит. ' +
          'Оба вывода меняют распределение усилий.',
      },
    ],
    chart: {
      type: 'hbar',
      xLabel: measure.name,
      yLabel: dimension.name,
      unit: measure.unit,
      series: [{
        name: measure.name,
        points: leaders.concat(sorted.slice(5, 12)).slice(0, 12).map((g) => ({
          x: g.value,
          y: Number(g.sum.toFixed(4)),
          annotation: formatPercent(g.sum / total, 0),
        })),
      }],
    },
    subjects: [measure.name, dimension.name],
  });
}

/** Русское согласование числительного с существительным. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
