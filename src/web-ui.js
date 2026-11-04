/** Single-page agent console served at GET / (no build step, no external assets). */
export const WEB_UI = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Manual Search</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1c2230; --muted:#667085; --line:#e3e6eb; --accent:#2457d6; --ok:#137a3f; --warn:#a15c00; --bad:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12151b; --card:#1b2029; --text:#e7eaf0; --muted:#98a2b3; --line:#2b3240; --accent:#7aa2ff; --ok:#4cc38a; --warn:#f5b54a; --bad:#f97066; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 system-ui, -apple-system, Segoe UI, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 18px; font-size: 14px; }
  form { display:flex; gap:8px; flex-wrap: wrap; }
  input[type=text] { flex:1 1 320px; padding:11px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--text); font-size:15px; }
  select, button { padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--text); font-size:14px; }
  button { background: var(--accent); color:#fff; border-color: var(--accent); cursor:pointer; font-weight:600; }
  button:disabled { opacity:.6; cursor: wait; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-top:16px; }
  .answer { white-space: pre-wrap; }
  .meta { color:var(--muted); font-size:13px; margin-top:10px; }
  .pill { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; font-weight:600; border:1px solid currentColor; }
  .answered { color:var(--ok); } .partial { color:var(--warn); } .unknown { color:var(--bad); }
  .src { border-top:1px solid var(--line); padding:10px 0 2px; }
  .src b { font-weight:600; } .src .pg { color: var(--accent); font-weight:600; } .src p { margin:4px 0 0; color:var(--muted); font-size:14px; }
  .cite { color: var(--accent); font-weight:600; }
  .copy { background: transparent; color: var(--accent); border-color: var(--line); font-weight: 500; padding: 6px 10px; float: right; }
</style>
</head>
<body>
<main>
  <h1>Manual search</h1>
  <p class="sub" id="sub">Ask in plain language. Answers cite manual pages.</p>
  <form id="f">
    <input type="text" id="q" placeholder="e.g. How do I factory reset the router?" autocomplete="off" required>
    <select id="doc"><option value="">All manuals</option></select>
    <select id="style"><option value="agent">For me (agent)</option><option value="customer">Reply to customer</option></select>
    <button id="go">Ask</button>
  </form>
  <div id="out"></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
let key = ''; try { key = localStorage.getItem('docRagKey') || ''; } catch {}
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) } });
  if (res.status === 401) {
    key = prompt('API key') || '';
    try { localStorage.setItem('docRagKey', key); } catch {}
    if (key) return api(path, opts);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
api('/api/docs').then(({ docs }) => {
  $('sub').textContent = docs.length + ' manual(s) indexed - ' + docs.reduce((a, d) => a + d.pages, 0) + ' pages. Answers cite manual pages.';
  for (const d of docs) $('doc').insertAdjacentHTML('beforeend', '<option value="' + esc(d.id) + '">' + esc(d.title) + '</option>');
}).catch((e) => ($('sub').textContent = e.message));
$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('go').disabled = true;
  $('out').innerHTML = '<div class="card">Searching the manuals...</div>';
  try {
    const r = await api('/api/ask', { method: 'POST', body: JSON.stringify({ question: $('q').value, docs: $('doc').value ? [$('doc').value] : undefined, style: $('style').value }) });
    const list = r.citations.length ? r.citations : r.sources.slice(0, 3);
    $('out').innerHTML = '<div class="card"><button class="copy" id="cp" type="button">Copy</button><div class="answer">' +
      esc(r.answer).replace(/\\[(\\d{1,2})\\]/g, '<span class="cite">[$1]</span>') + '</div>' +
      '<div class="meta"><span class="pill ' + esc(r.status) + '">' + esc(r.status) + '</span> ' + esc(r.source === 'ai' ? r.model : r.source) + ' - ' + r.ms + ' ms</div></div>' +
      '<div class="card"><b>' + (r.citations.length ? 'Sources' : 'Closest passages') + '</b>' + list.map((s) =>
        '<div class="src"><span class="cite">[' + s.n + ']</span> <b>' + esc(s.title) + '</b> <span class="pg">' + esc(s.page) + '</span> ' + esc(s.section) + '<p>' + esc(s.snippet) + '</p></div>').join('') + '</div>';
    $('cp').onclick = () => navigator.clipboard?.writeText(r.answer);
  } catch (err) {
    $('out').innerHTML = '<div class="card unknown">' + esc(err.message) + '</div>';
  } finally { $('go').disabled = false; }
});
</script>
</body>
</html>`;
