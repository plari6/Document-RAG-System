# Document RAG System: PDF Manual Search

Support agents ask questions about 200-page product manuals in plain language and get a short answer that **cites the exact pages**. The tool is a Node.js command-line app with an HTTP API and a small web page for agents.

```
$ doc-rag ask "Router light is solid red after an update and the app shows E-301"

A solid red LED combined with error code E-301 indicates that the firmware is damaged,
which typically occurs if a firmware update was interrupted [1][2].

1. Hold the RESET button while powering on the router for 30 seconds to enter recovery mode [2].
2. Open http://192.168.50.1/recovery in a browser and upload the firmware again [2].
3. If the status LED stays solid red, contact support for a replacement [2].

Sources
[1] NetPro X200 Wi-Fi 6 Router - User Manual p. 4  - 3 LED Indicators and Buttons > 3.1 Status LED
[2] NetPro X200 Wi-Fi 6 Router - User Manual p. 12 - 10 Error Codes

answered | ai gemini:gemini-3-flash-preview | search: hybrid | 3788 ms
```

## Why it is built this way

| Problem in support teams | What the tool does |
|---|---|
| Agents spend minutes scrolling a 200-page PDF while the customer waits | Hybrid search finds the right page in milliseconds; the AI writes the answer in about 3 s |
| AI answers that can't be checked | Every fact carries a `[n]` citation with manual title, page and section; citations to passages that don't exist are removed |
| Made-up answers | The model may only use the retrieved excerpts. If they don't contain the answer, the reply is "not covered" (`unknown`) |
| Exact codes (E-301, part numbers) get lost in purely semantic search | BM25 keyword search runs alongside the embeddings, and an exact match wins |
| AI provider outages and free-tier quotas | A multi-model fallback chain (Gemini versions, then Gemma, Groq, NVIDIA, OpenRouter, Ollama) tries the next model; if every model is down, the tool quotes the best passage verbatim |
| Manuals change | Re-ingesting replaces the old version; unchanged files are skipped (SHA-256 check) |
| Nobody knows what the manuals are missing | `doc-rag gaps` lists the questions the manuals could not answer |

## Quick start

```bash
git clone https://github.com/plari6/Document-RAG-System && cd Document-RAG-System
npm install
npm link                      # optional: makes the `doc-rag` command available everywhere

doc-rag demo                  # 14-page sample manual, 4 questions (works without any API key)
doc-rag init                  # creates .env - add GEMINI_API_KEY (free: https://aistudio.google.com/apikey)
doc-rag ingest ./manuals      # PDFs, folders or wildcards like "manuals/*.pdf"
doc-rag ask "How do I reset the device to factory settings?"
doc-rag chat                  # conversation with follow-up questions
```

Without `npm link`, use `node bin/doc-rag.js <command>`. Requires Node.js 20 or newer.

## Commands

| Command | What it does |
|---|---|
| `ingest <paths...>` | Add manuals (`.pdf`, `.txt`, `.md`). `--force` re-processes, `--no-embed` keeps keyword search only, `--title`, `--password`, `--chunk-size` |
| `embed [doc]` | Create missing embeddings, e.g. to resume after a free-tier quota limit |
| `list` / `remove <doc>` | Show or delete indexed manuals (`<doc>` = id, file name or part of the title) |
| `search <query>` | Show the most relevant passages instantly, with no AI (`-k`, `--doc`, `--full`, `--json`) |
| `ask <question>` | Cited answer. `--style customer` writes a ready-to-send reply to the customer. `--doc` limits the manuals, `--no-ai` quotes passages only, `--json` |
| `chat` | Interactive session with follow-ups. Commands: `/doc`, `/style`, `/sources`, `/status`, `/new` |
| `serve` | HTTP API and agent page on `http://127.0.0.1:3000` |
| `gaps` | Questions that got `unknown`/`partial` answers, grouped and counted |
| `doctor [--ping]` | Check keys and the library, and call every model in both chains |
| `demo` | End-to-end demo on the bundled sample manual |

Global options: `--library <dir>` (default `./.doc-rag` or `$DOC_RAG_HOME`), `--simulate-outage gemini` (demo of the failover), `--verbose` (every model attempt), `--no-color`.

## HTTP API (`doc-rag serve`)

For helpdesk sidebar apps (Zendesk, Freshdesk), Slack bots or n8n/Zapier/Make flows.

```bash
curl -X POST http://localhost:3000/api/ask \
  -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"question":"Which power adapter is supplied?","style":"customer"}'
```

```json
{
  "answer": "The NetPro X200 router is supplied with a 12 V / 1.5 A power adapter, model PA-1215. ...",
  "status": "answered",
  "source": "ai",
  "model": "gemini:gemini-3-flash-preview",
  "citations": [{ "n": 1, "title": "NetPro X200 ...", "page": "p. 2", "section": "1 Safety Instructions", "snippet": "..." }],
  "sources": ["..."],
  "retrieval": { "mode": "hybrid", "degraded": [] },
  "ms": 3109
}
```

| Endpoint | |
|---|---|
| `GET /` | Agent search page (answer, citations, copy button, "reply to customer" mode) |
| `GET /health` | Library size and the state of each model (public) |
| `GET /api/docs` | Indexed manuals |
| `GET /api/search?q=&k=5&doc=<id>` | Passages only, no AI |
| `POST /api/ask` | `{ question, k?, docs?, style?: "agent"\|"customer", history?: [{role, content}] }` |

