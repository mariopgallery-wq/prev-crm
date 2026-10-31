import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseQuoteText } from '../src/lib/importQuote.js';

test('recognizes client, quote number, date, category and priced work lines from text', () => {
  const text = `PREVENTIVO N. P 17/26\nData emissione: 12/03/2026\nCliente: Mario Rossi\nIndirizzo: Via Roma 12\nP. IVA: 12345678901\nSettore impianto elettrico\nFornitura e posa quadro elettrico € 1.200,00\nInstallazione prese € 350,00\nImponibile: € 1.550,00\nIVA 10%: € 155,00\nTotale documento: € 1.705,00`;
  const result = parseQuoteText(text, 'preventivo.pdf', { settings: { defaultVat: 10 } });
  assert.equal(result.client, 'Mario Rossi');
  assert.match(result.number, /17\/26/);
  assert.equal(result.date, '2026-03-12');
  assert.equal(result.category, 'Impianto elettrico');
  assert.equal(result.total, 1550);
  assert.equal(result.lines.find(line => line.desc.includes('quadro elettrico'))?.amount, 1200);
  assert.equal(result.lines.find(line => line.desc.includes('prese'))?.amount, 350);
});

test('does not throw on incomplete text and asks the user to verify missing fields', () => {
  const result = parseQuoteText('Documento senza campi riconoscibili', 'scan.pdf', { settings: { defaultVat: 10 } });
  assert.equal(typeof result.client, 'string');
  assert.ok(result.warnings.length > 0);
  assert.ok(Array.isArray(result.lines));
});

