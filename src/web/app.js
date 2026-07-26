/**
 * Agentics Analytics — фронтенд.
 *
 * Без сборки и без зависимостей: браузер получает ровно те файлы, что лежат в
 * репозитории. Графики рисуются вручную в SVG — на четырёх формах это меньше
 * кода, чем интеграция библиотеки, и полностью управляемо по цвету и доступности.
 *
 * Числа приходят с сервера уже рассчитанными; здесь они только отображаются.
 */

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

const state = {
  datasets: [],
  current: null,      // полный объект набора
  insights: [],
  summary: null,
  llmAvailable: false,
  samples: [],
  running: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

/** Экранирование текста, приходящего из данных пользователя. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const nfCompact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });

function fmtNum(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (typeof v !== 'number') return String(v);
  return Math.abs(v) >= 100000 ? nfCompact.format(v) : nf.format(v);
}

/**
 * Форматирование с учётом единицы измерения метрики.
 *
 * Без этого доля 0,0144 печатается как «0,01», а разница между 1,4% и 0,4%
 * на графике исчезает совсем. Малые величины получают столько знаков, сколько
 * нужно, чтобы соседние значения различались.
 */
function fmtValue(v, unit) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (typeof v !== 'number') return String(v);

  if (unit === '%') {
    // Доли приходят в 0..1; уже посчитанные проценты — как есть.
    const asPercent = Math.abs(v) <= 1 ? v * 100 : v;
    const digits = Math.abs(asPercent) < 1 ? 2 : Math.abs(asPercent) < 10 ? 1 : 0;
    return `${asPercent.toFixed(digits).replace('.', ',')}%`;
  }

  const abs = Math.abs(v);
  if (abs !== 0 && abs < 1) {
    return v.toPrecision(2).replace('.', ',');
  }
  const text = abs >= 100000 ? nfCompact.format(v) : nf.format(v);
  return unit ? `${text} ${unit}` : text;
}

