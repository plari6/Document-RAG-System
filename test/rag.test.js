import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ingestFile, embedDocument } from '../src/ingest.js';
import { parseAnswer } from '../src/rag/prompts.js';
import { extractiveAnswer } from '../src/rag/engine.js';
import { openLibrary } from '../src/store/library.js';
import { AIError, ERROR_KINDS } from '../src/ai/errors.js';
import { tempDir, samplePdf, testApp, overloaded } from './helpers.js';

let tmp;
let pdf;
before(async () => {
  tmp = await tempDir();
  pdf = await samplePdf(tmp.dir);
});
after(() => tmp.cleanup());

const fresh = async (opts) => {
  const sub = await tempDir();
  const app = await testApp(sub.dir, opts);
  return { app, cleanup: sub.cleanup };
};

test('ingest: chunks + embeddings stored, re-ingest of the same file is skipped', async () => {
  const { app, cleanup } = await fresh();
  try {
    const r = await ingestFile(app.library, app.embedder, pdf, {});
    assert.equal(r.status, 'added');
    assert.equal(r.doc.id, 'netpro-x200-manual');
    assert.equal(r.doc.pages, 14);
    assert.ok(r.doc.chunks > 20);
    assert.equal(r.doc.embed.model, 'fake:embed-a');
    assert.equal(r.doc.embed.done, r.doc.chunks);
    const again = await ingestFile(app.library, app.embedder, pdf, {});
    assert.equal(again.status, 'unchanged');

    // persisted: a new process sees the same library and vectors
    const lib2 = await openLibrary(app.library.dir);
    assert.equal(lib2.docs.length, 1);
    const vecs = await lib2.vectors('netpro-x200-manual');
    assert.equal(vecs.filter(Boolean).length, r.doc.chunks);
  } finally {
    await cleanup();
  }
});

test('ask: grounded answer with valid citations and page numbers', async () => {
  const { app, cleanup } = await fresh();
  try {
    await ingestFile(app.library, app.embedder, pdf, {});
    const r = await app.rag.answer('How do I factory reset with the RESET button?');
    assert.equal(r.source, 'ai');
    assert.equal(r.status, 'answered');
    assert.equal(r.retrieval.mode, 'hybrid');
    assert.ok(r.citations.length >= 1);
    assert.ok(!r.citations.includes(99), 'citations to non-existent excerpts are dropped');
    // the reset procedure (p. 10) is retrieved; the answer cites it or the RESET button description (p. 4)
    assert.ok(r.sources.slice(0, 3).some((s) => s.pageStart === 10 && /Factory Reset/.test(s.section)));
    assert.ok([4, 10].includes(r.citedSources[0].pageStart));
    assert.match(r.answer, /\[\d\]/);
  } finally {
    await cleanup();
  }
});

test('customer style removes [n] markers but keeps citations', async () => {
  const { app, cleanup } = await fresh();
  try {
    await ingestFile(app.library, app.embedder, pdf, {});
    const r = await app.rag.answer('What is the warranty period in the European Union?', { style: 'customer' });
    assert.doesNotMatch(r.answer, /\[\d\]/);
    assert.ok(r.citedSources.some((s) => s.pageStart === 13));
  } finally {
    await cleanup();
  }
});

test('LLM failover: first model overloaded -> second model answers', async () => {
  const { app, cleanup } = await fresh({ llm: { fail: overloaded() }, llm2: {} });
  try {
    await ingestFile(app.library, app.embedder, pdf, {});
    const r = await app.rag.answer('What does error E-102 mean?');
    assert.equal(r.source, 'ai');
    assert.equal(r.model, 'fakellm2:model-b');
    assert.deepEqual(r.attempts.filter((a) => !a.ok).map((a) => a.kind), ['overloaded']);
    assert.ok(r.citedSources.some((s) => s.pageStart === 12));
  } finally {
    await cleanup();
  }
});

test('every LLM down -> extractive answer quoting the right page (never throws)', async () => {
  const { app, cleanup } = await fresh({ llm: { fail: overloaded() }, llm2: { fail: overloaded('fakellm2') } });
  try {
    await ingestFile(app.library, app.embedder, pdf, {});
    const r = await app.rag.answer('The customer forgot the administrator password');
    assert.equal(r.source, 'extractive');
    assert.equal(r.status, 'partial');
    assert.match(r.answer, /cannot be recovered/);
    assert.equal(r.citedSources[0].pageStart, 11);
  } finally {
    await cleanup();
  }
});

test('unanswerable question -> unknown, and it is logged as a gap', async () => {
  const { app, cleanup } = await fresh();
  try {
    await ingestFile(app.library, app.embedder, pdf, {});
    const r = await app.rag.answer('Is there a Zigbee hub?');
    assert.equal(r.status, 'unknown');
    const log = await app.library.queries();
    assert.equal(log.at(-1).status, 'unknown');
    assert.equal(log.at(-1).q, 'Is there a Zigbee hub?');
  } finally {
    await cleanup();
  }
});

test('noAi mode and no-match mode', async () => {
  const { app, cleanup } = await fresh();
  try {
    await ingestFile(app.library, app.embedder, pdf, {});
    const r = await app.rag.answer('E-301 firmware verification failed recovery', { noAi: true });
    assert.equal(r.source, 'extractive');
    assert.match(r.answer, /AI disabled/);
    assert.match(r.answer, /recovery/);
    const none = await app.rag.answer('qwertyuiop asdfghjkl', { noAi: true });
    assert.equal(none.status, 'unknown');
  } finally {
    await cleanup();
  }
});

