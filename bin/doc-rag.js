#!/usr/bin/env node
import { Command, Option } from 'commander';
import { createInterface } from 'node:readline';
import { copyFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, loadEnv, libraryDir, PROJECT_DIR } from '../src/app.js';
import { expandPaths, ingestFile, embedDocument } from '../src/ingest.js';
import { createServer } from '../src/server.js';
import { buildSampleManualPdf } from '../src/demo/sample-manual.js';
import { c, formatAnswer, formatSource, table, progress, setColor } from '../src/cli/format.js';

await loadEnv();
const pkg = JSON.parse(readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8'));
const program = new Command();

program
  .name('doc-rag')
  .description('Ask long PDF manuals questions in plain language: answers cite the exact pages.')
  .version(pkg.version)
  .option('-l, --library <dir>', 'library folder (default: $DOC_RAG_HOME or ./.doc-rag)')
  .option('--simulate-outage <providers>', 'pretend these providers are down, e.g. "gemini" or "gemini,groq" (demo the fallback)')
  .option('--no-color', 'disable colors')
  .option('-v, --verbose', 'log every model attempt and failover');

function opts() {
  const o = program.opts();
  if (o.color === false) setColor(false);
  return o;
}

async function app(extra = {}) {
  const o = opts();
  return createApp({
    library: extra.library || o.library,
    simulate: o.simulateOutage ? o.simulateOutage.split(',') : [],
    onEvent: (e) => {
      if (o.verbose && ['failure', 'retry', 'hedge', 'success', 'skip'].includes(e.type)) {
        const what = e.type === 'success' ? c.green(`ok ${e.ms} ms`) : e.type === 'retry' ? c.yellow(`${e.kind}, retry in ${Math.round(e.waitMs / 1000)}s`) : c.yellow(`${e.type} ${e.kind || e.reason || ''}`);
        console.error(c.dim(`[${e.layer}] ${e.target || (e.targets || []).join(' + ')}: `) + what);
      } else if (e.type === 'failure' && e.layer === 'llm' && !o.verbose) {
        console.error(c.dim(`[ai] ${e.target} ${e.kind} -> next model`));
      }
    },
    ...extra,
  });
}

function fail(err) {
  console.error(c.red(`Error: ${err.message || err}`));
  process.exitCode = 1;
}

const kOpt = () => new Option('-k, --top <n>', 'number of passages to retrieve').argParser((v) => Math.max(1, Math.min(20, parseInt(v, 10) || 6)));
const docOpt = () => new Option('-d, --doc <id...>', 'limit to these manuals (id, file name or part of the title)');

// ---------------------------------------------------------------- init
program
  .command('init')
  .description('create a .env file in the current folder from the template')
  .action(async () => {
    const target = path.resolve('.env');
    if (existsSync(target)) return console.log(`${c.yellow('.env already exists')} - edit ${target}`);
    await copyFile(path.join(PROJECT_DIR, '.env.example'), target);
    console.log(`${c.green('Created')} ${target}\nAdd GEMINI_API_KEY (https://aistudio.google.com/apikey), then: doc-rag ingest <manual.pdf>`);
  });

// ---------------------------------------------------------------- ingest
program
  .command('ingest')
  .alias('add')
  .description('add PDF manuals (files, folders or wildcards) to the library')
  .argument('<paths...>', 'PDF/TXT/MD files, folders, or patterns like manuals/*.pdf')
  .option('-f, --force', 're-process files even if unchanged')
  .option('--no-embed', 'skip embeddings (keyword search only; run "doc-rag embed" later)')
  .option('-t, --title <title>', 'override the document title (single file only)')
  .option('--password <pw>', 'password for protected PDFs')
  .option('--chunk-size <chars>', 'target chunk size in characters', (v) => parseInt(v, 10))
  .action(async (inputs, o) => {
    try {
      const a = await app();
      const files = await expandPaths(inputs);
      if (!files.length) throw new Error('No PDF/TXT/MD files found');
      if (o.title && files.length > 1) throw new Error('--title only works with a single file');
      if (o.embed && !a.embedder.configured) console.error(c.yellow('No GEMINI_API_KEY: indexing for keyword search only. Add a key and run "doc-rag embed" for semantic search.'));
      let failed = 0;
      for (const file of files) {
        const name = path.basename(file);
        const t0 = Date.now();
        const bar = progress(`  embedding ${name}`);
        try {
          const r = await ingestFile(a.library, a.embedder, file, {
            force: o.force,
            embed: o.embed && a.embedder.configured,
            title: o.title,
            password: o.password,
            chunkSize: o.chunkSize || a.chunkSize,
            overlap: a.chunkOverlap,
            onProgress: ({ done, total, model }) => bar.update(done, total, c.dim(model)),
            onWait: (ms, err) => bar.update(0, 0, c.yellow(`${err.kind}: waiting ${Math.round(ms / 1000)}s`)),
          });
          bar.done();
          const d = r.doc;
          const emb = r.embedding;
          const embTxt = emb ? (emb.error ? c.yellow(`embedded ${emb.done}/${emb.total} (${emb.error.message}) - run "doc-rag embed" to resume`) : c.dim(`embedded ${emb.done}/${emb.total} with ${emb.model}`)) : '';
          const label = r.status === 'unchanged' ? c.dim('unchanged') : c.green(r.status);
          console.log(`${label} ${c.bold(d.id)}  ${d.title}  ${d.pages} pages, ${d.chunks} chunks, ${((Date.now() - t0) / 1000).toFixed(1)}s ${embTxt}`);
          for (const w of r.warnings) console.log(`  ${c.yellow('warning:')} ${w}`);
        } catch (err) {
          bar.done();
          failed++;
          console.error(`${c.red('failed')} ${name}: ${err.message}`);
        }
      }
      console.log(c.dim(`Library: ${a.library.dir} (${a.library.docs.length} manuals)`));
      if (failed) process.exitCode = 1;
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- embed (resume)
program
  .command('embed')
  .description('create missing embeddings (resume after a quota limit, or after ingest --no-embed)')
  .argument('[doc]', 'only this manual')
  .action(async (ref) => {
    try {
      const a = await app();
      if (!a.embedder.configured) throw new Error('No embedding provider configured. Set GEMINI_API_KEY in .env');
      const docs = ref ? [a.library.findDoc(ref)].filter(Boolean) : a.library.docs;
      if (ref && !docs.length) throw new Error(`No document matches "${ref}"`);
      for (const d of docs) {
        const bar = progress(`  ${d.id}`);
        const r = await embedDocument(a.library, a.embedder, d.id, {
          onProgress: ({ done, total, model }) => bar.update(done, total, c.dim(model)),
          onWait: (ms, err) => bar.update(0, 0, c.yellow(`${err.kind}: waiting ${Math.round(ms / 1000)}s`)),
        });
        bar.done();
        console.log(`${r.error ? c.yellow('partial') : c.green('ok')} ${d.id}: ${r.done}/${r.total} chunks embedded${r.model ? ` with ${r.model}` : ''}${r.error ? ` - ${r.error.message}` : ''}`);
      }
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- list / remove
program
  .command('list')
  .alias('ls')
  .description('show indexed manuals')
  .option('--json', 'JSON output')
  .action(async (o) => {
    try {
      const a = await app();
      const docs = a.library.docs;
      if (o.json) return console.log(JSON.stringify(docs, null, 2));
      if (!docs.length) return console.log(`Library is empty (${a.library.dir}). Add manuals: doc-rag ingest <file.pdf | folder>`);
      console.log(
        table(
          docs.map((d) => [d.id, d.title.slice(0, 50), d.pages, d.chunks, d.embed ? `${d.embed.done}/${d.embed.total} ${d.embed.model}` : c.yellow('keyword only'), d.ingestedAt.slice(0, 10)]),
          ['ID', 'TITLE', 'PAGES', 'CHUNKS', 'EMBEDDINGS', 'ADDED'],
        ),
      );
      console.log(c.dim(`\n${docs.length} manuals, ${docs.reduce((s, d) => s + d.pages, 0)} pages - ${a.library.dir}`));
    } catch (err) {
      fail(err);
    }
  });

program
  .command('remove')
  .alias('rm')
  .description('remove a manual from the library')
  .argument('<doc>', 'id, file name or part of the title')
  .action(async (ref) => {
    try {
      const a = await app();
      const d = a.library.findDoc(ref);
      if (!d) throw new Error(`No document matches "${ref}"`);
      await a.library.remove(d.id);
      console.log(`${c.green('removed')} ${d.id} (${d.title})`);
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- search
program
  .command('search')
  .description('find the most relevant passages (no AI answer, instant)')
  .argument('<query...>')
  .addOption(kOpt())
  .addOption(docOpt())
  .option('--full', 'print whole passages')
  .option('--json', 'JSON output')
  .action(async (words, o) => {
    try {
      const a = await app();
      const r = await a.rag.search(words.join(' '), { k: o.top || 5, docs: o.doc });
      if (o.json) return console.log(JSON.stringify(r, null, 2));
      if (!r.results.length) console.log(c.yellow('No matching passages.'));
      for (const s of r.results) console.log(formatSource(s, { full: o.full }) + '\n');
      console.log(c.dim(`search: ${r.mode}${r.degraded.length ? ` (embeddings down: ${r.degraded.join(', ')})` : ''}`));
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- ask
program
  .command('ask')
  .description('answer a question from the manuals, with page citations')
  .argument('<question...>')
  .addOption(kOpt())
  .addOption(docOpt())
  .addOption(new Option('-s, --style <style>', 'agent = steps + citations; customer = ready-to-send reply').choices(['agent', 'customer']).default('agent'))
  .option('--no-ai', 'skip the LLM: quote the best passages instead')
  .option('--all-sources', 'show every retrieved passage, not only the cited ones')
  .option('--json', 'JSON output')
  .action(async (words, o) => {
    try {
      const a = await app();
      const r = await a.rag.answer(words.join(' '), { k: o.top, docs: o.doc, style: o.style, noAi: o.ai === false });
      if (o.json) return console.log(JSON.stringify(r, null, 2));
      console.log(formatAnswer(r, { showAll: o.allSources, verbose: opts().verbose }));
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- chat
program
  .command('chat')
  .description('interactive Q&A session (keeps context for follow-up questions)')
  .addOption(docOpt())
  .addOption(new Option('-s, --style <style>').choices(['agent', 'customer']).default('agent'))
  .action(async (o) => {
    try {
      const a = await app();
      if (!a.library.docs.length) throw new Error('The library is empty. Add manuals first: doc-rag ingest <file.pdf | folder>');
      let docs = o.doc ? a.rag.resolveDocs(o.doc) : undefined;
      let style = o.style;
      let history = [];
      let last = null;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const scope = () => (docs ? docs.join(', ') : `all ${a.library.docs.length} manuals`);
      console.log(`${c.bold('doc-rag chat')} - searching ${scope()}. Type a question, or /help.`);
      const help = `/docs  list manuals     /doc <id|all>  limit search     /style agent|customer
/sources  passages of the last answer     /status  model health     /new  clear context     /exit`;
      // async iterator buffers lines typed (or piped) while an answer is still loading
      const ask = () => process.stdout.write(c.cyan('\n? '));
      ask();
      for await (const raw of rl) {
        const line = raw.trim();
        if (!line) {
          ask();
          continue;
        }
        if (!process.stdin.isTTY) console.log(line); // echo piped input so transcripts read well
        if (line.startsWith('/')) {
          const [cmd, ...rest] = line.slice(1).split(/\s+/);
          const arg = rest.join(' ');
          if (['exit', 'quit', 'q'].includes(cmd)) break;
          else if (cmd === 'help') console.log(help);
          else if (cmd === 'docs') a.library.docs.forEach((d) => console.log(`${c.bold(d.id)}  ${d.title} (${d.pages} pages)`));
          else if (cmd === 'doc') {
            try {
              docs = !arg || arg === 'all' ? undefined : a.rag.resolveDocs(arg.split(','));
              console.log(`Searching ${scope()}`);
            } catch (err) {
              console.log(c.red(err.message));
            }
          } else if (cmd === 'style') {
            style = arg === 'customer' ? 'customer' : 'agent';
            console.log(`Style: ${style}`);
          } else if (cmd === 'sources') {
            if (!last) console.log('No answer yet.');
            else last.sources.forEach((s) => console.log(formatSource(s, { full: true }) + '\n'));
          } else if (cmd === 'status') {
            console.log(table(a.ai.status().map((t) => [t.id, t.state, t.avgMs ?? '', t.lastErrorKind || '']), ['MODEL', 'STATE', 'AVG MS', 'LAST ERROR']));
          } else if (cmd === 'new') {
            history = [];
            console.log('Context cleared.');
          } else console.log(`Unknown command. ${help}`);
          ask();
          continue;
        }
        try {
          last = await a.rag.answer(line, { docs, style, history });
          console.log('\n' + formatAnswer(last, { verbose: opts().verbose }));
          history.push({ role: 'user', content: line }, { role: 'assistant', content: last.answer });
          history = history.slice(-6);
        } catch (err) {
          console.log(c.red(err.message));
        }
        ask();
      }
      rl.close();
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- serve
program
  .command('serve')
  .description('HTTP API + agent search page (for helpdesk sidebars, Slack bots, n8n/Zapier)')
  .option('-p, --port <port>', 'port', (v) => parseInt(v, 10))
  .option('--host <host>', 'bind address', process.env.HOST || '127.0.0.1')
  .action(async (o) => {
    try {
      const a = await app();
      const port = o.port || Number(process.env.PORT) || 3000;
      const server = createServer(a, {
        apiKey: process.env.API_KEY || '',
        allowedOrigins: process.env.ALLOWED_ORIGINS || '*',
        rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN) || 60,
        log: (m) => console.log(c.dim(`${new Date().toISOString()} ${m}`)),
      });
      server.listen(port, o.host, () => {
        console.log(`${c.green('Listening')} on http://${o.host}:${port}  (${a.library.docs.length} manuals)`);
        console.log(c.dim(`  GET /  agent page   GET /health   GET /api/search?q=   POST /api/ask {question}${process.env.API_KEY ? '   (API_KEY required)' : ''}`));
      });
      const stop = () => server.close(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- gaps
program
  .command('gaps')
  .description('questions the manuals could not answer (content gaps to fix)')
  .option('-n, --limit <n>', 'rows', (v) => parseInt(v, 10), 20)
  .option('--json', 'JSON output')
  .action(async (o) => {
    try {
      const a = await app();
      const qs = await a.library.queries();
      const groups = new Map();
      for (const q of qs) {
        if (q.status === 'answered') continue;
        const key = q.q.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
        const g = groups.get(key) || { question: q.q, count: 0, statuses: new Set(), last: q.at };
        g.count++;
        g.statuses.add(q.status);
        g.last = q.at;
        groups.set(key, g);
      }
      const rows = [...groups.values()].sort((x, y) => y.count - x.count).slice(0, o.limit);
      if (o.json) return console.log(JSON.stringify(rows.map((r) => ({ ...r, statuses: [...r.statuses] })), null, 2));
      const answered = qs.filter((q) => q.status === 'answered').length;
      console.log(c.dim(`${qs.length} questions logged, ${answered} fully answered (${qs.length ? Math.round((answered / qs.length) * 100) : 0}%)\n`));
      if (!rows.length) return console.log(c.green('No gaps yet.'));
      console.log(table(rows.map((r) => [r.count, [...r.statuses].join('/'), r.question.slice(0, 70), r.last.slice(0, 10)]), ['TIMES', 'STATUS', 'QUESTION', 'LAST ASKED']));
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- doctor
program
  .command('doctor')
  .description('check setup: keys, library, model chain (--ping calls every model)')
  .option('--ping', 'send a tiny request to every configured model')
  .action(async (o) => {
    try {
      const a = await app();
      const ok = (b) => (b ? c.green('ok  ') : c.red('miss'));
      console.log(c.bold('Environment'));
      console.log(`  ${ok(Number(process.versions.node.split('.')[0]) >= 20)} Node ${process.versions.node} (needs 20+)`);
      for (const k of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'NVIDIA_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL']) console.log(`  ${process.env[k] ? c.green('set ') : c.dim('--  ')} ${k}`);
      console.log(c.bold('\nLibrary'));
      const docs = a.library.docs;
      console.log(`  ${a.library.dir}: ${docs.length} manuals, ${docs.reduce((s, d) => s + d.chunks, 0)} chunks`);
      for (const d of docs.filter((x) => !x.embed || x.embed.done < x.chunks)) console.log(`  ${c.yellow('warn')} ${d.id}: embeddings ${d.embed?.done || 0}/${d.chunks} - run "doc-rag embed"`);

      console.log(c.bold('\nEmbedding chain'));
      for (const t of a.embedder.chain) {
        let note = t.configured ? '' : c.dim('(no key)');
        if (o.ping && t.configured) {
          const t0 = Date.now();
          const v = await a.embedder.embedQuery('doctor ping', t.id);
          note = v ? c.green(`ok ${Date.now() - t0} ms, ${v.length} dims`) : c.red('failed');
        }
        console.log(`  ${t.configured ? c.green('ready') : c.dim('off  ')} ${t.id} ${note}`);
      }

      console.log(c.bold('\nAnswer model chain'));
      for (const t of a.ai.status()) {
        let note = t.enabled ? '' : c.dim(`(${t.disabledReason || 'no key'})`);
        if (o.ping && t.enabled) {
          try {
            const r = await a.ai.generate({ only: t.id, messages: [{ role: 'user', content: 'Reply with the word OK.' }], maxTokens: 1024, timeoutMs: 20_000, totalBudgetMs: 25_000 });
            note = c.green(`ok ${r.ms} ms`);
          } catch (err) {
            note = c.red(`${err.attempts?.[0]?.kind || 'error'}: ${(err.attempts?.[0]?.error || err.message).slice(0, 90)}`);
          }
        }
        console.log(`  ${t.enabled ? c.green('ready') : c.dim('off  ')} ${t.id} ${note}`);
      }
      if (!o.ping) console.log(c.dim('\nRun "doc-rag doctor --ping" to call every model.'));
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- demo
program
  .command('demo')
  .description('end-to-end demo on a bundled 14-page router manual (works without API keys)')
  .option('--keep', 'keep the demo library (prints its path)')
  .action(async (o) => {
    const dir = path.join(tmpdir(), `doc-rag-demo-${process.pid}`);
    try {
      await mkdir(dir, { recursive: true });
      const pdf = path.join(PROJECT_DIR, 'examples', 'netpro-x200-manual.pdf');
      if (!existsSync(pdf)) {
        await mkdir(path.dirname(pdf), { recursive: true });
        await writeFile(pdf, buildSampleManualPdf());
      }
      const a = await app({ library: path.join(dir, 'library') });
      console.log(c.bold('1. Ingest'), c.dim(path.relative(process.cwd(), pdf) || pdf));
      const t0 = Date.now();
      const r = await ingestFile(a.library, a.embedder, pdf, { embed: a.embedder.configured });
      console.log(`   ${r.doc.title}: ${r.doc.pages} pages -> ${r.doc.chunks} chunks in ${Date.now() - t0} ms` + (r.embedding ? `, embeddings ${r.embedding.done}/${r.embedding.total}${r.embedding.model ? ` (${r.embedding.model})` : ''}${r.embedding.error ? c.yellow(` - ${r.embedding.error.message}`) : ''}` : c.yellow(' (no GEMINI_API_KEY: keyword search only)')));

      const questions = [
        ['The customer forgot the admin password. What should they do?', 'agent'],
        ['Router light is solid red after an update and the app shows E-301', 'agent'],
        ['How long is the warranty in Germany?', 'customer'],
        ['Does the X200 support Zigbee smart home devices?', 'agent'],
      ];
      let n = 2;
      for (const [q, style] of questions) {
        console.log(`\n${c.bold(`${n++}. Ask`)}${style === 'customer' ? c.dim(' (customer reply)') : ''}: ${c.cyan(q)}\n`);
        const res = await a.rag.answer(q, { style });
        console.log(formatAnswer(res).replace(/^/gm, '   '));
      }
      console.log(`\n${c.bold('Try it yourself:')} doc-rag ingest <your-manual.pdf>  then  doc-rag ask "your question"  or  doc-rag chat`);
      if (o.keep) console.log(c.dim(`Demo library kept at ${path.join(dir, 'library')} (use --library to query it)`));
    } catch (err) {
      fail(err);
    } finally {
      if (!o.keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

program.parseAsync(process.argv).catch(fail);
