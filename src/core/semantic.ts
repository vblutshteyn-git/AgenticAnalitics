/**
 * The semantic layer.
 *
 * Gartner's 2026 market guide for agentic analytics predicts that 60% of
 * projects relying on MCP alone will fail by 2028, for lack of a consistent
 * semantic layer — MCP moves data to the agent but says nothing about what the
 * data means. This module is the answer to that: it turns raw profiled columns
 * into a declared contract of measures, dimensions and time grains, which is
 * the only surface the agent is allowed to query through.
 *
 * The model is generated automatically, then shown to the user for review.
 * `reviewed: false` propagates into insight confidence, so the product never
 * pretends a guessed model is a confirmed one.
 */

import type {
  Aggregation,
  ColumnProfile,
  DimensionDef,
  MeasureDef,
  SemanticModel,
  TimeDimensionDef,
} from './types.js';

/** Substrings that mark a numeric column as a countable amount. */
const ADDITIVE_HINTS = [
  'amount', 'revenue', 'sales', 'cost', 'price', 'total', 'sum', 'qty', 'quantity',
  'count', 'volume', 'spend', 'profit', 'margin', 'value', 'gmv', 'units', 'orders',
  'сумма', 'выручка', 'продажи', 'стоимость', 'цена', 'итог', 'количество', 'объем',
  'объём', 'прибыль', 'маржа', 'заказы', 'расход', 'доход',
];

/** Substrings that mark a numeric column as a ratio — never summed. */
const RATIO_HINTS = [
  'rate', 'ratio', 'percent', 'pct', 'share', 'avg', 'average', 'mean', 'score',
  'index', 'conversion', 'ctr', 'cpc', 'cpm', 'roi', 'roas', 'nps', 'churn',
  'utilization', 'utilisation', 'temperature', 'age', 'balance', 'level',
  // Durations measured per row: the total of "days to deliver" across orders
  // is not a quantity anyone wants, but the average very much is.
  'days', 'duration', 'latency', 'elapsed', 'lead_time', 'age_days',
  'доля', 'процент', 'средн', 'коэффициент', 'индекс', 'конверсия', 'рейтинг',
  'возраст', 'баланс', 'уровень', 'дней', 'длительность', 'срок',
];

/** Measures where a fall is the good outcome. */
const LOWER_IS_BETTER_HINTS = [
  'cost', 'churn', 'error', 'defect', 'latency', 'delay', 'complaint', 'refund',
  'cancel', 'bounce', 'downtime', 'incident', 'loss', 'debt', 'wait', 'failure',
  'расход', 'затрат', 'отток', 'ошибк', 'дефект', 'задержк', 'жалоб', 'возврат',
  'отмен', 'простой', 'инцидент', 'убыт', 'потер', 'ожидан', 'сбо',
];

const HIGHER_IS_BETTER_HINTS = [
  'revenue', 'profit', 'sales', 'margin', 'conversion', 'retention', 'satisfaction',
  'nps', 'growth', 'roi', 'roas', 'uptime', 'score', 'rating', 'engagement',
  'выручка', 'прибыль', 'продажи', 'маржа', 'конверсия', 'удержан', 'удовлетвор',
  'рост', 'рейтинг', 'вовлеч',
];

const UNIT_HINTS: Array<{ match: string[]; unit: string }> = [
  { match: ['usd', '$', 'dollar'], unit: 'USD' },
  { match: ['eur', '€'], unit: 'EUR' },
  { match: ['rub', '₽', 'руб'], unit: 'RUB' },
  { match: ['percent', 'pct', '%', 'rate', 'ratio', 'доля', 'процент'], unit: '%' },
  { match: ['sec', 'second', 'секунд'], unit: 's' },
  { match: ['ms', 'millisecond'], unit: 'ms' },
  { match: ['day', 'дн'], unit: 'дн.' },
];

/** Upper bound on distinct values for a dimension to be worth grouping by. */
export const MAX_GROUPABLE_CARDINALITY = 200;