function pct(v, digits = 0) {
  return `${(v * 100).toFixed(digits)}%`;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind ? `is-${kind}` : ''}`;
  el.textContent = message;
  $('#toast-stack').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Некорректный ответ сервера (${res.status}).`);
  }
  if (!res.ok) {
    const detail = [body.error, ...(body.suggestions ?? [])].filter(Boolean).join(' ');
    throw new Error(detail || `Ошибка ${res.status}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Графики
// ---------------------------------------------------------------------------

const CHART_PAD = { top: 12, right: 14, bottom: 26, left: 52 };

/**
 * Выбрать «круглый» шаг сетки, чтобы подписи оси были читаемыми числами,
 * а не результатом деления диапазона на константу.
 */
function niceStep(range, targetTicks) {
  if (range <= 0) return 1;
  const raw = range / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function axisTicks(min, max, target = 5) {
  const step = niceStep(max - min, target);
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(v);
  return ticks.length >= 2 ? ticks : [min, max];
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Доступное имя графика для программ чтения с экрана. */
function svgTitle(svg, text) {
  const title = svgEl('title');
  title.textContent = text;
  svg.append(title);
}

/**
 * Подпись графика. Формулировка зависит от формы: у горизонтальных столбцов
 * по оси X отложена величина, а по оси Y — разрез, поэтому шаблон «Y по X»
 * читался бы задом наперёд и с вложенными кавычками.
 */
function chartCaption(spec) {
  switch (spec.type) {
    case 'hbar':
    case 'bar':
      return `${spec.xLabel} · разрез: ${spec.yLabel}`;
    case 'scatter':
      return `${spec.yLabel} и ${spec.xLabel}`;
    default:
      return `${spec.yLabel} по «${spec.xLabel}»`;
  }
}

/** Обёртка с заголовком, легендой и слоем подсказок. */
function chartFrame(spec, svg, legend) {
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';

  const title = document.createElement('div');
  title.className = 'chart-title';
  title.textContent = chartCaption(spec);
  wrap.append(title, svg);

  if (legend && legend.length > 0) {
    const box = document.createElement('div');
    box.className = 'chart-legend';
    for (const item of legend) {
      const el = document.createElement('span');
      el.className = 'legend-item';
      el.innerHTML =
        `<span class="legend-swatch ${item.line ? 'is-line' : ''}" ` +
        `style="background:${item.color}"></span>${esc(item.label)}`;
      box.append(el);
    }
    wrap.append(box);
  }

  const tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  wrap.append(tip);
  return { wrap, tip };
}

function showTip(tip, wrap, x, y, html) {
  tip.innerHTML = html;
  tip.style.left = `${x}px`;
  tip.style.top = `${y - 8}px`;
  tip.classList.add('is-visible');
}

function hideTip(tip) {
  tip.classList.remove('is-visible');
}

/** Линейный график: один ряд плюс необязательная опорная линия. */
function renderLine(spec) {
  const W = 720, H = 240;
  const points = spec.series[0]?.points ?? [];
  if (points.length === 0) return document.createElement('div');

  const values = points.map((p) => p.y);
  const refValues = spec.reference?.points.map((p) => p.y) ?? [];
  const all = [...values, ...refValues];
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) { min -= 1; max += 1; }
  // Небольшой запас сверху и снизу, чтобы линия не липла к рамке.
  const pad = (max - min) * 0.08;
  min -= pad; max += pad;

  const plotW = W - CHART_PAD.left - CHART_PAD.right;
  const plotH = H - CHART_PAD.top - CHART_PAD.bottom;
  const xAt = (i) => CHART_PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yAt = (v) => CHART_PAD.top + plotH - ((v - min) / (max - min)) * plotH;

  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img' });
  svgTitle(svg, chartCaption(spec));

  // Сетка и подписи оси Y — приглушённые, чтобы не спорить с данными.
  for (const tick of axisTicks(min, max)) {
    const y = yAt(tick);
    svg.append(svgEl('line', {
      x1: CHART_PAD.left, x2: W - CHART_PAD.right, y1: y, y2: y,
      stroke: 'var(--gridline)', 'stroke-width': 1,
    }));
    const label = svgEl('text', {
      x: CHART_PAD.left - 8, y: y + 3.5, 'text-anchor': 'end',
      'font-size': 10.5, fill: 'var(--text-muted)',
    });
    label.textContent = fmtValue(tick, spec.unit);
    svg.append(label);
  }

  // Опорная линия (тренд или ожидаемый уровень) — пунктир, вторичный цвет.
  if (spec.reference && spec.reference.points.length > 1) {
    svg.append(svgEl('path', {
      d: spec.reference.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(p.y)}`).join(' '),
      fill: 'none', stroke: 'var(--series-2)', 'stroke-width': 2,
      'stroke-dasharray': '5 4', opacity: 0.9,
    }));
  }

  svg.append(svgEl('path', {
    d: points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(p.y)}`).join(' '),
    fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));

  // Отмеченные точки (аномалии, разладка) — с кольцом фона, чтобы читались
  // поверх линии.
  points.forEach((p, i) => {
    if (!p.annotation) return;
    svg.append(svgEl('circle', {
      cx: xAt(i), cy: yAt(p.y), r: 4.5,
      fill: 'var(--series-2)', stroke: 'var(--surface-1)', 'stroke-width': 2,
    }));
  });

  // Подписи оси X: показываем столько, сколько влезает без наложения.
  const maxLabels = Math.min(points.length, Math.floor(plotW / 72));
  const stride = Math.max(1, Math.ceil(points.length / Math.max(1, maxLabels)));
  points.forEach((p, i) => {
    if (i % stride !== 0 && i !== points.length - 1) return;
    const label = svgEl('text', {
      x: xAt(i), y: H - 8, 'text-anchor': 'middle',
      'font-size': 10.5, fill: 'var(--text-muted)',
    });
    label.textContent = String(p.x);
    svg.append(label);
  });

  const { wrap, tip } = chartFrame(spec, svg, [
    { label: spec.series[0].name, color: 'var(--series-1)', line: true },
    ...(spec.reference ? [{ label: spec.reference.label, color: 'var(--series-2)', line: true }] : []),
  ]);

  // Перекрестье: одна общая зона наведения, ближайшая точка по X.
  const crosshair = svgEl('line', {
    y1: CHART_PAD.top, y2: CHART_PAD.top + plotH,
    stroke: 'var(--axis)', 'stroke-width': 1, opacity: 0,
  });
  const marker = svgEl('circle', {
    r: 5, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2, opacity: 0,
  });
  svg.append(crosshair, marker);

  const overlay = svgEl('rect', {
    x: CHART_PAD.left, y: CHART_PAD.top, width: plotW, height: plotH,
    fill: 'transparent', style: 'cursor:crosshair',
  });
  svg.append(overlay);

  overlay.addEventListener('mousemove', (event) => {
    const box = svg.getBoundingClientRect();
    const scale = W / box.width;
    const svgX = (event.clientX - box.left) * scale;
    const ratio = (svgX - CHART_PAD.left) / plotW;
    const index = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
    const p = points[index];

    crosshair.setAttribute('x1', xAt(index));
    crosshair.setAttribute('x2', xAt(index));
    crosshair.setAttribute('opacity', 0.6);
    marker.setAttribute('cx', xAt(index));
    marker.setAttribute('cy', yAt(p.y));
    marker.setAttribute('opacity', 1);

    showTip(
      tip, wrap,
      (xAt(index) / scale),
      (yAt(p.y) / scale) + svg.offsetTop,
      `${esc(p.x)}<br><b>${esc(fmtValue(p.y, spec.unit))}</b>` +
        (p.annotation ? `<br><span style="color:var(--series-2)">${esc(p.annotation)}</span>` : ''),
    );
  });
  overlay.addEventListener('mouseleave', () => {
    crosshair.setAttribute('opacity', 0);
    marker.setAttribute('opacity', 0);
    hideTip(tip);
  });

  return wrap;
}

/**
 * Горизонтальные столбцы. Если значения меняют знак — это расходящаяся шкала
 * (вклад «плюс/минус»), и полюса красятся синим и красным вокруг нуля.
 */
function renderHbar(spec) {
  const points = spec.series[0]?.points ?? [];
  if (points.length === 0) return document.createElement('div');

  const rowH = 26, gap = 2;
  const labelW = 168;
  const W = 720;
  const H = points.length * rowH + 26;
  const plotL = labelW + 8;

  const values = points.map((p) => p.y);
  // Reserve room on the right for the direct value label, sized to the longest
  // one actually being drawn — otherwise the bar at full scale pushes its own
  // label off the edge of the viewBox.
  const longestLabel = Math.max(
    ...points.map((p) => `${fmtValue(p.y, spec.unit)}${p.annotation ? ` · ${p.annotation}` : ''}`.length),
  );
  const plotW = W - plotL - Math.max(52, longestLabel * 6.6 + 12);
  const hasNegative = values.some((v) => v < 0);
  const maxAbs = Math.max(...values.map(Math.abs), 1e-9);
  // Нулевая линия в середине только когда есть отрицательные значения.
  const zeroX = hasNegative ? plotL + plotW / 2 : plotL;
  const scale = hasNegative ? (plotW / 2) / maxAbs : plotW / maxAbs;

  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img' });
  svgTitle(svg, chartCaption(spec));

  const { wrap, tip } = chartFrame(
    spec, svg,
    hasNegative
      ? [
          { label: 'вклад в рост', color: 'var(--diverge-pos)' },
          { label: 'вклад в снижение', color: 'var(--diverge-neg)' },
        ]
      : [],
  );

  points.forEach((p, i) => {
    const y = i * rowH + 4;
    const barH = rowH - gap * 2;
    const width = Math.max(2, Math.abs(p.y) * scale);
    const x = p.y < 0 ? zeroX - width : zeroX;
    const color = !hasNegative
      ? 'var(--series-1)'
      : p.y >= 0 ? 'var(--diverge-pos)' : 'var(--diverge-neg)';

    const label = svgEl('text', {
      x: labelW, y: y + barH / 2 + 4, 'text-anchor': 'end',
      'font-size': 11.5, fill: 'var(--text-secondary)',
    });
    // Длинные значения измерений усекаются, полное имя — в подсказке.
    const text = String(p.x);
    label.textContent = text.length > 26 ? `${text.slice(0, 25)}…` : text;
    svg.append(label);

    const bar = svgEl('rect', {
      x, y, width, height: barH, rx: 4, fill: color,
      style: 'cursor:default',
    });
    svg.append(bar);

    // Прямая подпись значения — идентичность не держится на одном цвете.
    const valueLabel = svgEl('text', {
      x: p.y < 0 ? x - 6 : x + width + 6,
      y: y + barH / 2 + 4,
      'text-anchor': p.y < 0 ? 'end' : 'start',
      'font-size': 11, fill: 'var(--text-muted)',
    });
    valueLabel.textContent = p.annotation
      ? `${fmtValue(p.y, spec.unit)} · ${p.annotation}`
      : fmtValue(p.y, spec.unit);
    svg.append(valueLabel);

    bar.addEventListener('mouseenter', () => {
      bar.setAttribute('opacity', 0.82);
      const box = svg.getBoundingClientRect();
      const s = box.width / W;
      showTip(
        tip, wrap,
        (x + width / 2) * s,
        (y + barH / 2) * s,
        `${esc(p.x)}<br><b>${esc(fmtValue(p.y, spec.unit))}</b>` +
          (p.annotation ? ` · ${esc(p.annotation)}` : ''),
      );
    });
    bar.addEventListener('mouseleave', () => {
      bar.removeAttribute('opacity');
      hideTip(tip);
    });
  });

  if (hasNegative) {
    svg.append(svgEl('line', {
      x1: zeroX, x2: zeroX, y1: 0, y2: points.length * rowH,
      stroke: 'var(--axis)', 'stroke-width': 1,
    }));
  }

  return wrap;
}

/** Диаграмма рассеяния: один ряд, точки с кольцом фона против слипания. */
function renderScatter(spec) {
  const W = 720, H = 300;
  const points = spec.series[0]?.points ?? [];
  if (points.length === 0) return document.createElement('div');

  const xs = points.map((p) => Number(p.x));
  const ys = points.map((p) => p.y);
  let xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (xMin === xMax) { xMin -= 1; xMax += 1; }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const xPad = (xMax - xMin) * 0.05, yPad = (yMax - yMin) * 0.05;
  xMin -= xPad; xMax += xPad; yMin -= yPad; yMax += yPad;

  const plotW = W - CHART_PAD.left - CHART_PAD.right;
  const plotH = H - CHART_PAD.top - CHART_PAD.bottom;
  const xAt = (v) => CHART_PAD.left + ((v - xMin) / (xMax - xMin)) * plotW;
  const yAt = (v) => CHART_PAD.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img' });
  svgTitle(svg, chartCaption(spec));

  for (const tick of axisTicks(yMin, yMax, 4)) {
    const y = yAt(tick);
    svg.append(svgEl('line', {
      x1: CHART_PAD.left, x2: W - CHART_PAD.right, y1: y, y2: y,
      stroke: 'var(--gridline)', 'stroke-width': 1,
    }));
    const label = svgEl('text', {
      x: CHART_PAD.left - 8, y: y + 3.5, 'text-anchor': 'end',
      'font-size': 10.5, fill: 'var(--text-muted)',
    });
    label.textContent = fmtValue(tick, spec.unit);
    svg.append(label);
  }
  for (const tick of axisTicks(xMin, xMax, 5)) {
    const label = svgEl('text', {
      x: xAt(tick), y: H - 8, 'text-anchor': 'middle',
      'font-size': 10.5, fill: 'var(--text-muted)',
    });
    label.textContent = fmtNum(tick);
    svg.append(label);
  }

  const { wrap, tip } = chartFrame(spec, svg, []);

  for (const p of points) {
    const dot = svgEl('circle', {
      cx: xAt(Number(p.x)), cy: yAt(p.y), r: 3.2,
      fill: 'var(--series-1)', 'fill-opacity': 0.55,
      stroke: 'var(--surface-1)', 'stroke-width': 0.6,
    });
    svg.append(dot);
    dot.addEventListener('mouseenter', () => {
      dot.setAttribute('r', 5.5);
      dot.setAttribute('fill-opacity', 1);
      const box = svg.getBoundingClientRect();
      const s = box.width / W;
      showTip(
        tip, wrap, xAt(Number(p.x)) * s, yAt(p.y) * s,
        `${esc(spec.xLabel)}: <b>${esc(fmtNum(Number(p.x)))}</b><br>` +
        `${esc(spec.yLabel)}: <b>${esc(fmtValue(p.y, spec.unit))}</b>`,
      );
    });
    dot.addEventListener('mouseleave', () => {
      dot.setAttribute('r', 3.2);
      dot.setAttribute('fill-opacity', 0.55);
      hideTip(tip);
    });
  }

  // Ось X подписана снизу, ось Y — в заголовке кадра; вторая метка оси X
  // ставится текстом, чтобы читатель не искал, что отложено по горизонтали.
  const axisLabel = svgEl('text', {
    x: W - CHART_PAD.right, y: CHART_PAD.top - 2, 'text-anchor': 'end',
    'font-size': 10.5, fill: 'var(--text-muted)',
  });
  axisLabel.textContent = `по горизонтали — ${spec.xLabel}`;
  svg.append(axisLabel);

  return wrap;
}

function renderChart(spec) {
  if (!spec) return null;
  switch (spec.type) {
    case 'line': return renderLine(spec);
    case 'hbar':
    case 'bar': return renderHbar(spec);
    case 'scatter': return renderScatter(spec);
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Отрисовка боковой панели
// ---------------------------------------------------------------------------

function renderDatasetList() {
  const list = $('#dataset-list');
  $('#dataset-count').textContent = state.datasets.length ? `(${state.datasets.length})` : '';
  list.replaceChildren();

  if (state.datasets.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = 'Пока пусто.';
    list.append(li);
    return;
  }

  for (const ds of state.datasets) {
    const li = document.createElement('li');
    li.className = `dataset-item ${state.current?.id === ds.id ? 'is-active' : ''}`;
    li.innerHTML =
      `<strong>${esc(ds.name)}</strong>` +
      `<span>${ds.rowCount} строк · ${ds.columnCount} колонок` +
      `${ds.insightCount ? ` · ${ds.insightCount} инсайтов` : ''}</span>`;
    li.addEventListener('click', () => selectDataset(ds.id));
    list.append(li);
  }
}

// ---------------------------------------------------------------------------
// Загрузка данных
// ---------------------------------------------------------------------------

async function refreshDatasets() {
  const { datasets } = await api('/api/datasets');
  state.datasets = datasets;
  renderDatasetList();
}

async function uploadFile(file) {
  if (!file) return;
  toast(`Читаю «${file.name}»…`);
  const content = await file.text();
  try {
    const { dataset, warnings } = await api('/api/datasets', {
      method: 'POST',
      body: JSON.stringify({ name: file.name, content, format: 'auto' }),
    });
    for (const warning of warnings) toast(warning);
    await refreshDatasets();
    await selectDataset(dataset.id);
    toast(`Загружено: ${dataset.rowCount} строк.`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadSample(id) {
  try {
    const { dataset } = await api('/api/samples', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    await refreshDatasets();
    await selectDataset(dataset.id);
    toast(`Демо-набор загружен: ${dataset.rowCount} строк.`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function selectDataset(id) {
  try {
    const { dataset } = await api(`/api/datasets/${encodeURIComponent(id)}`);
    state.current = dataset;
    const { insights } = await api(`/api/datasets/${encodeURIComponent(id)}/insights`);
    state.insights = insights;
    state.summary = null;

    $('#empty-state').hidden = true;
    $('#workspace').hidden = false;
    $('#ds-name').textContent = dataset.name;
    $('#ds-meta').textContent =
      `${dataset.rowCount} строк · ${dataset.columns.length} колонок · ` +
      `${dataset.semantic.grainDescription}`;

    renderDatasetList();
    renderSemantic();
    renderProfile();
    renderBuilder();
    renderInsights();
    $('#run-progress').hidden = true;
    $('#query-result').replaceChildren();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Семантическая модель
// ---------------------------------------------------------------------------

function renderSemantic() {
  const model = state.current.semantic;
  const notice = $('#semantic-notice');

  notice.className = `notice ${model.reviewed ? 'is-ok' : 'is-warn'}`;
  notice.replaceChildren();
  const text = document.createElement('span');
  text.innerHTML = model.reviewed
    ? '<strong>Модель подтверждена.</strong> Выводы строятся без ограничения уверенности сверху.'
    : '<strong>Модель сгенерирована автоматически.</strong> Пока она не подтверждена, ' +
      'уверенность всех находок снижена: агент мог неверно понять смысл колонок.';
  notice.append(text);

  if (!model.reviewed) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = 'Подтвердить модель';
    btn.addEventListener('click', () => patchSemantic({ reviewed: true }));
    notice.append(btn);
  }

  const grid = $('#semantic-grid');
  grid.replaceChildren();

  // --- метрики -------------------------------------------------------------
  const measures = document.createElement('div');
  measures.className = 'sem-card';
  measures.innerHTML = `<h3>Метрики <span class="count">${model.measures.length}</span></h3>`;
  for (const m of model.measures) {
    const row = document.createElement('div');
    row.className = 'sem-row';
    row.innerHTML =
      `<span class="sem-name">${esc(m.name)}</span>` +
      `<span class="tag ${m.additive ? 'tag-add' : ''}">${m.additive ? 'аддитивная' : 'не суммируется'}</span>` +
      (m.polarity !== 'neutral'
        ? `<span class="tag ${m.polarity === 'higher_is_better' ? 'tag-good' : 'tag-bad'}">` +
          `${m.polarity === 'higher_is_better' ? 'рост = хорошо' : 'рост = плохо'}</span>`
        : '') +
      `<span class="sem-note">${esc(m.description)}</span>`;

    if (m.column !== '*') {
      const select = document.createElement('select');
      select.className = 'input';
      for (const agg of ['sum', 'avg', 'median', 'min', 'max', 'count', 'count_distinct']) {
        const opt = document.createElement('option');
        opt.value = agg;
        opt.textContent = agg;
        opt.selected = agg === m.defaultAggregation;
        select.append(opt);
      }
      select.addEventListener('change', () => {
        const patched = model.measures.map((x) =>
          x.name === m.name
            ? { ...x, defaultAggregation: select.value, additive: select.value === 'sum' ? true : x.additive }
            : x,
        );
        patchSemantic({ measures: patched });
      });
      row.insertBefore(select, row.querySelector('.sem-note'));
    }
    measures.append(row);
  }
  grid.append(measures);

  // --- измерения -----------------------------------------------------------
  const dims = document.createElement('div');
  dims.className = 'sem-card';
  dims.innerHTML = `<h3>Измерения <span class="count">${model.dimensions.length}</span></h3>`;
  for (const d of model.dimensions) {
    const row = document.createElement('div');
    row.className = 'sem-row';
    row.innerHTML =
      `<span class="sem-name">${esc(d.name)}</span>` +
      `<span class="tag">${d.cardinality} значений</span>` +
      (d.groupable ? '' : '<span class="tag tag-bad">только топ-N</span>') +
      `<span class="sem-note">${esc(d.description)}</span>`;
    dims.append(row);
  }
  if (model.dimensions.length === 0) {
    dims.insertAdjacentHTML('beforeend', '<p class="muted small">Измерений не найдено — сегментировать данные не по чему.</p>');
  }
  grid.append(dims);

  // --- время и исключённое --------------------------------------------------
  const other = document.createElement('div');
  other.className = 'sem-card';
  other.innerHTML = `<h3>Время и служебное</h3>`;
  if (model.timeDimensions.length > 0) {
    for (const t of model.timeDimensions) {
      other.insertAdjacentHTML('beforeend',
        `<div class="sem-row"><span class="sem-name">${esc(t.name)}</span>` +
        `<span class="tag tag-add">${esc(t.grain)}</span>` +
        `<span class="sem-note">${esc(t.description)}</span></div>`);
    }
  } else {
    other.insertAdjacentHTML('beforeend',
      '<p class="muted small">Временной оси нет — тренды, аномалии и разложение изменений недоступны.</p>');
  }
  if (model.identifiers.length > 0) {
    other.insertAdjacentHTML('beforeend',
      `<div class="sem-row"><span class="sem-name">Идентификаторы</span>` +
      `<span class="sem-note">${esc(model.identifiers.join(', '))}</span></div>`);
  }
  for (const ign of model.ignored) {
    other.insertAdjacentHTML('beforeend',
      `<div class="sem-row"><span class="sem-name">${esc(ign.column)}</span>` +
      `<span class="tag tag-bad">исключена</span>` +
      `<span class="sem-note">${esc(ign.reason)}</span></div>`);
  }
  grid.append(other);
}

async function patchSemantic(patch) {
  try {
    const { semantic } = await api(`/api/datasets/${encodeURIComponent(state.current.id)}/semantic`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    state.current.semantic = semantic;
    renderSemantic();
    renderBuilder();
    toast('Семантическая модель обновлена.', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Профиль колонок
// ---------------------------------------------------------------------------

function renderProfile() {
  const table = $('#profile-table');
  const head =
    '<thead><tr><th>Колонка</th><th>Тип</th><th>Пропуски</th><th>Уникальных</th>' +
    '<th>Мин</th><th>Медиана</th><th>Макс</th><th>Примеры</th></tr></thead>';
  const rows = state.current.profiles.map((p) => {
    const n = p.numeric;
    return (
      '<tr>' +
      `<td><strong>${esc(p.name)}</strong></td>` +
      `<td>${esc(p.logicalType)}</td>` +
      `<td class="num">${pct(p.nullRate, 1)}</td>` +
      `<td class="num">${p.distinctCount}</td>` +
      `<td class="num">${n ? esc(fmtNum(n.min)) : '—'}</td>` +
      `<td class="num">${n ? esc(fmtNum(n.median)) : '—'}</td>` +
      `<td class="num">${n ? esc(fmtNum(n.max)) : '—'}</td>` +
      `<td>${esc((p.topValues ?? []).slice(0, 3).map((v) => v.value).join(', ') || p.sample.slice(0, 3).join(', '))}</td>` +
      '</tr>'
    );
  }).join('');
  table.innerHTML = `${head}<tbody>${rows}</tbody>`;
}

// ---------------------------------------------------------------------------
// Запуск анализа (SSE)
// ---------------------------------------------------------------------------

function runAnalysis() {
  if (state.running) return;
  state.running = true;

  const button = $('#run-analysis');
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Идёт анализ…';

  const log = $('#trace-log');
  log.replaceChildren();
  $('#run-progress').hidden = false;
  $('#progress-fill').style.width = '0%';
  $('#headline-card').hidden = true;
  $('#plan-card').hidden = true;
  $('#insight-list').replaceChildren();

  state.insights = [];
  state.summary = null;

  const focus = $('#focus-input').value.trim();
  const url =
    `/api/datasets/${encodeURIComponent(state.current.id)}/analyze` +
    (focus ? `?focus=${encodeURIComponent(focus)}` : '');
  const source = new EventSource(url);

  const finish = () => {
    source.close();
    state.running = false;
    button.disabled = false;
    button.textContent = 'Найти инсайты';
  };

  source.onmessage = (event) => {
    const data = JSON.parse(event.data);

    $('#progress-fill').style.width = `${Math.round((data.progress ?? 0) * 100)}%`;

    // Находки печатаются в свой список, а не в журнал — журнал показывает ход
    // работы агента, и он ценен сам по себе: видно, сколько гипотез отвергнуто.
    if (!data.insight) {
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="trace-phase">${esc(data.phase)}</span>` +
        `<span class="trace-msg">${esc(data.message)}` +
        (data.detail ? `<span class="trace-detail">${esc(data.detail)}</span>` : '') +
        '</span>';
      log.append(li);
      log.scrollTop = log.scrollHeight;
    } else {
      state.insights.push(data.insight);
    }

    if (data.summary) {
      state.summary = data.summary;
      // Финальный ранжированный список приходит в фазе rank; берём по одному
      // экземпляру каждой находки.
      state.insights = Array.from(new Map(state.insights.map((i) => [i.id, i])).values());
      renderInsights();
      refreshDatasets();
    }

    if (data.phase === 'done') finish();
    if (data.phase === 'error') {
      toast(data.message, 'error');
      finish();
    }
  };

  source.onerror = () => {
    if (state.running) toast('Соединение с сервером прервано.', 'error');
    finish();
  };
}

