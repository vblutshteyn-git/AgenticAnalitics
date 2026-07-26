/**
 * Tests for the parts that must not be wrong.
 *
 * The statistics are checked against textbook closed-form answers, not against
 * whatever the code happened to return when it was written. The agent is
 * checked against datasets with deliberately planted structure: an analytics
 * engine that has never been shown a known answer is not trustworthy, however
 * confident its output reads.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runAgent, generateHypotheses } from '../agent/orchestrator.js';
import { assessQuality } from '../analysis/quality.js';
import { coerceDate, coerceNumber, detectDayFirst, parseDelimited, parseJsonTable } from '../core/ingest.js';
import { executeQuery, QueryError } from '../core/query.js';
import {
  benjaminiHochberg,
  chiSquarePValue,
  findChangepoint,
  gini,
  herfindahl,
  linearRegression,
  mad,
  median,
  pearson,
  percentile,
  spearman,
  twoSidedTTest,
  welchTTest,
} from '../core/stats.js';
import { DatasetStore } from '../core/store.js';
import type { Insight } from '../core/types.js';
import { SAMPLE_DATASETS } from '../tools/samples.js';

const dataDir = mkdtempSync(join(tmpdir(), 'agentics-test-'));
const store = new DatasetStore(dataDir);

after(() => rmSync(dataDir, { recursive: true, force: true }));

/** Assert two floats agree to `places` decimals. */
function near(actual: number, expected: number, places = 6, message?: string): void {
  assert.ok(
    Math.abs(actual - expected) < Math.pow(10, -places),
    message ?? `ожидалось ${expected}, получено ${actual}`,
  );
}

// ---------------------------------------------------------------------------

