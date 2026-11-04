/** Terminal output helpers (no dependencies). Colors are off when piped or NO_COLOR is set. */

let enabled = process.stdout.isTTY && !process.env.NO_COLOR;
export const setColor = (on) => (enabled = on);
const wrap = (a, b) => (s) => (enabled ? `\x1b[${a}m${s}\x1b[${b}m` : String(s));
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  magenta: wrap(35, 39),
};

export function snippet(text, max = 220) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}...` : t;
}

export function formatSource(s, { full = false } = {}) {
  const head = `${c.cyan(`[${s.n}]`)} ${c.bold(s.title)} ${c.yellow(s.page)}${s.section ? c.dim(` - ${s.section}`) : ''}`;
  return `${head}\n    ${full ? s.text.replace(/\n/g, '\n    ') : c.dim(snippet(s.text))}`;
}

const STATUS = { answered: c.green, partial: c.yellow, unknown: c.red };

export function formatAnswer(r, { showAll = false, verbose = false } = {}) {
  const out = [];
  const color = STATUS[r.status] || ((x) => x);
  // highlight [n] markers
  out.push(r.answer.replace(/\[(\d{1,2})\]/g, (m) => c.cyan(m)));
  out.push('');
  const list = showAll ? r.sources : r.citedSources.length ? r.citedSources : r.sources.slice(0, 3);
  if (list.length) {
    out.push(c.bold(showAll || r.citedSources.length ? 'Sources' : 'Closest passages'));
    for (const s of list) out.push(formatSource(s));
    out.push('');
  }
  const via = r.source === 'ai' ? `ai ${r.model}` : r.source;
  const failed = (r.attempts || []).filter((a) => !a.ok);
  let meta = `${color(r.status)} | ${via} | search: ${r.retrieval.mode} | ${r.ms} ms`;
  if (failed.length) meta += ` | failed over: ${failed.map((a) => `${a.target} (${a.kind})`).join(', ')}`;
  if (r.retrieval.degraded?.length) meta += ` | embeddings down: ${r.retrieval.degraded.join(', ')} (keyword search used)`;
  out.push(c.dim(meta));
  if (verbose) out.push(c.dim(`retrieval query: ${r.retrieval.query}`));
  return out.join('\n');
}

export function table(rows, headers) {
  const all = [headers, ...rows].map((r) => r.map((x) => String(x ?? '')));
  const w = headers.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => r.map((x, i) => x.padEnd(w[i])).join('  ');
  return [c.bold(line(all[0])), ...all.slice(1).map(line)].join('\n');
}

/** Single-line progress bar that rewrites itself on a TTY. */
export function progress(label) {
  const tty = process.stderr.isTTY;
  let last = '';
  return {
    update(done, total, extra = '') {
      const pct = total ? Math.round((done / total) * 100) : 100;
      const bar = '#'.repeat(Math.round(pct / 5)).padEnd(20, '.');
      const msg = `${label} [${bar}] ${done}/${total} ${extra}`;
      if (tty) process.stderr.write(`\r${msg.padEnd(last.length)}`);
      last = msg;
    },
    done() {
      if (tty && last) process.stderr.write('\n');
      last = '';
    },
  };
}
