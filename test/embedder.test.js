import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedder, normalize } from '../src/embed/embedder.js';
import { AIError, ERROR_KINDS } from '../src/ai/errors.js';
import { fakeEmbedProvider, DIMS } from './helpers.js';

const noSleep = async () => {};
const err = (kind, extra = {}) => new AIError(kind, { kind, ...extra });

function make({ a = {}, b = {}, ...opts } = {}) {
  const callsA = [];
  const callsB = [];
  const embedder = createEmbedder({
    chain: 'fake:one,fake2:two',
    providers: { fake: fakeEmbedProvider({ ...a, calls: callsA }), fake2: fakeEmbedProvider({ ...b, calls: callsB }) },
    dims: DIMS,
    batchSize: 10,
    sleepImpl: noSleep,
    ...opts,
  });
  return { embedder, callsA, callsB };
}

const texts = Array.from({ length: 25 }, (_, i) => `chunk ${i} about pumps`);

test('normalize returns unit vectors', () => {
  const v = normalize([3, 4]);
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6);
});

test('embeds in batches with the first model', async () => {
  const { embedder, callsA, callsB } = make();
  const r = await embedder.embedDocuments(texts);
  assert.equal(r.model, 'fake:one');
  assert.equal(r.vectors.filter(Boolean).length, 25);
  assert.deepEqual(callsA.map((c) => c.n), [10, 10, 5]);
  assert.equal(callsB.length, 0);
});

test('rate limits are retried on the same model (honouring Retry-After)', async () => {
  const waits = [];
  const { embedder, callsA } = make({
    a: { fail: ({ call }) => (call === 2 ? err(ERROR_KINDS.rate_limit, { retryAfterMs: 1234 }) : null) },
    onEvent: (e) => e.type === 'retry' && waits.push(e.waitMs),
  });
  const r = await embedder.embedDocuments(texts);
  assert.equal(r.model, 'fake:one');
  assert.equal(r.vectors.filter(Boolean).length, 25);
  assert.deepEqual(waits, [1234]);
  assert.equal(callsA.length, 4);
});

test('switches to the next model when the first fails before producing anything', async () => {
  const { embedder, callsB } = make({ a: { fail: () => err(ERROR_KINDS.auth) } });
  const r = await embedder.embedDocuments(texts);
  assert.equal(r.model, 'fake2:two');
  assert.equal(r.vectors.filter(Boolean).length, 25);
  assert.equal(callsB.length, 3);
});

test('a failure half-way keeps the vectors and the model (resumable), never mixes models', async () => {
  const { embedder, callsB } = make({ a: { fail: ({ call }) => (call >= 2 ? err(ERROR_KINDS.quota) : null) } });
  const r = await embedder.embedDocuments(texts);
  assert.equal(r.model, 'fake:one');
  assert.equal(r.vectors.filter(Boolean).length, 10);
  assert.ok(r.error);
  assert.equal(callsB.length, 0, 'second model must not be used for the same document');

  // resume with the same model once the quota is back
  const { embedder: e2 } = make();
  const r2 = await e2.embedDocuments(texts, { model: 'fake:one', existing: r.vectors });
  assert.equal(r2.vectors.filter(Boolean).length, 25);
  assert.equal(r2.vectors[0], r.vectors[0], 'existing vectors are kept');
});

test('query embedding: cached, and returns null (keyword fallback) when the model is down', async () => {
  const { embedder, callsA } = make();
  const v1 = await embedder.embedQuery('reset', 'fake:one');
  const v2 = await embedder.embedQuery('reset', 'fake:one');
  assert.equal(v1, v2);
  assert.equal(callsA.length, 1);
  assert.equal(callsA[0].task, 'query');

  const { embedder: down } = make({ a: { fail: () => err(ERROR_KINDS.overloaded) } });
  assert.equal(await down.embedQuery('reset', 'fake:one'), null);
  assert.equal(await down.embedQuery('unknown model', 'nope:x'), null);
});

test('no configured provider -> error result, no throw', async () => {
  const embedder = createEmbedder({ chain: 'fake:one', providers: { fake: { configured: false } }, dims: DIMS });
  assert.equal(embedder.configured, false);
  const r = await embedder.embedDocuments(['a']);
  assert.equal(r.model, null);
  assert.match(r.error.message, /no embedding provider/);
});
