/**
 * Structural diff for serialized state objects (Phase 18 M1).
 *
 * The equivalence harness compares multi-megabyte states; `toEqual` on
 * buffers that size produces useless failure output and pathological
 * runtime (the recorded "toEqual-on-MB lesson"). This walker compares
 * with plain loops and reports *where* states differ — path, index,
 * both values — capped so a wholesale mismatch doesn't drown the log.
 */

const MAX_DIFFS = 24;

export function diffStates(a: unknown, b: unknown): string[] {
  const out: string[] = [];
  walk('$', a, b, out);
  return out;
}

function walk(path: string, a: unknown, b: unknown, out: string[]): void {
  if (out.length >= MAX_DIFFS) return;

  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
      out.push(`${path}: Uint8Array vs ${typeName(a instanceof Uint8Array ? b : a)}`);
      return;
    }
    if (a.length !== b.length) {
      out.push(`${path}: byte length ${a.length} vs ${b.length}`);
      return;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        out.push(`${path}[${i}]: 0x${hex(a[i]!)} vs 0x${hex(b[i]!)}`);
        if (out.length >= MAX_DIFFS) return;
      }
    }
    return;
  }

  if (a instanceof Uint16Array || b instanceof Uint16Array) {
    if (!(a instanceof Uint16Array) || !(b instanceof Uint16Array)) {
      out.push(`${path}: Uint16Array vs ${typeName(a instanceof Uint16Array ? b : a)}`);
      return;
    }
    if (a.length !== b.length) {
      out.push(`${path}: word length ${a.length} vs ${b.length}`);
      return;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        out.push(`${path}[${i}]: 0x${hex(a[i]!)} vs 0x${hex(b[i]!)}`);
        if (out.length >= MAX_DIFFS) return;
      }
    }
    return;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out.push(`${path}: array vs ${typeName(Array.isArray(a) ? b : a)}`);
      return;
    }
    if (a.length !== b.length) {
      out.push(`${path}: array length ${a.length} vs ${b.length}`);
      return;
    }
    for (let i = 0; i < a.length; i++) {
      walk(`${path}[${i}]`, a[i], b[i], out);
      if (out.length >= MAX_DIFFS) return;
    }
    return;
  }

  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) {
      out.push(`${path}: object vs ${typeName(isPlainObject(a) ? b : a)}`);
      return;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      walk(`${path}.${key}`, a[key], b[key], out);
      if (out.length >= MAX_DIFFS) return;
    }
    return;
  }

  if (a !== b) {
    out.push(`${path}: ${String(a)} vs ${String(b)}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** Plain-loop byte compare with a located, capped report. */
export function diffBytes(label: string, a: Uint8Array, b: Uint8Array): string[] {
  const out: string[] = [];
  walk(label, a, b, out);
  return out;
}
