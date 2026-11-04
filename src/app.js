import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRouterFromEnv } from './ai/index.js';
import { createEmbedderFromEnv } from './embed/embedder.js';
import { openLibrary } from './store/library.js';
import { createRag } from './rag/engine.js';

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** .env from the current folder first, then the project folder (existing env vars always win). */
export async function loadEnv() {
  if (process.env.DOC_RAG_SKIP_DOTENV === '1') return;
  const dotenv = await import('dotenv');
  for (const dir of [process.cwd(), PROJECT_DIR]) {
    const f = path.join(dir, '.env');
    if (existsSync(f)) dotenv.config({ path: f, quiet: true });
  }
}

export function libraryDir(opt, env = process.env) {
  return path.resolve(opt || env.DOC_RAG_HOME || '.doc-rag');
}

/**
 * Wire everything together. `simulate` = providers to fake as down (demo of the fallback chain).
 * `providers`/`embedProviders` let tests inject fakes (no network).
 */
export async function createApp({ library: dir, env = process.env, simulate = [], onEvent = () => {}, providers, embedProviders } = {}) {
  const library = await openLibrary(libraryDir(dir, env));
  const ai = createRouterFromEnv(env, { onEvent: (e) => onEvent({ ...e, layer: 'llm' }), simulate, providers });
  const embedder = createEmbedderFromEnv(env, { onEvent: (e) => onEvent({ ...e, layer: 'embed' }), simulate, providers: embedProviders });
  const rag = createRag({ library, embedder, ai, org: env.ORG_NAME || '', defaultK: Number(env.TOP_K) || 6, onEvent });
  return {
    library,
    ai,
    embedder,
    rag,
    chunkSize: Number(env.CHUNK_SIZE) || 1000,
    chunkOverlap: env.CHUNK_OVERLAP === undefined ? 150 : Number(env.CHUNK_OVERLAP) || 0,
  };
}