// ---------------------------------------------------------------------------
// Инсайты
// ---------------------------------------------------------------------------

const KIND_LABELS = {
  trend: 'тренд',
  anomaly: 'аномалия',
  driver: 'драйвер изменения',
  correlation: 'взаимосвязь',
  concentration: 'концентрация',
  comparison: 'различие сегментов',
  quality: 'качество данных',
};

const STEP_LABELS = {
  investigate: 'разобраться',
  act: 'действие',
  monitor: 'наблюдать',
  fix_data: 'данные',
};

function meter(label, value) {
  const level = value >= 0.7 ? 'is-high' : value < 0.45 ? 'is-low' : '';
  return (
    `<span class="meter">${label}` +
    `<span class="meter-track"><span class="meter-fill ${level}" style="width:${Math.round(value * 100)}%"></span></span>` +
    `<span class="meter-value">${pct(value)}</span></span>`
  );
}

function renderInsights() {
  const container = $('#insight-list');
  container.replaceChildren();

  if (state.summary) {
    $('#headline-card').hidden = false;
    $('#headline-text').textContent = state.summary.headline;
    const s = state.summary;
    $('#run-stats').innerHTML =
      `<div><dt>Гипотез проверено</dt><dd>${s.hypothesesTested}</dd></div>` +
      `<div><dt>Подтверждено</dt><dd>${s.insightsConfirmed}</dd></div>` +
      `<div><dt>Отклонено</dt><dd>${s.insightsRejected}</dd></div>` +
      `<div><dt>Время</dt><dd>${(s.durationMs / 1000).toFixed(1)} с</dd></div>` +
      `<div><dt>Формулировка</dt><dd style="font-size:13px;font-weight:500">` +
      `${s.llmUsed ? 'языковая модель' : 'детерминированная'}</dd></div>`;

    if (s.nextSteps.length > 0) {
      $('#plan-card').hidden = false;
      $('#plan-list').innerHTML = s.nextSteps.map((step) =>
        `<li><span class="step-tag step-${esc(step.type)}">${esc(STEP_LABELS[step.type] ?? step.type)}</span>` +
        `${esc(step.action)}<span class="rationale">${esc(step.rationale)}</span></li>`,
      ).join('');
    }
  }

  if (state.insights.length === 0) {
    container.innerHTML =
      '<p class="muted">Инсайтов пока нет. Нажмите «Найти инсайты», чтобы запустить агента.</p>';
    return;
  }

  for (const insight of state.insights) {
    container.append(renderInsightCard(insight));
  }
}

