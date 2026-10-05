/**
 * Grapheme helpers (emoji-safe length limits). Mirrors the frontend's
 * clampGraphemes (Intl.Segmenter) so unit-vs-grapheme mismatches can never
 * let emoji bypass a limit or get split mid-sequence server-side.
 * (Same cast pattern as rooms.service — the TS lib lacks Segmenter types.)
 */

const IntlWithSeg = Intl as unknown as {
  Segmenter?: new (
    locale: string,
    opts: { granularity: string },
  ) => { segment(s: string): Iterable<{ segment: string }> };
};

export function graphemeSlice(s: string, n: number): string {
  if (typeof IntlWithSeg.Segmenter === "function") {
    const seg = new IntlWithSeg.Segmenter("en", { granularity: "grapheme" });
    const parts = Array.from(seg.segment(s), (p) => p.segment);
    return parts.length > n ? parts.slice(0, n).join("") : s;
  }
  // Fallback (no Segmenter): code-point-safe slice, never split surrogates.
  return Array.from(s).slice(0, n).join("");
}

export function graphemeCount(s: string): number {
  if (typeof IntlWithSeg.Segmenter === "function") {
    const seg = new IntlWithSeg.Segmenter("en", { granularity: "grapheme" });
    return Array.from(seg.segment(s)).length;
  }
  return Array.from(s).length;
}