describe('статистические примитивы', () => {
  it('percentile интерполирует линейно', () => {
    const xs = [1, 2, 3, 4];
    near(percentile(xs, 0), 1);
    near(percentile(xs, 1), 4);
    near(percentile(xs, 0.5), 2.5);
    // Позиция 0.25*(4-1) = 0.75 → между 1 и 2.
    near(percentile(xs, 0.25), 1.75);
  });

  it('median и mad устойчивы к выбросу', () => {
    const clean = [1, 2, 3, 4, 5];
    const withOutlier = [1, 2, 3, 4, 1000];
    assert.equal(median(clean), 3);
    assert.equal(median(withOutlier), 3, 'медиана не должна двигаться от одного выброса');
    // MAD от [1,2,3,4,5]: отклонения [2,1,0,1,2], медиана 1 → 1.4826.
    near(mad(clean), 1.4826, 4);
    near(mad(withOutlier), 1.4826, 4, 'MAD не должен раздуваться от одного выброса');
  });

  it('линейная регрессия точна на бесшумных данных', () => {
    const x = [0, 1, 2, 3, 4];
    const y = x.map((v) => 3 * v + 7);
    const fit = linearRegression(x, y);
    near(fit.slope, 3);
    near(fit.intercept, 7);
    near(fit.r2, 1);
    assert.ok(fit.pValue < 1e-6, 'идеальная прямая должна быть значимой');
  });

  it('регрессия не находит наклон там, где его нет', () => {
    const x = [0, 1, 2, 3, 4, 5];
    const y = [5, 5, 5, 5, 5, 5];
    const fit = linearRegression(x, y);
    near(fit.slope, 0);
    assert.equal(fit.r2, 0);
  });

  it('корреляция Пирсона: ±1 на прямой, 0 на симметричной параболе', () => {
    const x = [1, 2, 3, 4, 5];
    near(pearson(x, [2, 4, 6, 8, 10]).r, 1);
    near(pearson(x, [10, 8, 6, 4, 2]).r, -1);
    // y = x², центрированный по x: линейной составляющей нет.
    near(pearson([-2, -1, 0, 1, 2], [4, 1, 0, 1, 4]).r, 0);
  });

  it('Спирмен ловит монотонность там, где Пирсон занижает', () => {
    const x = [1, 2, 3, 4, 5, 6];
    const y = [1, 2, 4, 8, 16, 32]; // строго монотонно, но нелинейно
    assert.equal(spearman(x, y).r, 1);
    assert.ok(pearson(x, y).r < 1, 'Пирсон на экспоненте не должен давать ровно 1');
  });

  it('t-распределение согласуется с табличными значениями', () => {
    // Двусторонний p при t = 2.228 и df = 10 равен приблизительно 0.05.
    near(twoSidedTTest(2.228, 10), 0.05, 3);
    // При t = 0 вероятность равна 1 по определению.
    near(twoSidedTTest(0, 10), 1, 9);
  });

  it('тест Уэлча различает раздельные и совпадающие выборки', () => {
    const a = [10, 11, 12, 11, 10, 12, 11];
    const b = [20, 21, 22, 21, 20, 22, 21];
    const separated = welchTTest(a, b);
    assert.ok(separated.pValue < 0.001, 'полностью разделённые выборки должны быть значимы');
    assert.ok(Math.abs(separated.cohensD) > 3, 'размер эффекта должен быть большим');

    const identical = welchTTest(a, [...a]);
    near(identical.tStatistic, 0);
    near(identical.pValue, 1, 9);
  });

  it('chi-square: p убывает с ростом статистики', () => {
    // При chi2 = 3.841 и df = 1 p равно приблизительно 0.05.
    near(chiSquarePValue(3.841, 1), 0.05, 3);
    assert.ok(chiSquarePValue(10, 1) < chiSquarePValue(3.841, 1));
  });

  it('Бенджамини–Хохбер монотонен и не уменьшает p', () => {
    const p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205];
    const q = benjaminiHochberg(p);
    assert.equal(q.length, p.length);
    for (let i = 0; i < p.length; i++) {
      assert.ok(q[i]! >= p[i]! - 1e-12, `q[${i}] не должно быть меньше p[${i}]`);
      assert.ok(q[i]! <= 1);
    }
    // Порядок сохраняется: отсортированные p дают неубывающие q.
    for (let i = 1; i < q.length; i++) assert.ok(q[i]! >= q[i - 1]! - 1e-12);
    // Наименьшее p из восьми: q = 0.001 * 8 / 1 = 0.008.
    near(q[0]!, 0.008, 9);
  });

  it('концентрация: Джини и Херфиндаль на краевых случаях', () => {
    near(gini([5, 5, 5, 5]), 0, 6, 'равномерное распределение → Джини 0');
    assert.ok(gini([0, 0, 0, 100]) > 0.7, 'вырожденное распределение → Джини близок к 1');
    near(herfindahl([1]), 1);
    near(herfindahl([0.25, 0.25, 0.25, 0.25]), 0.25);
  });

  it('точка разладки: находит ступень, игнорирует чистый тренд', () => {
    const step = [...Array(12).fill(10), ...Array(12).fill(30)];
    const found = findChangepoint(step);
    assert.ok(found, 'явная ступень должна быть найдена');
    assert.equal(found.index, 12);
    near(found.meanBefore, 10);
    near(found.meanAfter, 30);

    // Постоянный ряд не содержит ступени.
    assert.equal(findChangepoint(new Array(24).fill(7)), null);
    // Слишком короткий ряд отклоняется, а не угадывается.
    assert.equal(findChangepoint([1, 2, 3]), null);
  });

  it('точка разладки не срабатывает у самого края ряда', () => {
    // Один аномальный хвост из двух точек — это выброс, а не смена режима.
    const series = [...Array(30).fill(10), 40, 41];
    const found = findChangepoint(series);
    if (found) {
      assert.ok(
        found.index >= Math.floor(series.length * 0.15),
        `разладка найдена на позиции ${found.index} — слишком близко к краю`,
      );
    }
  });
});

// ---------------------------------------------------------------------------

