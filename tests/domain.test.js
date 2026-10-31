import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CATEGORIES, DEFAULT_SETTINGS, defaultDb, normalizeDb, calcTotal,
  quoteNumber, newDraft, escapeName, formatDate, dashboardGreeting,
} from '../src/lib/domain.js';

test('default workspace contains all six sectors and company settings', () => {
  const db = defaultDb();
  assert.equal(CATEGORIES.length, 6);
  assert.deepEqual(db.quotes, []);
  assert.deepEqual(db.items, []);
  assert.deepEqual(db.clients, []);
  assert.equal(db.settings.name, DEFAULT_SETTINGS.name);
  assert.equal(db.settings.defaultVat, 10);
});

test('dashboard greeting follows the requested local-time ranges and exact boundaries', () => {
  const localTime = (hour, minute = 0) => new Date(2026, 9, 31, hour, minute, 0);
  assert.equal(dashboardGreeting(localTime(3, 59)), 'Buonasera');
  assert.equal(dashboardGreeting(localTime(4, 0)), 'Buongiorno');
  assert.equal(dashboardGreeting(localTime(14, 59)), 'Buongiorno');
  assert.equal(dashboardGreeting(localTime(15, 0)), 'Buon pomeriggio');
  assert.equal(dashboardGreeting(localTime(19, 59)), 'Buon pomeriggio');
  assert.equal(dashboardGreeting(localTime(20, 0)), 'Buonasera');
  assert.equal(dashboardGreeting(localTime(23, 59)), 'Buonasera');
  assert.equal(dashboardGreeting(localTime(0, 0)), 'Buonasera');
});

test('dashboard greeting uses the configured company name from settings', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.ok(app.includes('<h1>{dashboardGreeting()}, {String(db.settings?.name || DEFAULT_SETTINGS.name).trim() || DEFAULT_SETTINGS.name}'), 'dashboard heading must read the company name from settings');
  assert.doesNotMatch(app, /Buongiorno, Chiaradia/);
});

test('new quote inherits the configured VAT and payment terms', () => {
  const db = defaultDb();
  db.settings.defaultVat = 22;
  db.settings.payment = 'Bonifico bancario';
  const draft = newDraft(db);
  assert.equal(draft.vatRate, 22);
  assert.equal(draft.payment, 'Bonifico bancario');
  assert.equal(draft.status, 'Bozza');
  assert.equal(draft.id, null);
  assert.match(draft.number, /^P 01\.\d{2}$/);
});

test('VAT and grand total calculate to cents and clamp invalid values', () => {
  assert.deepEqual(calcTotal({ net: '199.99', vatRate: 22 }), {
    net: 199.99, vat: 44, rate: 22, total: 243.99,
  });
  assert.deepEqual(calcTotal({ net: -12, vatRate: -5 }), {
    net: 0, vat: 0, rate: 0, total: 0,
  });
  assert.deepEqual(calcTotal({ net: 10, vatRate: 150 }), {
    net: 10, vat: 10, rate: 100, total: 20,
  });
});

test('quote numbering increments the largest number in the current year only', () => {
  const yy = String(new Date().getFullYear()).slice(-2);
  assert.equal(quoteNumber([]), `P 01.${yy}`);
  assert.equal(quoteNumber([{ number: `P 01.${yy}` }, { number: `P 03.${yy}` }, { number: 'P 99.99' }]), `P 04.${yy}`);
});

test('database normalization tolerates malformed or legacy records without losing valid data', () => {
  const db = normalizeDb({
    quotes: [null, { number: 'P 07.26', client: 'Mario Rossi', net: '100.00', vatRate: 10, lines: [{ desc: 'Installazione' }] }],
    items: [null, { desc: 'Presa elettrica', cat: 'non noto' }],
    clients: [null, { name: '   ' }, { name: 'Mario Rossi', address: 'Via Roma' }],
    settings: { defaultVat: '150' },
  });
  assert.equal(db.quotes.length, 1);
  assert.equal(db.quotes[0].client, 'Mario Rossi');
  assert.equal(db.quotes[0].vat, 10);
  assert.equal(db.quotes[0].total, 110);
  assert.ok(db.quotes[0].lines[0].id);
  assert.equal(db.items.length, 1);
  assert.equal(db.items[0].cat, CATEGORIES[0]);
  assert.deepEqual(db.clients.map(c => c.name), ['Mario Rossi']);
  assert.equal(db.settings.defaultVat, 100);
});

test('client matching ignores leading/trailing whitespace and capitalization', () => {
  assert.equal(escapeName('  MARIO Rossi '), 'mario rossi');
  assert.equal(escapeName(null), '');
});

test('date formatting safely handles missing and invalid dates', () => {
  assert.equal(formatDate(''), '—');
  assert.equal(formatDate('not-a-date'), 'not-a-date');
  assert.match(formatDate('2026-10-27'), /27/);
});

