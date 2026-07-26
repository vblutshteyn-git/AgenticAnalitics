/**
 * The language layer — strictly optional, and strictly linguistic.
 *
 * The division of labour in this system is deliberate: **statistics are
 * computed in code, language is produced by the model.** The model never
 * reports a number it was not handed, never decides whether a finding is
 * significant, and never queries the data directly. It does two things:
 *
 *   1. Writes the run's headline from findings that already passed
 *      verification.
 *   2. Translates a natural-language question into a {@link SemanticQuery} —
 *      a structured object validated against a schema, which the deterministic
 *      engine then executes.
 *
 * Both paths degrade to a working deterministic answer when no API key is
 * configured, when the API is unreachable, or when a request is declined. The
 * product is fully usable with no model at all; the model improves the prose.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
// The SDK's structured-output helper is typed against Zod 4; zod@3.25 ships it
// under this subpath. The rest of the codebase has no Zod dependency.
import { z } from 'zod/v4';

import type { QualityReport } from '../analysis/quality.js';
import { describeModel } from '../core/semantic.js';
import type { Dataset, Insight, SemanticQuery } from '../core/types.js';

/** The model this product is built against. */
export const DEFAULT_MODEL = 'claude-opus-5';

export interface LlmClient {
  client: Anthropic;
  model: string;
}

/**
 * Build a client if credentials are available. Returns null otherwise — the
 * caller is expected to carry on without one rather than fail.
 */
export function createLlmClient(model = process.env['AGENTICS_MODEL'] ?? DEFAULT_MODEL): LlmClient | null {
  const hasCredentials =
    !!process.env['ANTHROPIC_API_KEY'] || !!process.env['ANTHROPIC_AUTH_TOKEN'];
  if (!hasCredentials) return null;
  return { client: new Anthropic(), model };
}

/**
 * Written into every prompt. The prohibitions are the point: an analytics
 * agent that invents a plausible number is worse than one that says nothing,
 * because the number will be believed.
 */
const GUARDRAILS = `Ты — аналитический редактор в системе agentic analytics.

Жёсткие правила:
- Используй ТОЛЬКО те числа, которые явно приведены во входных данных. Никогда не вычисляй, не округляй и не оценивай значения самостоятельно.
- Не добавляй выводов, которые не следуют из переданных находок. Если данных для утверждения нет — не делай утверждения.
- Не смягчай и не усиливай статистику: если находка помечена низкой уверенностью, это должно быть видно в тексте.
- Корреляция не означает причинную связь. Никогда не формулируй наблюдательную зависимость как причину.

Стиль: деловой русский, без маркетинговых оборотов, без обращений к читателю, без вводных фраз вроде «Вот краткая сводка».`;

/** Shared request options. Effort stays low: this is a writing task. */
const NARRATION_TOKENS = 8000;

/**
 * Compose the run headline.
 *
 * Returns null on any failure — including a refusal — so the orchestrator
 * falls back to its deterministic headline. There is no path where a failure
 * here costs the user their results.
 */
