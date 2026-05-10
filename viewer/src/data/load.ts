import { canonicalize } from './canonicalize.ts';
import type { Facts } from './schema.ts';

const KNOWN_KINDS: readonly string[] = [
  'struct',
  'enum',
  'union',
  'trait',
  'type_alias',
];

export class FactsLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FactsLoadError';
  }
}

export async function loadFacts(url: string): Promise<Facts> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    throw new FactsLoadError(`fetch ${url} failed`, { cause });
  }
  if (!res.ok) {
    throw new FactsLoadError(`fetch ${url} → HTTP ${res.status} ${res.statusText}`);
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (cause) {
    throw new FactsLoadError(`parse ${url} as JSON failed`, { cause });
  }

  return canonicalize(validate(raw));
}

// Narrow boundary check: confirm the shape we read. Does not recursively
// validate every field — unknown kinds in particular degrade gracefully at
// render time. The point is to fail loudly when the dump is structurally
// wrong, not to enforce the full Rust schema.
function validate(raw: unknown): Facts {
  if (!isObject(raw)) throw new FactsLoadError('root is not an object');
  const root = raw as Record<string, unknown>;
  const crates = root['crates'];
  if (!isObject(crates)) throw new FactsLoadError('root.crates is not an object');
  const edges = root['edges'];
  if (!Array.isArray(edges)) throw new FactsLoadError('root.edges is not an array');
  const callEdges = root['call_edges'];
  if (callEdges !== undefined && !Array.isArray(callEdges)) {
    throw new FactsLoadError('root.call_edges is not an array');
  }
  for (const [i, eRaw] of edges.entries()) {
    if (!isObject(eRaw)) {
      throw new FactsLoadError(`edges[${i}] is not an object`);
    }
    const e = eRaw as Record<string, unknown>;
    if (typeof e['from'] !== 'string' || typeof e['to'] !== 'string') {
      throw new FactsLoadError(`edges[${i}] missing from/to`);
    }
    if (typeof e['kind'] !== 'string' || typeof e['via'] !== 'string') {
      throw new FactsLoadError(`edges[${i}] missing kind/via`);
    }
    if (typeof e['origin'] !== 'string') {
      throw new FactsLoadError(`edges[${i}] missing origin`);
    }
  }
  for (const [i, eRaw] of ((callEdges ?? []) as unknown[]).entries()) {
    if (!isObject(eRaw)) {
      throw new FactsLoadError(`call_edges[${i}] is not an object`);
    }
    const e = eRaw as Record<string, unknown>;
    if (typeof e['caller'] !== 'string' || typeof e['callee'] !== 'string') {
      throw new FactsLoadError(`call_edges[${i}] missing caller/callee`);
    }
    if (typeof e['kind'] !== 'string' || typeof e['resolution'] !== 'string') {
      throw new FactsLoadError(`call_edges[${i}] missing kind/resolution`);
    }
    if (typeof e['origin'] !== 'string') {
      throw new FactsLoadError(`call_edges[${i}] missing origin`);
    }
  }

  for (const [crateName, crateRaw] of Object.entries(crates)) {
    if (!isObject(crateRaw)) {
      throw new FactsLoadError(`crates['${crateName}'] is not an object`);
    }
    const c = crateRaw as Record<string, unknown>;
    if (typeof c['name'] !== 'string') {
      throw new FactsLoadError(`crates['${crateName}'].name is not a string`);
    }
    if (!isObject(c['modules'])) {
      throw new FactsLoadError(`crates['${crateName}'].modules is not an object`);
    }
    for (const [modPath, modRaw] of Object.entries(c['modules'] as Record<string, unknown>)) {
      if (!isObject(modRaw)) {
        throw new FactsLoadError(
          `crates['${crateName}'].modules['${modPath}'] is not an object`,
        );
      }
      const m = modRaw as Record<string, unknown>;
      if (typeof m['path'] !== 'string') {
        throw new FactsLoadError(
          `crates['${crateName}'].modules['${modPath}'].path is not a string`,
        );
      }
      if (typeof m['file'] !== 'string') {
        throw new FactsLoadError(
          `crates['${crateName}'].modules['${modPath}'].file is not a string`,
        );
      }
      if (!Array.isArray(m['types'])) {
        throw new FactsLoadError(
          `crates['${crateName}'].modules['${modPath}'].types is not an array`,
        );
      }
      for (const [i, tRaw] of (m['types'] as unknown[]).entries()) {
        if (!isObject(tRaw)) {
          throw new FactsLoadError(
            `crates['${crateName}'].modules['${modPath}'].types[${i}] is not an object`,
          );
        }
        const t = tRaw as Record<string, unknown>;
        if (typeof t['name'] !== 'string') {
          throw new FactsLoadError(
            `crates['${crateName}'].modules['${modPath}'].types[${i}].name missing`,
          );
        }
        if (typeof t['kind'] !== 'string') {
          throw new FactsLoadError(
            `crates['${crateName}'].modules['${modPath}'].types[${i}].kind missing`,
          );
        }
        if (!KNOWN_KINDS.includes(t['kind'])) {
          // Forward-compat: warn, don't fail. Render falls back to a default.
          console.warn(
            `unknown TypeKind '${t['kind']}' at ${crateName}::${modPath}::${t['name']}`,
          );
        }
        if (!Array.isArray(t['fields'])) {
          throw new FactsLoadError(
            `crates['${crateName}'].modules['${modPath}'].types[${i}].fields is not an array`,
          );
        }
        for (const [j, fRaw] of (t['fields'] as unknown[]).entries()) {
          if (!isObject(fRaw)) {
            throw new FactsLoadError(
              `crates['${crateName}'].modules['${modPath}'].types[${i}].fields[${j}] is not an object`,
            );
          }
          const f = fRaw as Record<string, unknown>;
          if (typeof f['name'] !== 'string') {
            throw new FactsLoadError(
              `crates['${crateName}'].modules['${modPath}'].types[${i}].fields[${j}].name missing`,
            );
          }
          if (typeof f['ty_text'] !== 'string') {
            throw new FactsLoadError(
              `crates['${crateName}'].modules['${modPath}'].types[${i}].fields[${j}].ty_text missing`,
            );
          }
        }
      }
    }
  }

  return raw as unknown as Facts;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
