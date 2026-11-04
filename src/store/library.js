import { mkdir, readFile, writeFile, rename, rm, appendFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * On-disk library (default ./.doc-rag):
 *   library.json            manifest: one entry per document (title, pages, chunk count, embedding model...)
 *   docs/<id>.chunks.json   chunks with text, section and page range
 *   docs/<id>.vec           Float32 vectors, `dims` floats per chunk (all zeros = not embedded yet)
 *   queries.jsonl           question log (for `doc-rag gaps`)
 * Single-process writer; reads are cheap and cached.
 */

const VERSION = 1;

async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  try {
    await rename(tmp, file);
  } catch (err) {
    // Windows: rename over a file held open by an editor/AV scanner can fail - write directly instead
    if (['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
      await writeFile(file, data);
      await rm(tmp, { force: true });
    } else throw err;
  }
}

export function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'doc'
  );
}

export function vectorsToBuffer(vectors, dims) {
  const out = new Float32Array(vectors.length * dims);
  vectors.forEach((v, i) => v && out.set(v.subarray(0, dims), i * dims));
  return Buffer.from(out.buffer);
}

export function bufferToVectors(buf, dims, count) {
  const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const vectors = [];
  for (let i = 0; i < count; i++) {
    const v = all.subarray(i * dims, (i + 1) * dims);
    vectors.push(v.length === dims && v.some((x) => x !== 0) ? v : null);
  }
  return vectors;
}

export async function openLibrary(dir) {
  const root = path.resolve(dir);
  const docsDir = path.join(root, 'docs');
  const manifestFile = path.join(root, 'library.json');
  let manifest = { version: VERSION, createdAt: new Date().toISOString(), docs: [] };
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (!Array.isArray(manifest.docs)) throw new Error('bad manifest');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Library at ${root} is corrupted (${err.message}). Delete it and re-ingest.`);
  }
  const chunkCache = new Map();
  const vecCache = new Map();
  let generation = 0; // bumps on every change, so search indexes know to rebuild

  const lib = {
    dir: root,
    get generation() {
      return generation;
    },
    get docs() {
      return manifest.docs;
    },
    async exists() {
      return stat(manifestFile).then(() => true, () => false);
    },
    async save() {
      await mkdir(docsDir, { recursive: true });
      manifest.updatedAt = new Date().toISOString();
      await atomicWrite(manifestFile, JSON.stringify(manifest, null, 2));
      generation++;
    },

    /** Resolve a user reference: exact id, id prefix, file name or title substring. */
    findDoc(ref) {
      if (!ref) return null;
      const r = String(ref).toLowerCase();
      const d = manifest.docs;
      return (
        d.find((x) => x.id === r) ||
        d.find((x) => x.fileName?.toLowerCase() === r) ||
        d.find((x) => x.id.startsWith(r)) ||
        d.find((x) => x.title.toLowerCase().includes(r)) ||
        d.find((x) => x.fileName?.toLowerCase().includes(r)) ||
        null
      );
    },
    findBySha(sha) {
      return manifest.docs.find((d) => d.sha256 === sha) || null;
    },
    newId(name, { replace } = {}) {
      const base = slugify(name);
      let id = base;
      for (let n = 2; manifest.docs.some((d) => d.id === id && d.id !== replace); n++) id = `${base}-${n}`;
      return id;
    },

    async putDocument(meta, chunks) {
      await mkdir(docsDir, { recursive: true });
      await atomicWrite(path.join(docsDir, `${meta.id}.chunks.json`), JSON.stringify(chunks));
      await rm(path.join(docsDir, `${meta.id}.vec`), { force: true });
      chunkCache.set(meta.id, chunks);
      vecCache.delete(meta.id);
      const i = manifest.docs.findIndex((d) => d.id === meta.id);
      if (i >= 0) manifest.docs[i] = meta;
      else manifest.docs.push(meta);
      await lib.save();
      return meta;
    },

    async putVectors(id, { model, dims, vectors }) {
      const meta = manifest.docs.find((d) => d.id === id);
      if (!meta) throw new Error(`Unknown document ${id}`);
      await atomicWrite(path.join(docsDir, `${id}.vec`), vectorsToBuffer(vectors, dims));
      vecCache.set(id, vectors);
      meta.embed = { model, dims, done: vectors.filter(Boolean).length, total: vectors.length, updatedAt: new Date().toISOString() };
      await lib.save();
    },

    async chunks(id) {
      if (chunkCache.has(id)) return chunkCache.get(id);
      const c = JSON.parse(await readFile(path.join(docsDir, `${id}.chunks.json`), 'utf8'));
      chunkCache.set(id, c);
      return c;
    },

    async vectors(id) {
      if (vecCache.has(id)) return vecCache.get(id);
      const meta = manifest.docs.find((d) => d.id === id);
      let v = new Array(meta?.chunks || 0).fill(null);
      if (meta?.embed?.model && meta.embed.dims) {
        try {
          v = bufferToVectors(await readFile(path.join(docsDir, `${id}.vec`)), meta.embed.dims, meta.chunks);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }
      vecCache.set(id, v);
      return v;
    },

    async remove(id) {
      manifest.docs = manifest.docs.filter((d) => d.id !== id);
      chunkCache.delete(id);
      vecCache.delete(id);
      await rm(path.join(docsDir, `${id}.chunks.json`), { force: true });
      await rm(path.join(docsDir, `${id}.vec`), { force: true });
      await lib.save();
    },

    async logQuery(entry) {
      try {
        await mkdir(root, { recursive: true });
        await appendFile(path.join(root, 'queries.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
      } catch {
        /* logging must never break answering */
      }
    },
    async queries() {
      try {
        return (await readFile(path.join(root, 'queries.jsonl'), 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      } catch {
        return [];
      }
    },
  };
  return lib;
}