export async function narrateRun(
  llm: LlmClient,
  dataset: Dataset,
  insights: Insight[],
  quality: QualityReport,
  focus?: string,
): Promise<string | null> {
  const nonQuality = insights.filter((i) => i.kind !== 'quality');
  const findings = insights.slice(0, 8).map((i, idx) => {
    const facts = i.evidence.facts.slice(0, 6).map((f) => `      ${f.label}: ${f.value}`).join('\n');
    return [
      `  [${idx + 1}] ${i.title}`,
      `      тип: ${i.kind}`,
      `      уверенность: ${(i.confidence * 100).toFixed(0)}%, влияние: ${(i.impact * 100).toFixed(0)}%`,
      facts,
      i.caveats.length > 0 ? `      оговорки: ${i.caveats.join(' ')}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const prompt = [
    `Набор данных: «${dataset.name}» — ${dataset.rowCount} строк, ${dataset.columns.length} колонок.`,
    `Гранулярность: ${dataset.semantic.grainDescription}`,
    `Качество данных: ${(quality.score * 100).toFixed(0)}%.` +
      (quality.issues.filter((i) => i.severity === 'high').length > 0
        ? ` Критичные замечания: ${quality.issues.filter((i) => i.severity === 'high').map((i) => i.message).join(' ')}`
        : ''),
    dataset.semantic.reviewed
      ? 'Семантическая модель подтверждена пользователем.'
      : 'Семантическая модель сгенерирована автоматически и не подтверждена.',
    focus ? `\nПользователь просил сфокусироваться на: «${focus}»` : '',
    nonQuality.length === 0
      ? '\nСтатистически подтверждённых находок нет.'
      : `\nПодтверждённые находки (уже прошли проверку значимости и поправку на множественность):\n\n${findings}`,
    '',
    'Напиши итог для руководителя: 3–5 предложений. Первое предложение — главный вывод, ' +
      'то есть ответ на вопрос «что здесь важного». Далее — связь между находками, если она есть. ' +
      'Последнее предложение — один конкретный следующий шаг. ' +
      'Не перечисляй находки списком, не пересказывай их по очереди: свяжи их в один связный вывод. ' +
      'Не используй заголовки и маркированные списки.',
  ].filter(Boolean).join('\n');

  try {
    const response = await llm.client.beta.messages.create({
      model: llm.model,
      max_tokens: NARRATION_TOKENS,
      // A writing task over pre-computed facts: low effort is the right spend.
      output_config: { effort: 'low' },
      // Recommended default on this model: a declined request is re-run
      // server-side on Anthropic's fallback rather than returned as a refusal.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: GUARDRAILS,
      messages: [{ role: 'user', content: prompt }],
    });

    // Check the stop reason before touching content: on a refusal the content
    // array is empty or partial, and indexing it blindly would throw.
    if (response.stop_reason === 'refusal') return null;

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Natural language → semantic query
// ---------------------------------------------------------------------------

/**
 * The shape the model is constrained to produce. Structured output means the
 * model cannot answer the question in prose — it can only name a measure, a
 * dimension and a filter, all of which are then validated against the semantic
 * model before anything executes. An invented column name fails loudly at the
 * query layer instead of quietly becoming a wrong answer.
 */
const QueryPlanSchema = z.object({
  understood: z
    .boolean()
    .describe('Удалось ли выразить вопрос через доступные метрики и измерения.'),
  reasoning: z
    .string()
    .describe('Одно предложение: как вопрос отображён на семантическую модель, либо почему это невозможно.'),
  metrics: z
    .array(
      z.object({
        measure: z.string().describe('Точное имя метрики из семантической модели.'),
        aggregation: z
          .enum(['sum', 'avg', 'min', 'max', 'count', 'count_distinct', 'median'])
          .describe('Агрегация. Для неаддитивных метрик используй avg, не sum.'),
      }),
    )
    .describe('Метрики для расчёта. Не более трёх.'),
  groupBy: z
    .array(z.string())
    .describe('Имена измерений или временных осей для разреза. Пустой массив, если разрез не нужен.'),
  timeGrain: z
    .enum(['hour', 'day', 'week', 'month', 'quarter', 'year', 'none'])
    .describe('Шаг по времени. "none", если группировки по времени нет.'),
  filters: z
    .array(
      z.object({
        field: z.string().describe('Имя поля из семантической модели.'),
        operator: z.enum(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_null', 'not_null']),
        value: z.string().describe('Значение для сравнения. Для оператора in — значения через запятую.'),
      }),
    )
    .describe('Фильтры. Пустой массив, если фильтрация не нужна.'),
  orderByMetric: z
    .boolean()
    .describe('Сортировать по первой метрике по убыванию (для вопросов вида «топ-N»).'),
  limit: z.number().int().min(1).max(1000).describe('Максимум строк в результате.'),
});

export type QueryPlan = z.infer<typeof QueryPlanSchema>;

export interface PlannedQuery {
  query: SemanticQuery;
  reasoning: string;
}

/**
 * Translate a question into an executable query, or return why it cannot be
 * answered from this dataset. "I cannot answer that with these columns" is a
 * correct and useful response; a fabricated answer is not.
 */
export async function planQuery(
  llm: LlmClient,
  dataset: Dataset,
  question: string,
): Promise<PlannedQuery | { error: string }> {
  const prompt = [
    'Семантическая модель набора данных:',
    '',
    describeModel(dataset.semantic),
    '',
    `Вопрос пользователя: «${question}»`,
    '',
    'Вырази этот вопрос как структурированный запрос к модели выше.',
    'Используй только те имена метрик и измерений, которые перечислены — дословно.',
    'Если вопрос нельзя выразить через доступные поля, поставь understood = false ' +
      'и объясни в reasoning, каких именно данных не хватает.',
  ].join('\n');

  try {
    const response = await llm.client.messages.parse({
      model: llm.model,
      max_tokens: NARRATION_TOKENS,
      output_config: {
        effort: 'medium',
        format: zodOutputFormat(QueryPlanSchema),
      },
      system:
        GUARDRAILS +
        '\n\nСейчас твоя задача — только перевести вопрос в структурированный запрос. ' +
        'Ты не отвечаешь на вопрос и не приводишь никаких чисел: расчёт выполнит детерминированный движок.',
      messages: [{ role: 'user', content: prompt }],
    });

    if (response.stop_reason === 'refusal') {
      return { error: 'Запрос отклонён моделью. Сформулируйте вопрос иначе.' };
    }

    const plan = response.parsed_output;
    if (!plan) return { error: 'Не удалось разобрать ответ модели.' };
    if (!plan.understood) {
      return { error: plan.reasoning || 'Вопрос не выражается через доступные поля набора.' };
    }
    if (plan.metrics.length === 0) {
      return { error: 'Модель не смогла определить метрику для расчёта.' };
    }

    return { query: planToQuery(plan, dataset.id), reasoning: plan.reasoning };
  } catch (err) {
    return {
      error: `Языковая модель недоступна: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Convert the flat, LLM-friendly plan into the engine's query type. */
export function planToQuery(plan: QueryPlan, datasetId: string): SemanticQuery {
  const query: SemanticQuery = {
    datasetId,
    metrics: plan.metrics.slice(0, 3).map((m) => ({
      measure: m.measure,
      aggregation: m.aggregation,
    })),
    limit: plan.limit,
  };

  if (plan.groupBy.length > 0) query.groupBy = plan.groupBy;
  if (plan.timeGrain !== 'none') query.timeGrain = plan.timeGrain;

  if (plan.filters.length > 0) {
    query.filters = plan.filters.map((f) => {
      if (f.operator === 'is_null' || f.operator === 'not_null') {
        return { field: f.field, operator: f.operator };
      }
      if (f.operator === 'in') {
        return {
          field: f.field,
          operator: 'in' as const,
          value: f.value.split(',').map((v) => v.trim()).filter(Boolean),
        };
      }
      return { field: f.field, operator: f.operator, value: f.value };
    });
  }

  if (plan.orderByMetric && plan.metrics.length > 0) {
    const first = plan.metrics[0]!;
    query.orderBy = {
      field: `${first.aggregation}(${first.measure})`,
      direction: 'desc',
    };
  }

  return query;
}