describe('разбор данных', () => {
  it('CSV с кавычками, переводами строк и экранированием', () => {
    const csv = 'a,b\n"строка, с запятой","многострочное\nзначение"\n"он сказал ""да""",2';
    const table = parseDelimited(csv);
    assert.deepEqual(table.columns, ['a', 'b']);
    assert.equal(table.rowCount, 2);
    assert.equal(table.rows[0]![0], 'строка, с запятой');
    assert.equal(table.rows[1]![0], 'многострочное\nзначение');
    assert.equal(table.rows[0]![1], 'он сказал "да"');
  });

  it('определение разделителя: точка с запятой и табуляция', () => {
    assert.equal(parseDelimited('a;b;c\n1;2;3').columns.length, 3);
    assert.equal(parseDelimited('a\tb\tc\n1\t2\t3').columns.length, 3);
  });

  it('числа: разделители разрядов, валюта, проценты, скобки', () => {
    assert.equal(coerceNumber('1 234,56'), 1234.56);
    assert.equal(coerceNumber('1,234.56'), 1234.56);
    assert.equal(coerceNumber('1.234,56'), 1234.56);
    assert.equal(coerceNumber('$1,200'), 1200);
    assert.equal(coerceNumber('(500)'), -500);
    assert.equal(coerceNumber('12,5%'), 0.125);
    assert.equal(coerceNumber('не число'), null);
    assert.equal(coerceNumber(''), null);
    // «1,234» — это тысячи, а «1,23» — десятичная запятая.
    assert.equal(coerceNumber('1,234'), 1234);
    assert.equal(coerceNumber('1,23'), 1.23);
  });

  it('даты: ISO, эпоха и разрешение неоднозначности DD/MM', () => {
    assert.equal(coerceDate('2025-03-15'), Date.UTC(2025, 2, 15));
    assert.equal(coerceDate('2025-03-15T10:30:00Z'), Date.UTC(2025, 2, 15, 10, 30));
    assert.equal(coerceDate('не дата'), null);

    // 25 в первой позиции не может быть месяцем — значит формат день-первый.
    assert.equal(detectDayFirst(['25/03/2025', '01/04/2025']), true);
    assert.equal(coerceDate('25/03/2025', true), Date.UTC(2025, 2, 25));
    // Без признаков день-первый предполагается месяц-первый.
    assert.equal(detectDayFirst(['01/03/2025', '02/04/2025']), false);
    assert.equal(coerceDate('01/03/2025', false), Date.UTC(2025, 0, 3));
  });

  it('JSON: массив объектов, вложенность и NDJSON', () => {
    const nested = parseJsonTable('[{"user":{"id":1,"name":"a"},"v":10}]');
    assert.ok(nested.columns.includes('user.id'), 'вложенные поля должны разворачиваться');
    assert.equal(nested.rowCount, 1);

    const ndjson = parseJsonTable('{"a":1}\n{"a":2}\n{"a":3}');
    assert.equal(ndjson.rowCount, 3);

    // Разные ключи в записях дают объединение колонок.
    const ragged = parseJsonTable('[{"a":1},{"b":2}]');
    assert.deepEqual(ragged.columns.sort(), ['a', 'b']);
  });
});

// ---------------------------------------------------------------------------