test('embeddings down at query time -> keyword search, still answers', async () => {
  const sub = await tempDir();
  try {
    const app = await testApp(sub.dir);
    await ingestFile(app.library, app.embedder, pdf, {});
    const failing = await testApp(sub.dir, { embed: { fail: () => new AIError('down', { kind: ERROR_KINDS.overloaded }) } });
    const r = await failing.rag.answer('What does error E-102 mean?');
    assert.equal(r.retrieval.mode, 'keyword');
    assert.deepEqual(r.retrieval.degraded, ['fake:embed-a']);
    assert.equal(r.source, 'ai');
    assert.ok(r.citedSources.some((s) => s.pageStart === 12));
  } finally {
    await sub.cleanup();
  }
});

test('embedding quota mid-ingest -> partial index, "embed" resumes with the same model', async () => {
  const sub = await tempDir();
  try {
    let calls = 0;
    const quota = () => (++calls >= 2 ? new AIError('daily quota', { kind: ERROR_KINDS.quota }) : null);
    const app = await testApp(sub.dir, { env: { EMBED_BATCH_SIZE: '10' }, embed: { fail: quota } });
    const r = await ingestFile(app.library, app.embedder, pdf, {});
    assert.equal(r.embedding.done, 10);
    assert.ok(r.embedding.error);
    assert.equal(r.doc.embed.model, 'fake:embed-a');

    const later = await testApp(sub.dir, { env: { EMBED_BATCH_SIZE: '10' } });
    const res = await embedDocument(later.library, later.embedder, r.doc.id);
    assert.equal(res.done, r.doc.chunks);
    assert.equal(res.model, 'fake:embed-a');
  } finally {
    await sub.cleanup();
  }
});

test('multiple manuals: --doc filter, follow-up questions, updated file keeps its id', async () => {
  const { app, cleanup } = await fresh();
  try {
    await ingestFile(app.library, app.embedder, pdf, {});
    const txt = path.join(tmp.dir, 'pump-p100.txt');
    await writeFile(txt, '# AquaPump P100 Manual\n1 Maintenance\nClean the impeller filter every 3 months with warm water.\f2 Error Codes\nCode P-7 means the impeller is blocked. Turn the pump off and remove debris.');
    await ingestFile(app.library, app.embedder, txt, {});
    assert.equal(app.library.docs.length, 2);

    const only = await app.rag.search('error code meaning', { docs: ['aquapump'] });
    assert.ok(only.results.every((s) => s.docId === 'pump-p100'));
    await assert.rejects(app.rag.search('x', { docs: ['nope'] }), /No document matches/);

    // follow-up: "what about P-7" should keep the context of the previous question
    const r = await app.rag.answer('and what does it mean?', { history: [{ role: 'user', content: 'pump code P-7 impeller blocked' }, { role: 'assistant', content: '...' }] });
    assert.match(r.retrieval.query, /P-7/);
    assert.equal(r.sources[0].docId, 'pump-p100');

    await writeFile(txt, '# AquaPump P100 Manual\n1 Maintenance\nClean the impeller filter every 6 months.');
    const upd = await ingestFile(app.library, app.embedder, txt, {});
    assert.equal(upd.status, 'updated');
    assert.equal(upd.doc.id, 'pump-p100');
    assert.equal(app.library.docs.length, 2);
    const s = await app.rag.search('impeller filter months', { docs: ['pump-p100'] });
    assert.match(s.results[0].text, /6 months/);

    await app.library.remove('pump-p100');
    assert.equal(app.library.docs.length, 1);
  } finally {
    await cleanup();
  }
});

test('empty library gives a helpful error', async () => {
  const { app, cleanup } = await fresh();
  try {
    await assert.rejects(app.rag.answer('anything'), /library is empty/);
  } finally {
    await cleanup();
  }
});

test('parseAnswer: fenced JSON, prose around JSON, invalid citations removed', () => {
  const a = parseAnswer('```json\n{"answer":"Hold RESET 10 s [1][7].","status":"answered","citations":[1,7]}\n```', 3);
  assert.deepEqual(a.citations, [1]);
  assert.equal(a.answer, 'Hold RESET 10 s [1].');
  const b = parseAnswer('Sure! {"answer":"See [2]","status":"weird"} hope it helps', 3);
  assert.equal(b.status, 'answered');
  assert.deepEqual(b.citations, [2]);
  assert.throws(() => parseAnswer('no json here', 3));
  assert.throws(() => parseAnswer('{"answer":""}', 3));
});

test('extractiveAnswer refuses weak matches', () => {
  const src = (n, cov, text) => ({ n, keywordCoverage: cov, cosine: null, text, section: 'S', page: 'p. 1' });
  assert.equal(extractiveAnswer('zigbee hub support', [src(1, 0.2, 'Smart Connect moves devices.')]), null);
  const ok = extractiveAnswer('reset password', [src(1, 0.9, 'Perform a factory reset to clear the password.'), src(2, 0.1, 'x')]);
  assert.deepEqual(ok.citations, [1]);
});
