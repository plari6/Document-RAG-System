/**
 * Clean raw per-page PDF text before chunking:
 *  - Unicode normalisation (ligatures, non-breaking spaces, soft hyphens)
 *  - removal of running headers/footers and page numbers that repeat on most pages
 *  - de-hyphenation of words split across lines ("config-\nuration")
 */

const PAGE_NUMBER = /^\s*(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?\s*$/i;

export function normalizeText(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/­/g, '') // soft hyphen
    .replace(/[  -​  　]/g, ' ')
    .replace(/[‐‑‒–]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ ]{2,}/g, ' ');
}

/** Lines compared for boilerplate detection: digits collapsed so "page 3 of 9" == "page 4 of 9". */
const shape = (line) => line.trim().toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');

/**
 * Find lines that appear at the top or bottom of many pages (running headers/footers).
 * Only the first/last `edge` non-empty lines of each page are candidates, so body text that
 * happens to repeat (e.g. a warning) is kept.
 */
export function findBoilerplate(pages, { edge = 3, minShare = 0.4, minPages = 4 } = {}) {
  if (pages.length < minPages) return new Set();
  const counts = new Map();
  for (const p of pages) {
    const lines = p.text.split('\n').map((l) => l.trim()).filter(Boolean);
    // on short pages only the very first/last line can be a header/footer
    const e = Math.max(1, Math.min(edge, Math.floor(lines.length / 3)));
    const cand = new Set([...lines.slice(0, e), ...lines.slice(-e)].map(shape));
    for (const c of cand) counts.set(c, (counts.get(c) || 0) + 1);
  }
  const limit = Math.max(2, Math.ceil(pages.length * minShare));
  const out = new Set();
  for (const [k, n] of counts) if (n >= limit && k.length < 160) out.add(k);
  return out;
}

export function cleanPages(rawPages) {
  const pages = rawPages.map((p) => ({ page: p.page, text: normalizeText(p.text) }));
  const boiler = findBoilerplate(pages);
  return pages.map((p) => {
    const lines = p.text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !PAGE_NUMBER.test(l) && !boiler.has(shape(l)));
    // join "word-\ncontinuation" when the next line starts lowercase
    const text = lines.join('\n').replace(/([\p{L}])-\n(\p{Ll})/gu, '$1$2');
    return { page: p.page, text };
  });
}
