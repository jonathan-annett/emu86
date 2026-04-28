/**
 * Fetch ELKS hard-disk images used by the Phase 10 / 10.1 integration tests.
 *
 * The ELKS project publishes hard-disk images (~32 MiB each) as release
 * assets on the v0.9.0 GitHub release. These fixtures are too large to
 * commit to the repo, so this script fetches them on demand into
 * `reference/elks-images-hd/`. Integration tests skip with helpful messages
 * when the relevant fixture is absent.
 *
 * Phase 10 added `hd32-fat.img` (the partitionless variant). Phase 10.1
 * adds the MBR-partitioned variants, `hd32mbr-fat.img` and
 * `hd32mbr-minix.img`, used by the MBR-boot integration tests. Phase 10.2
 * adds the partitionless MINIX variant `hd32-minix.img`.
 *
 * Usage:
 *   npm run build:elks-hd-image                  # default: hd32-fat.img
 *   npm run build:elks-hd-image -- --all         # all variants
 *   npm run build:elks-hd-image -- hd32mbr-fat   # specific variant
 *   npm run build:elks-hd-image -- hd32-minix    # partitionless MINIX
 *
 * Network access is required. The script is idempotent — if a target file
 * is already present at the expected size, it skips that fetch.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface ImageSpec {
  readonly name: string;
  readonly url: string;
  readonly bytes: number;
}

const BASE = 'https://github.com/ghaerr/elks/releases/download/v0.9.0';

const IMAGES: readonly ImageSpec[] = [
  { name: 'hd32-fat.img',      url: `${BASE}/hd32-fat.img`,      bytes: 32_514_048 },
  { name: 'hd32-minix.img',    url: `${BASE}/hd32-minix.img`,    bytes: 32_514_048 },
  { name: 'hd32mbr-fat.img',   url: `${BASE}/hd32mbr-fat.img`,   bytes: 32_546_304 },
  { name: 'hd32mbr-minix.img', url: `${BASE}/hd32mbr-minix.img`, bytes: 32_546_304 },
];

const DEST_DIR = 'reference/elks-images-hd';

async function fetchImage(spec: ImageSpec): Promise<void> {
  const fullPath = resolve(DEST_DIR, spec.name);
  if (existsSync(fullPath)) {
    const sz = statSync(fullPath).size;
    if (sz === spec.bytes) {
      console.log(`${spec.name} already present at ${fullPath} (${sz} bytes); skipping.`);
      return;
    }
    console.warn(`${spec.name} exists but size is ${sz} (expected ${spec.bytes}); refetching.`);
  }
  console.log(`Fetching ${spec.url} ...`);
  const res = await fetch(spec.url);
  if (!res.ok) {
    throw new Error(`fetch failed for ${spec.name}: HTTP ${res.status} ${res.statusText}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length !== spec.bytes) {
    throw new Error(
      `fetched size for ${spec.name} (${buf.length}) does not match expected ${spec.bytes}; aborting`,
    );
  }
  writeFileSync(fullPath, buf);
  console.log(`Wrote ${buf.length} bytes to ${fullPath}.`);
}

function selectImages(args: readonly string[]): readonly ImageSpec[] {
  if (args.length === 0) {
    // Default: only the Phase 10 fixture, for backwards-compat with
    // existing flows that called this script with no args.
    return IMAGES.filter((i) => i.name === 'hd32-fat.img');
  }
  if (args.includes('--all')) return IMAGES;
  const wanted: ImageSpec[] = [];
  for (const arg of args) {
    if (arg.startsWith('--')) continue;
    const stem = arg.replace(/\.img$/, '');
    const found = IMAGES.find((i) => i.name === arg || i.name === `${stem}.img`);
    if (!found) {
      throw new Error(`unknown image name: ${arg} (known: ${IMAGES.map((i) => i.name).join(', ')})`);
    }
    wanted.push(found);
  }
  return wanted;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const targets = selectImages(args);
  mkdirSync(resolve(DEST_DIR), { recursive: true });
  for (const spec of targets) {
    await fetchImage(spec);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  process.exit(1);
});
