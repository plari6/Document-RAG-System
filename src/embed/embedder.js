import { AIError, ERROR_KINDS, fetchFailure, kindFromStatus, parseRetryAfter, readBody, shortMessage } from '../ai/errors.js';
import { parseChain } from '../ai/chain.js';

/**
 * Embeddings with a fallback chain (Gemini embedding models -> OpenAI-compatible, e.g. Ollama).
 *
 * Vectors from different models are not comparable, so the rules differ from text generation:
 *  - ingest: a document is embedded with the first model that works; if a model fails before any
 *    vector of that document was produced, the next model is tried. If it fails half-way, the
 *    remaining chunks are left without vectors (keyword search still finds them) and
 *    `doc-rag embed` resumes later with the same model.
 *  - query: the question is embedded with the model each document was indexed with. If that
 *    model is down, those documents are searched by keywords only (never a crash).
 */

export const DEFAULT_EMBED_CHAIN = ['gemini:gemini-embedding-001', 'gemini:gemini-embedding-2'];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function normalize(vec) {
  const v = Float32Array.from(vec);
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function geminiEmbedProvider({ apiKey, fetchImpl, baseURL = GEMINI_BASE }) {
  return {
    name: 'gemini',
    configured: Boolean(apiKey),
    maxBatch: 100,
    async embed({ model, texts, task, dims, timeoutMs, signal }) {
      if (!apiKey) throw new AIError('GEMINI_API_KEY is not set', { kind: ERROR_KINDS.auth, provider: 'gemini', model });
      const taskType = task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
      const body = {
        requests: texts.map((t) => ({
          model: `models/${model}`,
          content: { parts: [{ text: t }] },
          taskType,
          ...(dims ? { outputDimensionality: dims } : {}),
        })),
      };
      const timeout = AbortSignal.timeout(timeoutMs);
      let res;
      try {
        res = await fetchImpl(`${baseURL}/models/${encodeURIComponent(model)}:batchEmbedContents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        throw fetchFailure(err, { provider: 'gemini', model, callerSignal: signal });
      }
      const payload = await readBody(res).catch((err) => {
        throw fetchFailure(err, { provider: 'gemini', model, callerSignal: signal });
      });
      if (!res.ok) {
        throw new AIError(`gemini ${res.status}: ${shortMessage(payload.json, payload.text)}`, {
          kind: kindFromStatus(res.status, payload.text),
          status: res.status,
          retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after'), payload.json),
          provider: 'gemini',
          model,
        });
      }
      const list = payload.json?.embeddings;
      if (!Array.isArray(list) || list.length !== texts.length || !list.every((e) => e?.values?.length)) {
        throw new AIError('gemini returned malformed embeddings', { kind: ERROR_KINDS.bad_output, provider: 'gemini', model });
      }
      return list.map((e) => e.values);
    },
  };
}

function openAIEmbedProvider({ name, apiKey, baseURL, requiresKey = true, fetchImpl }) {
  const root = baseURL.replace(/\/+$/, '');
  return {
    name,
    configured: !requiresKey || Boolean(apiKey),
    maxBatch: 64,
    async embed({ model, texts, dims, timeoutMs, signal }) {
      const timeout = AbortSignal.timeout(timeoutMs);
      let res;
      try {
        res = await fetchImpl(`${root}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, input: texts, ...(dims && name !== 'ollama' ? { dimensions: dims } : {}) }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        throw fetchFailure(err, { provider: name, model, callerSignal: signal });
      }
      const payload = await readBody(res).catch((err) => {
        throw fetchFailure(err, { provider: name, model, callerSignal: signal });
      });
      if (!res.ok) {
        throw new AIError(`${name} ${res.status}: ${shortMessage(payload.json, payload.text)}`, {
          kind: kindFromStatus(res.status, payload.text),
          status: res.status,
          retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after'), payload.json),
          provider: name,
          model,
        });
      }
      const data = payload.json?.data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new AIError(`${name} returned malformed embeddings`, { kind: ERROR_KINDS.bad_output, provider: name, model });
      }
      return data.sort((a, z) => (a.index ?? 0) - (z.index ?? 0)).map((d) => d.embedding);
    },
  };
}

export function createEmbedProvidersFromEnv(env = process.env, fetchImpl = fetch) {
  const p = {
    gemini: geminiEmbedProvider({ apiKey: env.GEMINI_API_KEY, fetchImpl }),
    nvidia: openAIEmbedProvider({ name: 'nvidia', apiKey: env.NVIDIA_API_KEY, baseURL: 'https://integrate.api.nvidia.com/v1', fetchImpl }),
    openai: openAIEmbedProvider({ name: 'openai', apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', fetchImpl }),
    ollama: openAIEmbedProvider({ name: 'ollama', baseURL: env.OLLAMA_BASE_URL || 'http://localhost:11434/v1', requiresKey: false, fetchImpl }),
  };
  if (!env.OLLAMA_BASE_URL) p.ollama.configured = false;
  return p;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new AIError('aborted', { kind: ERROR_KINDS.aborted }))), { once: true });
  });

/** Errors that mean "this model will not work today" -> switch model. */
const SWITCH = new Set([ERROR_KINDS.auth, ERROR_KINDS.not_found, ERROR_KINDS.quota, ERROR_KINDS.bad_request]);

