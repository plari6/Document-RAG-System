import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AIError, ERROR_KINDS } from '../src/ai/errors.js';
import { tokenize } from '../src/search/bm25.js';
import { buildSampleManualPdf } from '../src/demo/sample-manual.js';
import { createApp } from '../src/app.js';

export const DIMS = 64;

/** Deterministic "embedding": hashed bag of words. Similar wording -> similar vectors. */
export function fakeVector(text) {
  const v = new Array(DIMS).fill(0);
  for (const t of tokenize(text)) {
    let h = 2166136261;
    for (const ch of t) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    v[Math.abs(h) % DIMS] += 1;
  }
  if (v.every((x) => x === 0)) v[0] = 1;
  return v;
}

export function fakeEmbedProvider({ fail, calls = [] } = {}) {
  return {
    name: 'fake',
    configured: true,
    maxBatch: 100,
    async embed({ model, texts, task }) {
      calls.push({ model, n: texts.length, task });
      if (fail) {
        const err = typeof fail === 'function' ? fail({ model, texts, task, call: calls.length }) : fail;
        if (err) throw err;
      }
      return texts.map(fakeVector);
    },
  };
}

/**
 * Fake LLM: answers from the excerpts it receives - cites the excerpt that contains the most
 * question words, or says "unknown" when none matches.
 */
export function fakeLlm({ fail = null, calls = [], raw } = {}) {
  return {
    name: 'fakellm',
    configured: true,
    async complete(req) {
      calls.push(req);
      if (fail) throw fail;
      if (raw) return { text: raw };
      const content = req.messages.at(-1).content;
      const question = content.split('Question:').pop().trim();
      const q = new Set(tokenize(question));
      const excerpts = [...content.matchAll(/^\[(\d+)\] [^\n]*\n([\s\S]*?)(?=\n\n---\n\n|\n\n===)/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
      let best = null;
      for (const e of excerpts) {
        const hits = tokenize(e.text).filter((t) => q.has(t)).length;
        if (!best || hits > best.hits) best = { ...e, hits };
      }
      if (!best || best.hits < 2) return { text: JSON.stringify({ answer: 'The manuals do not cover this.', status: 'unknown', citations: [] }) };
      const sentence = best.text.split('\n').find((l) => tokenize(l).some((t) => q.has(t))) || best.text;
      return { text: '```json\n' + JSON.stringify({ answer: `${sentence.trim()} [${best.n}]`, status: 'answered', citations: [best.n, 99] }) + '\n```' };
    },
  };
}

export const overloaded = (p = 'fakellm') => new AIError(`${p} 503: overloaded`, { kind: ERROR_KINDS.overloaded, status: 503, provider: p });

export async function tempDir(prefix = 'doc-rag-test-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function samplePdf(dir) {
  const file = path.join(dir, 'netpro-x200-manual.pdf');
  await writeFile(file, buildSampleManualPdf());
  return file;
}

/** App wired to fakes only (no network, no .env). */
export async function testApp(dir, { llm = {}, llm2, embed = {}, env = {} } = {}) {
  return createApp({
    library: path.join(dir, 'lib'),
    env: {
      AI_CHAIN: llm2 ? 'fakellm:model-a,fakellm2:model-b' : 'fakellm:model-a',
      EMBED_CHAIN: 'fake:embed-a,fake2:embed-b',
      EMBED_DIMS: String(DIMS),
      AI_HEDGE_MS: '0',
      AI_TIMEOUT_MS: '2000',
      ...env,
    },
    providers: { fakellm: fakeLlm(llm), ...(llm2 ? { fakellm2: fakeLlm(llm2) } : {}) },
    embedProviders: { fake: fakeEmbedProvider(embed), fake2: fakeEmbedProvider(embed.second || {}) },
  });
}
