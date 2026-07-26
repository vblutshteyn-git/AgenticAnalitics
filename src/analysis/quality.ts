/**
 * Data quality gate.
 *
 * This runs before any hypothesis is tested, and it is the part of the system
 * that keeps the rest honest. The recurring criticism of MCP-connected agents
 * is that they will answer confidently from uncertified data; the answer here
 * is to make quality a first-class output — reported to the user *and* fed
 * back into every downstream confidence score, so a finding computed on a
 * column that is 40% null can never present itself as solid.
 */

import type { ColumnProfile, Dataset, Insight, NextStep } from '../core/types.js';
import {
  baseInsight,
  clamp01,
  formatNumber,
  formatPercent,
  impactFrom,
} from './helpers.js';

export interface QualityReport {
  /** 0..1, multiplied into the confidence of every other insight. */
  score: number;
  issues: QualityIssue[];
  insights: Insight[];
}

export interface QualityIssue {
  severity: 'high' | 'medium' | 'low';
  column?: string;
  kind: string;
  message: string;
  /** How much this drags the overall score down, 0..1. */
  weight: number;
}

const NULL_WARN = 0.05;
const NULL_HIGH = 0.3;

export function assessQuality(dataset: Dataset): QualityReport {
  const issues: QualityIssue[] = [];
  const analysed = analysedColumns(dataset);

  // --- missing values ------------------------------------------------------
  for (const p of dataset.profiles) {
    if (!analysed.has(p.name)) continue;
    if (p.nullRate >= NULL_HIGH) {
      issues.push({
        severity: 'high',
        column: p.name,
        kind: 'nulls',
        message:
          `Колонка «${p.name}» пуста в ${formatPercent(p.nullRate)} строк ` +
          `(${Math.round(p.nullRate * dataset.rowCount)} из ${dataset.rowCount}). ` +
          'Любой агрегат по ней посчитан на неполных данных.',
        weight: 0.25 * Math.min(1, p.nullRate / 0.5),
      });
    } else if (p.nullRate >= NULL_WARN) {
      issues.push({
        severity: 'medium',
        column: p.name,
        kind: 'nulls',
        message: `Колонка «${p.name}» пуста в ${formatPercent(p.nullRate)} строк.`,
        weight: 0.08,
      });
    }
  }

  // --- unparseable values --------------------------------------------------
  for (const p of dataset.profiles) {
    if (!analysed.has(p.name) || p.invalidCount === 0) continue;
    const rate = p.invalidCount / Math.max(1, dataset.rowCount);
    issues.push({
      severity: rate > 0.02 ? 'high' : 'low',
      column: p.name,
      kind: 'invalid',
      message:
        `В колонке «${p.name}» ${p.invalidCount} значений не соответствуют типу ` +
        `${p.logicalType} и исключены из расчётов (${formatPercent(rate)} строк).`,
      weight: Math.min(0.2, rate * 4),
    });
  }

  // --- duplicate rows ------------------------------------------------------
  const duplicates = countDuplicateRows(dataset);
  if (duplicates.count > 0) {
    const rate = duplicates.count / dataset.rowCount;
    issues.push({
      severity: rate > 0.01 ? 'high' : 'medium',
      kind: 'duplicates',
      message:
        `${duplicates.count} полностью совпадающих строк (${formatPercent(rate)}). ` +
        'Дубли завышают суммы и счётчики.',
      weight: Math.min(0.25, rate * 5),
    });
  }

  // --- duplicated identifiers ----------------------------------------------
  for (const idName of dataset.semantic.identifiers) {
    const p = dataset.profiles.find((x) => x.name === idName);
    if (!p) continue;
    const nonNull = Math.round((1 - p.nullRate) * dataset.rowCount);
    if (nonNull > 0 && p.distinctCount < nonNull) {
      const dupes = nonNull - p.distinctCount;
      issues.push({
        severity: 'medium',
        column: idName,
        kind: 'duplicate_keys',
        message:
          `Идентификатор «${idName}» повторяется: ${p.distinctCount} уникальных значений ` +
          `на ${nonNull} непустых строк (${dupes} повторов). ` +
          'Либо строка — не то, чем кажется, либо в данных есть задвоение.',
        weight: 0.12,
      });
    }
  }

  // --- time coverage -------------------------------------------------------
  for (const t of dataset.semantic.timeDimensions) {
    const p = dataset.profiles.find((x) => x.name === t.column);
    if (!p?.temporal) continue;
    if (p.temporal.gaps > 0) {
      const gapRate = p.temporal.gaps / Math.max(1, p.temporal.periods + p.temporal.gaps);
      issues.push({
        severity: gapRate > 0.2 ? 'high' : 'low',
        column: t.column,
        kind: 'time_gaps',
        message:
          `На оси «${t.name}» пропущено ${p.temporal.gaps} ${periodWord(t.grain)} ` +
          `из ${p.temporal.periods + p.temporal.gaps} (${formatPercent(gapRate)}). ` +
          'Тренды и сезонность на таком ряду искажаются.',
        weight: Math.min(0.2, gapRate * 0.6),
      });
    }
    // A dataset whose latest record is old is a common and silent trap.
    const ageDays = (Date.now() - Date.parse(p.temporal.max)) / 86400_000;
    if (ageDays > 90) {
      issues.push({
        severity: 'medium',
        column: t.column,
        kind: 'staleness',
        message:
          `Последняя запись по «${t.name}» датирована ${p.temporal.max.slice(0, 10)} — ` +
          `${Math.round(ageDays)} дней назад. Выводы описывают прошлое, а не текущее состояние.`,
        weight: 0.1,
      });
    }
  }

  // --- constant and near-constant columns ----------------------------------
  for (const p of dataset.profiles) {
    if (p.distinctCount === 1 && dataset.rowCount > 1) {
      issues.push({
        severity: 'low',
        column: p.name,
        kind: 'constant',
        message: `Колонка «${p.name}» содержит одно значение во всех строках — информативной нагрузки нет.`,
        weight: 0.02,
      });
    }
  }

  // --- suspicious numeric distributions ------------------------------------
  for (const p of dataset.profiles) {
    if (!p.numeric || !analysed.has(p.name)) continue;
    const zeroRate = p.numeric.zeroCount / Math.max(1, p.numeric.count);
    if (zeroRate > 0.5) {
      issues.push({
        severity: 'medium',
        column: p.name,
        kind: 'zero_inflation',
        message:
          `В колонке «${p.name}» ${formatPercent(zeroRate)} значений равны нулю. ` +
          'Если ноль здесь означает «нет данных», средние занижены.',
        weight: 0.08,
      });
    }
    // A max thousands of times the 95th percentile is usually a unit error.
    if (p.numeric.p95 > 0 && p.numeric.max > p.numeric.p95 * 100) {
      issues.push({
        severity: 'medium',
        column: p.name,
        kind: 'extreme_outlier',
        message:
          `Максимум «${p.name}» (${formatNumber(p.numeric.max)}) в ${Math.round(p.numeric.max / p.numeric.p95)} раз ` +
          `превышает 95-й перцентиль (${formatNumber(p.numeric.p95)}). ` +
          'Похоже на ошибку единиц измерения или тестовую запись.',
        weight: 0.1,
      });
    }
  }

  const totalWeight = issues.reduce((a, i) => a + i.weight, 0);
  const score = clamp01(1 - Math.min(0.75, totalWeight));

  return {
    score,
    issues,
    insights: buildQualityInsights(dataset, issues, score),
  };
}

