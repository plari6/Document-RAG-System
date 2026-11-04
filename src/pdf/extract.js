import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const SUPPORTED = ['.pdf', '.txt', '.md'];

/**
 * Read a manual into per-page text.
 * PDF via pdf-parse (pdf.js). .txt/.md are supported for quick tests: form feeds (\f)
 * or lines like "--- page 12 ---" split pages.
 * Returns { title, pages: [{ page, text }], totalPages, emptyPages, sha256, bytes }.
 */
export async function extractDocument(file, { password } = {}) {
  const ext = path.extname(file).toLowerCase();
  if (!SUPPORTED.includes(ext)) throw new Error(`Unsupported file type "${ext}" (supported: ${SUPPORTED.join(', ')})`);
  const buf = await readFile(file);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const base = { sha256, bytes: buf.length, fileName: path.basename(file) };
  const fallbackTitle = path.basename(file, ext).replace(/[_-]+/g, ' ').trim();

  if (ext !== '.pdf') {
    const text = buf.toString('utf8');
    const parts = text.split(/\f|^-{3,}\s*page\s*\d+\s*-{3,}\s*$/im);
    const pages = parts.map((t, i) => ({ page: i + 1, text: t }));
    const h1 = text.match(/^#\s+(.+)$/m)?.[1];
    return { ...base, title: h1 || fallbackTitle, pages, totalPages: pages.length, emptyPages: pages.filter((p) => !p.text.trim()).length };
  }

  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error(`${path.basename(file)} is not a valid PDF`);
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf), ...(password ? { password } : {}) });
  try {
    const result = await parser.getText();
    let title = '';
    try {
      const info = await parser.getInfo();
      title = String(info?.info?.Title || '').trim();
    } catch {
      /* metadata is optional */
    }
    if (!title || /^(untitled|microsoft word|document\d*)/i.test(title) || title.length > 120) title = fallbackTitle;
    const pages = result.pages.map((p) => ({ page: p.num, text: p.text || '' }));
    return {
      ...base,
      title,
      pages,
      totalPages: result.total || pages.length,
      emptyPages: pages.filter((p) => p.text.replace(/\s/g, '').length < 20).length,
    };
  } catch (err) {
    if (/password/i.test(err?.message || err?.name || '')) throw new Error(`${path.basename(file)} is password protected (use --password)`);
    throw new Error(`Could not read ${path.basename(file)}: ${err?.message || err}`);
  } finally {
    await parser.destroy().catch(() => {});
  }
}
