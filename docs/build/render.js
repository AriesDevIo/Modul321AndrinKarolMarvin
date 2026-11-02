// Renders a Markdown document from docs/ into a styled PDF with headless Chrome
// (title page, table of contents, Mermaid diagrams, page numbers).
//
//   node docs/build/render.js documentation   → docs/Projektdokumentation.pdf
//   node docs/build/render.js testing         → docs/testing-karol.pdf
//
// Needs Google Chrome and internet access (marked + mermaid from cdn.jsdelivr.net).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DOCS = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const TITLE_ROWS = (rows) => rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('\n');
const DOCUMENTS = {
  documentation: {
    md: 'Projektdokumentation.md',
    pdf: 'Projektdokumentation.pdf',
    header: 'Distributed Event Ticketing System · M321 LB2',
    kicker: 'TBZ · Modul 321 · LB2 Projektarbeit',
    title: 'Distributed Event<br>Ticketing System',
    sub: 'Projektdokumentation · „Gate 321“',
    rows: [
      ['Modul', '321 – Verteilte Systeme programmieren'],
      ['Klasse', 'AP23a'],
      ['Team', 'Andrin (User Service, Event Service)<br>Karol Krawiec (Booking Service, PostgreSQL, Web-Frontend)<br>Marvin (Payment &amp; Notification Service, Gateway, Docker Compose)'],
      ['Lehrperson', 'Stefan Kemper'],
      ['Abgabe', '27.10.2026'],
      ['Code', 'github.com/AriesDevIo/Modul321AndrinKarolMarvin<br>Branch <code>main</code>, Tag <code>v1.0</code>'],
      ['LernMAAS-VM', 'http://10.4.31.20:8080 (via LernMAAS VPN)'],
    ],
    foot: 'The documentation is written in English. Component chapters are written by the responsible team member (see the author label at the top of each component).',
  },
  testing: {
    md: 'testing-karol.md',
    pdf: 'testing-karol.pdf',
    header: 'Testing Booking Service · Karol Krawiec · M321 LB2',
    kicker: 'TBZ · Modul 321 · LB2 · Einzelabgabe Testing',
    title: 'Testing<br>Booking Service',
    sub: 'Testdefinition · Testprotokoll · Automatisierte Tests',
    rows: [
      ['Modul', '321 – Verteilte Systeme programmieren'],
      ['Klasse', 'AP23a'],
      ['Autor', 'Karol Krawiec'],
      ['Komponente', 'Booking Service (Distributed Event Ticketing System)'],
      ['Lehrperson', 'Stefan Kemper'],
      ['Datum', '02.11.2026'],
      ['Code', 'github.com/AriesDevIo/Modul321AndrinKarolMarvin<br><code>booking-service/test/</code>, <code>scripts/ha-tests.sh</code>, Logs in <code>docs/test-logs/</code>'],
    ],
    foot: 'The document is written in English, like the project documentation.',
  },
};

const doc = DOCUMENTS[process.argv[2]];
if (!doc) {
  console.error(`usage: node render.js ${Object.keys(DOCUMENTS).join('|')}`);
  process.exit(1);
}

// Drop the Markdown file's own H1 and intro quote; the title page replaces them.
const md = fs.readFileSync(path.join(DOCS, doc.md), 'utf8').replace(/^# .*\n+(> .*\n)*/, '');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${doc.title.replace(/<br>/g, ' ')}</title>
<script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>${fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8')}</style></head>
<body>
<section class="title-page">
  <div class="title-band"><div class="kicker">${doc.kicker}</div><h1>${doc.title}</h1><div class="sub">${doc.sub}</div></div>
  <dl class="meta-grid">${TITLE_ROWS(doc.rows)}</dl>
  <div class="title-foot">${doc.foot}</div>
</section>
<section class="toc"><h2>Table of contents</h2><ol id="toc"></ol></section>
<main id="content"></main>
<script id="md" type="application/json">${JSON.stringify(md).replace(/<\//g, '<\\/')}</script>
<script>
(async () => {
  const esc = ${esc.toString()};
  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }) => lang === 'mermaid'
    ? '<div class="mermaid">' + esc(text) + '</div>'
    : '<pre><code>' + esc(text) + '</code></pre>';
  document.getElementById('content').innerHTML = marked.parse(JSON.parse(document.getElementById('md').textContent), { renderer, gfm: true });

  const toc = document.getElementById('toc');
  document.querySelectorAll('#content h2, #content h3').forEach((h, i) => {
    h.id = 's' + i;
    const m = h.textContent.match(/^([A-Z]\\.\\d+|\\d+(?:\\.\\d+)*|Appendix A:)\\s*(.*)$/);
    const appendix = m && m[1] === 'Appendix A:';
    const li = document.createElement('li');
    li.className = h.tagName === 'H2' ? 'l2' : 'l3';
    li.innerHTML = '<a href="#' + h.id + '"><span class="num"></span><span class="t"></span></a>';
    li.querySelector('.num').textContent = appendix ? 'A' : (m ? m[1] : '');
    li.querySelector('.t').textContent = appendix ? 'Appendix: ' + m[2] : (m ? m[2] : h.textContent);
    toc.appendChild(li);
  });

  mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict', themeVariables: { fontSize: '13px', fontFamily: 'Helvetica, Arial, sans-serif' } });
  await mermaid.run({ querySelector: '.mermaid' });
  window.__ready = true;
})().catch((e) => { window.__error = String(e && e.stack || e); });
</script></body></html>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
const htmlPath = path.join(tmp, 'doc.html');
fs.writeFileSync(htmlPath, html);

const PORT = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}/profile`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = (code) => { chrome.kill(); setTimeout(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); }, 300); };

(async () => {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => { const id = nextId++; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;

  await send('Page.enable');
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  await send('Page.navigate', { url: `file://${htmlPath}` });
  for (let i = 0; i < 150 && !(await evaluate('window.__ready || window.__error')); i++) await sleep(200);
  const error = await evaluate('window.__error');
  if (error) { console.error('render error:', error); return finish(1); }

  const footer = (inner) => `<div style="width:100%;font-size:8px;color:#8a8597;padding:0 20mm;text-align:right;font-family:Helvetica">${inner}</div>`;
  const { data } = await send('Page.printToPDF', {
    printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
    headerTemplate: footer(doc.header),
    footerTemplate: footer('<span class="pageNumber"></span> / <span class="totalPages"></span>'),
  });
  const out = path.join(DOCS, doc.pdf);
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
  const diagrams = await evaluate("document.querySelectorAll('.mermaid svg').length");
  const pages = (fs.readFileSync(out).toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  console.log(`wrote ${path.relative(process.cwd(), out)}: ${pages} pages, ${diagrams} diagrams`);
  finish(0);
})().catch((e) => { console.error(e); finish(1); });
