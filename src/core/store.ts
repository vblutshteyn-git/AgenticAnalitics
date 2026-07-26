/**
 * Dataset store. In-memory for query speed, with an on-disk mirror so uploads
 * survive a restart. Datasets are held column-oriented with parsed numeric and
 * temporal projections, which is what makes repeated hypothesis testing cheap.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseAny } from './ingest.js';
import { profileTable } from './profile.js';
import { buildSemanticModel } from './semantic.js';
import type { Dataset, DatasetSummary, Insight, SemanticModel } from './types.js';

export interface IngestOptions {
  name: string;
  source: Dataset['source'];
  /** Filename or format name, used to pick a parser. */
  formatHint?: string;
  notes?: string;
}

export interface IngestResult {
  dataset: Dataset;
  warnings: string[];
}

/** Guardrail against a single upload exhausting memory. */
export const MAX_ROWS = 500_000;
export const MAX_BYTES = 64 * 1024 * 1024;

export class DatasetStore {
  private datasets = new Map<string, Dataset>();
  private insights = new Map<string, Insight[]>();
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = dataDir;
    mkdirSync(join(this.dir, 'datasets'), { recursive: true });
    this.loadFromDisk();
  }

  ingest(content: string, options: IngestOptions): IngestResult {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_BYTES) {
      throw new Error(
        `Файл слишком большой: ${(bytes / 1e6).toFixed(1)} МБ, лимит ${MAX_BYTES / 1e6} МБ.`,
      );
    }

    const parsed = parseAny(content, options.formatHint);
    const warnings = [...parsed.warnings];

    if (parsed.columns.length === 0) {
      throw new Error('Не удалось определить колонки. Проверьте формат файла.');
    }
    if (parsed.rowCount === 0) {
      throw new Error('В файле нет строк данных (только заголовок).');
    }

    let rowCount = parsed.rowCount;
    let values = parsed.rows;
    if (rowCount > MAX_ROWS) {
      warnings.push(`Набор усечён до первых ${MAX_ROWS} строк из ${rowCount}.`);
      values = values.map((col) => col.slice(0, MAX_ROWS));
      rowCount = MAX_ROWS;
    }

    const id = shortId(options.name);
    const { profiles, numericCache, timeCache } = profileTable(parsed.columns, values, rowCount);
    const semantic = buildSemanticModel(id, profiles, rowCount);

    const dataset: Dataset = {
      id,
      name: options.name,
      source: options.source,
      createdAt: new Date().toISOString(),
      rowCount,
      columns: parsed.columns,
      values,
      numericCache,
      timeCache,
      profiles,
      semantic,
      notes: options.notes,
    };

    this.datasets.set(id, dataset);
    this.insights.set(id, []);
    this.persist(dataset, content, options.formatHint);
    return { dataset, warnings };
  }

  get(id: string): Dataset | undefined {
    return this.datasets.get(id);
  }

  require(id: string): Dataset {
    const d = this.datasets.get(id);
    if (!d) {
      const available = this.list().map((s) => `${s.id} (${s.name})`).join(', ') || 'нет наборов';
      throw new Error(`Набор данных «${id}» не найден. Доступны: ${available}.`);
    }
    return d;
  }

  list(): DatasetSummary[] {
    return Array.from(this.datasets.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((d) => ({
        id: d.id,
        name: d.name,
        source: d.source,
        createdAt: d.createdAt,
        rowCount: d.rowCount,
        columnCount: d.columns.length,
        measures: d.semantic.measures.length,
        dimensions: d.semantic.dimensions.length,
        hasTime: d.semantic.timeDimensions.length > 0,
        insightCount: (this.insights.get(d.id) ?? []).length,
      }));
  }

  delete(id: string): boolean {
    const existed = this.datasets.delete(id);
    this.insights.delete(id);
    for (const suffix of ['.raw', '.meta.json']) {
      try {
        unlinkSync(join(this.dir, 'datasets', `${id}${suffix}`));
      } catch {
        // Already gone; nothing to clean up.
      }
    }
    return existed;
  }

  updateSemanticModel(id: string, patch: Partial<SemanticModel>): SemanticModel {
    const dataset = this.require(id);
    dataset.semantic = { ...dataset.semantic, ...patch, datasetId: id };
    this.persistMeta(dataset);
    return dataset.semantic;
  }

  setInsights(datasetId: string, insights: Insight[]): void {
    this.insights.set(datasetId, insights);
    const dataset = this.datasets.get(datasetId);
    if (dataset) this.persistMeta(dataset);
  }

  getInsights(datasetId: string): Insight[] {
    return this.insights.get(datasetId) ?? [];
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * The raw text is stored alongside a small metadata file. Re-parsing on boot
   * costs a little startup time but keeps the on-disk format transparent and
   * lets a user recover their original upload byte for byte.
   */
  private persist(dataset: Dataset, content: string, formatHint?: string): void {
    try {
      writeFileSync(join(this.dir, 'datasets', `${dataset.id}.raw`), content, 'utf8');
      this.persistMeta(dataset, formatHint);
    } catch (err) {
      console.error(`[store] не удалось сохранить набор ${dataset.id}:`, err);
    }
  }

  private persistMeta(dataset: Dataset, formatHint?: string): void {
    try {
      const metaPath = join(this.dir, 'datasets', `${dataset.id}.meta.json`);
      let existingHint = formatHint;
      if (existingHint === undefined) {
        try {
          existingHint = JSON.parse(readFileSync(metaPath, 'utf8')).formatHint;
        } catch {
          existingHint = undefined;
        }
      }
      const meta = {
        id: dataset.id,
        name: dataset.name,
        source: dataset.source,
        createdAt: dataset.createdAt,
        notes: dataset.notes,
        formatHint: existingHint,
        semantic: dataset.semantic,
        insights: this.insights.get(dataset.id) ?? [],
      };
      writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    } catch (err) {
      console.error(`[store] не удалось сохранить метаданные ${dataset.id}:`, err);
    }
  }

  private loadFromDisk(): void {
    const dir = join(this.dir, 'datasets');
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
    } catch {
      return;
    }

    for (const file of files) {
      const id = file.replace('.meta.json', '');
      try {
        const meta = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        const content = readFileSync(join(dir, `${id}.raw`), 'utf8');
        const parsed = parseAny(content, meta.formatHint);
        if (parsed.columns.length === 0 || parsed.rowCount === 0) continue;

        const { profiles, numericCache, timeCache } = profileTable(
          parsed.columns,
          parsed.rows,
          parsed.rowCount,
        );
        this.datasets.set(id, {
          id,
          name: meta.name ?? id,
          source: meta.source ?? 'upload',
          createdAt: meta.createdAt ?? new Date().toISOString(),
          rowCount: parsed.rowCount,
          columns: parsed.columns,
          values: parsed.rows,
          numericCache,
          timeCache,
          profiles,
          // Prefer the saved model: it may carry human corrections.
          semantic: meta.semantic ?? buildSemanticModel(id, profiles, parsed.rowCount),
          notes: meta.notes,
        });
        this.insights.set(id, meta.insights ?? []);
      } catch (err) {
        console.error(`[store] не удалось восстановить набор ${id}:`, err);
      }
    }
  }
}

/** Readable slug plus a short hash, so ids are both stable and human-scannable. */
function shortId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9а-я]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const hash = createHash('sha256').update(randomUUID()).digest('hex').slice(0, 6);
  return slug ? `${slug}-${hash}` : `ds-${hash}`;
}
