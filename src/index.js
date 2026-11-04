// Library entry point: use the RAG engine from your own Node.js code.
export { createApp, loadEnv } from './app.js';
export { ingestFile, embedDocument, expandPaths } from './ingest.js';
export { createRag, extractiveAnswer } from './rag/engine.js';
export { openLibrary } from './store/library.js';
export { createEmbedder, createEmbedderFromEnv } from './embed/embedder.js';
export { createServer } from './server.js';
export { extractDocument } from './pdf/extract.js';
export { chunkPages } from './text/chunk.js';
export { cleanPages } from './text/clean.js';
