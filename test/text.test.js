import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPages, normalizeText, findBoilerplate } from '../src/text/clean.js';
import { chunkPages, detectHeading, toBlocks } from '../src/text/chunk.js';
import { tokenize, stem, createBm25, cleanQuery } from '../src/search/bm25.js';

test('normalizeText fixes ligatures, soft hyphens and odd spaces', () => {
  assert.equal(normalizeText('conﬁgure the de­vice–now'), 'configure the device-now');
});

test('running headers, footers and page numbers are removed; body text is kept', () => {
  const pages = Array.from({ length: 6 }, (_, i) => ({
    page: i + 1,
    text: `ACME Manual v2\nBody text of page ${i + 1} about the pump.\nShared warning line\nPage ${i + 1} of 6`,
  }));
  pages[2].text = `ACME Manual v2\nShared warning line\nMore body\n3`;
  const boiler = findBoilerplate(pages);
  assert.ok(boiler.has('acme manual v#'));
  const clean = cleanPages(pages);
  for (const p of clean) {
    assert.ok(!/ACME Manual/.test(p.text), p.text);
    assert.ok(!/Page \d of 6/.test(p.text));
  }
  assert.match(clean[0].text, /Body text of page 1/);
});

test('words hyphenated across lines are joined', () => {
  const [p] = cleanPages([{ page: 1, text: 'Open the config-\nuration menu. Use Wi-\nFi only.' }]);
  assert.match(p.text, /configuration menu/);
  assert.match(p.text, /Wi-\nFi/); // capitalised continuation is kept as-is
});

test('detectHeading: numbered, keyword and all-caps headings; not steps or TOC lines', () => {
  assert.equal(detectHeading('4.2 Factory reset')?.level, 2);
  assert.equal(detectHeading('Chapter 3 Installation')?.level, 1);
  assert.equal(detectHeading('TROUBLESHOOTING')?.level, 1);
  assert.equal(detectHeading('1. Unplug the router and wait 30 seconds.'), null);
  assert.equal(detectHeading('4 Installation ........ 12'), null);
  assert.equal(detectHeading('The router restarts, which takes about two minutes.'), null);
});

test('toBlocks keeps list items separate and tags pages', () => {
  const blocks = toBlocks([{ page: 7, text: '5 Setup\nIntro line one\ncontinues here.\n1. First step\n2. Second step' }]);
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'para', 'para', 'para']);
  assert.ok(blocks.every((b) => b.page === 7));
});

test('chunkPages: sections, page ranges, size limit and overlap', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} explains a detail of the pump.`).join(' ');
  const pages = [
    { page: 1, text: '1 Safety\nKeep hands away from the impeller at all times.' },
    { page: 2, text: `2 Maintenance\n2.1 Cleaning\n${long}` },
    { page: 3, text: 'Continued maintenance text on page three.\n3 Warranty\nTwo years from purchase.' },
  ];
  const chunks = chunkPages(pages, { size: 500, overlap: 120 });
  assert.ok(chunks.length >= 4);
  for (const c of chunks) assert.ok(c.text.length <= 500 + 130, `chunk too long: ${c.text.length}`);
  assert.equal(chunks[0].section, '1 Safety');
  const cleaning = chunks.filter((c) => c.section === '2 Maintenance > 2.1 Cleaning');
  assert.ok(cleaning.length >= 3);
  // overlap: the next chunk starts with the end of the previous one
  const tailSentence = cleaning[0].text.split('. ').at(-1);
  assert.ok(cleaning[1].text.includes(tailSentence.slice(0, 30)));
  const last = chunks.at(-1);
  assert.equal(last.section, '3 Warranty');
  assert.equal(last.pageStart, 3);
  assert.ok(chunks.some((c) => c.pageStart === 2 && c.pageEnd === 3), 'a chunk spans pages 2-3');
});

test('tokenize: codes, versions and stemming', () => {
  const t = tokenize('Error E-104 on firmware v2.1 while resetting routers');
  for (const x of ['e104', '104', 'error', 'firmware', 'v21', 'reset', 'router']) assert.ok(t.includes(x), `${x} in ${t}`);
  assert.equal(stem('batteries'), 'battery');
  assert.equal(stem('stopped'), 'stop');
  assert.equal(stem('class'), 'class');
});

test('BM25 ranks the right passage, expands prefixes and ignores support-chat noise', () => {
  const idx = createBm25([
    { text: 'The administrator password cannot be recovered. Perform a factory reset.', boost: 'Forgot password' },
    { text: 'Connect the blue WAN port to the modem.', boost: 'Installation' },
    { text: 'Warranty is 2 years.', boost: 'Warranty' },
  ]);
  const [top] = idx.search('customer forgot admin password');
  assert.equal(top.index, 0);
  assert.ok(top.coverage > 0.9, `coverage ${top.coverage}`);
  assert.equal(idx.search('how long is the warranty')[0].index, 2);
  assert.equal(cleanQuery('How long is it').trim(), 'is it');
  assert.deepEqual(idx.search('zzz qqq'), []);
});