When `API_KEY` is set, `/api/*` requires `x-api-key: <key>` or `Authorization: Bearer <key>`. The server listens on `127.0.0.1` unless you set `HOST=0.0.0.0`. CORS uses `ALLOWED_ORIGINS`, and `RATE_LIMIT_PER_MIN` limits requests per IP.

## How it works

```
PDF ──pdf-parse──> per-page text ──clean──> paragraphs + headings ──chunk──> ~1000-char chunks
                                    │                                        (section path, page range)
              strip running headers/footers,                                       │
              page numbers, fix hyphenation                    Gemini embeddings (768-d, normalised)
                                                                                    │
question ──> BM25 keywords  ┐                                          .doc-rag/ library on disk
         └─> query embedding ┴─> score fusion ─> top 6 passages ─> LLM (JSON: answer, status, citations)
                                                                     │ every model down
                                                                     └─> verbatim best passage (no AI)
```

1. **Extraction** (`src/pdf/extract.js`) uses pdf-parse v2 to get text page by page, so citations point to real page numbers. It warns when pages have no text layer (scanned PDFs need OCR first, e.g. `ocrmypdf`).
2. **Cleaning** (`src/text/clean.js`) removes lines that repeat at the top or bottom of most pages (running headers, footers, "Page 3 of 200"), normalises Unicode and joins words hyphenated across lines.
3. **Chunking** (`src/text/chunk.js`) detects headings (`4.2 Factory reset`, `CHAPTER 3`, `APPENDIX A`, all-caps titles) while ignoring numbered steps and table-of-contents lines. Chunks never span two sections. Each chunk keeps its heading path and page range, plus a sentence-level overlap.
4. **Embeddings** (`src/embed/embedder.js`) go through Gemini `batchEmbedContents` with `RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY` task types. Each chunk is embedded with its manual title and section. Vectors from different models can't be compared, so each manual records its model:
   - A model that fails before producing anything is replaced by the next one in `EMBED_CHAIN`.
   - A model that fails half-way (for example on the daily quota) keeps the vectors it made, and `doc-rag embed` resumes later with the same model.
   - Rate limits honour Google's `retryDelay`.
5. **Retrieval** (`src/search/retrieve.js`) combines BM25 (with stemming, error-code tokens such as `E-301` → `e301`, prefix expansion such as `admin` → `administrator`, and boosts for title and section) with cosine similarity. It blends normalised scores rather than ranks (RRF), so a passage that is the only exact match for a rare code is not outranked. If the embedding model is down at query time, search falls back to keywords and the answer says so.
6. **Answering** (`src/rag/engine.js`, `prompts.js`):
   - The model receives only the numbered excerpts. It must copy values exactly, reply in the question's language and ignore any instructions inside the documents.
   - Its JSON output is parsed leniently (code fences or surrounding text are fine). A bad output makes the router try the next model.
   - Short follow-up questions in chat ("and how do I fix it?") are searched together with the previous question.
7. **AI layer** (`src/ai/`) is the multi-model fallback router. It applies per-model timeouts, cooldowns for 429/503 errors, daily-quota parking, hedged requests and output validation. Pinned Gemini versions come first because the `-latest` aliases were the most overloaded in testing.

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `GEMINI_API_KEY` | | Answers and embeddings |
| `GROQ_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL` | | Extra fallback models (optional) |
| `AI_CHAIN` | built-in | `provider:model` list in priority order |
| `AI_TIMEOUT_MS` / `AI_TOTAL_BUDGET_MS` / `AI_HEDGE_MS` | 10000 / 30000 / 6000 | Router timing |
| `EMBED_CHAIN` | `gemini:gemini-embedding-001,gemini:gemini-embedding-2` | Add `ollama:nomic-embed-text` for offline use |
| `EMBED_DIMS` / `EMBED_BATCH_SIZE` | 768 / 50 | |
| `DOC_RAG_HOME` | `./.doc-rag` | Library location |
| `ORG_NAME` | | Company name used in the assistant instructions |
| `TOP_K`, `CHUNK_SIZE`, `CHUNK_OVERLAP` | 6, 1000, 150 | |
| `PORT`, `HOST`, `API_KEY`, `ALLOWED_ORIGINS`, `RATE_LIMIT_PER_MIN` | 3000, 127.0.0.1, none, `*`, 60 | `serve` |

## Use as a library

```js
import { createApp, ingestFile } from 'document-rag-system';

const app = await createApp({ library: './.doc-rag' });
await ingestFile(app.library, app.embedder, './manuals/x200.pdf');
const r = await app.rag.answer('How do I reset it?', { style: 'customer' });
console.log(r.answer, r.citedSources.map((s) => `${s.title} ${s.page}`));
```

## Tests

```bash
npm test          # 37 tests, no network: fake LLM and embedding providers
npm run doctor    # live check of every configured model
```

The tests cover:

- PDF round trips and header/footer removal
- heading and list detection, chunk sizes and overlap
- BM25 ranking
- embedding batching, retry, model switch and resume
- LLM failover, all-models-down extractive answers and unknown questions
- `--doc` filters, follow-ups and file updates
- HTTP auth and errors
- a synthetic 200-page manual: ingest in under a second without embeddings, and an exact code on page 173 found first in under 500 ms

## Limits

- Scanned PDFs need OCR first; the tool detects them and warns.
- Tables are read as plain text lines, which is fine for spec tables but not for complex merged cells.
- The library is a folder of JSON and binary vector files with one writer process. That covers hundreds of manuals; for thousands, move the vectors to pgvector, Qdrant or similar behind the same `retrieve()` interface.
- Free Gemini keys have small daily quotas, and Google may use free-tier prompts to improve its products. Use a paid key for client data.

## License

MIT