test('uses the page layout to separate company header, customer, quote data, payment terms, work descriptions and totals', () => {
  const content = [
    'CHIARADIA IMPIANTI', 'Di Filippo Chiaradia', 'C.da graviglione 9',
    '70024 – Gravina in Puglia (BA)', 'P. IVA 08623720722', 'PEC: chiaradiafilippo@pec.it',
    'DIMATTIA GIUSEPPE', 'LOCALE DI CULTO', '26900 LODI (LO)',
    'P 31.26', 'Data: 24/10/2026', 'Termini: 70% a conferma lavoro', '30% a completamento',
    'ARTICOLO IMPORTO', 'Preventivo per fornitura e posa in opera di un climatizzatore mono split',
    'Hisense Console 18000btu A++', 'Si precisa quanto segue:',
    'La valutazione è stata fatta in base alla qualità delle categorie dei lavori indicati verbalmente in sede',
    'di sopralluogo effettuato con il committente ed elencati in lista;',
    'Il preventivo include:', 'Fornitura e posa quadro elettrico', 'Totale imponibile: 17.500,00 €',
    'IVA (10%): 1.750,00 €', 'Totale: 19.250,00 €',
  ];
  const layoutLines = content.map((text, index) => ({
    text, page: 1, yNorm: 0.08 + index * 0.018, top: (0.08 + index * 0.018) * 842,
    x: 0.08, xEnd: 0.95, fontSize: 10,
    segments: [{ text, x: 0.08, xEnd: 0.5, fontSize: 10 }],
  }));
  const setLine = (text, updates) => {
    const line = layoutLines.find(item => item.text === text);
    Object.assign(line, updates);
    line.top = line.yNorm * 842;
  };
  setLine('CHIARADIA IMPIANTI', { yNorm: 0.08 });
  for (const text of content.slice(1, 6)) setLine(text, { yNorm: 0.11 });
  setLine('DIMATTIA GIUSEPPE', {
    text: 'DIMATTIA GIUSEPPE P 31.26', yNorm: 0.23,
    segments: [
      { text: 'DIMATTIA GIUSEPPE', x: 0.08, xEnd: 0.33, fontSize: 10 },
      { text: 'P 31.26', x: 0.80, xEnd: 0.91, fontSize: 10 },
    ],
  });
  setLine('LOCALE DI CULTO', { yNorm: 0.25 });
  setLine('26900 LODI (LO)', { yNorm: 0.27 });
  setLine('P 31.26', { yNorm: 0.23, x: 0.80, segments: [{ text: 'P 31.26', x: 0.80, xEnd: 0.91, fontSize: 10 }] });
  setLine('Data: 24/10/2026', { yNorm: 0.25, x: 0.62, segments: [{ text: 'Data: 24/10/2026', x: 0.62, xEnd: 0.95, fontSize: 10 }] });
  setLine('Termini: 70% a conferma lavoro', { yNorm: 0.27, x: 0.62, segments: [{ text: 'Termini: 70% a conferma lavoro', x: 0.62, xEnd: 0.95, fontSize: 10 }] });
  setLine('30% a completamento', { yNorm: 0.29, x: 0.72, segments: [{ text: '30% a completamento', x: 0.72, xEnd: 0.95, fontSize: 10 }] });
  setLine('ARTICOLO IMPORTO', { yNorm: 0.31, segments: [
    { text: 'ARTICOLO', x: 0.08, xEnd: 0.30, fontSize: 10 },
    { text: 'IMPORTO', x: 0.84, xEnd: 0.95, fontSize: 10 },
  ] });
  setLine('Preventivo per fornitura e posa in opera di un climatizzatore mono split', { yNorm: 0.33 });
  setLine('Hisense Console 18000btu A++', { yNorm: 0.348 });
  setLine('Si precisa quanto segue:', { yNorm: 0.37 });
  setLine('La valutazione è stata fatta in base alla qualità delle categorie dei lavori indicati verbalmente in sede', { yNorm: 0.395 });
  setLine('di sopralluogo effettuato con il committente ed elencati in lista;', { yNorm: 0.41 });
  setLine('Il preventivo include:', { yNorm: 0.445 });
  setLine('Fornitura e posa quadro elettrico', { yNorm: 0.47, segments: [
    { text: 'Fornitura e posa quadro elettrico', x: 0.10, xEnd: 0.52, fontSize: 10 },
    { text: '1.200,00 €', x: 0.84, xEnd: 0.95, fontSize: 10 },
  ], text: 'Fornitura e posa quadro elettrico 1.200,00 €' });
  setLine('Totale imponibile: 17.500,00 €', { yNorm: 0.91 });
  setLine('IVA (10%): 1.750,00 €', { yNorm: 0.94 });
  setLine('Totale: 19.250,00 €', { yNorm: 0.96 });
  const result = parseQuoteText(content.join('\n'), 'preventivo-modello.pdf', { settings: { defaultVat: 10 } }, { layoutLines });

  assert.equal(result.client, 'DIMATTIA GIUSEPPE');
  assert.equal(result.number, 'P 31.26');
  assert.equal(result.date, '2026-10-24');
  assert.equal(result.tax, '', 'the company VAT number must not become the customer tax number');
  assert.equal(result.address, '', 'a site descriptor must not be placed in the street-address field');
  assert.equal(result.place, 'LOCALE DI CULTO · 26900 LODI (LO)', 'site descriptor and postal locality belong to customer location notes');
  assert.equal(result.payment, '70% a conferma lavoro\n30% a completamento');
  assert.equal(result.category, 'Climatizzazione');
  assert.equal(result.total, 17500);
  assert.equal(result.title, 'Preventivo per fornitura e posa in opera di un climatizzatore mono split');
  assert.equal(result.subtitle, 'Hisense Console 18000btu A++');
  assert.match(result.intro, /La valutazione è stata fatta/);
  assert.match(result.intro, /Il preventivo include:/);
  assert.equal(result.lines.find(line => line.desc === 'Fornitura e posa quadro elettrico')?.amount, 1200);
  assert.ok(!result.lines.some(line => /^Il preventivo include:/i.test(line.desc)));
  assert.ok(result.lines.every(line => !/CHIARADIA|DIMATTIA|P 31\.26|Totale imponibile|19\.250/.test(line.desc)));
});

