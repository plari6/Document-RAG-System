import { createBm25 } from './bm25.js';

/**
 * Hybrid retrieval: BM25 keywords + embedding similarity.
 * Keywords catch exact codes and part numbers ("E-301", "CX-9917"); embeddings catch paraphrases
 * ("wifi keeps dropping" -> "Wireless connection is unstable").
 *
 * Fusion is a convex combination of normalised scores, not Reciprocal Rank Fusion: with RRF a
 * passage that is the only exact match for a rare error code (rank 1 in keywords, unranked in
 * vectors) loses to passages that are merely "okay" in both lists. Here the keyword score is
 * relative to the best keyword hit and the cosine is min-max scaled over the documents in scope.
 */

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Load every chunk of the library into one in-memory index. */
export async function buildIndex(library) {
  const entries = [];
  for (const doc of library.docs) {
    const chunks = await library.chunks(doc.id);
    const vectors = await library.vectors(doc.id);
    chunks.forEach((chunk, i) => entries.push({ doc, chunk, vector: vectors[i] || null, model: doc.embed?.model || null }));
  }
  const bm25 = createBm25(entries.map((e) => ({ text: e.chunk.text, boost: `${e.doc.title} ${e.chunk.section || ''}` })));
  return { entries, bm25, generation: library.generation };
}

/** Keep an index cached per library and rebuild only after ingest/remove. */
export function createIndexCache(library) {
  let cached = null;
  return async () => {
    if (!cached || cached.generation !== library.generation) cached = await buildIndex(library);
    return cached;
  };
}

/**
 * @param alpha weight of the embedding score (0 = keywords only, 1 = vectors only)
 * @returns { hits: [{ entry, score, bm25, coverage, cosine }], mode: 'hybrid'|'keyword'|'vector', degraded: string[] }
 */
export async function retrieve(index, embedder, query, { k = 6, docIds, pool = 50, alpha = 0.5, signal } = {}) {
  const allowed = docIds?.length ? new Set(docIds) : null;
  const inScope = (i) => !allowed || allowed.has(index.entries[i].doc.id);

  const kw = index.bm25.search(query, { limit: pool, filter: allowed ? inScope : undefined });
  const maxBm25 = kw[0]?.score || 1;
  const cand = new Map(); // entry index -> hit
  const hit = (i) => {
    if (!cand.has(i)) cand.set(i, { index: i, entry: index.entries[i], score: 0, bm25: 0, coverage: 0, cosine: null, kwNorm: 0, vecNorm: null });
    return cand.get(i);
  };
  for (const r of kw) Object.assign(hit(r.index), { bm25: r.score, coverage: r.coverage, kwNorm: r.score / maxBm25 });

  // Embedding search, one pass per embedding model used by the documents in scope.
  const models = new Set();
  index.entries.forEach((e, i) => e.vector && e.model && inScope(i) && models.add(e.model));
  const degraded = [];
  let vectorUsed = false;
  if (embedder) {
    for (const model of models) {
      const q = await embedder.embedQuery(query, model, { signal });
      if (!q) {
        degraded.push(model);
        continue;
      }
      vectorUsed = true;
      const scored = [];
      index.entries.forEach((e, i) => {
        if (e.model !== model || !e.vector || !inScope(i) || e.vector.length !== q.length) return;
        scored.push({ i, s: dot(q, e.vector) });
      });
      if (!scored.length) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (const r of scored) (lo = Math.min(lo, r.s)), (hi = Math.max(hi, r.s));
      const span = hi - lo || 1;
      const byI = new Map(scored.map((r) => [r.i, r]));
      // vector candidates: top `pool` by cosine
      scored.sort((a, z) => z.s - a.s);
      for (const r of scored.slice(0, pool)) hit(r.i);
      // every candidate (including keyword-only ones) gets its cosine
      for (const h of cand.values()) {
        const r = byI.get(h.index);
        if (r) Object.assign(h, { cosine: r.s, vecNorm: (r.s - lo) / span });
      }
    }
  }

  for (const h of cand.values()) {
    // Entries without a vector (keyword-only document, or its model is down) are scored on keywords alone.
    h.score = vectorUsed && h.vecNorm != null ? (1 - alpha) * h.kwNorm + alpha * h.vecNorm : h.kwNorm;
  }
  const hits = [...cand.values()].sort((a, z) => z.score - a.score).slice(0, k);
  const mode = vectorUsed ? (kw.length ? 'hybrid' : 'vector') : 'keyword';
  return { hits, mode, degraded };
}
