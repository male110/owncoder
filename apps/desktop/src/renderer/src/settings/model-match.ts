/** Subsequence fuzzy match: query chars appear in order within haystack. */
export function fuzzyMatchModel(name: string, id: string, query: string): boolean {
  const targets = [name.toLowerCase(), id.toLowerCase()];
  return targets.some((text) => {
    let qi = 0;
    for (let i = 0; i < text.length && qi < query.length; i++) {
      if (text[i] === query[qi]) qi++;
    }
    return qi === query.length;
  });
}