test('infers the customer from the lower header area in a Word-style text extraction and does not copy company P.IVA', () => {
  const text = `CHIARADIA IMPIANTI\nDi Filippo Chiaradia\nC.da graviglione 9\n70024 – Gravina in Puglia (BA)\nP. IVA 08623720722\nPEC: chiaradiafilippo@pec.it\nCell: 3395046509\nE-mail: filippochiaradia@hotmail.it\nDIMATTIA GIUSEPPE\nLOCALE DI CULTO\n26900 LODI (LO)\nP 31.26\nData: 24/10/2026\nTermini: 70% a conferma lavoro\n30% a completamento\nARTICOLO IMPORTO\nPreventivo per fornitura e posa in opera di un climatizzatore mono split\nHisense Console 18000btu A++\nSi precisa quanto segue:\nInstallazione di climatizzatore\nTotale imponibile: 17.500,00 €\nIVA (10%): 1.750,00 €\nTotale: 19.250,00 €`;
  const result = parseQuoteText(text, 'preventivo.docx', { settings: { defaultVat: 10 } });
  assert.equal(result.client, 'DIMATTIA GIUSEPPE');
  assert.equal(result.number, 'P 31.26');
  assert.equal(result.date, '2026-10-24');
  assert.equal(result.tax, '');
  assert.equal(result.address, '', 'a site descriptor must not be placed in the street-address field');
  assert.equal(result.place, 'LOCALE DI CULTO · 26900 LODI (LO)', 'site descriptor and postal locality belong to customer location notes');
  assert.equal(result.payment, '70% a conferma lavoro\n30% a completamento');
  assert.equal(result.total, 17500);
  assert.ok(result.lines.some(line => line.desc === 'Installazione di climatizzatore'));
});

test('keeps intentionally repeated description rows instead of deduplicating them', () => {
  const text = `Preventivo n. P 07.26\nData: 12/03/2026\nCliente: Mario Rossi\nARTICOLO IMPORTO\nInstallazione presa elettrica\nInstallazione presa elettrica\nTotale imponibile: 100,00 €\nIVA 10%: 10,00 €\nTotale: 110,00 €`;
  const result = parseQuoteText(text, 'repeat.docx', { settings: { defaultVat: 10 } });
  assert.equal(result.lines.filter(line => line.desc === 'Installazione presa elettrica').length, 2);
});


test('customer document renders a line price only when its per-line visibility switch is enabled', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('function QuoteDocument');
  const end = app.indexOf('export default function App', start);
  assert.ok(start >= 0 && end > start, 'QuoteDocument component should exist');
  const documentComponent = app.slice(start, end);
  assert.match(documentComponent, /line\.desc/);
  assert.match(documentComponent, /line\.showPrice === true/);
  assert.match(documentComponent, /className="quote-line-amount"/);
  assert.match(documentComponent, /money\(linePrice\)/);
});

test('recognizes integer euro prices with thousands separators without mistaking ordinary counts for prices', () => {
  const text = `Preventivo n. P 09.26\nData: 15/04/2026\nCliente: Mario Rossi\nARTICOLO IMPORTO\nFornitura materiale 1.200 €\nInstallazione di 2 unità\nTotale imponibile: 1.200,00 €`;
  const result = parseQuoteText(text, 'interi.docx', { settings: { defaultVat: 10 } });
  assert.equal(result.lines.find(line => line.desc === 'Fornitura materiale')?.amount, 1200);
  assert.equal(result.lines.find(line => line.desc === 'Installazione di 2 unità')?.amount, null);
});


test('regression: header/customer/payment text is never imported as work descriptions or street address', () => {
  const text = `CHIARADIA IMPIANTI\nDi Filippo Chiaradia\nC.da graviglione 9\n70024 – Gravina in Puglia (BA)\nP. IVA 08623720722\nPEC: chiaradiafilippo@pec.it\nDIMATTIA GIUSEPPE\nLOCALE DI CULTO\n26900 LODI (LO)\nP 31.26\nData: 24/10/2026\nTermini: 70% a conferma lavoro\n30% a completamento\nARTICOLO IMPORTO\nPreventivo per fornitura e posa in opera di un climatizzatore mono split\nHisense Console 18000btu A++\nSi precisa quanto segue:\nLa valutazione è stata fatta in base alla qualità e tipologia delle categorie dei lavori indicati verbalmente in sede\ndi sopralluogo effettuato con il committente ed elencati in lista;\nIl preventivo include:\nRealizzazione della linea di alimentazione dei climatizzatori mt 10 circa, escluso di tracce.\nTotale imponibile: 17.500,00 €\nIVA (10%): 1.750,00 €\nTotale: 19.250,00 €`;
  const result = parseQuoteText(text, 'P.31-26 DIMATTIA GIUSEPPE LOCALE DI CULTO LODI DUAL 18+18000 HISENSE CONSOLE.pdf', { settings: { defaultVat: 10, address: 'C.da graviglione 9', vat: '08623720722', name: 'CHIARADIA IMPIANTI' } });
  assert.equal(result.client, 'DIMATTIA GIUSEPPE');
  assert.equal(result.number, 'P 31.26', 'prefer the number read from the document over the filename fallback');
  assert.equal(result.date, '2026-10-24');
  assert.equal(result.address, '');
  assert.equal(result.tax, '');
  assert.equal(result.payment, '70% a conferma lavoro\n30% a completamento');
  assert.match(result.title, /Preventivo per fornitura e posa/);
  assert.match(result.subtitle, /Hisense Console/);
  assert.match(result.intro, /La valutazione è stata fatta/);
  assert.ok(result.lines.some(line => line.desc === 'Realizzazione della linea di alimentazione dei climatizzatori mt 10 circa, escluso di tracce.'));
  assert.ok(result.lines.every(line => !/CHIARADIA|DIMATTIA|LOCALE DI CULTO|26900 LODI|P 31[.-]26|Termini:|30% a completamento|ed elencati in lista|di sopralluogo effettuato/i.test(line.desc)), `Unexpected header or intro text in lines: ${JSON.stringify(result.lines)}`);
});

