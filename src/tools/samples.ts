/**
 * Sample datasets with known, planted structure.
 *
 * These exist for two reasons. First, a new user needs something to click on
 * before they have data of their own. Second — and more usefully — the planted
 * effects are known in advance, so the test suite can assert that the agent
 * actually finds them. A statistics engine nobody has checked against a known
 * answer is a liability.
 *
 * Generation is seeded, so the same dataset comes out every time.
 */

export interface SampleDataset {
  id: string;
  name: string;
  description: string;
  /** What the agent is expected to find — asserted by the tests. */
  plantedEffects: string[];
  generate: () => string;
}

/**
 * Mulberry32 — a small, fast, seeded PRNG. Reproducibility matters more here
 * than statistical perfection, and this is well past adequate for either.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller: normal deviates from the uniform generator above. */
function normal(rand: () => number, mean = 0, sd = 1): number {
  const u = Math.max(1e-12, rand());
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pick<T>(rand: () => number, items: T[], weights?: number[]): T {
  if (!weights) return items[Math.floor(rand() * items.length)]!;
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function toCsv(header: string[], rows: Array<Array<string | number>>): string {
  const lines = [header.join(',')];
  for (const row of rows) lines.push(row.map((v) => csvEscape(String(v))).join(','));
  return lines.join('\n');
}

function isoDay(base: number, dayOffset: number): string {
  return new Date(base + dayOffset * 86400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// SaaS subscriptions
// ---------------------------------------------------------------------------

/**
 * Planted structure:
 *  - MRR trends upward overall
 *  - the EMEA region collapses partway through (a driver + a changepoint)
 *  - revenue is concentrated in the Enterprise plan
 *  - one week has an anomalous drop
 *  - the "Партнёры" channel has materially worse retention
 *  - ~4% of support_tickets are missing, and there are duplicate rows
 */
function generateSaas(): string {
  const rand = rng(20260726);
  const base = Date.UTC(2025, 0, 6);
  const days = 400;

  const regions = ['Россия', 'EMEA', 'Азия', 'Америка'];
  const regionWeights = [40, 25, 20, 15];
  const plans = ['Enterprise', 'Business', 'Team', 'Starter'];
  const planWeights = [12, 25, 33, 30];
  const planPrice: Record<string, number> = {
    Enterprise: 4200, Business: 1150, Team: 390, Starter: 95,
  };
  const channels = ['Прямые продажи', 'Самообслуживание', 'Партнёры', 'Реселлеры'];
  const channelWeights = [25, 45, 18, 12];

  const rows: Array<Array<string | number>> = [];

  for (let day = 0; day < days; day++) {
    // Volume grows steadily, with a weekly cycle and one anomalous week.
    const weekday = new Date(base + day * 86400_000).getUTCDay();
    const weekendFactor = weekday === 0 || weekday === 6 ? 0.45 : 1;
    const growth = 1 + day * 0.0022;
    const anomalyWeek = day >= 250 && day < 257 ? 0.35 : 1;

    const count = Math.max(1, Math.round(14 * growth * weekendFactor * anomalyWeek * (0.85 + rand() * 0.3)));

    for (let i = 0; i < count; i++) {
      const region = pick(rand, regions, regionWeights);
      const plan = pick(rand, plans, planWeights);
      const channel = pick(rand, channels, channelWeights);

      // EMEA steps down hard at day 210 and never recovers — a level shift,
      // not a gradual trend, and localised to one segment.
      const emeaCollapse = region === 'EMEA' && day > 210 ? 0.42 : 1;
      // Enterprise seat counts grow faster than the rest.
      const planGrowth = plan === 'Enterprise' ? 1 + day * 0.0016 : 1;

      const seats = Math.max(
        1,
        Math.round(
          (plan === 'Enterprise' ? 45 : plan === 'Business' ? 14 : plan === 'Team' ? 5 : 1) *
            planGrowth *
            Math.exp(normal(rand, 0, 0.35)),
        ),
      );

      const mrr = Math.round(planPrice[plan]! * (seats / 10 + 0.6) * emeaCollapse * (0.9 + rand() * 0.2));

      // Partner-sourced accounts churn substantially more often.
      const churnBase = channel === 'Партнёры' ? 0.19 : 0.06;
      const churned = rand() < churnBase * (region === 'EMEA' && day > 210 ? 1.8 : 1) ? 'да' : 'нет';

      const satisfaction = Math.max(
        1,
        Math.min(10, normal(rand, channel === 'Партнёры' ? 6.1 : 8.0, 1.4)),
      );

      // ~4% of ticket counts are missing — the quality gate should flag it.
      const tickets = rand() < 0.04 ? '' : Math.max(0, Math.round(normal(rand, 2.4, 2.2)));

      rows.push([
        `SUB-${String(rows.length + 1).padStart(6, '0')}`,
        isoDay(base, day),
        region,
        plan,
        channel,
        mrr,
        seats,
        churned,
        tickets,
        satisfaction.toFixed(1),
      ]);
    }
  }

  // A handful of exact duplicates, as real exports routinely contain.
  for (let i = 0; i < 18; i++) {
    const source = rows[Math.floor(rand() * rows.length)]!;
    rows.push([...source]);
  }

  return toCsv(
    [
      'subscription_id', 'date', 'region', 'plan', 'channel',
      'mrr', 'seats', 'churned', 'support_tickets', 'satisfaction_score',
    ],
    rows,
  );
}

// ---------------------------------------------------------------------------
// E-commerce orders
// ---------------------------------------------------------------------------

/**
 * Planted structure:
 *  - order revenue concentrated in a few categories
 *  - a strong correlation between item count and order value
 *  - one delivery method with markedly higher return rate
 *  - shipping cost trending up over the period
 *  - a unit-error outlier (one order with an absurd value)
 */
function generateRetail(): string {
  const rand = rng(19042026);
  const base = Date.UTC(2025, 5, 1);
  const days = 300;

  const categories = ['Электроника', 'Одежда', 'Дом и сад', 'Спорт', 'Книги', 'Красота'];
  const categoryWeights = [34, 24, 14, 12, 8, 8];
  const categoryPrice: Record<string, number> = {
    'Электроника': 24000, 'Одежда': 3800, 'Дом и сад': 5200,
    'Спорт': 6100, 'Книги': 850, 'Красота': 2200,
  };
  const delivery = ['Курьер', 'Пункт выдачи', 'Постамат', 'Почта'];
  const deliveryWeights = [35, 38, 17, 10];
  const cities = ['Москва', 'Санкт-Петербург', 'Новосибирск', 'Екатеринбург', 'Казань', 'Другие'];
  const cityWeights = [38, 19, 8, 7, 6, 22];

  const rows: Array<Array<string | number>> = [];

  for (let day = 0; day < days; day++) {
    const weekday = new Date(base + day * 86400_000).getUTCDay();
    const weekendBoost = weekday === 0 || weekday === 6 ? 1.35 : 1;
    const count = Math.max(1, Math.round(22 * weekendBoost * (0.8 + rand() * 0.4)));

    for (let i = 0; i < count; i++) {
      const category = pick(rand, categories, categoryWeights);
      const method = pick(rand, delivery, deliveryWeights);
      const city = pick(rand, cities, cityWeights);

      const items = Math.max(1, Math.round(Math.exp(normal(rand, 0.55, 0.6))));
      // Order value scales with item count — the planted correlation.
      const orderValue = Math.round(
        categoryPrice[category]! * items * Math.exp(normal(rand, 0, 0.4)),
      );

      // Shipping cost drifts upward across the period.
      const shipping = Math.round(
        (method === 'Курьер' ? 490 : method === 'Постамат' ? 190 : method === 'Почта' ? 320 : 0) *
          (1 + day * 0.0016) *
          (0.85 + rand() * 0.3),
      );

      // Post-office deliveries are returned far more often.
      const returnRate = method === 'Почта' ? 0.24 : method === 'Курьер' ? 0.07 : 0.09;
      const returned = rand() < returnRate ? 'да' : 'нет';

      const deliveryDays = Math.max(
        1,
        Math.round(normal(rand, method === 'Курьер' ? 1.8 : method === 'Почта' ? 9.5 : 3.2, 1.6)),
      );

      rows.push([
        `ORD-${String(rows.length + 1).padStart(6, '0')}`,
        isoDay(base, day),
        city,
        category,
        method,
        orderValue,
        items,
        shipping,
        deliveryDays,
        returned,
      ]);
    }
  }

  // A single unit-error row: value entered in kopeks rather than roubles.
  const victim = Math.floor(rand() * rows.length);
  rows[victim]![5] = Number(rows[victim]![5]) * 100;

  return toCsv(
    [
      'order_id', 'order_date', 'city', 'category', 'delivery_method',
      'order_value', 'items_count', 'shipping_cost', 'delivery_days', 'returned',
    ],
    rows,
  );
}

export const SAMPLE_DATASETS: SampleDataset[] = [
  {
    id: 'saas',
    name: 'SaaS-подписки (демо)',
    description:
      'Подписки за 400 дней: MRR, регионы, тарифы, каналы продаж, отток. ' +
      'В данные намеренно заложены тренд, обвал одного региона, концентрация выручки ' +
      'и проблемы с качеством — есть что находить.',
    plantedEffects: [
      'рост MRR во времени',
      'обвал региона EMEA примерно на 210-й день',
      'концентрация выручки в тарифе Enterprise',
      'провал недели около 250-го дня',
      'худшее удержание в канале «Партнёры»',
      'пропуски в support_tickets и дубли строк',
    ],
    generate: generateSaas,
  },
  {
    id: 'retail',
    name: 'Заказы интернет-магазина (демо)',
    description:
      'Заказы за 300 дней: города, категории, способы доставки, возвраты. ' +
      'Заложены концентрация по категориям, связь суммы заказа с числом позиций, ' +
      'повышенный возврат при доставке почтой и одна ошибка в единицах измерения.',
    plantedEffects: [
      'концентрация выручки в категории «Электроника»',
      'корреляция между items_count и order_value',
      'повышенная доля возвратов при доставке «Почта»',
      'рост стоимости доставки во времени',
      'выброс с ошибкой в единицах измерения',
    ],
    generate: generateRetail,
  },
];

export function getSample(id: string): SampleDataset | undefined {
  return SAMPLE_DATASETS.find((s) => s.id === id);
}
