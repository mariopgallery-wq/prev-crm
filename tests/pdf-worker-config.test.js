import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('PDF.js uses the bundled ES module worker directly and follows the configured Pages base path', async () => {
  const app = await read('../src/App.jsx');
  const vite = await read('../vite.config.js');
  assert.ok(app.includes("import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'"));
  assert.ok(app.includes("pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(pdfWorkerUrl, { type: 'module' });"));
  assert.ok(!app.includes('GlobalWorkerOptions.workerSrc = pdfWorkerUrl'));
  assert.ok(vite.includes("base: './'") || vite.includes('base: "./"'));
});

test('line dragging remembers pointer movement during the long press and starts from the number handle', async () => {
  const app = await read('../src/App.jsx');
  assert.ok(app.includes('lastClientX: event.clientX, lastClientY: event.clientY,'));
  assert.ok(app.includes('reorderLineAtPoint(drag, drag.lastClientX, drag.lastClientY);'));
  assert.ok(app.includes('onPointerDown={e => startLineDrag(e, line.id)}'));
});

test('the customer name keeps the exact letter case entered and printed', async () => {
  const app = await read('../src/App.jsx');
  const css = await read('../src/styles.css');
  assert.ok(app.includes('client: draft.client.trim()'));
  assert.ok(app.includes("<strong>{draft.client || 'NOME CLIENTE'}</strong>"));
  assert.ok(!css.includes('.quote-recipient>strong{font-size:12px;text-transform:uppercase}'));
});

