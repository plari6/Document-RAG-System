import { createIndexCache, retrieve } from '../search/retrieve.js';
import { tokenize } from '../search/bm25.js';
import { buildContext, buildSystemPrompt, buildUserPrompt, pageLabel, parseAnswer } from './prompts.js';

const FOLLOW_UP = /\b(it|its|that|this|those|these|they|them|one|same|also|again|instead|what about|and if)\b/i;

/**
 * Minimum share of the question's keywords (IDF-weighted) a passage must contain to be quoted
 * by the no-AI fallback: the best passage needs 0.4, a second passage 0.5.
 */
const EXTRACTIVE_MIN_COVERAGE = 0.4;
const EXTRACTIVE_SECOND_COVERAGE = 0.5;
const EXTRACTIVE_MIN_COSINE = 0.72;
const QUOTE_CHARS = 700;

function toSource(hit, n) {
  const { doc, chunk } = hit.entry;
  return {
    n,
    docId: doc.id,
    title: doc.title,
    fileName: doc.fileName,
    section: chunk.section || '',
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    page: pageLabel(chunk),
    text: chunk.text,
    score: Number(hit.score.toFixed(5)),
    cosine: hit.cosine == null ? null : Number(hit.cosine.toFixed(4)),
    keywordCoverage: Number(hit.coverage.toFixed(3)),
  };
}

/** Cut at a sentence end near `max` characters. */
function quote(text, max = QUOTE_CHARS) {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return `${end > max * 0.5 ? cut.slice(0, end + 1) : cut} ...`;
}

/** Drop the heading lines a chunk starts with (they are shown in the citation already). */
const body = (s) => s.text.split('\n').filter((l, i, all) => !(s.section.includes(l.trim()) && i < all.length - 1)).join('\n');

/**
 * No-AI answer: quote the best-matching passage(s) verbatim, with citations.
 * Verbatim text is safer than stitched sentences - nothing can be taken out of context.
 */
export function extractiveAnswer(question, sources) {
  if (!tokenize(question).length || !sources.length) return null;
  const ok = (s, min) => s.keywordCoverage >= min || (s.cosine ?? 0) >= EXTRACTIVE_MIN_COSINE;
  const [first, ...rest] = sources;
  // the best-ranked passage must itself match; a second one is added only if it matches strongly
  if (!ok(first, EXTRACTIVE_MIN_COVERAGE)) return null;
  const picked = [first, ...rest.filter((s) => ok(s, EXTRACTIVE_SECOND_COVERAGE)).slice(0, 1)];
  const parts = picked.map((s) => `${s.section ? `${s.section.split(' > ').pop()} ` : ''}(${s.page}) [${s.n}]:\n${quote(body(s))}`);
  return { answer: parts.join('\n\n'), citations: picked.map((s) => s.n).sort((a, z) => a - z) };
}

export function createRag({ library, embedder, ai, org = '', defaultK = 6, onEvent = () => {} }) {
  const getIndex = createIndexCache(library);

  function resolveDocs(docs) {
    if (!docs || (Array.isArray(docs) && !docs.length)) return undefined;
    const ids = [];
    for (const ref of [].concat(docs)) {
      const d = library.findDoc(ref);
      if (!d) throw Object.assign(new Error(`No document matches "${ref}". Run "doc-rag list" to see ids.`), { code: 'NO_DOC' });
      ids.push(d.id);
    }
    return ids;
  }

  async function search(query, { k = defaultK, docs, signal } = {}) {
    if (!library.docs.length) throw Object.assign(new Error('The library is empty. Add manuals first: doc-rag ingest <file.pdf | folder>'), { code: 'EMPTY' });
    const index = await getIndex();
    const docIds = resolveDocs(docs);
    const r = await retrieve(index, embedder, query, { k, docIds, signal });
    return { results: r.hits.map((h, i) => toSource(h, i + 1)), mode: r.mode, degraded: r.degraded };
  }

  /**
   * Answer a question from the manuals. Never throws for AI problems: falls back to quoting the
   * best-matching passages, or to "not found".
   * Returns { answer, status, source: 'ai'|'extractive'|'none', citations, sources, model, attempts, retrieval, ms }
   */
  async function answer(question, { k = defaultK, docs, history = [], style = 'agent', noAi = false, signal } = {}) {
    const started = Date.now();
    const q = String(question || '').trim();
    if (!q) throw new Error('Question is empty');
    const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content;
    const searchQuery = lastUser && (q.split(/\s+/).length < 8 || FOLLOW_UP.test(q)) ? `${lastUser} ${q}` : q;
    const { results: sources, mode, degraded } = await search(searchQuery, { k, docs, signal });

    const base = { question: q, sources, retrieval: { mode, degraded, query: searchQuery }, attempts: [], model: null };
    const finish = async (out) => {
      const res = { ...base, ...out, citedSources: (out.citations || []).map((n) => sources[n - 1]).filter(Boolean), ms: Date.now() - started };
      await library.logQuery({
        q,
        status: res.status,
        source: res.source,
        model: res.model,
        docs: [...new Set(res.citedSources.map((s) => s.docId))],
        top: sources[0] ? `${sources[0].docId} ${sources[0].page}` : null,
        ms: res.ms,
      });
      return res;
    };

    if (!sources.length) {
      return finish({ answer: 'No matching passages were found in the indexed manuals.', status: 'unknown', source: 'none', citations: [] });
    }

    let aiError = null;
    if (!noAi && ai && ai.enabledCount > 0) {
      const maxN = sources.length;
      try {
        const r = await ai.generate({
          system: buildSystemPrompt({ org, style }),
          messages: [{ role: 'user', content: buildUserPrompt({ question: q, context: buildContext(sources), history: history.slice(-6) }) }],
          json: true,
          temperature: 0.1,
          maxTokens: 2048,
          signal,
          parse: (t) => parseAnswer(t, maxN),
        });
        let text = r.data.answer;
        if (style === 'customer') text = text.replace(/\s?\[\d{1,2}\]/g, '');
        return finish({ answer: text, status: r.data.status, source: 'ai', citations: r.data.citations, model: r.target, attempts: summarize(r.attempts) });
      } catch (err) {
        aiError = err;
        onEvent({ type: 'ai_down', message: err.message });
      }
    }

    const ex = extractiveAnswer(searchQuery, sources);
    const why = noAi ? 'AI disabled' : ai && ai.enabledCount > 0 ? 'AI unavailable' : 'no AI key configured';
    if (ex) {
      return finish({
        answer: `(${why} - most relevant passages from the manuals)\n${ex.answer}`,
        status: 'partial',
        source: 'extractive',
        citations: ex.citations,
        attempts: summarize(aiError?.attempts),
      });
    }
    return finish({
      answer: `I couldn't find this in the indexed manuals (${why}). Try other words, or check the sources below.`,
      status: 'unknown',
      source: 'none',
      citations: [],
      attempts: summarize(aiError?.attempts),
    });
  }

  return { search, answer, resolveDocs, getIndex };
}

function summarize(attempts = []) {
  return (attempts || []).map((a) => ({ target: a.target, ok: Boolean(a.ok), kind: a.kind || undefined, ms: a.ms }));
}
