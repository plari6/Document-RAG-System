/**
 * Tiny dependency-free PDF writer (text only, Helvetica, A4).
 * Used to build the demo manual and the test fixtures, so the repo ships no binary PDFs.
 *
 * pages: Array<Array<string | { text, size?, bold? }>>  (one array of lines per page)
 * Long lines are wrapped. Text outside Latin-1 is replaced with "?".
 */
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 56;

function esc(s) {
  return String(s)
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrap(text, size) {
  // Helvetica averages ~0.5em per glyph; good enough for wrapping.
  const max = Math.floor((PAGE_W - 2 * MARGIN) / (size * 0.5));
  const words = String(text).split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > max) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  out.push(line);
  return out;
}

function pageStream(lines, { footer } = {}) {
  const ops = ['BT'];
  let y = PAGE_H - MARGIN;
  for (const raw of lines) {
    const item = typeof raw === 'string' ? { text: raw } : raw;
    const size = item.size || 11;
    const font = item.bold ? 'F2' : 'F1';
    const parts = item.text === '' ? [''] : wrap(item.text, size);
    for (const part of parts) {
      y -= size * 1.45;
      if (y < MARGIN + 20) break;
      ops.push(`/${font} ${size} Tf 1 0 0 1 ${MARGIN} ${y.toFixed(1)} Tm (${esc(part)}) Tj`);
    }
  }
  if (footer) ops.push(`/F1 9 Tf 1 0 0 1 ${MARGIN} ${MARGIN - 20} Tm (${esc(footer)}) Tj`);
  ops.push('ET');
  return ops.join('\n');
}

export function buildPdf(pages, { title = 'Document', footer } = {}) {
  const objects = []; // index i -> object number i+1
  const add = (body) => objects.push(body) && objects.length;

  const catalog = add(null);
  const pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title (${esc(title)}) /Producer (doc-rag) >>`);

  const kids = [];
  pages.forEach((lines, i) => {
    const foot = typeof footer === 'function' ? footer(i + 1, pages.length) : footer;
    const stream = pageStream(lines, { footer: foot });
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
