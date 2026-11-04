/**
 * Keyword search (BM25) - works with no AI at all, and catches exact terms that embeddings
 * miss: error codes ("E-104"), part numbers, menu names, settings.
 */

const STOP = new Set(
  `a an the and or but if then else of to in on at by for with from into onto about as is are was were be been being
   it its this that these those there here i you he she we they me my your our their his her them us do does did done
   can could should would will shall may might must have has had not no yes so than too very just also only what which
   who whom whose when where why how all any each both few more most other some such own same once again further over
   under up down out off above below between through during before after while until please`.split(/\s+/),
);

/**
 * Words that describe the support conversation rather than the product
 * ("the customer asks how long...") - ignored in queries only, never in the manuals.
 */
const QUERY_NOISE = /\b(how (long|many|much|often|far)|customers?|clients?|caller|agents?|someone|anyone|help|need|needs|want|wants|know|tell|explain|question|issue|problem)\b/gi;
export const cleanQuery = (q) => String(q || '').replace(QUERY_NOISE, ' ');

/** Light English stemmer: enough to match "resetting"/"resets"/"reset", "lights"/"light". */
export function stem(w) {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('ing') && w.length > 5) {
    w = w.slice(0, -3);
    return /(.)\1$/.test(w) && !/(ll|ss)$/.test(w) ? w.slice(0, -1) : w;
  }
  if (w.endsWith('ed') && w.length > 4) {
    w = w.slice(0, -2);
    return /(.)\1$/.test(w) && !/(ll|ss)$/.test(w) ? w.slice(0, -1) : w;
  }
  if (w.endsWith('es') && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  const out = [];
  const raw = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // keep codes like e-104 / 802.11ax / v2.1 together as well as split
    .match(/[\p{L}\p{N}]+(?:[-.][\p{L}\p{N}]+)*/gu);
  if (!raw) return out;
  for (const tok of raw) {
    if (/[-.]/.test(tok) && /\d/.test(tok)) out.push(tok.replace(/[-.]/g, ''));
    for (const part of tok.split(/[-.]/)) {
      if (!part || STOP.has(part) || (part.length < 2 && !/\d/.test(part))) continue;
      out.push(stem(part));
    }
  }
  return out;
}

export function createBm25(docs, { k1 = 1.2, b = 0.75 } = {}) {
  // docs: [{ id, text, boost?: string }] - `boost` (title/section) is counted twice
  const tf = [];
  const df = new Map();
  let totalLen = 0;
  for (const d of docs) {
    const toks = tokenize(d.text);
    if (d.boost) {
      const bt = tokenize(d.boost);
      toks.push(...bt, ...bt);
    }
    const m = new Map();
    for (const t of toks) m.set(t, (m.get(t) || 0) + 1);
    for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1);
    tf.push({ m, len: toks.length });
    totalLen += toks.length;
  }
  const N = docs.length;
  const avg = totalLen / Math.max(1, N);
  const idf = (t) => {
    const n = df.get(t) || 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };

  return {
    size: N,
    /** returns [{ index, score, coverage }] sorted desc; coverage = share of distinct query terms found */
    search(query, { limit = 20, filter } = {}) {
      const terms = [...new Set(tokenize(cleanQuery(query)))];
      if (!terms.length) return [];
      // Each query term may match several index terms: itself, or (if unknown) words it is a prefix of
      // ("admin" -> "administrator", "config" -> "configuration").
      const groups = terms.map((t) => {
        if (df.has(t) || t.length < 4 || /\d/.test(t)) return { weight: idf(t), alts: [t] };
        const alts = [...df.keys()].filter((v) => v.length > t.length && v.startsWith(t)).slice(0, 5);
        return { weight: alts.length ? Math.max(...alts.map(idf)) : idf(t), alts: alts.length ? alts : [t] };
      });
      const totalW = groups.reduce((a, g) => a + g.weight, 0) || 1;
      const res = [];
      for (let i = 0; i < N; i++) {
        if (filter && !filter(i)) continue;
        const { m, len } = tf[i];
        let s = 0;
        let hitW = 0;
        for (const g of groups) {
          let f = 0;
          for (const t of g.alts) f += m.get(t) || 0;
          if (!f) continue;
          hitW += g.weight;
          s += g.weight * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avg)));
        }
        if (s > 0) res.push({ index: i, score: s, coverage: hitW / totalW });
      }
      res.sort((a, z) => z.score - a.score);
      return res.slice(0, limit);
    },
  };
}