function renderInsightCard(insight) {
  const card = document.createElement('article');
  card.className = 'insight';

  const head = document.createElement('div');
  head.className = 'insight-head';
  head.innerHTML =
    '<div class="insight-badges">' +
    `<span class="kind-badge">${esc(KIND_LABELS[insight.kind] ?? insight.kind)}</span>` +
    meter('уверенность', insight.confidence) +
    meter('влияние', insight.impact) +
    '</div>' +
    `<h3>${esc(insight.title)}</h3>`;
  card.append(head);

  const body = document.createElement('div');
  body.className = 'insight-body';

  const narrative = document.createElement('p');
  narrative.className = 'narrative';
  narrative.textContent = insight.narrative;
  body.append(narrative);

  const chart = renderChart(insight.chart);
  if (chart) body.append(chart);

  // Доказательства: главная статистика первой, затем сопутствующие числа.
  const evidence = document.createElement('dl');
  evidence.className = 'evidence-grid';
  const rows = [
    { label: insight.evidence.statisticLabel, value: fmtNum(insight.evidence.statistic) },
    ...(insight.evidence.pValue !== undefined
      ? [{ label: 'Значимость (p)', value: insight.evidence.pValue < 0.0001 ? '< 0,0001' : insight.evidence.pValue.toFixed(4).replace('.', ',') }]
      : []),
    ...(insight.evidence.effectSize !== undefined
      ? [{ label: insight.evidence.effectSizeLabel ?? 'Размер эффекта', value: fmtNum(insight.evidence.effectSize) }]
      : []),
    { label: 'Наблюдений', value: String(insight.evidence.sampleSize) },
    ...insight.evidence.facts,
  ];
  evidence.innerHTML = rows
    .map((f) => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`)
    .join('');
  body.append(evidence);

  if (insight.trace.length > 0) {
    const details = document.createElement('details');
    details.className = 'trace';
    details.innerHTML =
      '<summary>Как это посчитано</summary>' +
      `<ol class="trace-steps">${insight.trace.map((t) => `<li>· ${esc(t)}</li>`).join('')}</ol>`;
    body.append(details);
  }

  if (insight.caveats.length > 0) {
    const caveats = document.createElement('div');
    caveats.className = 'caveats';
    caveats.innerHTML =
      '<h4>Что может это опровергнуть</h4>' +
      `<ul>${insight.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`;
    body.append(caveats);
  }

  if (insight.nextSteps.length > 0) {
    const steps = document.createElement('div');
    steps.className = 'insight-steps';
    steps.innerHTML =
      '<h4>Следующие шаги</h4><ul>' +
      insight.nextSteps.map((s, i) =>
        `<li><span class="step-tag step-${esc(s.type)}">${esc(STEP_LABELS[s.type] ?? s.type)}</span>` +
        `${esc(s.action)}<span class="rationale">${esc(s.rationale)}</span>` +
        (s.query ? `<button class="btn btn-sm" data-step="${i}" style="margin-top:6px">Выполнить запрос</button>` : '') +
        '</li>',
      ).join('') + '</ul>';

    // Кнопка переносит готовый запрос на вкладку «Запросы» и выполняет его —
    // от находки к проверке в один клик.
    steps.querySelectorAll('button[data-step]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const step = insight.nextSteps[Number(btn.dataset.step)];
        switchTab('query');
        runQuery(step.query);
      });
    });
    body.append(steps);
  }

  card.append(body);
  return card;
}

// ---------------------------------------------------------------------------
// Запросы
// ---------------------------------------------------------------------------

function renderBuilder() {
  const model = state.current.semantic;
  const builder = $('#builder');
  builder.replaceChildren();

  const field = (label, control) => {
    const wrap = document.createElement('div');
    wrap.className = 'builder-field';
    const lab = document.createElement('label');
    lab.textContent = label;
    wrap.append(lab, control);
    return wrap;
  };

  const metricSelect = document.createElement('select');
  metricSelect.className = 'input';
  metricSelect.id = 'q-metric';
  for (const m of model.measures) {
    const opt = document.createElement('option');
    opt.value = m.name;
    opt.textContent = `${m.name} (${m.defaultAggregation})`;
    metricSelect.append(opt);
  }

  const groupSelect = document.createElement('select');
  groupSelect.className = 'input';
  groupSelect.id = 'q-group';
  groupSelect.append(new Option('— без разреза —', ''));
  for (const t of model.timeDimensions) groupSelect.append(new Option(`${t.name} (время)`, t.name));
  for (const d of model.dimensions) {
    if (d.groupable) groupSelect.append(new Option(d.name, d.name));
  }

  const grainSelect = document.createElement('select');
  grainSelect.className = 'input';
  grainSelect.id = 'q-grain';
  for (const [value, label] of [
    ['', 'авто'], ['day', 'день'], ['week', 'неделя'],
    ['month', 'месяц'], ['quarter', 'квартал'], ['year', 'год'],
  ]) {
    grainSelect.append(new Option(label, value));
  }

  const limitInput = document.createElement('input');
  limitInput.type = 'number';
  limitInput.className = 'input';
  limitInput.id = 'q-limit';
  limitInput.value = '50';
  limitInput.min = '1';
  limitInput.max = '1000';
  limitInput.style.width = '80px';

  builder.append(
    field('Метрика', metricSelect),
    field('Разрез', groupSelect),
    field('Шаг по времени', grainSelect),
    field('Строк', limitInput),
  );
}

async function runQuery(preset) {
  const model = state.current.semantic;
  let query = preset;

  if (!query) {
    const group = $('#q-group').value;
    const grain = $('#q-grain').value;
    query = {
      metrics: [{ measure: $('#q-metric').value }],
      ...(group ? { groupBy: [group] } : {}),
      ...(grain ? { timeGrain: grain } : {}),
      limit: Number($('#q-limit').value) || 50,
    };
  }

  try {
    const { result } = await api(`/api/datasets/${encodeURIComponent(state.current.id)}/query`, {
      method: 'POST',
      body: JSON.stringify(query),
    });
    renderQueryResult(result);
  } catch (err) {
    toast(err.message, 'error');
  }
  void model;
}

function renderQueryResult(result, extra) {
  const container = $('#query-result');
  container.replaceChildren();

  const card = document.createElement('div');
  card.className = 'query-card';

  if (extra?.reasoning) {
    card.insertAdjacentHTML('beforeend',
      `<div class="explanation"><strong>Как понят вопрос:</strong> ${esc(extra.reasoning)}</div>`);
  }
  card.insertAdjacentHTML('beforeend', `<div class="explanation">${esc(result.explanation)}</div>`);

  if (result.rows.length === 0) {
    card.insertAdjacentHTML('beforeend', '<p class="muted">Ни одна строка не подошла под условия.</p>');
    container.append(card);
    return;
  }

  const scroll = document.createElement('div');
  scroll.className = 'table-scroll';
  const table = document.createElement('table');
  table.className = 'data-table';
  table.innerHTML =
    `<thead><tr>${result.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>` +
    `<tbody>${result.rows.map((row) =>
      `<tr>${row.map((v) =>
        typeof v === 'number'
          ? `<td class="num">${esc(fmtNum(v))}</td>`
          : `<td>${esc(v ?? '—')}</td>`,
      ).join('')}</tr>`,
    ).join('')}</tbody>`;
  scroll.append(table);
  card.append(scroll);

  card.insertAdjacentHTML('beforeend',
    `<p class="muted small" style="margin-top:10px">Строк: ${result.rowCount}` +
    `${result.truncated ? ' (усечено лимитом)' : ''} · просканировано: ${result.scanned}</p>`);

  container.append(card);
}

async function askQuestion() {
  const question = $('#ask-input').value.trim();
  if (!question) return;
  const btn = $('#ask-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Думаю…';
  try {
    const data = await api(`/api/datasets/${encodeURIComponent(state.current.id)}/ask`, {
      method: 'POST',
      body: JSON.stringify({ question }),
    });
    renderQueryResult(data.result, { reasoning: data.reasoning });
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Спросить';
  }
}

// ---------------------------------------------------------------------------
// Вкладки, тема, инициализация
// ---------------------------------------------------------------------------

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel-${name}`));
}

function initTheme() {
  const stored = localStorage.getItem('agentics-theme');
  if (stored) document.documentElement.dataset.theme = stored;

  $('#theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    const isDark = root.dataset.theme === 'dark' ||
      (root.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    root.dataset.theme = next;
    localStorage.setItem('agentics-theme', next);
  });
}

function initDropzone() {
  const zone = $('#dropzone');
  const input = $('#file-input');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files?.[0]) uploadFile(input.files[0]);
    input.value = '';
  });

  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('is-over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.remove('is-over'); });
  }
  zone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) uploadFile(file);
  });
}

