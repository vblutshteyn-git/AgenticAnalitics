/**
 * Trend analysis: is a measure actually moving over time, or just wobbling?
 *
 * Reports an OLS fit with a significance test on the slope, and separately
 * looks for a level shift (changepoint). A changepoint that explains the
 * series better than a straight line is reported instead of the trend, because
 * "it dropped in March and stayed down" is a different — and far more
 * actionable — story than "it is declining".
 */

import { findChangepoint, linearRegression } from '../core/stats.js';
import type { Dataset, Insight, MeasureDef, TimeDimensionDef, TimeGrain } from '../core/types.js';
import {
  baseInsight,
  buildTimeSeries,
  confidenceFrom,
  formatNumber,
  formatP,
  formatSigned,
  impactFrom,
  polarityVerdict,
  qualityOf,
} from './helpers.js';

/** Below this many points a "trend" is not a trend. */
const MIN_POINTS = 6;

export function analyzeTrend(
  dataset: Dataset,
  measure: MeasureDef,
  time: TimeDimensionDef,
  grain: TimeGrain,
): Insight | null {
  const series = buildTimeSeries(dataset, measure, time, grain);
  if (series.values.length < MIN_POINTS) return null;

  const n = series.values.length;
  const xs = series.values.map((_, i) => i);
  const fit = linearRegression(xs, series.values);
  const trace: string[] = [];

  trace.push(
    `Метрика «${measure.name}» агрегирована как ${measure.defaultAggregation} ` +
    `по оси «${time.name}» с шагом ${grain}: получено ${n} точек.`,
  );
  if (series.trimmed.leading || series.trimmed.trailing) {
    trace.push(
      `Из ряда исключены неполные граничные периоды ` +
      `(${[series.trimmed.leading ? 'первый' : '', series.trimmed.trailing ? 'последний' : '']
        .filter(Boolean).join(' и ')}): в них заметно меньше строк, чем в типичном периоде, ` +
      'поэтому их «падение» отражает границу выгрузки, а не изменение показателя.',
    );
  }

  const first = series.values[0]!;
  const last = series.values[n - 1]!;
  const firstThird = average(series.values.slice(0, Math.max(1, Math.floor(n / 3))));
  const lastThird = average(series.values.slice(-Math.max(1, Math.floor(n / 3))));
  const total = series.values.reduce((a, b) => a + b, 0);

  // Compare thirds rather than endpoints: single-point comparisons are at the
  // mercy of whichever period happened to be first and last.
  const relativeChange = firstThird === 0 ? (lastThird === 0 ? 0 : 1) : (lastThird - firstThird) / Math.abs(firstThird);
  trace.push(
    `Среднее первой трети периода: ${formatNumber(firstThird, measure.unit)}; ` +
    `последней трети: ${formatNumber(lastThird, measure.unit)} (${formatSigned(relativeChange)}).`,
  );
  trace.push(
    `МНК-регрессия по номеру периода: наклон = ${fit.slope.toFixed(4)} за период, ` +
    `R² = ${fit.r2.toFixed(3)}, t = ${fit.tStatistic.toFixed(2)}, ${formatP(fit.pValue)}.`,
  );

  const changepoint = findChangepoint(series.values);
  if (changepoint) {
    trace.push(
      `Обнаружен сдвиг уровня на позиции ${changepoint.index} (${series.labels[changepoint.index]}): ` +
      `${formatNumber(changepoint.meanBefore, measure.unit)} → ${formatNumber(changepoint.meanAfter, measure.unit)}, ` +
      `${formatP(changepoint.pValue)} (с поправкой Бонферрони на перебор точек разладки).`,
    );
  }

  // Choose between the two competing explanations on the evidence rather than
  // a heuristic: both a fitted line and a two-level step spend two parameters,
  // so whichever leaves less unexplained variance is the better description.
  // The 0.9 margin means a step has to win clearly, not by a hair.
  let shiftDominates = false;
  if (changepoint && changepoint.pValue < 0.01) {
    let rssLinear = 0;
    for (let i = 0; i < n; i++) {
      const r = series.values[i]! - (fit.intercept + fit.slope * i);
      rssLinear += r * r;
    }
    let rssShift = 0;
    for (let i = 0; i < n; i++) {
      const level = i < changepoint.index ? changepoint.meanBefore : changepoint.meanAfter;
      const r = series.values[i]! - level;
      rssShift += r * r;
    }
    shiftDominates = rssShift < rssLinear * 0.9;
    trace.push(
      `Сравнение моделей: остаточная дисперсия линейного тренда ${rssLinear.toFixed(0)}, ` +
      `модели со сдвигом уровня ${rssShift.toFixed(0)} — ` +
      `${shiftDominates ? 'сдвиг описывает ряд лучше' : 'тренд описывает ряд не хуже, сдвиг отклонён'}.`,
    );
  }

  const quality = qualityOf(dataset, [measure.column, time.column]);

  if (shiftDominates && changepoint) {
    return buildChangepointInsight(dataset, measure, time, series, changepoint, trace, quality, grain);
  }

  // No trend and no shift: say nothing rather than manufacture a finding.
  if (fit.pValue > 0.05 || Math.abs(relativeChange) < 0.03) return null;

  const direction = fit.slope > 0 ? 'up' : 'down';
  const perPeriodPct = firstThird === 0 ? 0 : fit.slope / Math.abs(firstThird);

  const confidence = confidenceFrom({
    pValue: fit.pValue,
    sampleSize: n,
    minSample: MIN_POINTS,
    dataQuality: quality,
    semanticReviewed: dataset.semantic.reviewed,
    // A trend line explaining under a third of the variance is a weak claim
    // even when the slope clears significance.
    penalty: fit.r2 < 0.3 ? 0.75 : 1,
  });

  const impact = impactFrom({
    relativeEffect: relativeChange,
    coverage: 1,
    shareOfTotal: 0.5,
  });

  const dirWord = direction === 'up' ? 'растёт' : 'снижается';
  const verdict = polarityVerdict(measure, direction);

  const projected = last + fit.slope * 3;

  return baseInsight({
    datasetId: dataset.id,
    kind: 'trend',
    title: `«${measure.name}» ${dirWord} на ${formatSigned(relativeChange)} за наблюдаемый период`,
    narrative:
      `За ${n} ${periodWord(grain, n)} метрика «${measure.name}» изменилась с ` +
      `${formatNumber(firstThird, measure.unit)} до ${formatNumber(lastThird, measure.unit)} ` +
      `(сравнение средних первой и последней трети периода, ${formatSigned(relativeChange)}). ` +
      `Линейный тренд составляет ${formatNumber(fit.slope, measure.unit)} за период ` +
      `(${formatSigned(perPeriodPct)} от базового уровня) и статистически значим: ${formatP(fit.pValue)}. ` +
      `Модель объясняет ${(fit.r2 * 100).toFixed(0)}% разброса значений.${verdict}`,
    impact,
    confidence,
    evidence: {
      statistic: fit.slope,
      statisticLabel: `Наклон тренда (${measure.unit ?? 'ед.'} за ${periodWord(grain, 1)})`,
      pValue: fit.pValue,
      effectSize: fit.r2,
      effectSizeLabel: 'R² (доля объяснённой дисперсии)',
      sampleSize: n,
      facts: [
        { label: 'Периодов в ряду', value: String(n) },
        { label: 'Начало периода (среднее 1/3)', value: formatNumber(firstThird, measure.unit) },
        { label: 'Конец периода (среднее 1/3)', value: formatNumber(lastThird, measure.unit) },
        { label: 'Изменение', value: formatSigned(relativeChange) },
        { label: 'Наклон за период', value: formatNumber(fit.slope, measure.unit) },
        { label: 'R²', value: fit.r2.toFixed(3) },
        { label: 'Значимость', value: formatP(fit.pValue) },
        { label: 'Суммарно за период', value: formatNumber(total, measure.unit) },
        { label: 'Прогноз через 3 периода (линейный)', value: formatNumber(projected, measure.unit) },
      ],
    },
    trace,
    caveats: [
      fit.r2 < 0.5
        ? `R² = ${fit.r2.toFixed(2)}: вокруг тренда много шума, отдельные периоды могут сильно отклоняться.`
        : '',
      'Линейная экстраполяция предполагает сохранение текущих условий и не учитывает сезонность.',
      n < 24 ? `Всего ${n} точек — сезонные эффекты годового масштаба на таком ряду неразличимы.` : '',
      changepoint
        ? `В ряду также найден сдвиг уровня около ${series.labels[changepoint.index]} — возможно, это не плавный тренд, а разовое событие.`
        : '',
    ].filter(Boolean),
    nextSteps: [
      {
        type: 'investigate',
        action: `Разложить «${measure.name}» по измерениям, чтобы найти сегменты — источники изменения`,
        rationale:
          'Агрегированный тренд обычно складывается из разнонаправленных сегментов. ' +
          'Пока источник не найден, воздействовать не на что.',
        query: dataset.semantic.dimensions.filter((d) => d.groupable).length > 0
          ? {
              datasetId: dataset.id,
              metrics: [{ measure: measure.name }],
              groupBy: [
                time.name,
                dataset.semantic.dimensions.find((d) => d.groupable)!.name,
              ],
              timeGrain: grain,
            }
          : undefined,
      },
      {
        type: 'monitor',
        action: `Поставить «${measure.name}» на контроль с порогом ${formatNumber(last + 2 * fit.slope, measure.unit)}`,
        rationale:
          'Если через два периода значение выйдет за эту границу, тренд ускорился и требует пересмотра.',
      },
      ...(n < 24
        ? [{
            type: 'fix_data' as const,
            action: 'Загрузить более длинную историю (минимум 24 периода)',
            rationale: 'Текущей длины ряда не хватает, чтобы отделить тренд от сезонности.',
          }]
        : []),
    ],
    chart: {
      type: 'line',
      xLabel: time.name,
      yLabel: measure.name,
      unit: measure.unit,
      series: [{
        name: measure.name,
        points: series.labels.map((label, i) => ({ x: label, y: series.values[i]! })),
      }],
      reference: {
        label: 'Линейный тренд',
        points: series.labels.map((label, i) => ({ x: label, y: fit.intercept + fit.slope * i })),
      },
    },
    subjects: [measure.name, time.name],
  });
}