test('normalization preserves editor-only line costs without adding them to the quote total', () => {
  const db = normalizeDb({
    quotes: [{
      number: 'P 08.26', client: 'Mario Rossi', net: 100, vatRate: 10, total: 110,
      lines: [{ id: 'line-1', desc: 'Installazione', internalPrice: 23.5 }],
    }],
  });
  assert.equal(db.quotes[0].lines[0].internalPrice, 23.5);
  assert.equal(calcTotal(db.quotes[0]).total, 110);
});

test('normalization preserves per-activity price visibility and keeps the quote total independent', () => {
  const db = normalizeDb({
    quotes: [{
      number: 'P 08.26', client: 'Mario Rossi', net: 100, vatRate: 10,
      lines: [
        { id: 'line-visible', desc: 'Installazione quadro', internalPrice: 23.5, showPrice: true },
        { id: 'line-hidden', desc: 'Verifica impianto', internalPrice: 12, showPrice: false },
        { id: 'line-legacy', desc: 'Sostituzione presa', internalPrice: 8 },
      ],
    }],
  });
  const [visible, hidden, legacy] = db.quotes[0].lines;
  assert.equal(visible.showPrice, true);
  assert.equal(hidden.showPrice, false);
  assert.equal(legacy.showPrice, false, 'old records without the setting default to hidden');
  assert.equal(calcTotal(db.quotes[0]).total, 110, 'per-line prices do not change the quote grand total');
});

test('normalization preserves deleted items and confirmed category templates without schema changes', () => {
  const entry = { id: 'trash-1', type: 'quote', label: 'P 01.26 · Cliente', deletedAt: '2026-10-28T10:00:00.000Z', data: { id: 'q1', number: 'P 01.26', client: 'Cliente' } };
  const template = { confirmed: true, confirmedAt: '2026-10-28T10:00:00.000Z', lines: ['Installazione quadro', 'Verifica impianto'] };
  const db = normalizeDb({ quotes: [], clients: [], items: [], trash: [entry], settings: { categoryTemplates: { 'Impianto elettrico': template } } });
  assert.equal(db.trash.length, 1);
  assert.equal(db.trash[0].data.id, 'q1');
  assert.deepEqual(db.settings.categoryTemplates['Impianto elettrico'].lines, template.lines);
  assert.equal(db.settings.categoryTemplates['Impianto elettrico'].confirmed, true);
});

test('normalization ignores malformed trash entries but keeps valid workspace data', () => {
  const db = normalizeDb({ quotes: [{ id: 'q1', client: 'Mario', lines: [] }], trash: [null, { type: 'unknown', data: {} }, { type: 'client', data: { name: 'Anna' } }] });
  assert.equal(db.quotes.length, 1);
  assert.equal(db.trash.length, 1);
  assert.equal(db.trash[0].type, 'client');
});


test('every quote line shows catalog and saved-quote suggestions only from the selected category', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('const editorCatalogItems = useMemo');
  const end = app.indexOf('const clientItems', start);
  assert.ok(start >= 0 && end > start);
  const catalog = app.slice(start, end);
  assert.match(catalog, /Array\.isArray\(db\.items\)/);
  assert.match(catalog, /item\.cat === category/);
  assert.match(catalog, /Array\.isArray\(db\.quotes\)/);
  assert.match(catalog, /quote\.category === category/);
  assert.match(catalog, /Array\.isArray\(quote\.lines\)/);
  assert.match(catalog, /\[db\.items, db\.quotes, draft\?\.category\]/);
  const rowStart = app.indexOf('draft.lines.map((line, index)');
  const rowEnd = app.indexOf('</div><div className="internal-cost-summary"', rowStart);
  assert.ok(rowStart >= 0 && rowEnd > rowStart);
  const row = app.slice(rowStart, rowEnd);
  assert.match(row, /const options = editorCatalogItems/);
  assert.match(row, /<select className="insert-suggestion"/);
  assert.match(row, /Inserisci dal catalogo…/);
  assert.match(row, /Catalogo vuoto/);
  assert.match(row, /options\.map\(item => <option/);
  assert.doesNotMatch(row, /\{options\.length > 0 && <select/);
});

test('quote editor exposes three distinct optional customer contact fields', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('<div className="client-contact-heading">');
  const end = app.indexOf('</section>', start);
  assert.ok(start >= 0 && end > start);
  const contacts = app.slice(start, end);
  assert.match(contacts, /id="q-phone" type="tel"/);
  assert.match(contacts, /id="q-email" type="email"/);
  assert.match(contacts, /id="q-pec" type="email"/);
  assert.match(contacts, /facoltativo/);
});

test('each non-empty activity has an explicit bullet marker in preview and print, including flex list rows', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(app, /<ul className="quote-bullets">[\s\S]*?className="quote-bullet-marker"/);
  assert.match(app, /className="quote-bullet-marker"[^>]*>•<\/span>/);
  assert.match(css, /\.quote-bullets li\s*\{[^}]*display:flex/s);
  assert.match(css, /\.quote-bullet-marker\s*\{[^}]*display:\s*inline-block/s);
  const printStyles = css.slice(css.lastIndexOf('@media print'));
  assert.match(printStyles, /\.quote-bullet-marker/);
});