test('printing shows only the A4 quote template and excludes editor revision history', async () => {
  const app = await read('../src/App.jsx');
  const css = await read('../src/styles.css');
  assert.match(app, /document\.body\.classList\.add\('print-quote-only'\)/);
  assert.match(app, /document\.body\.classList\.remove\('print-quote-only'\)/);
  assert.match(css, /body\.print-quote-only \*\s*\{\s*visibility:\s*hidden\s*!important/i);
  assert.match(css, /body\.print-quote-only #quote-document,\s*body\.print-quote-only #quote-document \*\s*\{\s*visibility:\s*visible\s*!important/i);
  assert.match(css, /@page\s*\{\s*size\s*:\s*A4 portrait/i);
  assert.match(css, /\.page-editor\s*>\s*:not\(\.editor-layout\)\s*\{\s*display:\s*none\s*!important/i);
  assert.match(css, /\.revision-history-card\s*,[\s\S]*?display:\s*none\s*!important/i);
  assert.match(css, /\.editor-layout\s*>\s*\.edit-panel\s*\{\s*display:\s*none\s*!important/i);
  assert.match(css, /\.editor-layout\s*>\s*\.preview-panel\s*>\s*:not\(\.preview-paper-wrap\)/);
  assert.match(css, /#quote-document\s*\{[\s\S]*?width:\s*184mm\s*!important/i);
});

test('PDF save suggests a filename from quote number, customer, address, category and company', async () => {
  const app = await read('../src/App.jsx');
  assert.ok(app.includes('function safeFilenamePart(value)'));
  assert.ok(app.includes('function buildQuotePdfBasename(quote = {})'));
  assert.ok(app.includes("safeFilenamePart(quote.number) || 'Preventivo'"));
  assert.ok(app.includes('safeFilenamePart(quote.client)'));
  assert.ok(app.includes('safeFilenamePart(quote.address)'));
  assert.ok(app.includes('safeFilenamePart(quote.category)'));
  assert.ok(app.includes("'Chiaradia Impianti'"));
  assert.ok(app.includes('document.title = buildQuotePdfBasename(draft);'));
  assert.ok(app.includes("window.addEventListener('afterprint', restorePrintState, { once: true });"));
  assert.equal((app.match(/onClick=\{printQuote\}/g) || []).length, 3);
  assert.doesNotMatch(app, /onClick=\{\(\) => window\.print\(\)\}/);
});

test('GitHub Pages workflow checks the Vite-emitted worker asset instead of an unrelated public file path', async () => {
  const workflow = await read('../.github/workflows/deploy.yml');
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /pdf\.worker\*\.mjs/);
  assert.match(workflow, /dist\/assets/);
  assert.doesNotMatch(workflow, /test -s dist\/pdf\.worker\.min\.mjs/);
});

test('the package exposes test and build scripts and includes PDF.js', async () => {
  const pkg = JSON.parse(await read('../package.json'));
  assert.equal(pkg.scripts.test, 'node --test');
  assert.equal(pkg.scripts.build, 'vite build');
  assert.ok(pkg.dependencies['pdfjs-dist']);
});


test('GitHub Pages deploy runs automatically on main, checks pull requests, and remains manually runnable', async () => {
  const workflow = await read('../.github/workflows/deploy.yml');
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /actions\/upload-pages-artifact@v5/);
  assert.match(workflow, /actions\/deploy-pages@v5/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
});


test('quote line descriptions preserve line breaks in the printed bullet list', async () => {
  const app = await read('../src/App.jsx');
  const css = await read('../src/styles.css');
  assert.ok(app.includes('<span className="quote-bullet-marker" aria-hidden="true">•</span>'));
  assert.ok(app.includes('<span className="quote-bullet-text">{line.desc}</span>'));
  assert.match(css, /\.quote-bullet-text\s*\{[^}]*white-space:\s*pre-line/s);
  assert.ok(app.includes("desc: String(line.desc || '').trim()"));
});

test('client phone, email and PEC are optional quote fields saved and printed', async () => {
  const app = await read('../src/App.jsx');
  const domain = await read('../src/lib/domain.js');
  for (const field of ['phone', 'email', 'pec']) {
    assert.ok(app.includes(`id="q-${field}"`));
    assert.ok(app.includes(`{draft.${field} && <div>`));
    assert.ok(domain.includes(`${field}: ''`));
    assert.ok(domain.includes(`String(q.${field} || '')`));
  }
});

test('editor catalog suggestions combine catalog and saved quotes only within the selected category', async () => {
  const app = await read('../src/App.jsx');
  assert.match(app, /filter\(item => item && item\.cat === category\)/);
  assert.match(app, /filter\(quote => quote && quote\.category === category\)/);
  assert.ok(app.includes('[db.items, db.quotes, draft?.category]'));
  assert.ok(app.includes('const options = editorCatalogItems'));
});

test('quote print layout reserves a fixed amount column and confines all article text to its column', async () => {
  const css = await read('../src/styles.css');
  assert.match(css, /--quote-amount-column:\s*28mm/);
  assert.match(css, /\.quote-table-header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--quote-amount-column\)/s);
  assert.match(css, /\.quote-description-body\s*\{[^}]*display:\s*grid\s*!important[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--quote-amount-column\)/s);
  assert.match(css, /\.quote-description-body\s*>\s*:not\(\.quote-bullets\)\s*\{[^}]*grid-column:\s*1/s);
  assert.match(css, /\.quote-bullets li\s*\{[^}]*grid-template-columns:\s*4mm\s+minmax\(0,\s*1fr\)\s+var\(--quote-amount-column\)/s);
  assert.match(css, /\.quote-line-amount\s*\{[^}]*grid-column:\s*3/s);
  assert.match(css, /@media print\s*\{[\s\S]*?\.quote-description-body\s*\{[^}]*display:\s*grid\s*!important/s);
});


test('editor always shows a dedicated history toggle and keeps the history and restore panel closed by default', async () => {
  const app = await read('../src/App.jsx');
  const css = await read('../src/styles.css');
  assert.match(app, /const \[revisionHistoryOpen, setRevisionHistoryOpen\] = useState\(false\)/);
  assert.match(app, /<div className="editor-revision-toolbar">/);
  assert.match(app, /aria-expanded=\{revisionHistoryOpen\}/);
  assert.match(app, /aria-controls="revision-history-panel"/);
  assert.match(app, /onClick=\{\(\) => setRevisionHistoryOpen\(open => !open\)\}/);
  assert.match(app, /revisionHistoryOpen && \(/);
  assert.match(app, /Cronologia e ripristino/);
  assert.match(app, /Chiudi cronologia e ripristino/);
  assert.match(app, /Salva prima il preventivo/);
  assert.match(css, /\.editor-revision-toolbar \{[^}]*display:flex/s);
  assert.match(css, /\.editor-revision-toolbar \.revision-toggle\[aria-expanded="true"\]/);
  const printStyles = css.slice(css.lastIndexOf('@media print'));
  assert.match(printStyles, /\.editor-revision-toolbar,[\s\S]*?\.revision-history-card[\s\S]*?display:\s*none\s*!important/);
});

test('ARTICOLO remains left aligned when the IMPORTO column is absent', async () => {
  const css = await read('../src/styles.css');
  assert.match(css, /\.quote-table-header\.no-visible-amount > span:first-child \{[^}]*text-align:\s*left !important/s);
  assert.doesNotMatch(css, /\.quote-table-header span:last-child\s*\{\s*text-align:\s*right/);
  assert.match(css, /\.quote-table-header\.has-visible-amount > span:last-child/);
});

test('deploy build emits an auto-updating service worker and registers it for the GitHub Pages base path', async () => {
  const vite = await read('../vite.config.js');
  const main = await read('../src/main.jsx');
  assert.match(vite, /emitFile\(\{ type: 'asset', fileName: 'sw\.js'/);
  assert.match(vite, /assets\.map\(file => `\.\/\$\{file\}`\)/);
  assert.match(vite, /self\.skipWaiting\(\)/);
  assert.match(vite, /self\.clients\.claim\(\)/);
  assert.match(main, /navigator\.serviceWorker\.register\(`\$\{import\.meta\.env\.BASE_URL\}sw\.js`/);
  assert.match(main, /registration\.update\(\)/);
  assert.match(main, /window\.addEventListener\('online', checkForAppUpdate\)/);
  assert.match(main, /visibilitychange/);
  assert.match(main, /window\.location\.reload\(\)/);
});

test('new quote template does not prefill sample title, intro or payment examples', async () => {
  const domain = await read('../src/lib/domain.js');
  const app = await read('../src/App.jsx');
  assert.match(domain, /title: ''/);
  assert.match(domain, /subtitle: '', intro: ''/);
  assert.match(domain, /payment: ''/);
  assert.doesNotMatch(app, /title: parsed\.title \|\| 'Preventivo per fornitura e posa in opera'/);
  assert.doesNotMatch(app, /payment: initial\.payment \|\| '70% a conferma lavoro/);
});
