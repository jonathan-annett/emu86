import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { SSTCase } from './types.js';

/**
 * Discover and load test cases from the SingleStepTests/8088 corpus.
 *
 * Place the corpus's `v2/` directory at `tests/sst/data/` (symlink or
 * copy — the path is in `.gitignore`). The loader walks `*.json` and
 * `*.json.gz` files recursively; the corpus ships gzipped to keep the
 * download under a gigabyte, and we read them in-place rather than
 * decompressing to disk. Each file is an array of {@link SSTCase}
 * objects.
 *
 * Filename conventions in the corpus: `<opcode-hex>.json[.gz]` for
 * one-byte opcodes, sometimes with sub-op suffix like `80.0.json[.gz]`
 * for ModR/M sub-ops. We don't interpret the name — callers can just
 * iterate.
 *
 * If the data directory doesn't exist, {@link findCorpusFiles} returns
 * an empty array. Tests should treat zero files as "skip", not "fail".
 */

const DATA_DIR = new URL('./data/', import.meta.url).pathname;

/** Return true if the corpus appears to be installed. */
export function corpusAvailable(): boolean {
  try {
    return statSync(DATA_DIR).isDirectory();
  } catch {
    return false;
  }
}

/** All `*.json` files under tests/sst/data/, recursively. */
export function findCorpusFiles(): string[] {
  if (!corpusAvailable()) return [];
  const out: string[] = [];
  walk(DATA_DIR, out);
  out.sort();
  return out;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.json.gz'))) {
      // The v2 corpus ships a metadata.json at the data root that catalogues
      // each opcode (status, ModR/M shape, etc.). It's not an array of test
      // cases, so loading it would explode. Skip by name.
      if (entry.name === 'metadata.json') continue;
      out.push(full);
    }
  }
}

/** Parse one corpus JSON file as an array of test cases. Handles `.gz` transparently. */
export function loadCases(path: string): SSTCase[] {
  const raw = path.endsWith('.gz')
    ? gunzipSync(readFileSync(path)).toString('utf8')
    : readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`SST corpus file ${path} did not contain an array`);
  }
  // We trust the corpus shape — it's been validated by upstream. Cast through
  // unknown to satisfy strict TS without importing every field.
  return parsed as SSTCase[];
}

/**
 * Identifier extracted from a corpus filename, used for grouping results
 * (e.g. "F6.0" for the TEST sub-op of the 0xF6 group).
 */
export function fileId(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.json(?:\.gz)?$/i, '');
}
