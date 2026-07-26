/**
 * MCP server — the machine-facing entrance to the product.
 *
 * This is how data gets in and how findings get out when the caller is an
 * agent rather than a person: Claude Desktop, Claude Code, or any MCP client
 * can upload a dataset, run the analysis, and query results without a browser.
 *
 * The tools deliberately do **not** expose raw SQL or raw row access. Every
 * read goes through the semantic layer, which is what keeps a remote agent
 * from inventing a column and getting a confident wrong answer back. Tool
 * descriptions are written prescriptively — they state *when* to call each
 * tool, not just what it does — because that is what a calling model acts on.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { runAgent } from '../agent/orchestrator.js';
import { createLlmClient, planQuery } from '../agent/llm.js';
import { executeQuery, QueryError } from '../core/query.js';
import { describeModel } from '../core/semantic.js';
import type { DatasetStore } from '../core/store.js';
import type { Insight, RunSummary, SemanticQuery } from '../core/types.js';

export const SERVER_NAME = 'agentics-analytics';
export const SERVER_VERSION = '0.1.0';

export function buildMcpServer(store: DatasetStore): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Agentic analytics: загрузка данных → автоматическое исследование → проверенные инсайты.\n\n' +
        'Порядок работы:\n' +
        '1. upload_dataset — загрузить CSV или JSON. Возвращает dataset_id и автоматически ' +
        'построенную семантическую модель (метрики, измерения, временные оси).\n' +
        '2. get_semantic_model — проверить, правильно ли поняты колонки. При ошибке — ' +
        'update_semantic_model. Это важный шаг: все выводы опираются на эту модель.\n' +
        '3. analyze_dataset — запустить агента. Он формирует гипотезы, проверяет их ' +
        'статистически и возвращает только те, что прошли верификацию.\n' +
        '4. query_data — задать конкретный вопрос через семантическую модель.\n\n' +
        'Все числа рассчитываются детерминированным кодом, а не языковой моделью. ' +
        'Каждый инсайт содержит доказательства, трассировку расчёта и оговорки.',
    },
  );

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  server.registerTool(
    'upload_dataset',
    {
      title: 'Загрузить набор данных',
      description:
        'Загрузить табличные данные для анализа. Вызывай это, когда пользователь предоставил ' +
        'CSV, TSV или JSON и хочет их исследовать. Принимает содержимое файла как текст. ' +
        'Автоматически определяет типы колонок, профилирует их и строит семантическую модель. ' +
        'Возвращает dataset_id, который нужен всем остальным инструментам.',
      inputSchema: {
        name: z.string().describe('Понятное имя набора, например «Продажи за 2025» или имя файла.'),
        content: z
          .string()
          .describe('Полное содержимое файла как текст: CSV, TSV, JSON-массив объектов или NDJSON.'),
        format: z
          .enum(['csv', 'tsv', 'json', 'auto'])
          .optional()
          .describe('Формат данных. По умолчанию auto — определяется по содержимому.'),
        notes: z
          .string()
          .optional()
          .describe('Контекст о данных: откуда они, что означает строка, известные проблемы.'),
      },
    },
    async ({ name, content, format, notes }) => {
      try {
        const { dataset, warnings } = store.ingest(content, {
          name,
          source: 'mcp',
          formatHint: format === 'auto' ? undefined : format,
          notes,
        });

        const lines = [
          `Набор загружен: ${dataset.id}`,
          `Строк: ${dataset.rowCount}, колонок: ${dataset.columns.length}`,
          '',
          describeModel(dataset.semantic),
        ];
        if (warnings.length > 0) {
          lines.push('', 'Предупреждения при разборе:', ...warnings.map((w) => `  - ${w}`));
        }
        lines.push(
          '',
          'Следующий шаг: проверь семантическую модель выше. Если метрика или измерение ' +
            'определены неверно, исправь через update_semantic_model — от этого зависит ' +
            'корректность всех выводов. Затем запусти analyze_dataset.',
        );

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            dataset_id: dataset.id,
            row_count: dataset.rowCount,
            columns: dataset.columns,
            warnings,
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_datasets',
    {
      title: 'Список наборов данных',
      description:
        'Показать все загруженные наборы с их идентификаторами. Вызывай, когда нужен ' +
        'dataset_id, а он неизвестен, или чтобы понять, что уже загружено.',
      inputSchema: {},
    },
    async () => {
      const datasets = store.list();
      if (datasets.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Нет загруженных наборов. Используй upload_dataset.',
          }],
        };
      }
      const text = datasets
        .map(
          (d) =>
            `${d.id}\n  «${d.name}» — ${d.rowCount} строк, ${d.columnCount} колонок\n` +
            `  метрик: ${d.measures}, измерений: ${d.dimensions}` +
            `${d.hasTime ? ', есть временная ось' : ', временной оси нет'}\n` +
            `  инсайтов: ${d.insightCount}, загружен: ${d.createdAt.slice(0, 16).replace('T', ' ')}`,
        )
        .join('\n\n');
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { datasets },
      };
    },
  );

  // -------------------------------------------------------------------------
  // Semantic layer
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_semantic_model',
    {
      title: 'Получить семантическую модель',
      description:
        'Показать, как система поняла колонки набора: что считается метрикой, что измерением, ' +
        'что временной осью, и что исключено из анализа. Вызывай перед анализом, чтобы ' +
        'убедиться в правильности трактовки, и всегда, когда результат выглядит неожиданно — ' +
        'причина чаще всего здесь.',
      inputSchema: {
        dataset_id: z.string().describe('Идентификатор набора из upload_dataset или list_datasets.'),
      },
    },
    async ({ dataset_id }) => {
      try {
        const dataset = store.require(dataset_id);
        return {
          content: [{ type: 'text' as const, text: describeModel(dataset.semantic) }],
          structuredContent: { semantic_model: dataset.semantic },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'update_semantic_model',
    {
      title: 'Исправить семантическую модель',
      description:
        'Изменить трактовку колонок: сменить агрегацию метрики, отметить её как неаддитивную, ' +
        'задать направление «хорошо/плохо», или подтвердить модель целиком. ' +
        'Вызывай, когда get_semantic_model показал неверную трактовку — например, метрика-отношение ' +
        'помечена как суммируемая. Подтверждение модели (reviewed) снимает ограничение сверху ' +
        'на уверенность всех выводов.',
      inputSchema: {
        dataset_id: z.string().describe('Идентификатор набора.'),
        reviewed: z
          .boolean()
          .optional()
          .describe('Отметить модель как проверенную человеком. Повышает уверенность выводов.'),
        measure_updates: z
          .array(
            z.object({
              name: z.string().describe('Имя метрики, как в семантической модели.'),
              default_aggregation: z
                .enum(['sum', 'avg', 'min', 'max', 'count', 'count_distinct', 'median'])
                .optional(),
              additive: z
                .boolean()
                .optional()
                .describe('false для отношений, ставок и уровней — их нельзя суммировать.'),
              polarity: z
                .enum(['higher_is_better', 'lower_is_better', 'neutral'])
                .optional()
                .describe('Направление, в котором изменение метрики считается благоприятным.'),
              unit: z.string().optional().describe('Единица измерения для отображения.'),
            }),
          )
          .optional()
          .describe('Исправления по метрикам.'),
        grain_description: z
          .string()
          .optional()
          .describe('Что представляет собой одна строка, например «одна транзакция».'),
      },
    },
    async ({ dataset_id, reviewed, measure_updates, grain_description }) => {
      try {
        const dataset = store.require(dataset_id);
        const measures = dataset.semantic.measures.map((m) => {
          const patch = measure_updates?.find((u) => u.name.toLowerCase() === m.name.toLowerCase());
          if (!patch) return m;
          return {
            ...m,
            defaultAggregation: patch.default_aggregation ?? m.defaultAggregation,
            additive: patch.additive ?? m.additive,
            polarity: patch.polarity ?? m.polarity,
            unit: patch.unit ?? m.unit,
          };
        });

        const unmatched = (measure_updates ?? [])
          .filter((u) => !measures.some((m) => m.name.toLowerCase() === u.name.toLowerCase()))
          .map((u) => u.name);

        const updated = store.updateSemanticModel(dataset_id, {
          measures,
          ...(reviewed !== undefined ? { reviewed } : {}),
          ...(grain_description ? { grainDescription: grain_description } : {}),
        });

        const text = [
          'Семантическая модель обновлена.',
          unmatched.length > 0
            ? `Не найдены метрики (изменения не применены): ${unmatched.join(', ')}.`
            : '',
          '',
          describeModel(updated),
        ].filter(Boolean).join('\n');

        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: { semantic_model: updated, unmatched_measures: unmatched },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'profile_dataset',
    {
      title: 'Профиль колонок',
      description:
        'Подробная статистика по каждой колонке: тип, доля пропусков, кардинальность, ' +
        'распределение числовых значений, топ-значения категорий, покрытие по времени. ' +
        'Вызывай, когда нужно понять структуру и качество данных до анализа, или чтобы ' +
        'разобраться, почему находка выглядит странно.',
      inputSchema: {
        dataset_id: z.string().describe('Идентификатор набора.'),
        columns: z
          .array(z.string())
          .optional()
          .describe('Ограничить вывод этими колонками. По умолчанию — все.'),
      },
    },
    async ({ dataset_id, columns }) => {
      try {
        const dataset = store.require(dataset_id);
        const selected = columns
          ? dataset.profiles.filter((p) => columns.includes(p.name))
          : dataset.profiles;

        const text = selected.map((p) => {
          const lines = [`${p.name} [${p.logicalType}]`];
          lines.push(
            `  пропусков: ${(p.nullRate * 100).toFixed(1)}%, ` +
              `уникальных: ${p.distinctCount} (${(p.cardinalityRatio * 100).toFixed(1)}%)`,
          );
          if (p.invalidCount > 0) lines.push(`  не соответствуют типу: ${p.invalidCount} значений`);
          if (p.numeric) {
            const n = p.numeric;
            lines.push(
              `  min ${fmt(n.min)} / p25 ${fmt(n.p25)} / медиана ${fmt(n.median)} / ` +
                `p75 ${fmt(n.p75)} / max ${fmt(n.max)}`,
              `  среднее ${fmt(n.mean)}, ст.откл. ${fmt(n.stdev)}, сумма ${fmt(n.sum)}`,
              `  нулей: ${n.zeroCount}, отрицательных: ${n.negativeCount}`,
            );
          }
          if (p.temporal) {
            lines.push(
              `  период: ${p.temporal.min.slice(0, 10)} .. ${p.temporal.max.slice(0, 10)}, ` +
                `шаг ${p.temporal.grain}, периодов ${p.temporal.periods}, пропусков ${p.temporal.gaps}`,
            );
          }
          if (p.topValues && p.topValues.length > 0) {
            lines.push(
              `  топ: ${p.topValues.slice(0, 5).map((v) => `${v.value} (${(v.share * 100).toFixed(1)}%)`).join(', ')}`,
            );
          }
          return lines.join('\n');
        }).join('\n\n');

        return {
          content: [{ type: 'text' as const, text: text || 'Колонки не найдены.' }],
          structuredContent: { profiles: selected },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  server.registerTool(
    'analyze_dataset',
    {
      title: 'Найти инсайты',
      description:
        'Запустить полный цикл data-to-insight: профилирование → проверка качества → ' +
        'генерация гипотез → статистическая проверка → верификация → ранжирование. ' +
        'Это основной инструмент — вызывай его, когда пользователь спрашивает «что интересного ' +
        'в этих данных», «найди закономерности» или «проанализируй». ' +
        'Возвращает только находки, прошедшие проверку значимости с поправкой на множественность ' +
        'сравнений, вместе с доказательствами, оговорками и следующими шагами. ' +
        'Отсутствие находок — тоже валидный результат, он означает отсутствие устойчивых закономерностей.',
      inputSchema: {
        dataset_id: z.string().describe('Идентификатор набора.'),
        focus: z
          .string()
          .optional()
          .describe(
            'Вопрос или тема на естественном языке, например «почему упала выручка» или ' +
              '«различия между регионами». Смещает приоритет гипотез, но не отключает остальные.',
          ),
        max_insights: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe('Сколько находок вернуть. По умолчанию 14.'),
      },
    },
    async ({ dataset_id, focus, max_insights }) => {
      try {
        const dataset = store.require(dataset_id);
        const insights: Insight[] = [];
        let summary: RunSummary | undefined;

        for await (const event of runAgent(dataset, {
          focus,
          maxInsights: max_insights ?? 14,
          llm: createLlmClient(),
        })) {
          if (event.insight) insights.push(event.insight);
          if (event.summary) summary = event.summary;
          if (event.phase === 'error') {
            return { content: [{ type: 'text' as const, text: event.message }], isError: true };
          }
        }

        // The rank phase re-emits confirmed insights; keep the last occurrence.
        const deduped = Array.from(new Map(insights.map((i) => [i.id, i])).values());
        store.setInsights(dataset_id, deduped);

        return {
          content: [{ type: 'text' as const, text: renderInsights(deduped, summary) }],
          structuredContent: { insights: deduped, summary },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_insights',
    {
      title: 'Показать сохранённые инсайты',
      description:
        'Вернуть находки последнего анализа без повторного расчёта. Вызывай, когда ' +
        'analyze_dataset уже отработал и нужно снова посмотреть результаты или их детали.',
      inputSchema: {
        dataset_id: z.string().describe('Идентификатор набора.'),
        kind: z
          .enum(['trend', 'anomaly', 'driver', 'correlation', 'concentration', 'comparison', 'quality'])
          .optional()
          .describe('Оставить только находки этого типа.'),
      },
    },
    async ({ dataset_id, kind }) => {
      try {
        store.require(dataset_id);
        const all = store.getInsights(dataset_id);
        const filtered = kind ? all.filter((i) => i.kind === kind) : all;
        if (filtered.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: all.length === 0
                ? 'Инсайтов нет — сначала запусти analyze_dataset.'
                : `Инсайтов типа «${kind}» нет. Всего сохранено: ${all.length}.`,
            }],
          };
        }
        return {
          content: [{ type: 'text' as const, text: renderInsights(filtered) }],
          structuredContent: { insights: filtered },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Querying
  // -------------------------------------------------------------------------

  server.registerTool(
    'query_data',
    {
      title: 'Запрос через семантическую модель',
      description:
        'Рассчитать метрики в разрезе измерений. Вызывай для конкретных вопросов: ' +
        '«выручка по месяцам», «топ-10 клиентов», «средний чек по регионам». ' +
        'Поля указываются именами из семантической модели — произвольные имена колонок ' +
        'и SQL не принимаются, это защита от ответов по несуществующим полям. ' +
        'Если не уверен в именах — сначала вызови get_semantic_model.',
      inputSchema: {
        dataset_id: z.string().describe('Идентификатор набора.'),
        metrics: z
          .array(
            z.object({
              measure: z.string().describe('Имя метрики из семантической модели.'),
              aggregation: z
                .enum(['sum', 'avg', 'min', 'max', 'count', 'count_distinct', 'median'])
                .optional()
                .describe('По умолчанию используется агрегация метрики из модели.'),
            }),
          )
          .min(1)
          .describe('Метрики для расчёта.'),
        group_by: z
          .array(z.string())
          .optional()
          .describe('Измерения или временные оси для разреза.'),
        time_grain: z
          .enum(['hour', 'day', 'week', 'month', 'quarter', 'year'])
          .optional()
          .describe('Шаг агрегации по времени, если в group_by есть временная ось.'),
        filters: z
          .array(
            z.object({
              field: z.string(),
              operator: z.enum([
                'eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null', 'contains',
              ]),
              value: z
                .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])
                .optional()
                .describe('Не требуется для is_null и not_null. Массив для in и between.'),
            }),
          )
          .optional(),
        order_by: z
          .object({
            field: z.string().describe('Имя колонки результата, например «sum(Выручка)».'),
            direction: z.enum(['asc', 'desc']),
          })
          .optional(),
        limit: z.number().int().min(1).max(5000).optional().describe('По умолчанию 500.'),
      },
    },
    async (args) => {
      try {
        const dataset = store.require(args.dataset_id);
        const query: SemanticQuery = {
          datasetId: args.dataset_id,
          metrics: args.metrics,
          ...(args.group_by ? { groupBy: args.group_by } : {}),
          ...(args.time_grain ? { timeGrain: args.time_grain } : {}),
          ...(args.filters ? { filters: args.filters } : {}),
          ...(args.order_by ? { orderBy: args.order_by } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        };
        const result = executeQuery(dataset, query);
        return {
          content: [{ type: 'text' as const, text: renderQueryResult(result) }],
          structuredContent: { result },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'ask',
    {
      title: 'Вопрос на естественном языке',
      description:
        'Задать вопрос словами. Языковая модель переводит его в структурированный запрос ' +
        'к семантической модели, а расчёт выполняет детерминированный движок — числа ' +
        'никогда не генерируются моделью. Требует настроенного ANTHROPIC_API_KEY; ' +
        'без него используй query_data напрямую. ' +
        'Если вопрос нельзя выразить через доступные поля, инструмент честно об этом сообщит.',
      inputSchema: {
        dataset_id: z.string().describe('Идентификатор набора.'),
        question: z.string().describe('Вопрос на естественном языке.'),
      },
    },
    async ({ dataset_id, question }) => {
      try {
        const dataset = store.require(dataset_id);
        const llm = createLlmClient();
        if (!llm) {
          return {
            content: [{
              type: 'text' as const,
              text:
                'Инструмент ask требует ANTHROPIC_API_KEY. Без него используй query_data — ' +
                'он принимает те же вопросы в структурированном виде.\n\n' +
                describeModel(dataset.semantic),
            }],
            isError: true,
          };
        }

        const planned = await planQuery(llm, dataset, question);
        if ('error' in planned) {
          return {
            content: [{ type: 'text' as const, text: planned.error }],
            isError: true,
          };
        }

        const result = executeQuery(dataset, planned.query);
        return {
          content: [{
            type: 'text' as const,
            text: `Как понят вопрос: ${planned.reasoning}\n\n${renderQueryResult(result)}`,
          }],
          structuredContent: { query: planned.query, result, reasoning: planned.reasoning },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'delete_dataset',
    {
      title: 'Удалить набор данных',
      description:
        'Удалить набор и все его инсайты без возможности восстановления. ' +
        'Вызывай только по явной просьбе пользователя.',
      inputSchema: {
        dataset_id: z.string().describe('Идентификатор набора.'),
      },
    },
    async ({ dataset_id }) => {
      const existed = store.delete(dataset_id);
      return {
        content: [{
          type: 'text' as const,
          text: existed ? `Набор ${dataset_id} удалён.` : `Набор ${dataset_id} не найден.`,
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  server.registerResource(
    'datasets',
    'agentics://datasets',
    {
      title: 'Загруженные наборы данных',
      description: 'Перечень наборов с идентификаторами и размерами.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(store.list(), null, 2),
      }],
    }),
  );

  return server;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderInsights(insights: Insight[], summary?: RunSummary): string {
  const sections: string[] = [];

  if (summary) {
    sections.push(
      [
        summary.headline,
        '',
        `Проверено гипотез: ${summary.hypothesesTested}. Подтверждено: ${summary.insightsConfirmed}. ` +
          `Отклонено: ${summary.insightsRejected}. Время: ${(summary.durationMs / 1000).toFixed(1)} с.`,
        summary.llmUsed ? 'Формулировка итога подготовлена языковой моделью.' : '',
      ].filter(Boolean).join('\n'),
    );
  }

  if (insights.length === 0) {
    sections.push('Статистически подтверждённых находок нет.');
    return sections.join('\n\n');
  }

  insights.forEach((insight, i) => {
    const lines: string[] = [];
    lines.push(`${'─'.repeat(70)}`);
    lines.push(`[${i + 1}] ${insight.title}`);
    lines.push(
      `тип: ${insight.kind} | уверенность: ${(insight.confidence * 100).toFixed(0)}% | ` +
        `влияние: ${(insight.impact * 100).toFixed(0)}%`,
    );
    lines.push('');
    lines.push(insight.narrative);
    lines.push('');
    lines.push('Доказательства:');
    lines.push(
      `  ${insight.evidence.statisticLabel}: ${insight.evidence.statistic.toFixed(4)}` +
        (insight.evidence.pValue !== undefined ? ` (p = ${insight.evidence.pValue.toExponential(2)})` : ''),
    );
    for (const f of insight.evidence.facts) lines.push(`  ${f.label}: ${f.value}`);

    lines.push('');
    lines.push('Как рассчитано:');
    for (const t of insight.trace) lines.push(`  · ${t}`);

    if (insight.caveats.length > 0) {
      lines.push('');
      lines.push('Оговорки:');
      for (const c of insight.caveats) lines.push(`  ! ${c}`);
    }

    if (insight.nextSteps.length > 0) {
      lines.push('');
      lines.push('Следующие шаги:');
      for (const s of insight.nextSteps) {
        lines.push(`  → [${stepLabel(s.type)}] ${s.action}`);
        lines.push(`     ${s.rationale}`);
      }
    }
    sections.push(lines.join('\n'));
  });

  if (summary && summary.nextSteps.length > 0) {
    const lines = ['ПЛАН ДЕЙСТВИЙ ПО НАБОРУ:'];
    summary.nextSteps.forEach((s, i) => {
      lines.push(`  ${i + 1}. [${stepLabel(s.type)}] ${s.action}`);
      lines.push(`     ${s.rationale}`);
    });
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

function stepLabel(type: string): string {
  switch (type) {
    case 'investigate': return 'разобраться';
    case 'act': return 'действие';
    case 'monitor': return 'наблюдать';
    case 'fix_data': return 'данные';
    default: return type;
  }
}

function renderQueryResult(result: {
  columns: string[];
  rows: Array<Array<string | number | null>>;
  rowCount: number;
  scanned: number;
  explanation: string;
  truncated: boolean;
}): string {
  const lines = [result.explanation, ''];

  if (result.rows.length === 0) {
    lines.push('Результат пуст — ни одна строка не подошла под условия.');
    return lines.join('\n');
  }

  // Fixed-width table: readable in a terminal and in a chat transcript alike.
  const widths = result.columns.map((c, i) =>
    Math.min(
      40,
      Math.max(c.length, ...result.rows.slice(0, 60).map((r) => String(r[i] ?? '—').length)),
    ),
  );
  const pad = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w));

  lines.push(result.columns.map((c, i) => pad(c, widths[i]!)).join('  '));
  lines.push(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of result.rows.slice(0, 60)) {
    lines.push(row.map((v, i) => pad(v === null ? '—' : String(v), widths[i]!)).join('  '));
  }

  if (result.rows.length > 60) lines.push(`… и ещё ${result.rows.length - 60} строк`);
  if (result.truncated) lines.push('(результат усечён лимитом)');
  lines.push('', `Строк в результате: ${result.rowCount}, просканировано: ${result.scanned}.`);

  return lines.join('\n');
}

function errorResult(err: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  let text: string;
  if (err instanceof QueryError) {
    text = [err.message, ...err.suggestions].join('\n');
  } else if (err instanceof Error) {
    text = err.message;
  } else {
    text = String(err);
  }
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function fmt(v: number): string {
  if (!isFinite(v)) return '—';
  if (Math.abs(v) >= 1e6 || (Math.abs(v) < 0.001 && v !== 0)) return v.toExponential(2);
  return String(Math.round(v * 1000) / 1000);
}