test('uses the number at the start of the filename only when the document itself has no quote number', () => {
  const text = `CHIARADIA IMPIANTI\nDi Filippo Chiaradia\nDIMATTIA GIUSEPPE\n26900 LODI (LO)\nData: 24/10/2026\nARTICOLO IMPORTO\nPreventivo per climatizzatore\nHisense Console 18000Btu A++\nIl preventivo include:\nInstallazione climatizzatore\nTotale imponibile: 17.500,00 €`;
  const result = parseQuoteText(text, 'P.31-26 DIMATTIA GIUSEPPE LOCALE DI CULTO.pdf', { settings: { defaultVat: 10 } });
  assert.equal(result.number, 'P 31-26');
  assert.equal(result.client, 'DIMATTIA GIUSEPPE');
  assert.ok(result.lines.every(line => !/DIMATTIA|LODI|CHIARADIA/.test(line.desc)));
});

test('imports hyphen-led rows as separate work items and appends unmarked wrapped text to the preceding item', () => {
  const text = `Preventivo n. P 21.26\nData: 12/05/2026\nCliente: Mario Rossi\nARTICOLO IMPORTO\nIl preventivo include:\n- Prima voce, parte iniziale\ncontinua la prima voce senza un nuovo trattino\n- Seconda voce, parte iniziale\ncontinuazione della seconda voce\n- Terza voce\nTotale imponibile: 1.500,00 €`;
  const result = parseQuoteText(text, 'elenco-trattini.pdf', { settings: { defaultVat: 10 } });
  assert.deepEqual(result.lines.map(line => line.desc), [
    'Prima voce, parte iniziale\ncontinua la prima voce senza un nuovo trattino',
    'Seconda voce, parte iniziale\ncontinuazione della seconda voce',
    'Terza voce',
  ]);
  assert.equal(result.lines.length, 3);
});

test('recognizes different PDF/OCR bullet glyphs and a marker extracted on its own line', () => {
  const text = `Cliente: Mario Rossi\nARTICOLO IMPORTO\n-\nFornitura e posa quadro elettrico 1.200,00 €\n– Installazione prese e comandi\n• Collegamento e verifica\n▪ Prova finale\nTotale imponibile: 1.500,00 €`;
  const result = parseQuoteText(text, 'marcatori-pdf.pdf', { settings: { defaultVat: 10 } });
  assert.deepEqual(result.lines.map(line => line.desc), [
    'Fornitura e posa quadro elettrico',
    'Installazione prese e comandi',
    'Collegamento e verifica',
    'Prova finale',
  ]);
  assert.equal(result.lines[0].amount, 1200);
});

test('uses PDF layout positions to keep marked rows separate and join their unmarked wrapped continuation', () => {
  const texts = [
    'ARTICOLO IMPORTO',
    '- Prima voce, parte iniziale',
    'continua la prima voce',
    '- Seconda voce, parte iniziale',
    'continua la seconda voce',
    '- Terza voce',
    'Totale imponibile: 1.500,00 €',
    'IVA 10%: 150,00 €',
    'Totale: 1.650,00 €',
  ];
  const positions = [0.20, 0.25, 0.265, 0.31, 0.325, 0.37, 0.90, 0.93, 0.96];
  const layoutLines = texts.map((text, index) => ({
    text, page: 1, yNorm: positions[index], top: positions[index] * 842,
    x: 0.08, xEnd: 0.75, fontSize: 10,
    segments: [{ text, x: 0.08, xEnd: 0.75, fontSize: 10 }],
  }));
  const result = parseQuoteText(texts.join('\\n'), 'layout-elenco.pdf', { settings: { defaultVat: 10 } }, { layoutLines });
  assert.deepEqual(result.lines.map(line => line.desc), [
    'Prima voce, parte iniziale continua la prima voce',
    'Seconda voce, parte iniziale continua la seconda voce',
    'Terza voce',
  ]);
});

