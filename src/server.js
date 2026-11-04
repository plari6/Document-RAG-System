import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WEB_UI } from './web-ui.js';

/**
 * HTTP API for helpdesk integrations (Zendesk/Freshdesk sidebar apps, Slack bots, n8n/Zapier):
 *   GET  /                 small search page for agents
 *   GET  /health           library + model status
 *   GET  /api/docs         indexed manuals
 *   GET  /api/search?q=..&k=5&doc=id
 *   POST /api/ask          { question, k?, docs?, style?: "agent"|"customer", history? }
 * Auth: if API_KEY is set, send "x-api-key: <key>" or "Authorization: Bearer <key>" on /api/*.
 */

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, { 'content-type': isText ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(isText ? body : JSON.stringify(body));
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else parts.push(d);
    });
    req.on('end', () => {
      try {
        resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Minimal per-IP rate limiter (requests per minute). */
function rateLimiter(perMin) {
  const hits = new Map();
  return (ip) => {
    if (!perMin) return true;
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
    list.push(now);
    hits.set(ip, list);
    if (hits.size > 5000) hits.clear();
    return list.length <= perMin;
  };
}

const publicSource = ({ text, ...s }, full) => (full ? { ...s, text } : { ...s, snippet: text.slice(0, 400) });

export function createServer(app, { apiKey = '', allowedOrigins = '*', rateLimitPerMin = 60, log = () => {} } = {}) {
  const { rag, library, ai, embedder } = app;
  const allow = rateLimiter(rateLimitPerMin);
  const origins = String(allowedOrigins || '*').split(',').map((s) => s.trim()).filter(Boolean);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    const cors = {};
    if (origin && (origins.includes('*') || origins.includes(origin))) {
      Object.assign(cors, {
        'access-control-allow-origin': origins.includes('*') ? '*' : origin,
        'access-control-allow-headers': 'content-type, x-api-key, authorization',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        vary: 'origin',
      });
    }
    if (req.method === 'OPTIONS') return send(res, 204, '', cors);
    const started = Date.now();
    try {
      if (url.pathname === '/' && req.method === 'GET') return send(res, 200, WEB_UI, cors);
      if (url.pathname === '/health') {
        return send(res, 200, {
          ok: true,
          documents: library.docs.length,
          chunks: library.docs.reduce((a, d) => a + d.chunks, 0),
          llm: ai.status().map(({ id, state, avgMs, lastErrorKind }) => ({ id, state, avgMs, lastErrorKind })),
          embeddings: embedder.chain,
        }, cors);
      }
      if (url.pathname.startsWith('/api/')) {
        if (apiKey) {
          const given = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
          if (!given || !safeEqual(given, apiKey)) return send(res, 401, { error: 'Missing or invalid API key' }, cors);
        }
        if (!allow(req.socket.remoteAddress || 'ip')) return send(res, 429, { error: 'Too many requests' }, { ...cors, 'retry-after': '60' });

        if (url.pathname === '/api/docs' && req.method === 'GET') {
          return send(res, 200, { docs: library.docs.map(({ file, ...d }) => d) }, cors);
        }
        if (url.pathname === '/api/search' && req.method === 'GET') {
          const q = (url.searchParams.get('q') || '').trim();
          if (!q) return send(res, 400, { error: 'q is required' }, cors);
          const docs = url.searchParams.getAll('doc').filter(Boolean);
          const k = Math.min(20, Math.max(1, Number(url.searchParams.get('k')) || 5));
          const r = await rag.search(q, { k, docs });
          return send(res, 200, { query: q, mode: r.mode, degraded: r.degraded, results: r.results.map((s) => publicSource(s, true)) }, cors);
        }
        if (url.pathname === '/api/ask' && req.method === 'POST') {
          const body = await readJson(req);
          const question = String(body.question || '').trim().slice(0, 2000);
          if (!question) return send(res, 400, { error: 'question is required' }, cors);
          const history = Array.isArray(body.history)
            ? body.history.filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').slice(-6)
            : [];
          const r = await rag.answer(question, {
            k: Math.min(12, Math.max(1, Number(body.k) || undefined || 6)),
            docs: body.docs,
            style: body.style === 'customer' ? 'customer' : 'agent',
            history,
          });
          log(`ask ${r.status} ${r.source} ${Date.now() - started}ms`);
          return send(res, 200, {
            answer: r.answer,
            status: r.status,
            source: r.source,
            model: r.model,
            citations: r.citedSources.map((s) => publicSource(s, false)),
            sources: r.sources.map((s) => publicSource(s, false)),
            retrieval: r.retrieval,
            ms: r.ms,
          }, cors);
        }
      }
      return send(res, 404, { error: 'Not found' }, cors);
    } catch (err) {
      const status = err.status || (err.code === 'NO_DOC' || err.code === 'EMPTY' ? 400 : 500);
      if (status >= 500) log(`error ${err.stack || err.message}`);
      return send(res, status, { error: status >= 500 ? 'Internal error' : err.message }, cors);
    }
  });
}
