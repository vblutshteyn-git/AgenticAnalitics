/**
 * Write the sample datasets to disk as CSV, for inspection or for uploading
 * through a different client.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SAMPLE_DATASETS } from './samples.js';

const outDir = resolve(process.argv[2] ?? 'samples');
mkdirSync(outDir, { recursive: true });

for (const sample of SAMPLE_DATASETS) {
  const csv = sample.generate();
  const path = join(outDir, `${sample.id}.csv`);
  writeFileSync(path, csv, 'utf8');
  const rows = csv.split('\n').length - 1;
  console.log(`${path} — ${rows} строк`);
  for (const effect of sample.plantedEffects) console.log(`    заложено: ${effect}`);
}
