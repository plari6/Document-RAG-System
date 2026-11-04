/**
 * Section-aware chunking with page tracking.
 *
 * Lines are grouped into paragraphs, headings ("4.2 Factory reset", "CHAPTER 3", "Appendix A")
 * start new sections, and paragraphs are packed into chunks of ~`size` characters that never
 * span two top-level sections. Every chunk keeps its page range and heading path so answers
 * can cite "p. 42, 4.2 Factory reset".
 */

const NUMBERED = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+(\p{Lu}.{1,90})$/u;
const KEYWORD = /^(chapter|section|appendix|part)\s+([\dA-Z]{1,4})\b[.:\-\s]*(.{0,90})$/i;
const BULLET = /^([-*•▪●>]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s+/u;

export function detectHeading(line) {
  const t = line.trim();
  if (t.length < 3 || t.length > 100) return null;
  if (/[.,;:]$/.test(t) && !KEYWORD.test(t)) return null;
  if (/(\.{3,}|…)\s*\d{1,4}$/.test(t)) return null; // table-of-contents line "4 Setup ..... 12"
  let m = t.match(KEYWORD);
  if (m) return { level: 1, text: t };
  m = t.match(NUMBERED);
  if (m) {
    // "1. Unplug the router" is a numbered step, not a heading: headings rarely start with a verb + article.
    const words = m[2].split(/\s+/);
    if (!m[1].includes('.') && words.length > 7) return null;
    if (/^\d+$/.test(m[1]) && Number(m[1]) > 40) return null;
    return { level: m[1].split('.').length, text: t };
  }
  // SHORT ALL-CAPS LINES ("TROUBLESHOOTING", "SAFETY INSTRUCTIONS")
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 4 && t.length <= 60 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
    return { level: 1, text: t };
  }
  return null;
}

/** Split pages into paragraphs and headings, each tagged with its page. */
export function toBlocks(pages) {
  const blocks = [];
  for (const { page, text } of pages) {
    let para = null;
    const flush = () => {
      if (para && para.text.trim()) blocks.push(para);
      para = null;
    };
    const lines = text.split('\n').map((x) => x.trim());
    const listNo = (s) => s?.match(/^(\d{1,2})[.)]\s/)?.[1];
    // nearest numbered item within 5 lines (wrapped list items span several lines)
    const nearNo = (from, step) => {
      for (let j = from, seen = 0; j >= 0 && j < lines.length && seen < 5; j += step, seen++) {
        const n = listNo(lines[j]);
        if (n) return Number(n);
      }
      return NaN;
    };
    lines.forEach((l, i) => {
      if (!l) {
        flush();
        return;
      }
      // "1. First step" next to "2. ..." (or after the previous number) is a list item, not a heading
      const n = Number(listNo(l));
      const inList = n && (nearNo(i - 1, -1) === n - 1 || nearNo(i + 1, 1) === n + 1);
      const h = inList ? null : detectHeading(l);
      if (h) {
        flush();
        blocks.push({ type: 'heading', level: h.level, text: h.text, page });
        return;
      }
      if (para && (BULLET.test(l) || /[.!?:]$/.test(para.text))) flush();
      if (!para) para = { type: 'para', text: l, page };
      else para.text += ' ' + l;
    });
    flush();
  }
  return blocks;
}

function splitSentences(text) {
  return text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((s) => s.trim()).filter(Boolean) || [text];
}

/** Break one oversized paragraph into pieces of at most `size` chars, on sentence boundaries. */
function splitLong(text, size) {
  const out = [];
  let cur = '';
  for (const s of splitSentences(text)) {
    if (s.length > size) {
      if (cur) out.push(cur), (cur = '');
      for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
      continue;
    }
    if (cur && cur.length + s.length + 1 > size) out.push(cur), (cur = '');
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

function tail(text, overlap) {
  if (!overlap) return '';
  const sentences = splitSentences(text);
  let out = '';
  for (let i = sentences.length - 1; i >= 0; i--) {
    const next = out ? `${sentences[i]} ${out}` : sentences[i];
    if (next.length > overlap) break;
    out = next;
  }
  return out;
}

export function chunkPages(pages, { size = 1000, overlap = 150, minSize = 200 } = {}) {
  const blocks = toBlocks(pages);
  const chunks = [];
  const path = []; // heading stack
  let cur = null;

  const section = () => path.map((h) => h.text).join(' > ');
  const flush = (carry = false) => {
    if (!cur || !cur.text.trim()) return;
    chunks.push({ i: chunks.length, section: cur.section, pageStart: cur.pageStart, pageEnd: cur.pageEnd, text: cur.text.trim() });
    const keep = carry ? tail(cur.text, overlap) : '';
    cur = keep ? { section: cur.section, pageStart: cur.pageEnd, pageEnd: cur.pageEnd, text: keep, carried: true } : null;
  };

  for (const b of blocks) {
    if (b.type === 'heading') {
      // A heading closes a chunk that has body text. Consecutive headings ("5 Wireless" + "5.1 Name")
      // stay together and the chunk takes the deepest section path.
      if (cur?.carried) cur = null;
      else if (cur?.hasBody) flush(false);
      while (path.length && path[path.length - 1].level >= b.level) path.pop();
      path.push(b);
      if (cur) cur.text += `\n${b.text}`;
      else cur = { pageStart: b.page, pageEnd: b.page, text: b.text };
      cur.section = section();
      continue;
    }
    for (const piece of b.text.length > size ? splitLong(b.text, size) : [b.text]) {
      if (cur?.hasBody && cur.text.length + piece.length + 1 > size && cur.text.length >= minSize) flush(true);
      if (!cur) cur = { section: section(), pageStart: b.page, pageEnd: b.page, text: piece };
      else {
        cur.text += `\n${piece}`;
        cur.pageEnd = b.page;
      }
      cur.carried = false;
      cur.hasBody = true;
    }
  }
  if (cur && !cur.carried) flush(false);
  return chunks;
}