export function buildSemanticModel(
  datasetId: string,
  profiles: ColumnProfile[],
  rowCount: number,
): SemanticModel {
  const measures: MeasureDef[] = [];
  const dimensions: DimensionDef[] = [];
  const timeDimensions: TimeDimensionDef[] = [];
  const identifiers: string[] = [];
  const ignored: Array<{ column: string; reason: string }> = [];

  for (const p of profiles) {
    const lower = p.name.toLowerCase();

    if (p.nullRate >= 0.98) {
      ignored.push({ column: p.name, reason: 'Пустая более чем на 98% колонка.' });
      continue;
    }
    if (p.distinctCount <= 1 && rowCount > 1) {
      ignored.push({ column: p.name, reason: 'Константа — одно значение во всех строках.' });
      continue;
    }

    switch (p.logicalType) {
      case 'date':
      case 'datetime': {
        if (!p.temporal) {
          ignored.push({ column: p.name, reason: 'Даты не удалось разобрать.' });
          break;
        }
        timeDimensions.push({
          name: p.name,
          column: p.name,
          grain: p.temporal.grain,
          min: p.temporal.min,
          max: p.temporal.max,
          description:
            `Временная ось, ${p.temporal.periods} ${periodWord(p.temporal.grain)} ` +
            `с ${p.temporal.min.slice(0, 10)} по ${p.temporal.max.slice(0, 10)}.`,
        });
        break;
      }

      case 'identifier': {
        identifiers.push(p.name);
        break;
      }

      case 'number':
      case 'integer': {
        /*
         * A low-cardinality integer is genuinely ambiguous: `status = 1|2|3`
         * is an encoded category, `support_tickets = 0..10` is a count, and
         * nothing in the data distinguishes them. Rather than guess and be
         * wrong half the time, expose it as both — groupable *and* summable.
         * The cost is a few extra hypotheses; the benefit is that neither
         * reading is silently unavailable.
         */
        const ambiguousCode =
          p.logicalType === 'integer' &&
          p.distinctCount <= 12 &&
          rowCount > 50 &&
          !hasHint(lower, ADDITIVE_HINTS);

        if (ambiguousCode) {
          dimensions.push({
            name: p.name,
            column: p.name,
            cardinality: p.distinctCount,
            groupable: true,
            description:
              `Целое число, всего ${p.distinctCount} уровней — может быть как кодом категории, ` +
              'так и небольшим счётчиком. Доступно и как измерение, и как метрика.',
          });
        }
        measures.push(makeMeasure(p, lower));
        break;
      }

      case 'boolean': {
        // Usable both ways: group by the flag, and track its rate over time.
        dimensions.push({
          name: p.name,
          column: p.name,
          cardinality: p.distinctCount,
          groupable: true,
          description: 'Логический признак.',
        });
        measures.push({
          name: `${p.name} (доля true)`,
          column: p.name,
          defaultAggregation: 'avg',
          additive: false,
          polarity: polarityFor(lower),
          unit: '%',
          description: 'Доля строк со значением «истина».',
        });
        break;
      }

      case 'category': {
        if (p.distinctCount > MAX_GROUPABLE_CARDINALITY) {
          dimensions.push({
            name: p.name,
            column: p.name,
            cardinality: p.distinctCount,
            groupable: false,
            description:
              `Высокая кардинальность (${p.distinctCount} значений) — ` +
              'группировка только по топ-значениям.',
          });
        } else {
          dimensions.push({
            name: p.name,
            column: p.name,
            cardinality: p.distinctCount,
            groupable: true,
            description: `Категория, ${p.distinctCount} значений.`,
          });
        }
        break;
      }

      case 'text': {
        if (p.cardinalityRatio > 0.9) {
          ignored.push({
            column: p.name,
            reason: 'Свободный текст, почти все значения уникальны — не подходит для группировки.',
          });
        } else {
          dimensions.push({
            name: p.name,
            column: p.name,
            cardinality: p.distinctCount,
            groupable: p.distinctCount <= MAX_GROUPABLE_CARDINALITY,
            description: `Текст, ${p.distinctCount} различных значений.`,
          });
        }
        break;
      }

      default:
        ignored.push({ column: p.name, reason: 'Тип колонки определить не удалось.' });
    }
  }

  // Row count is always available as a measure — many of the most useful
  // questions ("where did volume go?") are about counts, not amounts.
  measures.unshift({
    name: 'Количество строк',
    column: '*',
    defaultAggregation: 'count',
    additive: true,
    polarity: 'neutral',
    description: 'Число записей. Доступно всегда, независимо от колонок.',
  });

  return {
    datasetId,
    grainDescription: inferGrainDescription(profiles, identifiers, timeDimensions, rowCount),
    measures,
    dimensions,
    timeDimensions,
    identifiers,
    ignored,
    reviewed: false,
  };
}

