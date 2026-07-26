/**
 * Driver analysis — the question every dashboard leaves unanswered: the number
 * moved, but *who* moved it?
 *
 * Splits the timeline into a prior and a recent window, then decomposes the
 * total change into per-segment contributions. For non-additive measures it
 * additionally separates a *mix* effect (the segment's share of volume shifted)
 * from a *rate* effect (the segment's own value changed) — the distinction
 * between "we sold to different customers" and "customers behaved differently",
 * which point at completely different responses.
 */

import { welchTTest } from '../core/stats.js';
import type {
  Dataset,
  DimensionDef,
  Insight,
  MeasureDef,
  NextStep,
  TimeDimensionDef,
} from '../core/types.js';
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

const MIN_ROWS_PER_WINDOW = 20;
const MIN_ROWS_PER_SEGMENT = 5;

interface SegmentContribution {
  value: string;
  priorTotal: number;
  recentTotal: number;
  priorCount: number;
  recentCount: number;
  priorMean: number;
  recentMean: number;
  /** Absolute change in the segment's contribution to the measure. */
  delta: number;
  /** delta as a share of the overall change. */
  shareOfChange: number;
  /** Change attributable to the segment's share of volume moving. */
  mixEffect: number;
  /** Change attributable to the segment's own per-row value moving. */
  rateEffect: number;
  pValue: number;
}