function buildChangepointInsight(
  dataset: Dataset,
  measure: MeasureDef,
  time: TimeDimensionDef,
  series: { labels: string[]; values: number[] },
  cp: { index: number; pValue: number; meanBefore: number; meanAfter: number },
  trace: string[],
  quality: number,
  grain: TimeGrain,
): Insight {
  const relative = cp.meanBefore === 0 ? 1 : (cp.meanAfter - cp.meanBefore) / Math.abs(cp.meanBefore);
  const direction = cp.meanAfter > cp.meanBefore ? 'up' : 'down';
  const label = series.labels[cp.index] ?? '?';
  const dirWord = direction === 'up' ? 'выросла' : 'упала';

  return baseInsight({
    datasetId: dataset.id,
    kind: 'trend',
    title: `«${measure.name}» скачкообразно ${dirWord} на ${formatSigned(relative)} около ${label}`,
    narrative:
      `Ряд «${measure.name}» разделяется на два устойчивых режима с границей около ${label}. ` +
      `До этой точки среднее значение составляло ${formatNumber(cp.meanBefore, measure.unit)}, ` +
      `после — ${formatNumber(cp.meanAfter, measure.unit)} (${formatSigned(relative)}). ` +
      `Различие значимо (${formatP(cp.pValue)} с поправкой на перебор возможных точек разладки). ` +
      `Это разовый сдвиг уровня, а не постепенный тренд: искать нужно конкретное событие в районе ${label}, ` +
      `а не медленно действующий фактор.${polarityVerdict(measure, direction)}`,
    impact: impactFrom({ relativeEffect: relative, coverage: 1, shareOfTotal: 0.6 }),
    confidence: confidenceFrom({
      pValue: cp.pValue,
      sampleSize: series.values.length,
      minSample: MIN_POINTS,
      dataQuality: quality,
      semanticReviewed: dataset.semantic.reviewed,
    }),
    evidence: {
      statistic: cp.meanAfter - cp.meanBefore,
      statisticLabel: 'Сдвиг среднего уровня',
      pValue: cp.pValue,
      sampleSize: series.values.length,
      facts: [
        { label: 'Точка сдвига', value: label },
        { label: 'Среднее до', value: formatNumber(cp.meanBefore, measure.unit) },
        { label: 'Среднее после', value: formatNumber(cp.meanAfter, measure.unit) },
        { label: 'Изменение', value: formatSigned(relative) },
        { label: 'Периодов до / после', value: `${cp.index} / ${series.values.length - cp.index}` },
        { label: 'Значимость', value: formatP(cp.pValue) },
      ],
    },
    trace,
    caveats: [
      'Метод находит одну наиболее вероятную точку сдвига; при нескольких сдвигах будет показан только сильнейший.',
      'Совпадение по времени не доказывает причину — нужен внешний контекст о событиях этого периода.',
    ],
    nextSteps: [
      {
        type: 'investigate',
        action: `Выяснить, что произошло около ${label}`,
        rationale:
          'Сдвиг уровня почти всегда имеет дискретную причину: релиз, смена цены, ' +
          'подключение канала, изменение в сборе данных.',
      },
      {
        type: 'investigate',
        action: 'Проверить, сдвинулись ли все сегменты или только часть',
        rationale:
          'Если сдвиг локализован в одном сегменте — это операционное событие. ' +
          'Если сдвинулось всё сразу — с высокой вероятностью изменился способ сбора данных.',
        query: dataset.semantic.dimensions.filter((d) => d.groupable).length > 0
          ? {
              datasetId: dataset.id,
              metrics: [{ measure: measure.name }],
              groupBy: [time.name, dataset.semantic.dimensions.find((d) => d.groupable)!.name],
              timeGrain: grain,
            }
          : undefined,
      },
      {
        type: 'fix_data',
        action: 'Исключить возможность артефакта пайплайна данных',
        rationale:
          'Резкие ступени в метриках часто оказываются сменой источника или логики выгрузки, а не изменением в бизнесе.',
      },
    ],
    chart: {
      type: 'line',
      xLabel: time.name,
      yLabel: measure.name,
      series: [{
        name: measure.name,
        points: series.labels.map((l, i) => ({
          x: l,
          y: series.values[i]!,
          annotation: i === cp.index ? 'точка сдвига' : undefined,
        })),
      }],
      reference: {
        label: 'Уровень режима',
        points: series.labels.map((l, i) => ({
          x: l,
          y: i < cp.index ? cp.meanBefore : cp.meanAfter,
        })),
      },
    },
    subjects: [measure.name, time.name],
  });
}

function average(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function periodWord(grain: TimeGrain, n: number): string {
  const forms: Record<string, [string, string, string]> = {
    hour: ['час', 'часа', 'часов'],
    day: ['день', 'дня', 'дней'],
    week: ['неделю', 'недели', 'недель'],
    month: ['месяц', 'месяца', 'месяцев'],
    quarter: ['квартал', 'квартала', 'кварталов'],
    year: ['год', 'года', 'лет'],
    irregular: ['период', 'периода', 'периодов'],
  };
  const [one, few, many] = forms[grain] ?? forms['irregular']!;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