function makeMeasure(p: ColumnProfile, lower: string): MeasureDef {
  const isRatio = hasHint(lower, RATIO_HINTS);
  const isAdditive = !isRatio && (hasHint(lower, ADDITIVE_HINTS) || guessAdditive(p));
  return {
    name: p.name,
    column: p.name,
    defaultAggregation: isAdditive ? 'sum' : 'avg',
    additive: isAdditive,
    polarity: polarityFor(lower),
    unit: unitFor(lower),
    description: isAdditive
      ? 'Аддитивная метрика — суммируется по любым разрезам.'
      : 'Неаддитивная метрика (отношение или уровень) — усредняется, не суммируется.',
  };
}

/**
 * Without a naming hint, treat a non-negative numeric column with real spread
 * as additive. Columns with negatives or a tight range around a central value
 * behave more like levels than amounts.
 */
function guessAdditive(p: ColumnProfile): boolean {
  const n = p.numeric;
  if (!n) return false;
  if (n.negativeCount > n.count * 0.05) return false;
  if (n.min < 0) return false;
  // A column bounded in 0..1 is almost always a rate.
  if (n.min >= 0 && n.max <= 1 && p.logicalType === 'number') return false;
  return true;
}

function polarityFor(lower: string): MeasureDef['polarity'] {
  if (hasHint(lower, LOWER_IS_BETTER_HINTS)) return 'lower_is_better';
  if (hasHint(lower, HIGHER_IS_BETTER_HINTS)) return 'higher_is_better';
  return 'neutral';
}

function unitFor(lower: string): string | undefined {
  for (const { match, unit } of UNIT_HINTS) {
    if (match.some((m) => lower.includes(m))) return unit;
  }
  return undefined;
}

function hasHint(lower: string, hints: string[]): boolean {
  return hints.some((h) => lower.includes(h));
}

function periodWord(grain: string): string {
  switch (grain) {
    case 'hour': return 'часов';
    case 'day': return 'дней';
    case 'week': return 'недель';
    case 'month': return 'месяцев';
    case 'quarter': return 'кварталов';
    case 'year': return 'лет';
    default: return 'периодов';
  }
}

/**
 * Describe what one row is. Used in narration and, more importantly, to warn
 * when the data is pre-aggregated — averaging an average is a classic way to
 * get a confidently wrong answer.
 */