describe('семантический слой и запросы', () => {
  const csv = [
    'order_id,date,region,revenue,margin_rate',
    'A1,2025-01-01,Север,100,0.2',
    'A2,2025-01-02,Юг,200,0.3',
    'A3,2025-01-03,Север,300,0.25',
    'A4,2025-01-04,Юг,400,0.35',
    'A5,2025-01-05,Север,500,0.15',
  ].join('\n');

  const { dataset } = store.ingest(csv, { name: 'запросы', source: 'upload', formatHint: 'csv' });

  it('колонки классифицируются по назначению', () => {
    const model = dataset.semantic;
    assert.ok(model.identifiers.includes('order_id'), 'order_id — идентификатор, не метрика');
    assert.ok(model.timeDimensions.some((t) => t.name === 'date'));
    assert.ok(model.dimensions.some((d) => d.name === 'region'));
    assert.ok(model.measures.some((m) => m.name === 'revenue'));
    assert.ok(model.measures.some((m) => m.name === 'Количество строк'));
  });

  it('метрика-отношение помечается неаддитивной', () => {
    const rate = dataset.semantic.measures.find((m) => m.name === 'margin_rate');
    assert.ok(rate, 'margin_rate должна быть метрикой');
    assert.equal(rate.additive, false, 'ставка не должна суммироваться');
    assert.equal(rate.defaultAggregation, 'avg');
  });

  it('агрегация и группировка считаются верно', () => {
    const result = executeQuery(dataset, {
      datasetId: dataset.id,
      metrics: [{ measure: 'revenue', aggregation: 'sum' }],
      groupBy: ['region'],
    });
    const rows = new Map(result.rows.map((r) => [String(r[0]), Number(r[1])]));
    assert.equal(rows.get('Север'), 900);
    assert.equal(rows.get('Юг'), 600);
  });

  it('фильтры применяются до агрегации', () => {
    const result = executeQuery(dataset, {
      datasetId: dataset.id,
      metrics: [{ measure: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'revenue', operator: 'gte', value: 300 }],
    });
    assert.equal(Number(result.rows[0]![0]), 1200);
    assert.equal(result.scanned, 3);
  });

  /*
   * Единственный самый важный тест в файле: суммирование отношения — это
   * классический способ получить уверенно неверный ответ, и семантический
   * слой существует именно для того, чтобы этого не допустить.
   */
  it('суммирование неаддитивной метрики подменяется средним', () => {
    const result = executeQuery(dataset, {
      datasetId: dataset.id,
      metrics: [{ measure: 'margin_rate', aggregation: 'sum' }],
    });
    const value = Number(result.rows[0]![0]);
    near(value, 0.25, 6, 'должно вернуться среднее 0.25, а не сумма 1.25');
    assert.match(result.explanation, /неаддитивна/, 'подмена должна быть объяснена в ответе');
  });

  it('несуществующее поле вызывает ошибку с подсказкой', () => {
    assert.throws(
      () => executeQuery(dataset, {
        datasetId: dataset.id,
        metrics: [{ measure: 'выдуманная_метрика' }],
      }),
      (err: unknown) => {
        assert.ok(err instanceof QueryError);
        assert.ok(err.suggestions.length > 0, 'ошибка должна перечислять доступные метрики');
        return true;
      },
      'агент не должен получать ответ по несуществующей колонке',
    );
  });

  it('каждый ответ содержит объяснение и стоимость', () => {
    const result = executeQuery(dataset, {
      datasetId: dataset.id,
      metrics: [{ measure: 'revenue' }],
      groupBy: ['date'],
      timeGrain: 'day',
    });
    assert.ok(result.explanation.length > 0);
    assert.equal(result.scanned, 5, 'число просканированных строк должно быть видно');
  });
});

// ---------------------------------------------------------------------------

describe('контроль качества данных', () => {
  it('находит пропуски, дубли и повтор идентификатора', () => {
    const csv = [
      'id,value,category',
      '1,10,a',
      '2,,a',
      '3,,b',
      '4,,b',
      '4,40,b',
      '4,40,b',
    ].join('\n');
    const { dataset } = store.ingest(csv, { name: 'грязный', source: 'upload', formatHint: 'csv' });
    const report = assessQuality(dataset);

    assert.ok(report.score < 1, 'оценка качества грязных данных не должна быть максимальной');
    assert.ok(report.issues.some((i) => i.kind === 'nulls'), 'пропуски должны быть найдены');
    assert.ok(report.issues.some((i) => i.kind === 'duplicates'), 'дубли строк должны быть найдены');
  });

  it('на чистых данных не выдумывает проблем', () => {
    const rows = ['id,value,category'];
    for (let i = 1; i <= 60; i++) rows.push(`${i},${i * 3},${i % 3 === 0 ? 'a' : 'b'}`);
    const { dataset } = store.ingest(rows.join('\n'), {
      name: 'чистый', source: 'upload', formatHint: 'csv',
    });
    const report = assessQuality(dataset);
    assert.equal(
      report.issues.filter((i) => i.severity === 'high').length, 0,
      'на чистых данных не должно быть критичных замечаний',
    );
    assert.ok(report.score > 0.85, `ожидалась высокая оценка, получено ${report.score}`);
  });
});

// ---------------------------------------------------------------------------

