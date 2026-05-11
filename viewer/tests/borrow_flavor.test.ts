import { describe, expect, it } from 'vitest';
import { borrowFlavor } from '../src/analysis/borrow_flavor.ts';

describe('borrowFlavor', () => {
  describe('plain owned types are moves', () => {
    it.each([
      ['T', 'move'],
      ['Self', 'move'],
      ['usize', 'move'],
      ['Module', 'move'],
      ['Box<T>', 'move'],
      ['Vec<u8>', 'move'],
      ['Arc<RefCell<Foo>>', 'move'],
      ['Result<Module, Error>', 'move'],
      ['impl Iterator<Item = u8>', 'move'],
    ] as const)('%s → %s', (ty, expected) => {
      expect(borrowFlavor(ty)).toBe(expected);
    });
  });

  describe('top-level `&` is a shared borrow', () => {
    it.each([
      ['&T', 'shared'],
      ['&[u8]', 'shared'],
      ['&str', 'shared'],
      ['&Module', 'shared'],
      ["&'a T", 'shared'],
      ["&'static str", 'shared'],
      ['&self', 'shared'],
    ] as const)('%s → %s', (ty, expected) => {
      expect(borrowFlavor(ty)).toBe(expected);
    });
  });

  describe('top-level `&mut` is a mut borrow', () => {
    it.each([
      ['&mut T', 'mut'],
      ['&mut [u8]', 'mut'],
      ['&mut Store', 'mut'],
      ["&'a mut T", 'mut'],
      ["&'static mut Foo", 'mut'],
      ['&mut self', 'mut'],
    ] as const)('%s → %s', (ty, expected) => {
      expect(borrowFlavor(ty)).toBe(expected);
    });
  });

  it('only looks at the top level — nested borrows in an owned wrapper read as move', () => {
    expect(borrowFlavor('Vec<&T>')).toBe('move');
    expect(borrowFlavor('Option<&mut T>')).toBe('move');
    expect(borrowFlavor('Box<&dyn Trait>')).toBe('move');
  });

  it('does not confuse type names beginning with the letters "mut"', () => {
    // `&MutableThing` is a shared borrow of a type whose name starts with
    // `Mut`. Only the keyword `mut` (followed by whitespace) counts.
    expect(borrowFlavor('&MutableThing')).toBe('shared');
    expect(borrowFlavor('&mutex::Guard')).toBe('shared');
  });

  it('handles the self receiver tokens directly', () => {
    expect(borrowFlavor('self')).toBe('move');
    expect(borrowFlavor('&self')).toBe('shared');
    expect(borrowFlavor('&mut self')).toBe('mut');
  });

  describe('raw pointers are classified as raw', () => {
    it.each([
      ['*const T', 'raw'],
      ['*mut T', 'raw'],
      ['*const u8', 'raw'],
      ['*mut Module', 'raw'],
      ['*const [u8]', 'raw'],
    ] as const)('%s → %s', (ty, expected) => {
      expect(borrowFlavor(ty)).toBe(expected);
    });
  });

  it('does not confuse type names with the const/mut keywords inside raw pointers', () => {
    // Defensive: `*constant` and `*mutually` aren't valid Rust pointer
    // syntax, but the keyword check must require a word boundary so
    // hypothetical inputs don't slip through as 'raw'.
    expect(borrowFlavor('*constant')).toBe('move');
    expect(borrowFlavor('*mutually')).toBe('move');
  });

  it('tolerates leading whitespace from the extractor', () => {
    expect(borrowFlavor('  &T')).toBe('shared');
    expect(borrowFlavor('  &mut T')).toBe('mut');
    expect(borrowFlavor('  Vec<T>')).toBe('move');
  });
});
