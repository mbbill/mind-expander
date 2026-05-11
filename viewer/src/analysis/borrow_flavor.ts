// Classifies a Rust type-text or self-receiver token into one of three
// ownership flavors. Pure and text-only — no rustc, no extractor; works
// on the `ty_text` strings the extractor already produces.
//
//   move    — top-level type is owned (`T`, `Box<T>`, `Vec<U>`, `Self`,
//             `impl Trait`, `Arc<X>`, etc.). Caller transfers ownership.
//   shared  — top-level `&T` / `&'a T`. Caller retains ownership.
//   mut     — top-level `&mut T` / `&'a mut T`. Exclusive write borrow.
//
// Top-level only by design: `Vec<&T>` is a move, because the parameter
// itself is owned even though its contents are borrows. Trying to flatten
// the inner shape into one flavor produces noise without insight.

export type BorrowFlavor = 'move' | 'shared' | 'mut';

export function borrowFlavor(tyText: string): BorrowFlavor {
  const trimmed = tyText.trimStart();
  if (!trimmed.startsWith('&')) return 'move';
  // Skip past `&` and any optional lifetime annotation (`'a`, `'static`).
  let rest = trimmed.slice(1).trimStart();
  if (rest.startsWith("'")) {
    // Lifetime runs until whitespace or punctuation. Anything past that
    // restarts the head/keyword check.
    const cut = rest.search(/[\s>),]/);
    rest = cut === -1 ? '' : rest.slice(cut).trimStart();
  }
  // Match the keyword `mut` only — a type name like `MutableThing` must
  // not be mistaken for the keyword. The check accepts `mut` followed by
  // whitespace or end-of-string; identifier continuation (letters/digits)
  // means we're inside a type name, not the keyword.
  if (rest.startsWith('mut')) {
    const after = rest[3];
    if (after === undefined || /\s/.test(after)) return 'mut';
  }
  return 'shared';
}