/** Only columns the semantic model actually uses affect the score. */
function analysedColumns(dataset: Dataset): Set<string> {
  const s = new Set<string>();
  for (const m of dataset.semantic.measures) if (m.column !== '*') s.add(m.column);
  for (const d of dataset.semantic.dimensions) s.add(d.column);
  for (const t of dataset.semantic.timeDimensions) s.add(t.column);
  return s;
}

function countDuplicateRows(dataset: Dataset): { count: number } {
  // Hash on the analysed columns only: a differing surrogate key should not
  // hide two otherwise identical records.
  const analysed = analysedColumns(dataset);
  const indices = dataset.columns
    .map((c, i) => ({ c, i }))
    .filter((x) => analysed.has(x.c))
    .map((x) => x.i);
  if (indices.length === 0) return { count: 0 };

  const seen = new Set<string>();
  let count = 0;
  for (let r = 0; r < dataset.rowCount; r++) {
    let key = '';
    for (const ci of indices) key += (dataset.values[ci]?.[r] ?? ' ') + '';
    if (seen.has(key)) count++;
    else seen.add(key);
  }
  return { count };
}

function buildQualityInsights(
  dataset: Dataset,
  issues: QualityIssue[],
  score: number,
): Insight[] {
  const serious = issues.filter((i) => i.severity === 'high');
  if (serious.length === 0 && score > 0.85) return [];

  const trace: string[] = [
    `Проверено ${dataset.columns.length} колонок и ${dataset.rowCount} строк.`,
    `Найдено проблем: ${issues.length} (критичных: ${serious.length}, ` +
      `средних: ${issues.filter((i) => i.severity === 'medium').length}, ` +
      `низких: ${issues.filter((i) => i.severity === 'low').length}).`,
    `Итоговая оценка качества: ${(score * 100).toFixed(0)}% — этот коэффициент умножается ` +
      'на уверенность всех остальных находок.',
  ];

  const nextSteps: NextStep[] = serious.slice(0, 3).map((issue) => ({
    type: 'fix_data' as const,
    action: issue.column
      ? `Разобраться с колонкой «${issue.column}»: ${issue.kind === 'nulls' ? 'выяснить причину пропусков' : issue.kind === 'invalid' ? 'привести значения к единому формату' : 'проверить корректность данных'}`
      : `Устранить: ${issue.kind === 'duplicates' ? 'дублирование строк в выгрузке' : issue.kind}`,
    rationale: issue.message,
  }));

  nextSteps.push({
    type: 'act',
    action: 'Подтвердить семантическую модель перед принятием решений по этим данным',
    rationale:
      'Модель метрик и измерений сформирована автоматически. Пока она не проверена, ' +
      'уверенность всех выводов ограничена сверху — агент мог неверно понять смысл колонок.',
  });

  const insight = baseInsight({
    datasetId: dataset.id,
    kind: 'quality',
    title:
      serious.length > 0
        ? `Качество данных ${(score * 100).toFixed(0)}%: ${serious.length} критичных ${plural(serious.length, 'проблема', 'проблемы', 'проблем')}`
        : `Качество данных ${(score * 100).toFixed(0)}%: есть замечания`,
    narrative:
      `Перед анализом набор проверен на полноту, дубли, соответствие типов и покрытие по времени. ` +
      `Итоговая оценка — ${(score * 100).toFixed(0)}%. ` +
      (serious.length > 0
        ? `Критичные проблемы: ${serious.map((i) => i.message).join(' ')} `
        : 'Критичных проблем не найдено, но замечания есть. ') +
      `Оценка качества входит множителем в уверенность каждой находки ниже, ` +
      `поэтому выводы по этому набору намеренно осторожнее, чем были бы на чистых данных.`,
    impact: impactFrom({ shareOfTotal: 1 - score, relativeEffect: 1 - score, coverage: 1 }),
    // The issues are counted, not inferred; the count itself is certain.
    confidence: 1,
    evidence: {
      statistic: score,
      statisticLabel: 'Оценка качества данных',
      sampleSize: dataset.rowCount,
      facts: [
        { label: 'Строк', value: String(dataset.rowCount) },
        { label: 'Колонок', value: String(dataset.columns.length) },
        { label: 'Всего замечаний', value: String(issues.length) },
        { label: 'Критичных', value: String(serious.length) },
        ...issues.slice(0, 10).map((i) => ({
          label: `${severityLabel(i.severity)}${i.column ? ` · ${i.column}` : ''}`,
          value: i.message,
        })),
      ],
    },
    trace,
    caveats: [
      'Проверка структурная: она не выявляет содержательно неверные, но правдоподобные значения.',
      'Правила порогов универсальны и могут не подходить для специфики конкретной предметной области.',
    ],
    nextSteps,
    subjects: issues.map((i) => i.column).filter((c): c is string => !!c),
  });

  return [insight];
}

function severityLabel(s: QualityIssue['severity']): string {
  return s === 'high' ? 'Критично' : s === 'medium' ? 'Средне' : 'Низко';
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

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
