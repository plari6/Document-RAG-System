import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { extractDocument, SUPPORTED } from './pdf/extract.js';
import { cleanPages } from './text/clean.js';
import { chunkPages } from './text/chunk.js';

/** Expand files, folders (recursive) and simple wildcards ("manuals/*.pdf") into supported files. */
export async function expandPaths(inputs) {
  const out = [];
  const seen = new Set();
  const push = (f) => {
    const abs = path.resolve(f);
    if (!seen.has(abs.toLowerCase())) seen.add(abs.toLowerCase()) && out.push(abs);
  };
  async function walk(dir) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (SUPPORTED.includes(path.extname(ent.name).toLowerCase())) push(p);
    }
  }
  for (const input of inputs) {
    if (/[*?]/.test(input)) {
      const dir = path.dirname(input);
      const rx = new RegExp(`^${path.basename(input).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
      const names = await readdir(dir).catch(() => []);
      names.filter((n) => rx.test(n) && SUPPORTED.includes(path.extname(n).toLowerCase())).forEach((n) => push(path.join(dir, n)));
      continue;
    }
    const s = await stat(input).catch(() => null);
    if (!s) throw new Error(`Not found: ${input}`);
    if (s.isDirectory()) await walk(input);
    else push(input);
  }
  return out;
}

/** Text sent to the embedding model: title + section give each chunk its context. */
export const embedText = (doc, c) => `${doc.title}${c.section ? `\n${c.section}` : ''}\n\n${c.text}`;

export async function embedDocument(library, embedder, docId, { onProgress, onWait, signal } = {}) {
  const doc = library.docs.find((d) => d.id === docId);
  if (!doc) throw new Error(`Unknown document ${docId}`);
  const chunks = await library.chunks(docId);
  const existing = await library.vectors(docId);
  const missing = existing.filter((v) => !v).length;
  if (!missing) return { model: doc.embed?.model, done: chunks.length, total: chunks.length };
  if (!embedder?.configured) return { model: null, done: chunks.length - missing, total: chunks.length, error: new Error('no embedding provider configured (set GEMINI_API_KEY)') };
  const res = await embedder.embedDocuments(
    chunks.map((c) => embedText(doc, c)),
    { model: existing.some(Boolean) ? doc.embed?.model : undefined, existing, onProgress, onWait, signal },
  );
  if (res.model && res.vectors.some(Boolean)) await library.putVectors(docId, { model: res.model, dims: embedder.dims, vectors: res.vectors });
  return { model: res.model, done: res.vectors.filter(Boolean).length, total: chunks.length, error: res.error };
}

/**
 * Add (or update) one manual. Unchanged files (same SHA-256) are skipped unless `force`;
 * a file with the same name but new content replaces the old version and keeps its id.
 */
export async function ingestFile(library, embedder, file, { force = false, embed = true, title, chunkSize = 1000, overlap = 150, password, onProgress, onWait, signal } = {}) {
  const warnings = [];
  const extracted = await extractDocument(file, { password });
  const same = library.findBySha(extracted.sha256);
  if (same && !force) {
    const r = embed && same.embed?.done !== same.chunks ? await embedDocument(library, embedder, same.id, { onProgress, onWait, signal }) : null;
    return { status: 'unchanged', doc: same, embedding: r, warnings };
  }

  if (extracted.emptyPages / Math.max(1, extracted.totalPages) > 0.3) {
    warnings.push(`${extracted.emptyPages} of ${extracted.totalPages} pages have no text layer (scanned images?). Run OCR (e.g. ocrmypdf) for full coverage.`);
  }
  const pages = cleanPages(extracted.pages);
  const raw = chunkPages(pages, { size: chunkSize, overlap });
  if (!raw.length) throw new Error(`${extracted.fileName}: no extractable text. The PDF is probably scanned images - run OCR first (e.g. "ocrmypdf in.pdf out.pdf").`);

  const previous = same || library.docs.find((d) => d.fileName?.toLowerCase() === extracted.fileName.toLowerCase());
  const id = previous?.id || library.newId(path.basename(extracted.fileName, path.extname(extracted.fileName)));
  const chunks = raw.map((c) => ({ ...c, id: `${id}#${c.i}` }));
  const meta = {
    id,
    title: title || extracted.title,
    fileName: extracted.fileName,
    file: path.resolve(file),
    sha256: extracted.sha256,
    bytes: extracted.bytes,
    pages: extracted.totalPages,
    emptyPages: extracted.emptyPages,
    chunks: chunks.length,
    chunking: { size: chunkSize, overlap },
    ingestedAt: new Date().toISOString(),
    embed: null,
  };
  await library.putDocument(meta, chunks);
  const embedding = embed ? await embedDocument(library, embedder, id, { onProgress, onWait, signal }) : null;
  return { status: previous ? 'updated' : 'added', doc: library.docs.find((d) => d.id === id), embedding, warnings };
}
