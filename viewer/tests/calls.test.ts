import { describe, expect, it } from 'vitest';
import { buildFunctionCallIndex } from '../src/analysis/calls.ts';
import { buildModuleTree } from '../src/analysis/module_tree.ts';
import type { CrateFacts, Facts, FnFacts, ModuleFacts, TypeFacts } from '../src/data/schema.ts';

function fn(name: string, visibility = 'pub'): FnFacts {
  return { name, visibility };
}

function ty(crateName: string, modulePath: string, name: string, methods: FnFacts[]): TypeFacts {
  const prefix = modulePath === '' ? crateName : `${crateName}::${modulePath}`;
  return {
    name,
    full_path: `${prefix}::${name}`,
    kind: 'struct',
    visibility: 'pub',
    fields: [],
    methods,
  };
}

function mod(path: string, functions: FnFacts[], types: TypeFacts[] = []): ModuleFacts {
  return {
    path,
    file: path === '' ? 'src/lib.rs' : `src/${path.replace(/::/g, '/')}.rs`,
    types,
    functions,
  };
}

function crateFacts(modules: ModuleFacts[]): CrateFacts {
  return { name: 'c', modules: Object.fromEntries(modules.map((m) => [m.path, m])) };
}

function facts(crate: CrateFacts): Facts {
  return {
    crates: { c: crate },
    edges: [],
    call_edges: [
      {
        caller: 'c::caller',
        callee: 'c::callee',
        kind: 'function',
        resolution: 'exact',
        origin: 'callee',
      },
      {
        caller: 'c::caller',
        callee: 'c::other::far',
        kind: 'function',
        resolution: 'exact',
        origin: 'other::far',
      },
      {
        caller: 'c::Owner::local',
        callee: 'c::Owner::helper',
        kind: 'method',
        resolution: 'exact',
        origin: '.helper',
      },
      {
        caller: 'c::inner::module_caller',
        callee: 'c::inner::module_callee',
        kind: 'function',
        resolution: 'exact',
        origin: 'module_callee',
      },
      {
        caller: 'c::inner::NestedOwner::member_caller',
        callee: 'c::inner::NestedOwner::member_callee',
        kind: 'method',
        resolution: 'exact',
        origin: '.member_callee',
      },
    ],
  };
}

describe('buildFunctionCallIndex', () => {
  it('maps call edges onto free-function and method rows', () => {
    const crate = crateFacts([
      mod('', [fn('caller'), fn('callee')], [ty('c', '', 'Owner', [fn('local'), fn('helper')])]),
      mod('other', [fn('far')]),
      mod(
        'inner',
        [fn('module_caller'), fn('module_callee')],
        [ty('c', 'inner', 'NestedOwner', [fn('member_caller'), fn('member_callee')])],
      ),
    ]);
    const root = buildModuleTree(crate);
    const idx = buildFunctionCallIndex(facts(crate), 'c', root);

    expect(idx.rowByFunction.get('c::caller')).toMatchObject({
      typeId: 'c::__fn_pub',
      rowName: 'caller',
      rowKind: 'function',
      moduleId: 'c',
    });
    expect(idx.rowByFunction.get('c::Owner::local')).toMatchObject({
      typeId: 'c::Owner',
      rowName: 'local',
      rowKind: 'method',
      moduleId: 'c',
    });
    expect(
      idx.callTargetsByFunction.get('c::Owner::local')?.map((r) => r.functionFullPath),
    ).toEqual(['c::Owner::helper']);
    expect(idx.rowByFunction.get('c::inner::module_caller')).toMatchObject({
      typeId: 'c::inner::__fn_pub',
      rowName: 'module_caller',
      rowKind: 'function',
      moduleId: 'c::inner',
    });
    expect(
      idx.callTargetsByFunction
        .get('c::inner::module_caller')
        ?.map((r) => [r.functionFullPath, r.rowKind, r.typeId]),
    ).toEqual([['c::inner::module_callee', 'function', 'c::inner::__fn_pub']]);
    expect(idx.rowByFunction.get('c::inner::NestedOwner::member_caller')).toMatchObject({
      typeId: 'c::inner::NestedOwner',
      rowName: 'member_caller',
      rowKind: 'method',
      moduleId: 'c::inner',
    });
    expect(
      idx.callTargetsByFunction
        .get('c::inner::NestedOwner::member_caller')
        ?.map((r) => [r.functionFullPath, r.rowKind, r.typeId]),
    ).toEqual([['c::inner::NestedOwner::member_callee', 'method', 'c::inner::NestedOwner']]);
    expect(idx.nonLocalCallers.has('c::caller')).toBe(true);
    expect(idx.nonLocalCallers.has('c::Owner::local')).toBe(false);
    expect(idx.nonLocalCallers.has('c::inner::module_caller')).toBe(false);
    expect(idx.nonLocalCallers.has('c::inner::NestedOwner::member_caller')).toBe(false);
  });
});
