// Classifies a Rust type-text or self-receiver token into one of four
// ownership flavors. Pure and text-only — no rustc, no extractor; works
// on the `ty_text` strings the extractor already produces.
//
//   move    — top-level type is owned (`T`, `Box<T>`, `Vec<U>`, `Self`,
//             `impl Trait`, `Arc<X>`, etc.). Caller transfers ownership.
//   shared  — top-level `&T` / `&'a T`. Caller retains ownership.
//   mut     — top-level `&mut T` / `&'a mut T`. Exclusive write borrow.
//   raw     — top-level `*const T` / `*mut T`. Unsafe pointer territory;
//             no aliasing or lifetime guarantees.
//
// Top-level only by design: `Vec<&T>` is a move, because the parameter
// itself is owned even though its contents are borrows. Trying to flatten
// the inner shape into one flavor produces noise without insight.

export type BorrowFlavor = 'move' | 'shared' | 'mut' | 'raw';

export function borrowFlavor(tyText: string): BorrowFlavor {
  const trimmed = tyText.trimStart();
  // Raw pointers: `*const T` or `*mut T`. Word-boundary check on the
  // keyword so a hypothetical `*constant` (not valid Rust, but defensive)
  // doesn't get mistaken for the keyword form.
  if (trimmed.startsWith('*')) {
    const rest = trimmed.slice(1).trimStart();
    if (matchesKeyword(rest, 'const') || matchesKeyword(rest, 'mut')) return 'raw';
    // Standalone `*` without const/mut isn't valid Rust pointer syntax —
    // fall through and treat as a move so unknown shapes don't crash.
  }
  if (!trimmed.startsWith('&')) return 'move';
  // Skip past `&` and any optional lifetime annotation (`'a`, `'static`).
  let rest = trimmed.slice(1).trimStart();
  if (rest.startsWith("'")) {
    // Lifetime runs until whitespace or punctuation. Anything past that
    // restarts the head/keyword check.
    const cut = rest.search(/[\s>),]/);
    rest = cut === -1 ? '' : rest.slice(cut).trimStart();
  }
  if (matchesKeyword(rest, 'mut')) return 'mut';
  return 'shared';
}

function matchesKeyword(text: string, keyword: string): boolean {
  if (!text.startsWith(keyword)) return false;
  const after = text[keyword.length];
  // Keyword boundary: end of string or whitespace. Identifier continuation
  // (letter, digit, underscore) means we're inside a longer name like
  // `MutableThing` or `constants`, not the bare keyword.
  return after === undefined || /\s/.test(after);
}