test('editor provides a per-activity eye control that toggles printed price visibility', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const rowStart = app.indexOf('<div className="description-lines">');
  const rowEnd = app.indexOf('</div><div className="internal-cost-summary">', rowStart);
  assert.ok(rowStart >= 0 && rowEnd > rowStart);
  const row = app.slice(rowStart, rowEnd);
  assert.match(row, /aria-pressed=\{line\.showPrice === true\}/);
  assert.match(row, /item\.showPrice!==true/);
  assert.match(row, /<Eye size=\{16\}\/>/);
  assert.match(row, /<EyeOff size=\{16\}\/>/);
  assert.match(row, /Prezzo €/);
  assert.match(row, /showPrice:item\.showPrice!==true/);
});

test('the numbered activity handle supports deliberate long-press drag and keyboard reordering', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('const startLineDrag = (event, id) => {');
  const move = app.indexOf('const moveLineDrag = (event) => {', start);
  const end = app.indexOf('const moveLineByKeyboard', move);
  assert.ok(start >= 0 && move > start && end > move);
  const gesture = app.slice(start, end);
  assert.match(gesture, /setPointerCapture\?\.\(pointerId\)/);
  assert.match(gesture, /}, 380\)/);
  assert.match(gesture, /elementFromPoint\(event\.clientX, event\.clientY\)/);
  const handleStart = app.indexOf('className="description-bullet description-drag-handle"');
  const handleEnd = app.indexOf('</button>', handleStart);
  const handle = app.slice(handleStart, handleEnd);
  assert.match(handle, /onPointerDown=\{e => startLineDrag\(e, line\.id\)\}/);
  assert.match(handle, /onPointerMove=\{moveLineDrag\}/);
  assert.match(handle, /onLostPointerCapture=\{finishLineDrag\}/);
  assert.match(handle, /moveLineByKeyboard\(line\.id, -1\)/);
  const textareaStart = app.indexOf('aria-label={`Descrizione lavoro ${index + 1}`}');
  const textareaEnd = app.indexOf('/>', textareaStart);
  assert.doesNotMatch(app.slice(textareaStart, textareaEnd), /onPointerDown|startLineDrag/);
});

test('ordinary navigation preserves the draft and shows a resume control outside the editor', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('const setPage = (id) => {');
  const end = app.indexOf('const pageTitle', start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(app.slice(start, end), /setDraft\(null\)/);
  assert.match(app, /if \(draft\) \{\s*setView\('editor'\)/);
  assert.match(app, /draft && view !== 'editor' && <div className="draft-resume-banner"/);
  assert.match(app, /draft \? 'Riprendi preventivo' : 'Nuovo preventivo'/);
});

test('explicit return to the archive cancels unsaved changes but does not write to the workspace', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('const returnToArchive = () => {');
  const end = app.indexOf('\n  };', start);
  assert.ok(start >= 0 && end > start);
  const cancel = app.slice(start, end);
  assert.match(cancel, /setDraft\(null\)/);
  assert.match(cancel, /setView\('history'\)/);
  assert.doesNotMatch(cancel, /updateDb|saveQuote|supabase/);
  const backIndex = app.indexOf("onClick={returnToArchive}");
  assert.ok(backIndex >= 0, 'editor back button must explicitly discard');
  assert.ok(app.slice(backIndex, backIndex + 250).includes("Torna all’archivio"));
});

test('reopening the same quote resumes its in-memory draft instead of overwriting it', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('const editQuote = (quote) => {');
  const end = app.indexOf('const updateDraft', start);
  assert.ok(start >= 0 && end > start);
  const edit = app.slice(start, end);
  assert.match(edit, /draft\?\.id && draft\.id === quote\.id/);
  assert.match(edit, /setView\('editor'\)/);
});


test('starting a second quote or duplicate from another section asks before replacing the current draft', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const confirmReplaceDraft = \(nextAction\) => \{/);
  assert.match(app, /createQuoteForCategory = \(category\) => \{\s*if \(!confirmReplaceDraft/);
  assert.match(app, /createQuoteForClient = \(client\) => \{\s*if \(!confirmReplaceDraft/);
  assert.match(app, /const duplicateQuote = \(quote\) => \{\s*if \(!confirmReplaceDraft/);
  assert.match(app, /onClick=\{\(\) => createQuoteForCategory\(cat\)\}/);
  assert.match(app, /onClick=\{\(\) => createQuoteForClient\(client\)\}/);
});


test('print header shows IMPORTO only when at least one line price is enabled and valid', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const hasVisibleLinePrice = \(draft\.lines \|\| \[\]\)\.some/);
  assert.match(app, /line\.showPrice === true && value !== null && value !== '' && Number\.isFinite\(Number\(value\)\)/);
  assert.match(app, /\{hasVisibleLinePrice && <span>IMPORTO<\/span>\}/);
  assert.match(app, /hasVisibleLinePrice \? ' has-visible-amount' : ' no-visible-amount'/);
});