async function analyze(csv: string, name: string): Promise<{ insights: Insight[]; summary: NonNullable<Awaited<ReturnType<typeof collect>>['summary']> }> {
  const collected = await collect(csv, name);
  assert.ok(collected.summary, 'прогон должен завершиться итогом');
  return { insights: collected.insights, summary: collected.summary };
}

async function collect(csv: string, name: string) {
  const { dataset } = store.ingest(csv, { name, source: 'sample', formatHint: 'csv' });
  const insights: Insight[] = [];
  let summary;
  for await (const event of runAgent(dataset, { llm: null })) {
    if (event.insight) insights.push(event.insight);
    if (event.summary) summary = event.summary;
    assert.notEqual(event.phase, 'error', `агент упал: ${event.message}`);
  }
  return { insights: Array.from(new Map(insights.map((i) => [i.id, i])).values()), summary };
}

const titlesOf = (insights: Insight[]) => insights.map((i) => i.title).join(' | ');

describe('агент на данных с заложенной структурой', () => {
  it('находит рост, обвал сегмента и худший канал в SaaS-наборе', async () => {
    const sample = SAMPLE_DATASETS.find((s) => s.id === 'saas')!;
    const { insights, summary } = await analyze(sample.generate(), 'saas-тест');
    const titles = titlesOf(insights);

    assert.ok(summary.hypothesesTested > 50, 'должно проверяться достаточно гипотез');
    assert.ok(insights.length >= 5, `ожидалось не менее 5 находок, получено ${insights.length}`);

    // Заложено: MRR растёт во времени.
    assert.ok(
      insights.some((i) => i.kind === 'trend' && /mrr|seats|Количество строк/i.test(i.title)),
      `тренд не найден. Находки: ${titles}`,
    );
    // Заложено: EMEA обваливается — должен всплыть как драйвер изменения.
    assert.ok(/EMEA/.test(titles), `обвал EMEA не найден. Находки: ${titles}`);
    // Заложено: канал «Партнёры» удерживает хуже остальных.
    assert.ok(/Партнёры/.test(titles), `отличие канала «Партнёры» не найдено. Находки: ${titles}`);
    // Заложено: пропуски и дубли — качество должно быть отмечено.
    assert.ok(insights.some((i) => i.kind === 'quality'), 'проблемы качества не отмечены');
  });

  it('находит концентрацию, связь и возвраты в наборе заказов', async () => {
    const sample = SAMPLE_DATASETS.find((s) => s.id === 'retail')!;
    const { insights } = await analyze(sample.generate(), 'retail-тест');
    const titles = titlesOf(insights);

    // Заложено: выручка сосредоточена в «Электронике».
    assert.ok(
      insights.some((i) => i.kind === 'concentration') || /Электроника/.test(titles),
      `концентрация по категориям не найдена. Находки: ${titles}`,
    );
    // Заложено: order_value растёт с числом позиций.
    assert.ok(
      insights.some((i) => i.kind === 'correlation'),
      `связь между метриками не найдена. Находки: ${titles}`,
    );
    // Заложено: доставка «Почта» — больше возвратов и дольше срок.
    assert.ok(/Почта/.test(titles), `отличие доставки «Почта» не найдено. Находки: ${titles}`);
  });

  /*
   * Проверка на честность. На случайном шуме статистика при α = 0.05 и двух
   * сотнях гипотез выдала бы примерно десяток «находок»; поправка на
   * множественность должна их подавить. Продукт, который что-то «находит» в
   * шуме, бесполезен, потому что нельзя отличить его правду от его выдумки.
   */
  it('на чистом шуме не выдумывает закономерностей', async () => {
    // Набор намеренно широкий: смысл теста в том, что при большом числе
    // одновременных проверок наивная статистика при α = 0.05 обязана выдать
    // горсть «находок» на пустом месте. Узкая таблица порождает мало гипотез
    // и проверяла бы поправку на множественность вхолостую.
    const rows = ['date,segment,region,tier,value_a,value_b,value_c,value_d'];
    // Детерминированный псевдослучайный шум без какой-либо структуры.
    // Mulberry32 на 32-битной арифметике: наивный LCG на числах с плавающей
    // точкой переполняет мантиссу и вырождается в константу, из-за чего
    // «шумовой» набор перестаёт быть шумом.
    let seed = 12345 >>> 0;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const segments = ['x', 'y', 'z', 'w'];
    const regions = ['n', 'e', 's', 'w', 'c', 'nw', 'se'];
    const tiers = ['t1', 't2', 't3', 't4', 't5'];
    for (let day = 0; day < 400; day++) {
      for (let i = 0; i < 3; i++) {
        const date = new Date(Date.UTC(2025, 0, 1) + day * 86400_000).toISOString().slice(0, 10);
        rows.push([
          date,
          segments[Math.floor(rand() * segments.length)],
          regions[Math.floor(rand() * regions.length)],
          tiers[Math.floor(rand() * tiers.length)],
          (rand() * 100).toFixed(2),
          (rand() * 100).toFixed(2),
          (rand() * 100).toFixed(2),
          (rand() * 100).toFixed(2),
        ].join(','));
      }
    }

    const { insights, summary } = await analyze(rows.join('\n'), 'шум');
    const substantive = insights.filter((i) => i.kind !== 'quality');

    assert.ok(
      summary.hypothesesTested > 60,
      `тест бессмыслен без большого числа проверок, а их было ${summary.hypothesesTested}`,
    );
    assert.ok(
      substantive.length <= 2,
      `на шуме найдено ${substantive.length} «закономерностей»: ${titlesOf(substantive)}`,
    );
    for (const insight of substantive) {
      assert.ok(
        insight.confidence < 0.75,
        `находка на шуме заявлена с уверенностью ${insight.confidence}: ${insight.title}`,
      );
    }
  });

  it('каждая находка приходит с доказательствами, трассировкой и шагами', async () => {
    const sample = SAMPLE_DATASETS.find((s) => s.id === 'saas')!;
    const { insights } = await analyze(sample.generate(), 'структура-тест');

    for (const insight of insights) {
      assert.ok(insight.title.length > 0, 'у находки должен быть заголовок');
      assert.ok(insight.narrative.length > 40, `слишком короткое описание: ${insight.title}`);
      assert.ok(insight.trace.length > 0, `нет трассировки расчёта: ${insight.title}`);
      assert.ok(insight.evidence.facts.length > 0, `нет доказательств: ${insight.title}`);
      assert.ok(insight.nextSteps.length > 0, `нет следующих шагов: ${insight.title}`);
      assert.ok(
        insight.confidence >= 0 && insight.confidence <= 1,
        `уверенность вне диапазона: ${insight.confidence}`,
      );
      assert.ok(insight.impact >= 0 && insight.impact <= 1);
      // Корреляция обязана нести оговорку о причинности.
      if (insight.kind === 'correlation') {
        assert.ok(
          insight.caveats.some((c) => /причин/i.test(c)),
          'находка о связи обязана оговаривать отсутствие причинности',
        );
      }
    }
  });

  it('на наборе без времени и измерений завершается без ошибок', async () => {
    const { insights, summary } = await analyze('value\n1\n2\n3\n4\n5', 'вырожденный');
    assert.ok(summary.headline.length > 0, 'итог должен быть сформулирован даже без находок');
    assert.equal(
      insights.filter((i) => i.kind !== 'quality').length, 0,
      'на пяти числах без разрезов находок быть не должно',
    );
  });

  it('фокус смещает приоритет гипотез, не отбрасывая остальные', () => {
    const sample = SAMPLE_DATASETS.find((s) => s.id === 'saas')!;
    const { dataset } = store.ingest(sample.generate(), {
      name: 'фокус-тест', source: 'sample', formatHint: 'csv',
    });

    const plain = generateHypotheses(dataset);
    const focused = generateHypotheses(dataset, 'отток по каналам');

    assert.equal(plain.length, focused.length, 'фокус не должен удалять гипотезы');
    const topFocused = focused.slice(0, 12).map((h) => JSON.stringify(h.params)).join(' ');
    assert.ok(
      /churn|channel/i.test(topFocused),
      `фокус не поднял релевантные гипотезы наверх: ${topFocused.slice(0, 200)}`,
    );
  });
});