test('does not merge ordinary unmarked document rows when the imported file has no bullet markers', () => {
  const text = `Preventivo n. P 22.26\nData: 13/05/2026\nCliente: Mario Rossi\nARTICOLO IMPORTO\nInstallazione punto luce\nFornitura materiale\nTotale imponibile: 300,00 €`;
  const result = parseQuoteText(text, 'senza-elenco.pdf', { settings: { defaultVat: 10 } });
  assert.deepEqual(result.lines.map(line => line.desc), ['Installazione punto luce', 'Fornitura materiale']);
});

test('starts PDF description extraction at the first hyphen-led work item when no table heading exists', () => {
  const texts = [
    'CHIARADIA IMPIANTI',
    'Cliente: Mario Rossi',
    'P 23.26',
    'Data: 14/05/2026',
    '- Fornitura e posa linea elettrica',
    'tratto dal quadro al locale tecnico',
    '- Installazione protezioni',
    'Totale imponibile: 900,00 €',
    'IVA 10%: 90,00 €',
    'Totale: 990,00 €',
  ];
  const positions = [0.07, 0.19, 0.20, 0.22, 0.38, 0.395, 0.44, 0.90, 0.93, 0.96];
  const layoutLines = texts.map((text, index) => ({
    text, page: 1, yNorm: positions[index], top: positions[index] * 842,
    x: 0.08, xEnd: 0.75, fontSize: 10,
    segments: [{ text, x: 0.08, xEnd: 0.75, fontSize: 10 }],
  }));
  const result = parseQuoteText(texts.join('\\n'), 'senza-intestazione-tabella.pdf', { settings: { defaultVat: 10 } }, { layoutLines });
  assert.deepEqual(result.lines.map(line => line.desc), [
    'Fornitura e posa linea elettrica tratto dal quadro al locale tecnico',
    'Installazione protezioni',
  ]);
});

test('does not assign the supplier VAT number to a customer when supplier and customer VAT appear in the same PDF header', () => {
  const rows = [
    ['CHIARADIA IMPIANTI', 0.08, 0.08],
    ['P. IVA 08623720722', 0.17, 0.08],
    ['P 44.26', 0.20, 0.72],
    ['ROSSI SRL', 0.23, 0.08],
    ['P. IVA 12345678901', 0.255, 0.08],
    ['Via Roma 10', 0.28, 0.08],
    ['Data: 30/10/2026', 0.23, 0.72],
    ['ARTICOLO IMPORTO', 0.34, 0.08],
    ['Installazione impianto elettrico', 0.40, 0.08],
    ['Totale imponibile: 1.000,00 €', 0.90, 0.08],
  ];
  const layoutLines = rows.map(([text, yNorm, x]) => ({
    text, page: 1, yNorm, top: yNorm * 842, x, xEnd: x + 0.25, fontSize: 10,
    segments: [{ text, x, xEnd: x + 0.25, fontSize: 10 }],
  }));
  const result = parseQuoteText(rows.map(row => row[0]).join('\n'), 'rossi.pdf', { settings: { defaultVat: 10 } }, { layoutLines });
  assert.equal(result.client, 'ROSSI SRL');
  assert.equal(result.tax, '12345678901');
  assert.equal(result.address, 'Via Roma 10');
});

test('does not reuse supplier VAT in a plain-text import when the customer has no tax identifier', () => {
  const text = `CHIARADIA IMPIANTI\nP. IVA 08623720722\nROSSI SRL\nVia Roma 10\nData: 30/10/2026\nARTICOLO IMPORTO\nInstallazione impianto elettrico\nTotale imponibile: 1.000,00 €`;
  const result = parseQuoteText(text, 'rossi.docx', { settings: { defaultVat: 10 } });
  assert.equal(result.client, 'ROSSI SRL');
  assert.equal(result.tax, '');
});
