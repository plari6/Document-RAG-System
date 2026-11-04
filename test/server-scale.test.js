import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { ingestFile } from '../src/ingest.js';
import { buildPdf } from '../src/pdf/write-pdf.js';
import { tempDir, samplePdf, testApp } from './helpers.js';

let tmp;
let app;
let server;
let base;

before(async () => {
  tmp = await tempDir();
  app = await testApp(tmp.dir);
  await ingestFile(app.library, app.embedder, await samplePdf(tmp.dir), {});
  server = createServer(app, { apiKey: 'secret', rateLimitPerMin: 1000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await tmp.cleanup();
});

const auth = { 'x-api-key': 'secret', 'content-type': 'application/json' };

test('GET / serves the agent page and /health is public', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Manual search/);
  const h = await (await fetch(`${base}/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.documents, 1);
});

test('API key is required on /api/*', async () => {
  assert.equal((await fetch(`${base}/api/docs`)).status, 401);
  assert.equal((await fetch(`${base}/api/docs`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const ok = await fetch(`${base}/api/docs`, { headers: { authorization: 'Bearer secret' } });
  assert.equal(ok.status, 200);
  const { docs } = await ok.json();
  assert.equal(docs[0].id, 'netpro-x200-manual');
  assert.equal(docs[0].file, undefined, 'local file paths are not exposed');
});

test('GET /api/search and POST /api/ask', async () => {
  const s = await (await fetch(`${base}/api/search?q=${encodeURIComponent('E-401 USB storage')}&k=3`, { headers: auth })).json();
  assert.equal(s.results.length, 3);
  assert.equal(s.results[0].pageStart, 12);

  const res = await fetch(`${base}/api/ask`, { method: 'POST', headers: auth, body: JSON.stringify({ question: 'Which power adapter must I use?', style: 'customer' }) });
  assert.equal(res.status, 200);
  const a = await res.json();
  assert.equal(a.source, 'ai');
  assert.ok(a.citations.length >= 1);
  assert.ok(a.citations[0].snippet);
  assert.equal(a.citations[0].text, undefined);
});

test('bad requests get clear 4xx errors', async () => {
  assert.equal((await fetch(`${base}/api/ask`, { method: 'POST', headers: auth, body: '{bad' })).status, 400);
  assert.equal((await fetch(`${base}/api/ask`, { method: 'POST', headers: auth, body: '{}' })).status, 400);
  const nodoc = await fetch(`${base}/api/ask`, { method: 'POST', headers: auth, body: JSON.stringify({ question: 'x', docs: ['missing'] }) });
  assert.equal(nodoc.status, 400);
  assert.match((await nodoc.json()).error, /No document matches/);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('scale: a 200-page manual ingests in seconds and searches in milliseconds', async () => {
  const sub = await tempDir();
  try {
    const topics = ['pressure valve', 'conveyor belt', 'hydraulic pump', 'control panel', 'safety interlock', 'motor bearing', 'coolant system', 'sensor array'];
    const pages = Array.from({ length: 200 }, (_, i) => {
      const t = topics[i % topics.length];
      return [
        { text: `${i + 1} ${t.replace(/^./, (c) => c.toUpperCase())} procedure ${i + 1}`, size: 14, bold: true },
        ...Array.from({ length: 12 }, (_, j) => `Step ${j + 1}: inspect the ${t} unit ${i}-${j}, record torque values and verify the alignment marks before restarting the line.`),
        ...(i === 172 ? ['Calibration code CX-9917 resets the turbidity sensor offset to factory values.'] : []),
      ];
    });
    const file = path.join(sub.dir, 'big-manual.pdf');
    await writeFile(file, buildPdf(pages, { title: 'Plant Maintenance Manual', footer: (p) => `Plant Maintenance Manual - page ${p}` }));
    const big = await testApp(sub.dir);

    const t0 = Date.now();
    const r = await ingestFile(big.library, big.embedder, file, {});
    const ingestMs = Date.now() - t0;
    assert.equal(r.doc.pages, 200);
    assert.ok(r.doc.chunks >= 200, `chunks ${r.doc.chunks}`);
    assert.ok(ingestMs < 30_000, `ingest took ${ingestMs} ms`);

    await big.rag.search('warm up'); // build index once
    const t1 = Date.now();
    const s = await big.rag.search('turbidity sensor calibration code', { k: 3 });
    const searchMs = Date.now() - t1;
    assert.equal(s.results[0].pageStart, 173);
    assert.match(s.results[0].text, /CX-9917/);
    assert.ok(searchMs < 500, `search took ${searchMs} ms`);
  } finally {
    await sub.cleanup();
  }
});
