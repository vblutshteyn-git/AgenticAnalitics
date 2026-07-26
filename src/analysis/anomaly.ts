/**
 * Anomaly detection over a time series.
 *
 * Uses median + MAD rather than mean + standard deviation. The classical
 * z-score is computed from statistics that the outliers themselves inflate, so
 * a single large spike raises the threshold enough to hide itself. MAD is
 * unaffected by up to half the sample being extreme.
 *
 * When the series has a real trend, the residuals from the fitted line are
 * scored instead of the raw values — otherwise every point at the far end of a
 * growing series looks anomalous.
 */

import { linearRegression, normalTwoSided, robustZScores } from '../core/stats.js';
import type { Dataset, Insight, MeasureDef, TimeDimensionDef, TimeGrain } from '../core/types.js';
import {
  baseInsight,
  buildTimeSeries,
  confidenceFrom,
  formatNumber,
  formatP,
  formatSigned,
  impactFrom,
  qualityOf,
} from './helpers.js';

const MIN_POINTS = 10;
/** Robust-z past which a point is called an outlier. ~3 sigma equivalent. */
const Z_THRESHOLD = 3.5;

export function analyzeAnomalies(
  dataset: Dataset,
  measure: MeasureDef,
  time: TimeDimensionDef,
  grain: TimeGrain,
): Insight | null {
  const series = buildTimeSeries(dataset, measure, time, grain);
  const n = series.values.length;
  if (n < MIN_POINTS) return null;

  const trace: string[] = [];
  trace.push(`Построен ряд «${measure.name}» по «${time.name}» с шагом ${grain}: ${n} точек.`);
  if (series.trimmed.leading || series.trimmed.trailing) {
    trace.push(
      `Из ряда исключены неполные граничные периоды ` +
      `(${[series.trimmed.leading ? 'первый' : '', series.trimmed.trailing ? 'последний' : '']
        .filter(Boolean).join(' и ')}): в них заметно меньше строк, чем в типичном периоде, ` +
      'поэтому их «падение» отражает границу выгрузки, а не изменение показателя.',
    );
  }

  // Detrend first when a trend is present, so we flag departures from the
  // expected path rather than the path itself.
  const xs = series.values.map((_, i) => i);
  const fit = linearRegression(xs, series.values);
  const detrend = fit.pValue < 0.05 && fit.r2 > 0.25;
  const target = detrend
    ? series.values.map((v, i) => v - (fit.intercept + fit.slope * i))
    : series.values.slice();

  if (detrend) {
    trace.push(
      `Ряд содержит значимый тренд (R² = ${fit.r2.toFixed(2)}, ${formatP(fit.pValue)}) — ` +
      'выбросы ищутся в остатках от линии тренда, а не в исходных значениях.',
    );
  } else {
    trace.push('Значимого тренда не обнаружено — выбросы ищутся в исходных значениях ряда.');
  }

  const { scores, robust, centre, scale } = robustZScores(target);
  if (scale === 0) {
    trace.push('Разброс ряда нулевой — детекция выбросов неприменима.');
    return null;
  }
  trace.push(
    `Робастная z-оценка: медиана = ${formatNumber(centre, measure.unit)}, ` +
    `MAD-масштаб = ${formatNumber(scale, measure.unit)}` +
    (robust ? '.' : ' (MAD = 0, использовано стандартное отклонение — оценка менее устойчива).'),
  );

  const outliers = scores
    .map((z, i) => ({ z, i }))
    .filter((o) => Math.abs(o.z) >= Z_THRESHOLD)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

  if (outliers.length === 0) {
    trace.push(`Точек с |z| ≥ ${Z_THRESHOLD} не найдено.`);
    return null;
  }

  // Too many "outliers" means the threshold model is wrong for this series,
  // not that a third of the history is anomalous.
  const outlierShare = outliers.length / n;
  if (outlierShare > 0.25) {
    trace.push(
      `${outliers.length} из ${n} точек превышают порог (${(outlierShare * 100).toFixed(0)}%) — ` +
      'распределение слишком тяжёлое для этой модели, находка отклонена как ненадёжная.',
    );
    return null;
  }

  const top = outliers[0]!;
  const label = series.labels[top.i] ?? '?';
  const actual = series.values[top.i]!;
  const expected = detrend ? fit.intercept + fit.slope * top.i : centre;
  const deviation = actual - expected;
  const relative = expected === 0 ? 1 : deviation / Math.abs(expected);
  const pValue = normalTwoSided(top.z);

  trace.push(
    `Сильнейший выброс: ${label}, значение ${formatNumber(actual, measure.unit)} ` +
    `против ожидаемых ${formatNumber(expected, measure.unit)} (z = ${top.z.toFixed(2)}, ${formatP(pValue)}).`,
  );
  if (outliers.length > 1) {
    trace.push(
      `Всего точек за порогом: ${outliers.length} (${outliers.slice(0, 5).map((o) => series.labels[o.i]).join(', ')}` +
      `${outliers.length > 5 ? ', …' : ''}).`,
    );
  }

  const quality = qualityOf(dataset, [measure.column, time.column]);
  const rowsInBucket = series.counts[top.i] ?? 0;
  const totalRows = series.counts.reduce((a, b) => a + b, 0);

  const direction = deviation > 0 ? 'выше' : 'ниже';

  return baseInsight({
    datasetId: dataset.id,
    kind: 'anomaly',
    title: `Аномалия в «${measure.name}»: ${label} на ${formatSigned(relative)} ${direction} ожидаемого`,
    narrative:
      `В периоде ${label} метрика «${measure.name}» составила ${formatNumber(actual, measure.unit)} ` +
      `при ожидаемых ${formatNumber(expected, measure.unit)} — отклонение ${formatSigned(relative)} ` +
      `(робастная z-оценка ${top.z.toFixed(1)}, ${formatP(pValue)}). ` +
      (outliers.length > 1
        ? `Всего таких точек ${outliers.length} из ${n}. `
        : 'Это единственная точка ряда, вышедшая за порог. ') +
      `Оценка построена на медиане и MAD, поэтому сама аномалия не смещает границу, ` +
      `за которую выходит.`,
    impact: impactFrom({
      relativeEffect: relative,
      coverage: totalRows === 0 ? 0 : rowsInBucket / totalRows,
      shareOfTotal: Math.min(1, Math.abs(deviation) / Math.max(1e-9, Math.abs(series.values.reduce((a, b) => a + b, 0)))),
    }),
    confidence: confidenceFrom({
      pValue,
      sampleSize: n,
      minSample: MIN_POINTS,
      dataQuality: quality,
      semanticReviewed: dataset.semantic.reviewed,
      penalty: robust ? 1 : 0.8,
    }),
    evidence: {
      statistic: top.z,
      statisticLabel: 'Робастная z-оценка (медиана / MAD)',
      pValue,
      sampleSize: n,
      facts: [
        { label: 'Период', value: label },
        { label: 'Фактическое значение', value: formatNumber(actual, measure.unit) },
        { label: 'Ожидаемое значение', value: formatNumber(expected, measure.unit) },
        { label: 'Отклонение', value: `${formatNumber(deviation, measure.unit)} (${formatSigned(relative)})` },
        { label: 'z-оценка', value: top.z.toFixed(2) },
        { label: 'Строк в периоде', value: String(rowsInBucket) },
        { label: 'Всего аномальных точек', value: `${outliers.length} из ${n}` },
        { label: 'Порог', value: `|z| ≥ ${Z_THRESHOLD}` },
      ],
    },
    trace,
    caveats: [
      rowsInBucket > 0 && rowsInBucket < 5
        ? `В этом периоде всего ${rowsInBucket} строк — выброс может объясняться малой выборкой, а не реальным событием.`
        : '',
      'Порог |z| ≥ 3,5 подобран для одномодальных распределений; при мультимодальных данных возможны ложные срабатывания.',
      detrend
        ? 'Выбросы измерены как отклонения от линии тренда — при нелинейном тренде оценка смещена.'
        : 'Сезонность не моделировалась: регулярные пики (выходные, конец месяца) могут выглядеть как аномалии.',
    ].filter(Boolean),
    nextSteps: [
      {
        type: 'investigate',
        action: `Раскрыть период ${label} построчно и найти вклад отдельных сегментов`,
        rationale: 'Аномалия агрегата — это либо один экстремальный объект, либо сдвиг всего распределения. Различить их можно только на детальных данных.',
        query: {
          datasetId: dataset.id,
          metrics: [{ measure: measure.name }],
          groupBy: dataset.semantic.dimensions.filter((d) => d.groupable).slice(0, 1).map((d) => d.name),
          limit: 20,
        },
      },
      {
        type: 'fix_data',
        action: 'Проверить полноту выгрузки за этот период',
        rationale: 'Провалы вниз чаще всего оказываются недогруженными данными, а не падением показателя.',
      },
      {
        type: 'monitor',
        action: `Настроить оповещение при |z| ≥ ${Z_THRESHOLD} (границы: ${formatNumber(centre - Z_THRESHOLD * scale, measure.unit)} … ${formatNumber(centre + Z_THRESHOLD * scale, measure.unit)})`,
        rationale: 'Границы рассчитаны робастно и не требуют пересмотра при появлении новых выбросов.',
      },
    ],
    chart: {
      type: 'line',
      xLabel: time.name,
      yLabel: measure.name,
      unit: measure.unit,
      series: [{
        name: measure.name,
        points: series.labels.map((l, i) => ({
          x: l,
          y: series.values[i]!,
          annotation: Math.abs(scores[i]!) >= Z_THRESHOLD ? `z = ${scores[i]!.toFixed(1)}` : undefined,
        })),
      }],
      reference: {
        label: 'Ожидаемый уровень',
        points: series.labels.map((l, i) => ({
          x: l,
          y: detrend ? fit.intercept + fit.slope * i : centre,
        })),
      },
    },
    subjects: [measure.name, time.name],
  });
}