function inferGrainDescription(
  profiles: ColumnProfile[],
  identifiers: string[],
  timeDimensions: TimeDimensionDef[],
  rowCount: number,
): string {
  const parts: string[] = [];
  if (identifiers.length > 0) {
    const idProfile = profiles.find((p) => p.name === identifiers[0]);
    if (idProfile && idProfile.cardinalityRatio > 0.95) {
      parts.push(`одна строка = одна запись «${identifiers[0]}»`);
    } else if (idProfile) {
      parts.push(`«${identifiers[0]}» повторяется (${idProfile.distinctCount} уникальных на ${rowCount} строк)`);
    }
  }
  if (timeDimensions.length > 0) {
    const t = timeDimensions[0]!;
    if (t.grain !== 'irregular') {
      parts.push(`временной шаг — ${periodWord(t.grain).replace(/ов$|ей$|ей$/, '')}`);
    }
  }
  if (parts.length === 0) return `${rowCount} строк, гранулярность не определена автоматически.`;
  return `${rowCount} строк: ${parts.join('; ')}.`;
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function findMeasure(model: SemanticModel, name: string): MeasureDef | undefined {
  const lower = name.toLowerCase();
  return (
    model.measures.find((m) => m.name.toLowerCase() === lower) ??
    model.measures.find((m) => m.column.toLowerCase() === lower)
  );
}

export function findDimension(model: SemanticModel, name: string): DimensionDef | undefined {
  const lower = name.toLowerCase();
  return (
    model.dimensions.find((d) => d.name.toLowerCase() === lower) ??
    model.dimensions.find((d) => d.column.toLowerCase() === lower)
  );
}

export function findTimeDimension(model: SemanticModel, name: string): TimeDimensionDef | undefined {
  const lower = name.toLowerCase();
  return (
    model.timeDimensions.find((t) => t.name.toLowerCase() === lower) ??
    model.timeDimensions.find((t) => t.column.toLowerCase() === lower)
  );
}

/**
 * Guard against the single most common agentic-analytics error: summing a
 * ratio. Returns the aggregation to actually use, plus a note when the
 * requested one was overridden.
 */
export function resolveAggregation(
  measure: MeasureDef,
  requested?: Aggregation,
): { aggregation: Aggregation; note?: string } {
  if (!requested) return { aggregation: measure.defaultAggregation };
  if (requested === 'sum' && !measure.additive) {
    return {
      aggregation: 'avg',
      note:
        `Метрика «${measure.name}» неаддитивна, суммирование заменено на среднее. ` +
        'Сумма отношений не имеет смысла.',
    };
  }
  return { aggregation: requested };
}

/** Render the model as compact text for an LLM prompt or an audit log. */
export function describeModel(model: SemanticModel): string {
  const lines: string[] = [];
  lines.push(`Гранулярность: ${model.grainDescription}`);
  lines.push(`Проверено человеком: ${model.reviewed ? 'да' : 'нет (модель сгенерирована автоматически)'}`);

  lines.push('\nМЕТРИКИ:');
  for (const m of model.measures) {
    const flags = [
      m.additive ? 'аддитивная' : 'неаддитивная',
      `агрегация по умолчанию: ${m.defaultAggregation}`,
      m.unit ? `ед.: ${m.unit}` : null,
      m.polarity !== 'neutral'
        ? m.polarity === 'higher_is_better' ? 'рост = хорошо' : 'рост = плохо'
        : null,
    ].filter(Boolean).join(', ');
    lines.push(`  - ${m.name} [${flags}]`);
  }

  lines.push('\nИЗМЕРЕНИЯ:');
  for (const d of model.dimensions) {
    lines.push(`  - ${d.name} [${d.cardinality} значений${d.groupable ? '' : ', только топ-N'}]`);
  }

  if (model.timeDimensions.length > 0) {
    lines.push('\nВРЕМЕННЫЕ ОСИ:');
    for (const t of model.timeDimensions) {
      lines.push(`  - ${t.name} [${t.grain}, ${t.min.slice(0, 10)} .. ${t.max.slice(0, 10)}]`);
    }
  }
  if (model.identifiers.length > 0) {
    lines.push(`\nИДЕНТИФИКАТОРЫ: ${model.identifiers.join(', ')}`);
  }
  if (model.ignored.length > 0) {
    lines.push('\nИСКЛЮЧЕНО ИЗ АНАЛИЗА:');
    for (const i of model.ignored) lines.push(`  - ${i.column}: ${i.reason}`);
  }
  return lines.join('\n');
}