export function analyzeDrivers(
  dataset: Dataset,
  measure: MeasureDef,
  dimension: DimensionDef,
  time: TimeDimensionDef,
): Insight | null {
  const timeIdx = dataset.columns.indexOf(time.column);
  const times = dataset.timeCache[timeIdx];
  if (!times) return null;

  // Split at the median timestamp so both windows carry comparable weight,
  // rather than at the midpoint of the range which uneven activity would skew.
  const valid: number[] = [];
  for (let r = 0; r < dataset.rowCount; r++) {
    const t = times[r]!;
    if (!isNaN(t)) valid.push(t);
  }
  if (valid.length < MIN_ROWS_PER_WINDOW * 2) return null;
  valid.sort((a, b) => a - b);
  const splitPoint = valid[Math.floor(valid.length / 2)]!;

  const priorMask = new Uint8Array(dataset.rowCount);
  const recentMask = new Uint8Array(dataset.rowCount);
  let priorRows = 0;
  let recentRows = 0;
  for (let r = 0; r < dataset.rowCount; r++) {
    const t = times[r]!;
    if (isNaN(t)) continue;
    if (t < splitPoint) { priorMask[r] = 1; priorRows++; }
    else { recentMask[r] = 1; recentRows++; }
  }
  if (priorRows < MIN_ROWS_PER_WINDOW || recentRows < MIN_ROWS_PER_WINDOW) return null;

  const trace: string[] = [];
  const priorLabel = `${new Date(valid[0]!).toISOString().slice(0, 10)} … ${new Date(splitPoint).toISOString().slice(0, 10)}`;
  const recentLabel = `${new Date(splitPoint).toISOString().slice(0, 10)} … ${new Date(valid[valid.length - 1]!).toISOString().slice(0, 10)}`;
  trace.push(
    `Период разделён по медиане «${time.name}»: ранний ${priorLabel} (${priorRows} строк), ` +
    `поздний ${recentLabel} (${recentRows} строк).`,
  );

  const prior = buildGroupAggregates(dataset, measure, dimension, 200, priorMask);
  const recent = buildGroupAggregates(dataset, measure, dimension, 200, recentMask);
  const priorMap = new Map(prior.groups.map((g) => [g.value, g]));
  const recentMap = new Map(recent.groups.map((g) => [g.value, g]));

  const additive = measure.additive || measure.column === '*';
  const priorTotal = additive
    ? prior.groups.reduce((a, g) => a + g.sum, 0)
    : weightedMean(prior.groups);
  const recentTotal = additive
    ? recent.groups.reduce((a, g) => a + g.sum, 0)
    : weightedMean(recent.groups);
  const totalDelta = recentTotal - priorTotal;

  trace.push(
    `«${measure.name}» ${additive ? 'суммарно' : 'в среднем'}: ` +
    `${formatNumber(priorTotal, measure.unit)} → ${formatNumber(recentTotal, measure.unit)} ` +
    `(${formatNumber(totalDelta, measure.unit)}).`,
  );

  if (Math.abs(totalDelta) < 1e-9) {
    trace.push('Совокупное изменение практически нулевое — разложение по драйверам не имеет смысла.');
    return null;
  }

  const priorRowsTotal = prior.groups.reduce((a, g) => a + g.count, 0);
  const recentRowsTotal = recent.groups.reduce((a, g) => a + g.count, 0);

  const allValues = new Set([...priorMap.keys(), ...recentMap.keys()]);
  const contributions: SegmentContribution[] = [];

  for (const value of allValues) {
    const p = priorMap.get(value);
    const r = recentMap.get(value);
    const priorCount = p?.count ?? 0;
    const recentCount = r?.count ?? 0;
    if (priorCount + recentCount < MIN_ROWS_PER_SEGMENT) continue;

    const priorSum = p?.sum ?? 0;
    const recentSum = r?.sum ?? 0;
    const priorMean = p?.mean ?? 0;
    const recentMean = r?.mean ?? 0;

    let delta: number;
    let mixEffect: number;
    let rateEffect: number;

    if (additive) {
      delta = recentSum - priorSum;
      // Volume vs per-unit split, holding the other factor at its prior level.
      mixEffect = (recentCount - priorCount) * priorMean;
      rateEffect = recentCount * (recentMean - priorMean);
    } else {
      // For an average, a segment contributes through its weight in the mix.
      const priorWeight = priorRowsTotal === 0 ? 0 : priorCount / priorRowsTotal;
      const recentWeight = recentRowsTotal === 0 ? 0 : recentCount / recentRowsTotal;
      mixEffect = (recentWeight - priorWeight) * priorMean;
      rateEffect = recentWeight * (recentMean - priorMean);
      delta = mixEffect + rateEffect;
    }

    const test = welchTTest(r?.values ?? [], p?.values ?? []);

    contributions.push({
      value,
      priorTotal: additive ? priorSum : priorMean,
      recentTotal: additive ? recentSum : recentMean,
      priorCount,
      recentCount,
      priorMean,
      recentMean,
      delta,
      shareOfChange: totalDelta === 0 ? 0 : delta / totalDelta,
      mixEffect,
      rateEffect,
      pValue: test.pValue,
    });
  }

  if (contributions.length < 2) return null;

  contributions.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const top = contributions[0]!;
  const topVolumeShare = recentRowsTotal === 0 ? 0 : top.recentCount / recentRowsTotal;

  // A "driver" that explains less than a quarter of the move is not a driver;
  // the change is diffuse and naming one segment would mislead.
  if (Math.abs(top.shareOfChange) < 0.25) {
    trace.push(
      `Сильнейший сегмент «${top.value}» объясняет лишь ${formatPercent(Math.abs(top.shareOfChange))} ` +
      'совокупного изменения — оно размазано по всем сегментам, отдельного драйвера нет.',
    );
    return null;
  }

  /*
   * The filter that separates a finding from a tautology.
   *
   * A segment holding 90% of the volume will account for ~90% of any change,
   * and saying so tells the reader nothing they did not already know. What is
   * informative is a segment moving the total *disproportionately* to its
   * size. So the bar is excess contribution — share of the change minus share
   * of the volume — not raw contribution.
   */
  const excess = Math.abs(top.shareOfChange) - topVolumeShare;
  trace.push(
    `Доля сегмента «${top.value}» в объёме: ${formatPercent(topVolumeShare)}; ` +
    `доля в изменении: ${formatPercent(Math.abs(top.shareOfChange))}; ` +
    `превышение: ${(excess * 100).toFixed(1)} п.п.`,
  );
  if (excess < 0.12) {
    trace.push(
      'Вклад сегмента примерно пропорционален его размеру — это не драйвер, ' +
      'а просто самый крупный сегмент. Находка отклонена как неинформативная.',
    );
    return null;
  }

  trace.push(
    `Вклад сегмента «${top.value}»: ${formatNumber(top.delta, measure.unit)} ` +
    `(${formatPercent(Math.abs(top.shareOfChange))} совокупного изменения). ` +
    `Разложение: эффект объёма ${formatNumber(top.mixEffect, measure.unit)}, ` +
    `эффект ставки ${formatNumber(top.rateEffect, measure.unit)}.`,
  );
  trace.push(
    `Проверка значимости различия по строкам сегмента (тест Уэлча): ` +
    `n=${top.recentCount} против n=${top.priorCount}, ${formatP(top.pValue)}.`,
  );

  const mixDominant = Math.abs(top.mixEffect) > Math.abs(top.rateEffect);
  const quality = qualityOf(dataset, [measure.column, dimension.column, time.column]);
  const relativeSegmentChange =
    top.priorTotal === 0 ? 1 : (top.recentTotal - top.priorTotal) / Math.abs(top.priorTotal);

  const totalMeasure = additive
    ? Math.abs(priorTotal) + Math.abs(recentTotal)
    : Math.max(Math.abs(priorTotal), Math.abs(recentTotal));
  const shareOfTotal = totalMeasure === 0
    ? 0
    : Math.min(1, (Math.abs(top.priorTotal) + Math.abs(top.recentTotal)) / Math.max(1e-9, totalMeasure));

  const directionWord = top.delta > 0 ? 'прирост' : 'падение';
  const others = contributions.slice(1, 5);

  const nextSteps: NextStep[] = [
    {
      type: 'investigate',
      action: mixDominant
        ? `Выяснить, почему изменился объём сегмента «${top.value}» (${top.priorCount} → ${top.recentCount} строк)`
        : `Выяснить, почему изменилось само значение внутри «${top.value}» (${formatNumber(top.priorMean, measure.unit)} → ${formatNumber(top.recentMean, measure.unit)} на строку)`,
      rationale: mixDominant
        ? 'Доминирует эффект объёма: сегмент стал больше или меньше, при почти неизменном значении на строку. Причина обычно снаружи — спрос, маркетинг, доступность.'
        : 'Доминирует эффект ставки: сегмент не изменился в размере, но значение на строку сдвинулось. Причина обычно внутри — цена, качество, состав предложения.',
      query: {
        datasetId: dataset.id,
        metrics: [{ measure: measure.name }, { measure: 'Количество строк' }],
        groupBy: [time.name, dimension.name],
        filters: [{ field: dimension.name, operator: 'eq', value: top.value }],
        timeGrain: time.grain,
      },
    },
    {
      type: 'act',
      action: `Оценить эффект от воздействия на «${top.value}»: сегмент отвечает за ${formatPercent(Math.abs(top.shareOfChange))} изменения`,
      rationale:
        'Это точка максимального рычага в текущих данных: работа с остальными сегментами даст пропорционально меньший результат.',
    },
  ];

  // Segments moving against the aggregate are the most interesting thing on
  // the page and are routinely invisible in a headline number.
  const opposing = contributions.filter(
    (c) => Math.sign(c.delta) !== Math.sign(totalDelta) && Math.abs(c.delta) > Math.abs(totalDelta) * 0.15,
  );
  if (opposing.length > 0) {
    nextSteps.push({
      type: 'investigate',
      action: `Разобрать сегменты, идущие против общего движения: ${opposing.slice(0, 3).map((o) => `«${o.value}»`).join(', ')}`,
      rationale:
        'Эти сегменты компенсируют общее изменение и потому не видны в агрегате. ' +
        'Если общее движение неблагоприятно, здесь может быть рабочая практика, которую стоит распространить.',
    });
    trace.push(
      `Против общего направления движутся: ${opposing.slice(0, 5).map((o) => `${o.value} (${formatNumber(o.delta, measure.unit)})`).join(', ')}.`,
    );
  }

  if (top.pValue > 0.05) {
    nextSteps.push({
      type: 'fix_data',
      action: 'Собрать больше данных по сегменту перед принятием решений',
      rationale: `Различие внутри сегмента не проходит порог значимости (${formatP(top.pValue)}) — вклад может быть случайным.`,
    });
  }

  return baseInsight({
    datasetId: dataset.id,
    kind: 'driver',
    title:
      `${dimension.name} = «${top.value}»: ${formatPercent(Math.abs(top.shareOfChange))} ` +
      `изменения «${measure.name}»`,
    narrative:
      `При сравнении раннего и позднего периодов «${measure.name}» изменилась на ` +
      `${formatNumber(totalDelta, measure.unit)}. Основной вклад даёт значение «${top.value}» ` +
      `измерения «${dimension.name}»: ${formatNumber(top.delta, measure.unit)}, то есть ` +
      `${formatPercent(Math.abs(top.shareOfChange))} всего изменения при доле в объёме ` +
      `${formatPercent(topVolumeShare)} — то есть непропорционально своему размеру, ` +
      `с превышением на ${(excess * 100).toFixed(0)} п.п. ` +
      (Math.abs(top.shareOfChange) > 1
        ? 'Доля выше 100% означает, что часть других сегментов двигалась в противоположную сторону ' +
          'и гасила это изменение: без них совокупный сдвиг был бы больше. '
        : '') +
      (mixDominant
        ? `Изменение идёт от объёма: число строк сегмента ушло с ${top.priorCount} на ${top.recentCount}, ` +
          `тогда как значение на строку осталось около ${formatNumber(top.recentMean, measure.unit)}.`
        : `Изменение идёт от значения: число строк почти не поменялось (${top.priorCount} → ${top.recentCount}), ` +
          `а значение на строку сдвинулось с ${formatNumber(top.priorMean, measure.unit)} на ${formatNumber(top.recentMean, measure.unit)}.`) +
      (others.length > 0
        ? ` Следующие по величине: ${others.map((o) => `«${o.value}» (${formatNumber(o.delta, measure.unit)})`).join(', ')}.`
        : ''),
    impact: impactFrom({
      shareOfTotal,
      relativeEffect: relativeSegmentChange,
      coverage: recentRowsTotal === 0 ? 0 : top.recentCount / recentRowsTotal,
    }),
    confidence: confidenceFrom({
      pValue: top.pValue,
      sampleSize: Math.min(top.priorCount, top.recentCount),
      minSample: MIN_ROWS_PER_SEGMENT,
      dataQuality: quality,
      semanticReviewed: dataset.semantic.reviewed,
      // Contribution shares are exact arithmetic; the significance test is the
      // only uncertain part, so a weak p-value should not zero the finding.
      penalty: Math.abs(top.shareOfChange) > 0.5 ? 1 : 0.85,
    }),
    evidence: {
      statistic: top.shareOfChange,
      statisticLabel: 'Доля сегмента в совокупном изменении',
      pValue: top.pValue,
      effectSize: relativeSegmentChange,
      effectSizeLabel: 'Относительное изменение внутри сегмента',
      sampleSize: top.priorCount + top.recentCount,
      facts: [
        { label: 'Сегмент', value: `${dimension.name} = ${top.value}` },
        { label: 'Ранний период', value: priorLabel },
        { label: 'Поздний период', value: recentLabel },
        { label: 'Значение до → после', value: `${formatNumber(top.priorTotal, measure.unit)} → ${formatNumber(top.recentTotal, measure.unit)}` },
        { label: 'Вклад в изменение', value: `${formatNumber(top.delta, measure.unit)} (${formatPercent(Math.abs(top.shareOfChange))})` },
        { label: 'Эффект объёма', value: formatNumber(top.mixEffect, measure.unit) },
        { label: 'Эффект значения на строку', value: formatNumber(top.rateEffect, measure.unit) },
        { label: 'Строк до → после', value: `${top.priorCount} → ${top.recentCount}` },
        { label: 'Совокупное изменение', value: formatNumber(totalDelta, measure.unit) },
        { label: 'Значимость (тест Уэлча)', value: formatP(top.pValue) },
      ],
    },
    trace,
    caveats: [
      'Разложение на эффект объёма и эффект значения не единственно возможное: результат зависит от того, какой фактор фиксируется первым.',
      'Периоды разделены пополам по числу наблюдений, а не по календарю — при неравномерной активности границы окон не совпадают с календарными.',
      opposing.length > 0
        ? `${opposing.length} сегментов движутся против общего направления и частично компенсируют изменение.`
        : '',
      prior.truncatedGroups + recent.truncatedGroups > 0
        ? `Учтены только крупнейшие сегменты; ${prior.truncatedGroups + recent.truncatedGroups} мелких значений отброшено.`
        : '',
      'Вклад — это не причина: сегмент может двигаться под действием общего для всех фактора.',
    ].filter(Boolean),
    nextSteps,
    chart: {
      type: 'hbar',
      xLabel: `Вклад в изменение «${measure.name}»`,
      yLabel: dimension.name,
      unit: measure.unit,
      series: [{
        name: 'Вклад',
        points: contributions.slice(0, 10).map((c) => ({
          x: c.value,
          y: Number(c.delta.toFixed(4)),
          annotation: formatPercent(Math.abs(c.shareOfChange), 0),
        })),
      }],
    },
    subjects: [measure.name, dimension.name, time.name],
  });
}

function weightedMean(groups: Array<{ sum: number; count: number }>): number {
  let sum = 0;
  let count = 0;
  for (const g of groups) { sum += g.sum; count += g.count; }
  return count === 0 ? 0 : sum / count;
}