async function init() {
  initTheme();
  initDropzone();

  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  $('#run-analysis').addEventListener('click', runAnalysis);
  $('#run-query').addEventListener('click', () => runQuery());
  $('#ask-btn').addEventListener('click', askQuestion);
  $('#ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') askQuestion(); });
  $('#focus-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runAnalysis(); });
  $('#delete-dataset').addEventListener('click', async () => {
    if (!confirm(`Удалить набор «${state.current.name}» и все его инсайты?`)) return;
    await api(`/api/datasets/${encodeURIComponent(state.current.id)}`, { method: 'DELETE' });
    state.current = null;
    $('#workspace').hidden = true;
    $('#empty-state').hidden = false;
    await refreshDatasets();
    toast('Набор удалён.');
  });

  const mcpUrl = `${location.origin}/mcp`;
  $('#mcp-endpoint').textContent = 'MCP: /mcp';
  $('#mcp-endpoint').title = mcpUrl;
  $('#mcp-config').textContent = JSON.stringify(
    { mcpServers: { 'agentics-analytics': { type: 'http', url: mcpUrl } } },
    null, 2,
  );

  try {
    const status = await api('/api/status');
    state.llmAvailable = status.llmAvailable;
    state.samples = status.samples;

    const pill = $('#llm-status');
    pill.textContent = status.llmAvailable ? 'LLM подключена' : 'LLM не настроена';
    pill.classList.toggle('is-on', status.llmAvailable);
    pill.title = status.llmAvailable
      ? 'Формулировки и вопросы на естественном языке доступны. Все числа считает код.'
      : 'Анализ работает полностью. Недоступны только LLM-формулировки и вопросы словами.';

    $('#ask-hint').textContent = status.llmAvailable
      ? 'Модель переводит вопрос в запрос к семантической модели; расчёт выполняет движок — числа не генерируются моделью.'
      : 'Требуется переменная окружения ANTHROPIC_API_KEY. Ниже доступен конструктор запросов.';
    $('#ask-btn').disabled = !status.llmAvailable;
    $('#ask-input').disabled = !status.llmAvailable;

    const buttons = $('#sample-buttons');
    for (const sample of status.samples) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.textContent = sample.name;
      btn.title = sample.description;
      btn.addEventListener('click', () => loadSample(sample.id));
      buttons.append(btn);
    }
  } catch (err) {
    toast(`Не удалось получить статус сервера: ${err.message}`, 'error');
  }

  await refreshDatasets();
  if (state.datasets.length > 0) await selectDataset(state.datasets[0].id);
}

init();