export function createEmbedder({
  chain = DEFAULT_EMBED_CHAIN,
  providers,
  dims = 768,
  batchSize = 50,
  timeoutMs = 30_000,
  queryTimeoutMs = 8_000,
  maxRetries = 4,
  maxWaitMs = 65_000,
  onEvent = () => {},
  sleepImpl = sleep,
} = {}) {
  const targets = parseChain(chain).map((t) => ({ ...t, id: `${t.provider}:${t.model}`, client: providers[t.provider] }));
  const queryCache = new Map(); // `${id}\n${text}` -> Float32Array
  const down = new Map(); // id -> until (ms) for query-time failures

  const usable = () => targets.filter((t) => t.client?.configured);
  const byId = (id) => targets.find((t) => t.id === id) || (() => {
    const [t] = parseChain([id]);
    const client = providers[t.provider];
    return client ? { ...t, id, client } : null;
  })();

  async function callWithRetry(target, texts, task, { signal, onWait } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const vecs = await target.client.embed({ model: target.model, texts, task, dims, timeoutMs, signal });
        return vecs.map(normalize);
      } catch (err) {
        if (err.kind === ERROR_KINDS.aborted || SWITCH.has(err.kind) || attempt >= maxRetries) throw err;
        // rate limit / overloaded / timeout / network: wait and retry the same model (batch work can wait)
        const wait = Math.min(maxWaitMs, err.retryAfterMs || (err.kind === ERROR_KINDS.rate_limit ? 20_000 : 2_000 * 2 ** attempt));
        onEvent({ type: 'retry', target: target.id, kind: err.kind, waitMs: wait, attempt: attempt + 1 });
        onWait?.(wait, err);
        await sleepImpl(wait, signal);
      }
    }
  }

  return {
    get configured() {
      return usable().length > 0;
    },
    get chain() {
      return targets.map((t) => ({ id: t.id, configured: Boolean(t.client?.configured) }));
    },
    dims,

    /**
     * Embed document chunks. `existing` (optional) is the array of vectors already stored (null = missing),
     * `model` forces the model (resume). Returns { model, vectors, error? } - vectors[i] is null when missing.
     */
    async embedDocuments(texts, { model, existing, onProgress, onWait, signal } = {}) {
      const vectors = existing ? existing.slice() : texts.map(() => null);
      const todo = vectors.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
      if (!todo.length) return { model, vectors };
      const candidates = model ? [byId(model)].filter(Boolean) : usable();
      if (!candidates.length) {
        return { model: null, vectors, error: new AIError(model ? `embedding model ${model} is not configured` : 'no embedding provider configured (set GEMINI_API_KEY)', { kind: ERROR_KINDS.auth }) };
      }
      let lastErr;
      for (const target of candidates) {
        const size = Math.min(batchSize, target.client.maxBatch || batchSize);
        let produced = 0;
        try {
          for (let s = 0; s < todo.length; s += size) {
            const idx = todo.slice(s, s + size);
            const vecs = await callWithRetry(target, idx.map((i) => texts[i]), 'document', { signal, onWait });
            idx.forEach((i, j) => (vectors[i] = vecs[j]));
            produced += idx.length;
            onProgress?.({ done: vectors.filter(Boolean).length, total: texts.length, model: target.id });
          }
          return { model: target.id, vectors };
        } catch (err) {
          lastErr = err;
          onEvent({ type: 'failure', target: target.id, kind: err.kind, message: err.message });
          if (err.kind === ERROR_KINDS.aborted) return { model: produced ? target.id : model || null, vectors, error: err };
          // Partly embedded with this model (or a forced model): keep what we have, resume later with the same model.
          if (produced || existing?.some(Boolean) || model) return { model: target.id, vectors, error: err };
        }
      }
      return { model: null, vectors, error: lastErr };
    },

    /** Embed a search query with a specific model. Returns Float32Array or null (degrade to keywords). */
    async embedQuery(text, modelId, { signal } = {}) {
      const key = `${modelId}\n${text}`;
      if (queryCache.has(key)) return queryCache.get(key);
      if ((down.get(modelId) || 0) > Date.now()) return null;
      const target = byId(modelId);
      if (!target?.client?.configured) return null;
      try {
        const [vec] = (await target.client.embed({ model: target.model, texts: [text], task: 'query', dims, timeoutMs: queryTimeoutMs, signal })).map(normalize);
        if (queryCache.size > 500) queryCache.delete(queryCache.keys().next().value);
        queryCache.set(key, vec);
        return vec;
      } catch (err) {
        const cool = SWITCH.has(err.kind) ? 10 * 60_000 : err.retryAfterMs || 30_000;
        down.set(modelId, Date.now() + Math.min(cool, 60 * 60_000));
        onEvent({ type: 'failure', target: modelId, kind: err.kind, message: err.message, query: true });
        return null;
      }
    },
  };
}

export function createEmbedderFromEnv(env = process.env, { fetchImpl = fetch, onEvent, providers, simulate = [] } = {}) {
  let all = providers || createEmbedProvidersFromEnv(env, fetchImpl);
  const downSet = new Set(simulate.map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (downSet.size) {
    all = Object.fromEntries(
      Object.entries(all).map(([k, p]) => [
        k,
        downSet.has(k)
          ? { ...p, embed: async ({ model }) => { throw new AIError(`${k} 503: overloaded (simulated)`, { kind: ERROR_KINDS.overloaded, status: 503, provider: k, model }); } }
          : p,
      ]),
    );
  }
  return createEmbedder({
    chain: env.EMBED_CHAIN || DEFAULT_EMBED_CHAIN,
    providers: all,
    dims: Number(env.EMBED_DIMS) || 768,
    batchSize: Number(env.EMBED_BATCH_SIZE) || 50,
    maxRetries: downSet.size ? 0 : 4,
    onEvent,
  });
}
