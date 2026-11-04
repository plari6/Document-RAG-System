import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildPdf } from '../src/pdf/write-pdf.js';
import { extractDocument } from '../src/pdf/extract.js';
import { expandPaths } from '../src/ingest.js';
import { tempDir, samplePdf } from './helpers.js';

test('PDF round trip: per-page text, title metadata, page count', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const file = path.join(dir, 'm.pdf');
    await writeFile(file, buildPdf([['Page one (alpha)'], ['Page two beta'], ['Page three gamma']], { title: 'Pump Manual' }));
    const d = await extractDocument(file);
    assert.equal(d.title, 'Pump Manual');
    assert.equal(d.totalPages, 3);
    assert.deepEqual(d.pages.map((p) => p.page), [1, 2, 3]);
    assert.match(d.pages[0].text, /Page one \(alpha\)/);
    assert.match(d.pages[2].text, /gamma/);
    assert.equal(d.sha256.length, 64);
  } finally {
    await cleanup();
  }
});

test('sample manual extracts 14 pages', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const d = await extractDocument(await samplePdf(dir));
    assert.equal(d.totalPages, 14);
    assert.equal(d.emptyPages, 0);
    assert.match(d.pages[9].text, /Factory Reset/);
  } finally {
    await cleanup();
  }
});

test('rejects fake PDFs and unsupported types; reads .txt pages split by form feed', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await writeFile(path.join(dir, 'bad.pdf'), 'hello');
    await assert.rejects(extractDocument(path.join(dir, 'bad.pdf')), /not a valid PDF/);
    await writeFile(path.join(dir, 'x.docx'), 'x');
    await assert.rejects(extractDocument(path.join(dir, 'x.docx')), /Unsupported/);
    await writeFile(path.join(dir, 'notes.txt'), '# Notes\nfirst\fsecond\fthird');
    const d = await extractDocument(path.join(dir, 'notes.txt'));
    assert.equal(d.totalPages, 3);
    assert.equal(d.title, 'Notes');
  } finally {
    await cleanup();
  }
});

test('expandPaths: folders, wildcards and dedupe', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await writeFile(path.join(dir, 'a.pdf'), '%PDF-');
    await writeFile(path.join(dir, 'b.txt'), 'x');
    await writeFile(path.join(dir, 'c.png'), 'x');
    const all = await expandPaths([dir, path.join(dir, 'a.pdf')]);
    assert.deepEqual(all.map((f) => path.basename(f)).sort(), ['a.pdf', 'b.txt']);
    const wild = await expandPaths([path.join(dir, '*.pdf')]);
    assert.deepEqual(wild.map((f) => path.basename(f)), ['a.pdf']);
    await assert.rejects(expandPaths([path.join(dir, 'missing.pdf')]), /Not found/);
  } finally {
    await cleanup();
  }
});
