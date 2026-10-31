import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AirVent, ArrowDownToLine, ArrowLeft, ArrowRight, BadgeCheck, BookOpen,
  Building2, Check, CheckCircle2, CircleHelp, Cloud,
  CloudOff, Copy, Download, FilePlus2, FileText, Filter, Home, KeyRound, LogOut,
  Mail, MoreHorizontal, Pencil, Plus, Printer, RefreshCw, Search, Settings,
  ShieldCheck, Trash2, UserRound, Users, Wrench, X, Zap, Eye, EyeOff, History, ChevronDown,
  CalendarDays, CalendarClock, Clock3, Package, ReceiptText
} from 'lucide-react';
import { supabase } from './lib/supabase.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import mammoth from 'mammoth/mammoth.browser';
import { createWorker } from 'tesseract.js';
// Usa direttamente il worker ES module: evita il fallback fake worker di PDF.js.
pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(pdfWorkerUrl, { type: 'module' });

import { CATEGORIES, DEFAULT_SETTINGS, defaultDb, normalizeDb, calcTotal, money, formatDate, todayISO, quoteNumber, newDraft, escapeName, dashboardGreeting } from './lib/domain.js';
import { parseQuoteText } from './lib/importQuote.js';

const LOGO_URL = './logo-chiaradia.png';

function wordHtmlToLayout(html) {
  // Mammoth preserva la gerarchia di paragrafi e tabelle DOCX, ma non le coordinate
  // della pagina. Ricostruiamo le colonne delle celle e l'ordine verticale per riusare
  // lo stesso parser di testata/corpo/footer usato per i PDF.
  const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const blocks = [];
  const textOf = (node) => String(node?.textContent || '').replace(/[\t\r\n\u00a0]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const child of Array.from(parsed.body.children)) {
    if (child.tagName === 'TABLE') {
      for (const row of Array.from(child.querySelectorAll('tr'))) {
        const cells = Array.from(row.children).filter(cell => cell.tagName === 'TD' || cell.tagName === 'TH');
        const values = cells.map(textOf);
        if (!values.some(Boolean)) continue;
        const segments = values.map((text, index) => {
          const x = values.length <= 1 ? 0.08 : 0.08 + (0.84 * index) / (values.length - 1);
          return { text, x, xEnd: Math.min(0.98, x + (values.length <= 1 ? 0.84 : 0.34)), fontSize: 10 };
        }).filter(segment => segment.text);
        blocks.push({ text: values.filter(Boolean).join(' '), segments, x: Math.min(...segments.map(segment => segment.x)), fontSize: 10 });
      }
      continue;
    }
    const contentNodes = child.matches('p,h1,h2,h3,h4,h5,h6,li')
      ? [child]
      : Array.from(child.querySelectorAll(':scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > ul > li, :scope > ol > li'));
    for (const node of contentNodes) {
      const text = textOf(node);
      if (text) blocks.push({ text, segments: [{ text, x: 0.08, xEnd: 0.92, fontSize: 10 }], x: 0.08, fontSize: 10 });
    }
  }
  const lastIndex = Math.max(1, blocks.length - 1);
  return blocks.map((block, index) => ({
    ...block, page: 1, yNorm: 0.08 + (0.84 * index) / lastIndex, top: 80 + index * 12,
  }));
}

async function extractDocumentText(file) {
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const pages = [];
    const layoutLines = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ includeMarkedContent: false });
      const items = content.items.filter(item => typeof item.str === 'string' && item.str.trim()).map(item => {
        const transform = item.transform || [1, 0, 0, 10, 0, 0];
        const fontSize = Math.max(1, Math.hypot(Number(transform[0]) || 0, Number(transform[1]) || Number(transform[3]) || 10));
        const xPoints = Number(transform[4]) || 0;
        const baselineY = viewport.height - (Number(transform[5]) || 0);
        const widthPoints = Math.max(0, Number(item.width) || 0);
        return {
          text: item.str.replace(/\u00a0/g, ' ').trim(),
          xPoints,
          x: Math.max(0, xPoints / Math.max(1, viewport.width)),
          xEnd: Math.max(0, (xPoints + widthPoints) / Math.max(1, viewport.width)),
          top: baselineY,
          yNorm: Math.max(0, Math.min(1, baselineY / Math.max(1, viewport.height))),
          fontSize,
          page: pageNumber,
        };
      }).sort((a, b) => a.top - b.top || a.xPoints - b.xPoints);

      // Raggruppa gli elementi sulla stessa riga fisica senza perdere le coordinate
      // orizzontali: il parser può così distinguere cliente a sinistra e riferimenti a destra.
      const grouped = [];
      for (const item of items) {
        let row = grouped.find(candidate => Math.abs(candidate.top - item.top) <= Math.max(2.4, Math.min(candidate.fontSize, item.fontSize) * 0.32));
        if (!row) {
          row = { page: pageNumber, top: item.top, yNorm: item.yNorm, fontSize: item.fontSize, segments: [] };
          grouped.push(row);
        }
        row.segments.push(item);
        row.top = row.segments.reduce((sum, segment) => sum + segment.top, 0) / row.segments.length;
        row.yNorm = row.top / Math.max(1, viewport.height);
        row.fontSize = Math.max(row.fontSize, item.fontSize);
      }
      const pageLines = grouped.map(row => {
        const segments = row.segments.sort((a, b) => a.xPoints - b.xPoints).map(segment => ({
          text: segment.text,
          x: segment.x,
          xEnd: segment.xEnd,
          fontSize: segment.fontSize,
        }));
        let text = '';
        let previous = null;
        for (const segment of segments) {
          if (text && previous) {
            const gapPoints = (segment.x * viewport.width) - (previous.xEnd * viewport.width);
            const alreadySpace = /\s$/.test(text) || /^\s/.test(segment.text);
            if (!alreadySpace && gapPoints > Math.max(1.4, Math.min(previous.fontSize, segment.fontSize) * 0.18)) text += ' ';
          }
          text += segment.text;
          previous = segment;
        }
        return {
          text: text.replace(/\s+/g, ' ').trim(),
          x: segments.length ? Math.min(...segments.map(segment => segment.x)) : 0,
          xEnd: segments.length ? Math.max(...segments.map(segment => segment.xEnd)) : 0,
          top: row.top,
          yNorm: row.yNorm,
          fontSize: row.fontSize,
          page: pageNumber,
          segments,
        };
      }).filter(row => row.text).sort((a, b) => a.top - b.top);
      layoutLines.push(...pageLines);
      pages.push(pageLines.map(line => line.text).join('\n'));
    }
    let text = pages.join('\n');
    let ocrUsed = false;
    if (!text.trim() || (layoutLines.length < 10 && !/\bARTICOLO\b/i.test(text))) {
      // PDF da scanner/fotocamera: OCR locale nel browser, con coordinate delle parole
      // per conservare la separazione sinistra/destra della testata del preventivo.
      let worker;
      try {
        worker = await createWorker('ita+eng');
        const ocrLayout = [];
        const ocrPages = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
          const scale = 1.8;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) throw new Error('Il browser non permette di creare il canvas necessario al riconoscimento OCR.');
          await page.render({ canvasContext: context, viewport }).promise;
          const result = await worker.recognize(canvas);
          const lines = (result?.data?.lines || []).filter(line => line.text?.trim()).map(line => {
            const box = line.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 };
            const segments = (line.words || []).filter(word => word.text?.trim()).map(word => {
              const wordBox = word.bbox || box;
              return {
                text: word.text.trim(),
                x: Math.max(0, Math.min(1, wordBox.x0 / Math.max(1, canvas.width))),
                xEnd: Math.max(0, Math.min(1, wordBox.x1 / Math.max(1, canvas.width))),
                fontSize: Math.max(1, (wordBox.y1 - wordBox.y0) / scale),
              };
            });
            return {
              text: line.text.trim(),
              x: Math.max(0, Math.min(1, box.x0 / Math.max(1, canvas.width))),
              xEnd: Math.max(0, Math.min(1, box.x1 / Math.max(1, canvas.width))),
              top: box.y0 / scale,
              yNorm: Math.max(0, Math.min(1, box.y0 / Math.max(1, canvas.height))),
              fontSize: Math.max(1, (box.y1 - box.y0) / scale),
              page: pageNumber,
              segments,
            };
          });
          ocrLayout.push(...lines);
          ocrPages.push(lines.map(line => line.text).join('\n'));
          canvas.width = 1; canvas.height = 1;
        }
        // Se il PDF conteneva già un po' di testo, non duplicarlo: OCR è fallback solo
        // quando il testo selezionabile manca o è solo parziale. Scegliamo la mappa OCR
        // se ha recuperato la struttura tabellare oppure ha nettamente più testo utile.
        const ocrText = ocrPages.join('\n');
        const originalHasTable = /\bARTICOLO\b/i.test(text);
        const ocrHasTable = /\bARTICOLO\b/i.test(ocrText);
        const useOcr = !text.trim() || (ocrText.trim() && ((ocrHasTable && !originalHasTable) || ocrText.trim().length > text.trim().length * 1.4));
        if (useOcr && ocrLayout.length) {
          text = ocrText;
          layoutLines.splice(0, layoutLines.length, ...ocrLayout);
          ocrUsed = true;
        }
      } catch (ocrError) {
        if (!text.trim()) throw new Error(`Il PDF sembra una scansione e il riconoscimento OCR non è riuscito. ${ocrError?.message || 'Controlla la connessione e riprova.'}`);
      } finally {
        try { await worker?.terminate(); } catch {}
      }
    }
    if (!text.trim()) throw new Error('Non è stato riconosciuto testo nel PDF. Prova un PDF con testo selezionabile o un DOCX.');
    return { text, layoutLines, format: 'pdf', ocrUsed };
  }
  if (ext === 'docx') {
    const arrayBuffer = await file.arrayBuffer();
    const [result, htmlResult] = await Promise.all([
      mammoth.extractRawText({ arrayBuffer }),
      mammoth.convertToHtml({ arrayBuffer }),
    ]);
    if (!result.value.trim()) throw new Error('Il documento Word non contiene testo leggibile.');
    const layoutLines = wordHtmlToLayout(htmlResult.value);
    return { text: result.value, layoutLines, format: 'docx' };
  }
  if (ext === 'doc') {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const binary = new TextDecoder('windows-1252').decode(bytes);
    const utf16 = new TextDecoder('utf-16le').decode(bytes);
    const printable = (value) => value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '\n').replace(/[ ]{2,}/g, ' ').split('\n').map(line => line.trim()).filter(line => line.length > 3 && /[a-zà-ÿ]{3}/i.test(line)).join('\n');
    const extracted = [printable(utf16), printable(binary)].sort((a, b) => b.length - a.length)[0];
    if (extracted.length < 30) throw new Error('Questo DOC binario non è stato letto in modo affidabile. Aprilo in Word e salvalo come DOCX, quindi importalo di nuovo.');
    return { text: extracted, layoutLines: [], format: 'doc' };
  }
  if (ext === 'txt') return { text: await file.text(), layoutLines: [], format: 'txt' };
  throw new Error('Formato non supportato. Usa PDF, DOC, DOCX oppure TXT.');
}

function withTimeout(promise, ms = 12000, message = 'La richiesta è scaduta. Controlla la connessione e la configurazione Supabase.') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Usa la funzione SQL atomica quando la migrazione è installata. La modalità
// compatibile mantiene il vecchio salvataggio attivo fino all'applicazione SQL,
// ma controlla prima la versione corrente per evitare sovrascritture ovvie.
async function saveWorkspaceVersioned(userId, snapshot, expectedUpdatedAt) {
  const rpc = await withTimeout(supabase.rpc('pp_save_workspace', {
    p_data: snapshot,
    p_expected_updated_at: expectedUpdatedAt,
  }), 12000, 'Il salvataggio cloud ha superato 12 secondi.');
  if (!rpc.error) {
    const saved = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
    if (saved?.saved) return { saved: true, updated_at: saved.updated_at, legacyFallback: false };
    const latest = await withTimeout(supabase.from('preventivi_workspace').select('data,updated_at').eq('user_id', userId).maybeSingle(), 12000);
    if (latest.error) throw latest.error;
    return { saved: false, latest: latest.data || null, legacyFallback: false };
  }

  const missingRpc = rpc.error.code === 'PGRST202' || rpc.error.code === '42883'
    || /pp_save_workspace.*(not found|does not exist|schema cache)|could not find the function/i.test(rpc.error.message || '');
  if (!missingRpc) throw rpc.error;

  const latest = await withTimeout(supabase.from('preventivi_workspace').select('data,updated_at').eq('user_id', userId).maybeSingle(), 12000);
  if (latest.error) throw latest.error;
  if (latest.data?.updated_at && expectedUpdatedAt && latest.data.updated_at !== expectedUpdatedAt) {
    return { saved: false, latest: latest.data, legacyFallback: true };
  }
  const updatedAt = new Date().toISOString();
  const fallback = await withTimeout(supabase.from('preventivi_workspace').upsert({
    user_id: userId, data: snapshot, updated_at: updatedAt,
  }, { onConflict: 'user_id' }).select('updated_at').single(), 12000);
  if (fallback.error) throw fallback.error;
  return { saved: true, updated_at: fallback.data?.updated_at || updatedAt, legacyFallback: true };
}
function Brand({ compact = false }) {
  return <div className={`brand-lockup ${compact ? 'brand-lockup-compact' : ''}`}>
    <div className="brand-mark"><img src={LOGO_URL} alt="" /></div>
    <div className="brand-wording"><strong>PREVENTIVI<span>PRO</span></strong><small>CHIARADIA IMPIANTI</small></div>
  </div>;
}

const HOME_MODULES = [
  { id: 'preventivi', label: 'Preventivi', icon: FileText, tone: 'preventivi' },
  { id: 'jobs', label: 'Lavori Oggi', icon: CalendarDays, tone: 'jobs' },
  { id: 'calendar', label: 'Calendario', icon: CalendarClock, tone: 'calendar' },
  { id: 'clients', label: 'Clienti', icon: Users, tone: 'clients' },
  { id: 'sites', label: 'Cantieri', icon: Building2, tone: 'sites' },
  { id: 'deadlines', label: 'Scadenze', icon: Clock3, tone: 'deadlines' },
  { id: 'invoices', label: 'Fatture', icon: ReceiptText, tone: 'invoices' },
  { id: 'inventory', label: 'Magazzino', icon: Package, tone: 'inventory' },
  { id: 'settings', label: 'Impostazioni', icon: Settings, tone: 'settings' },
];

const MODULE_PLACEHOLDERS = {
  jobs: { title: 'Lavori Oggi', description: 'Qui troverai gli interventi pianificati per oggi e il relativo stato.' },
  calendar: { title: 'Calendario', description: 'Qui sarà disponibile il calendario operativo con gli interventi e le scadenze.' },
  sites: { title: 'Cantieri', description: 'Qui potrai consultare i cantieri collegati ai clienti e agli interventi.' },
  deadlines: { title: 'Scadenze', description: 'Qui saranno raccolte le certificazioni, le manutenzioni e le altre scadenze.' },
  invoices: { title: 'Fatture', description: 'Qui sarà disponibile il registro delle fatture e dei relativi pagamenti.' },
  inventory: { title: 'Magazzino', description: 'Qui potrai gestire articoli, giacenze e movimenti di magazzino.' },
};

function AuthScreen() {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('info');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      if (mode === 'signup') {
        const result = await withTimeout(supabase.auth.signUp({ email: email.trim(), password }), 12000);
        if (result.error) throw result.error;
        setMessageType('success');
        setMessage(result.data.session
          ? 'Account creato. Sto aprendo l’app…'
          : 'Account creato. Se la conferma e-mail è attiva, apri il messaggio ricevuto e conferma l’indirizzo, poi accedi.');
        if (result.data.session?.user) window.dispatchEvent(new CustomEvent('preventivi:authenticated', { detail: result.data.session.user }));
        else setMode('login');
      } else {
        const result = await withTimeout(supabase.auth.signInWithPassword({ email: email.trim(), password }), 12000,
          'Supabase non risponde entro 12 secondi. Controlla la connessione, il progetto e le impostazioni di autenticazione.');
        if (result.error) throw result.error;
        setMessageType('success'); setMessage('Accesso verificato. Caricamento dei tuoi preventivi…');
        window.dispatchEvent(new CustomEvent('preventivi:authenticated', { detail: result.data.user }));
      }
    } catch (error) {
      console.error('Autenticazione Supabase:', error);
      setMessageType('error');
      const raw = error?.message || 'Accesso non riuscito. Riprova.';
      setMessage(raw.includes('Invalid login credentials') ? 'E-mail o password non corretti.'
        : raw.includes('Email not confirmed') ? 'Devi prima confermare l’indirizzo e-mail dal messaggio ricevuto da Supabase.'
        : raw.includes('Failed to fetch') ? 'Impossibile raggiungere Supabase. Verifica URL, chiave pubblicabile, connessione e rete.'
        : raw);
    } finally { setBusy(false); }
  };

  const resetPassword = async () => {
    if (!email.trim()) { setMessageType('error'); setMessage('Inserisci prima l’indirizzo e-mail.'); return; }
    setBusy(true); setMessage('');
    try {
      const { error } = await withTimeout(supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.href }), 12000);
      if (error) throw error;
      setMessageType('success'); setMessage('Se l’indirizzo è registrato, riceverai un link per reimpostare la password.');
    } catch (error) { setMessageType('error'); setMessage(error.message || 'Impossibile inviare il link.'); }
    finally { setBusy(false); }
  };

  return <div className="auth-page">
    <div className="auth-ambient auth-ambient-one" /><div className="auth-ambient auth-ambient-two" />
    <main className="auth-card">
      <div className="auth-top"><Brand /><span className="secure-pill"><ShieldCheck size={14} /> Area riservata</span></div>
      <div className="auth-title"><div className="auth-kicker">GESTIONE PROFESSIONALE</div><h1>{mode === 'signup' ? 'Crea il tuo account' : 'Bentornato'}</h1><p>{mode === 'signup' ? 'Crea l’accesso per sincronizzare preventivi, clienti e catalogo.' : 'Accedi per ritrovare preventivi e clienti su tutti i tuoi dispositivi.'}</p></div>
      <form onSubmit={submit} className="auth-form">
        <label htmlFor="auth-email">E-mail</label>
        <div className="input-icon-wrap"><Mail size={18} /><input id="auth-email" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="nome@azienda.it" /></div>
        <label htmlFor="auth-password">Password</label>
        <div className="input-icon-wrap"><KeyRound size={18} /><input id="auth-password" type="password" required minLength={6} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Almeno 6 caratteri" /></div>
        {mode === 'login' && <button className="text-button forgot-button" type="button" onClick={resetPassword} disabled={busy}>Password dimenticata?</button>}
        <button className="button button-primary button-wide auth-submit" type="submit" disabled={busy}>{busy ? <><span className="spinner" /> {mode === 'signup' ? 'Creazione account…' : 'Accesso in corso…'}</> : <>{mode === 'signup' ? 'Crea account' : 'Accedi'} <ArrowRight size={17} /></>}</button>
      </form>
      {message && <div className={`message message-${messageType}`} role="status">{message}</div>}
      <div className="auth-switch">{mode === 'signup' ? 'Hai già un account?' : 'Non hai ancora un account?'} <button type="button" className="text-button" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setMessage(''); }}>{mode === 'signup' ? 'Accedi' : 'Registrati'}</button></div>
      <div className="auth-foot"><ShieldCheck size={15} /> Connessione protetta · Sincronizzazione tramite Supabase</div>
    </main>
    <div className="auth-bottom">PREVENTIVI PRO <span>·</span> CHIARADIA IMPIANTI</div>
  </div>;
}

function PasswordRecoveryScreen({ onComplete }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('error');

  const submit = async (event) => {
    event.preventDefault();
    if (password.length < 6) { setMessage('La password deve contenere almeno 6 caratteri.'); return; }
    if (password !== confirmPassword) { setMessage('Le due password non coincidono.'); return; }
    setBusy(true); setMessage('');
    try {
      const result = await withTimeout(supabase.auth.updateUser({ password }), 12000,
        'La richiesta è scaduta. Richiedi un nuovo link e riprova.');
      if (result.error) throw result.error;
      setMessageType('success');
      setMessage('Password aggiornata. Sto riaprendo il tuo spazio cloud…');
      await onComplete();
    } catch (error) {
      setMessageType('error');
      setMessage(error?.message || 'Non è stato possibile aggiornare la password. Richiedi un nuovo link.');
    } finally { setBusy(false); }
  };

  return <div className="auth-page"><div className="auth-card">
    <div className="auth-top"><Brand /><span className="secure-pill"><ShieldCheck size={14} /> Recupero account</span></div>
    <div className="auth-title"><div className="auth-kicker">SICUREZZA ACCOUNT</div><h1>Imposta una nuova password</h1><p>Scegli una nuova password per il tuo account Preventivi Pro.</p></div>
    <form onSubmit={submit} className="auth-form">
      <label htmlFor="recovery-password">Nuova password</label>
      <div className="input-icon-wrap"><KeyRound size={18} /><input id="recovery-password" type="password" required minLength={6} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></div>
      <label htmlFor="recovery-confirm">Conferma password</label>
      <div className="input-icon-wrap"><KeyRound size={18} /><input id="recovery-confirm" type="password" required minLength={6} autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} /></div>
      <button className="button button-primary button-wide auth-submit" type="submit" disabled={busy}>{busy ? <><span className="spinner" /> Salvataggio…</> : <>Aggiorna password <ArrowRight size={17} /></>}</button>
    </form>
    {message && <div className={`message message-${messageType}`} role="status">{message}</div>}
  </div></div>;
}

function DatabaseUnavailable({ email, message, onRetry, onLogout, retrying }) {
  return <div className="auth-page"><main className="auth-card database-error-card">
    <div className="auth-top"><Brand /><span className="secure-pill"><CloudOff size={14} /> Database non disponibile</span></div>
    <div className="auth-title"><div className="auth-kicker">ACCESSO VERIFICATO</div><h1>Collegamento al cloud non riuscito</h1><p>L’account {email ? <strong>{email}</strong> : 'autenticato'} è valido, ma l’app non può aprire i dati perché il database non ha risposto correttamente.</p></div>
    <div className="message message-error" role="alert">{message || 'Verifica che la tabella preventivi_workspace esista nel progetto Supabase corretto e che le policy RLS siano attive.'}</div>
    <p className="database-error-note">Per evitare di mostrare dati incompleti o fingere un salvataggio, l’area di lavoro rimane bloccata finché il collegamento cloud non torna operativo.</p>
    <div className="database-error-actions"><button className="button button-primary button-wide" type="button" onClick={onRetry} disabled={retrying}>{retrying ? <><span className="spinner" /> Verifica in corso…</> : <><RefreshCw size={16} /> Riprova collegamento</>}</button><button className="button button-secondary button-wide" type="button" onClick={onLogout}>Esci dall’account</button></div>
  </main></div>;
}

function EmptyState({ icon: Icon = FileText, title, text, action, onAction }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={24} /></span><strong>{title}</strong><p>{text}</p>{action && <button className="button button-primary" onClick={onAction}><Plus size={16} /> {action}</button>}</div>;
}

function safeFilenamePart(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
}

// Il browser usa il titolo del documento come nome iniziale quando si salva in PDF.
// Il numero viene mantenuto esattamente come scritto nell'editor (es. P01.26 o P01.27).
function buildQuotePdfBasename(quote = {}) {
  const number = safeFilenamePart(quote.number) || 'Preventivo';
  const parts = [
    number,
    safeFilenamePart(quote.client),
    safeFilenamePart(quote.address),
    safeFilenamePart(quote.category),
    'Chiaradia Impianti',
  ].filter(Boolean);
  return parts.join(' - ') || 'Preventivo';
}

function QuoteDocument({ draft, settings }) {
  const sums = calcTotal(draft);
  const logoSrc = settings.logoData || LOGO_URL;
  // L'intestazione IMPORTO compare solo se almeno una voce ha un prezzo
  // valorizzato e abilitato alla stampa.
  const hasVisibleLinePrice = (draft.lines || []).some(line => {
    const value = line.internalPrice !== undefined ? line.internalPrice : (line.amount ?? null);
    return line.showPrice === true && value !== null && value !== '' && Number.isFinite(Number(value));
  });
  return <article className="quote-document" id="quote-document">
    <header className="quote-doc-header">
      <div className="quote-company">
        <div className="company-name">{settings.name || DEFAULT_SETTINGS.name}</div>
        <div>{settings.contact || DEFAULT_SETTINGS.contact}</div>
        <div>{settings.address || DEFAULT_SETTINGS.address}</div>
        <div>{settings.city || DEFAULT_SETTINGS.city}</div>
        <div>P. IVA {settings.vat || DEFAULT_SETTINGS.vat}</div>
        {settings.pec && <div>PEC: {settings.pec}</div>}
        {settings.phone && <div>Cell: {settings.phone}</div>}
        {settings.email && <div>E-mail: <span className="doc-email">{settings.email}</span></div>}
      </div>
      <div className="quote-logo-wrap"><img src={logoSrc} alt="Logo Chiaradia Impianti" className="quote-logo" /></div>
    </header>
    <div className="quote-blue-rule" />
    <section className="quote-recipient-meta">
      <div className="quote-recipient">
        <strong>{draft.client || 'NOME CLIENTE'}</strong>
        {draft.address && <div>{draft.address}</div>}
        {draft.tax && <div>{draft.tax}</div>}
        {draft.place && <div>{draft.place}</div>}
        {draft.phone && <div>Tel.: {draft.phone}</div>}
        {draft.email && <div>E-mail: {draft.email}</div>}
        {draft.pec && <div>PEC: {draft.pec}</div>}
      </div>
      <div className="quote-reference">
        <strong className="quote-number">{draft.number || 'P —'}</strong>
        <div><span>Data:</span><strong>{formatDate(draft.date)}</strong></div>
        <div className="payment-line"><span>Termini:</span><strong>{(draft.payment || '').split('\n').map((part, i) => <React.Fragment key={i}>{i > 0 && <br />}{part}</React.Fragment>)}</strong></div>
      </div>
    </section>
    <div className={`quote-table-header${hasVisibleLinePrice ? ' has-visible-amount' : ' no-visible-amount'}`}>
      <span>ARTICOLO</span>
      {hasVisibleLinePrice && <span>IMPORTO</span>}
    </div>
    <section className="quote-description-body">
      <div className="quote-title-text">{draft.title || 'Preventivo per fornitura e posa in opera'}</div>
      {draft.subtitle && <div className="quote-subtitle-text">{draft.subtitle}</div>}
      {draft.intro && <p className="quote-intro">{draft.intro}</p>}
      {draft.lines?.some(line => line.desc?.trim()) && <ul className="quote-bullets">{draft.lines.filter(line => line.desc?.trim()).map(line => {
        const linePrice = line.internalPrice !== undefined ? line.internalPrice : (line.amount ?? null);
        const canShowPrice = line.showPrice === true && linePrice !== null && linePrice !== '' && Number.isFinite(Number(linePrice));
        return <li key={line.id}>
          <span className="quote-bullet-marker" aria-hidden="true">•</span>
          <span className="quote-bullet-text">{line.desc}</span>
          {canShowPrice && <strong className="quote-line-amount">{money(linePrice)}</strong>}
        </li>;
      })}</ul>}
      {draft.closing && <p className="quote-closing">{draft.closing}</p>}
    </section>
    <footer className="quote-doc-footer">
      <div className="quote-signatures"><div>Data</div><div>Firma</div></div>
      <div className="quote-totals">
        <div className="quote-total-row"><span>Totale imponibile:</span><strong>{money(sums.net)}</strong></div>
        <div className="quote-total-row"><span>IVA ({Number(draft.vatRate) || 0}%):</span><strong>{money(sums.vat)}</strong></div>
        <div className="quote-total-row quote-grand-total"><span>Totale:</span><strong>{money(sums.total)}</strong></div>
      </div>
    </footer>
  </article>;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [ready, setReady] = useState(false);
  const [cloudReady, setCloudReady] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [db, setDb] = useState(defaultDb);
  const [view, setView] = useState('home');
  const [draft, setDraft] = useState(null);
  const [syncState, setSyncState] = useState('idle');
  const [syncMessage, setSyncMessage] = useState('');
  const [realtimeStatus, setRealtimeStatus] = useState('connecting');
  const [toast, setToast] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [revisionHistoryOpen, setRevisionHistoryOpen] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogFilter, setCatalogFilter] = useState('Tutti');
  const [clientSearch, setClientSearch] = useState('');
  const [quoteImport, setQuoteImport] = useState(null);
  const [importBusy, setImportBusy] = useState(false);
  const [editingClient, setEditingClient] = useState(null);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const cloudTimer = useRef(null);
  const toastTimer = useRef(null);
  const savingRef = useRef(false);
  const syncPendingRef = useRef(false);
  const lineDragTimer = useRef(null);
  const lineDragRef = useRef(null);
  const [draggingLineId, setDraggingLineId] = useState(null);
  const latestDbRef = useRef(db);
  const lastSyncedAtRef = useRef(null);
  const localDirtyRef = useRef(false);
  const skipNextSaveRef = useRef(false);
  const localWriteSnapshotRef = useRef(null);
  const remoteConflictRef = useRef(null);

  useEffect(() => {
    if (view !== 'editor') setRevisionHistoryOpen(false);
  }, [view]);

  const printQuote = () => {
    if (!draft) return;
    const previousTitle = document.title;
    // Attiva una modalità di stampa isolata: nell'output resta visibile soltanto
    // il documento A4, anche se l'editor contiene cronologia e ripristini aperti.
    document.body.classList.add('print-quote-only');
    const restorePrintState = () => {
      document.title = previousTitle;
      document.body.classList.remove('print-quote-only');
    };
    document.title = buildQuotePdfBasename(draft);
    window.addEventListener('afterprint', restorePrintState, { once: true });
    try {
      window.print();
    } catch (error) {
      window.removeEventListener('afterprint', restorePrintState);
      restorePrintState();
      throw error;
    }
  };
  latestDbRef.current = db;

  const notify = useCallback((message) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3500);
  }, []);

  const hydrateUser = useCallback(async (nextUser) => {
    setBooting(false); setReady(false); setCloudReady(false); setUser(nextUser);
    setSyncState('loading'); setSyncMessage('Recupero dei dati dal database cloud…');
    try {
      const result = await withTimeout(
        supabase.from('preventivi_workspace').select('data,updated_at').eq('user_id', nextUser.id).maybeSingle(),
        12000,
        'Accesso riuscito, ma il database non risponde entro 12 secondi.'
      );
      if (result.error) throw result.error;
      if (result.data?.data && typeof result.data.data === 'object') {
        lastSyncedAtRef.current = result.data.updated_at || null;
        localDirtyRef.current = false;
        remoteConflictRef.current = null;
        setDb(normalizeDb(result.data.data));
        setSyncState('synced'); setSyncMessage('Dati caricati dal database cloud');
      } else {
        // A new account receives a cloud workspace, only after the upsert is confirmed.
        const seed = defaultDb();
        const seedUpdatedAt = new Date().toISOString();
        const resultSave = await withTimeout(supabase.from('preventivi_workspace').upsert({
          user_id: nextUser.id, data: seed, updated_at: seedUpdatedAt,
        }, { onConflict: 'user_id' }).select('updated_at').single(), 12000, 'Non è stato possibile inizializzare il workspace cloud.');
        if (resultSave.error) throw resultSave.error;
        lastSyncedAtRef.current = resultSave.data?.updated_at || seedUpdatedAt;
        localDirtyRef.current = false;
        remoteConflictRef.current = null;
        setDb(seed);
        setSyncState('synced'); setSyncMessage('Database cloud inizializzato');
      }
      setCloudReady(true);
    } catch (error) {
      console.error('Caricamento database cloud:', error);
      lastSyncedAtRef.current = null;
      localDirtyRef.current = false;
      remoteConflictRef.current = null;
      setDb(defaultDb());
      setCloudReady(false);
      setSyncState('error');
      setSyncMessage(error.message || 'Database cloud non raggiungibile. Verifica configurazione, tabella e policy RLS.');
    } finally {
      setReady(true); setView('home'); setDraft(null); setBooting(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' && alive) setPasswordRecovery(true);
      if (event === 'SIGNED_OUT' && alive) {
        setUser(null); setReady(false); setCloudReady(false); setBooting(false); setPasswordRecovery(false); setView('home'); setDraft(null); setSyncState('idle'); setRealtimeStatus('connecting'); lastSyncedAtRef.current = null; localDirtyRef.current = false; remoteConflictRef.current = null;
      }
    });
    (async () => {
      try {
        const result = await withTimeout(supabase.auth.getSession(), 12000, 'Verifica sessione scaduta. Ricarica la pagina.');
        if (!alive) return;
        if (result.error) throw result.error;
        if (result.data.session?.user) await hydrateUser(result.data.session.user);
        else { setBooting(false); setReady(false); }
      } catch (error) {
        if (alive) { console.error('Sessione Supabase:', error); setBooting(false); setSyncMessage(error.message || 'Impossibile verificare la sessione.'); }
      }
    })();
    const onAuthenticated = (event) => { if (alive && event.detail) hydrateUser(event.detail); };
    window.addEventListener('preventivi:authenticated', onAuthenticated);
    return () => { alive = false; authListener.subscription.unsubscribe(); window.removeEventListener('preventivi:authenticated', onAuthenticated); clearTimeout(cloudTimer.current); clearTimeout(toastTimer.current); };
  }, [hydrateUser]);

  // Realtime: ogni dispositivo autenticato sullo stesso account riceve gli aggiornamenti
  // del workspace. RLS limita il flusso alla riga appartenente all'utente.
  useEffect(() => {
    if (!user?.id || !cloudReady) return undefined;
    let active = true;
    const channel = supabase.channel(`preventivi-workspace-${user.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'preventivi_workspace',
        filter: `user_id=eq.${user.id}`,
      }, (payload) => {
        if (!active || !payload.new?.data) return;
        const row = payload.new;
        const incomingAt = row.updated_at || null;
        // L'eco della scrittura appena inviata da questo dispositivo non è un aggiornamento remoto.
        if (localWriteSnapshotRef.current && JSON.stringify(row.data) === localWriteSnapshotRef.current) {
          lastSyncedAtRef.current = incomingAt || lastSyncedAtRef.current;
          return;
        }
        if (incomingAt && lastSyncedAtRef.current && incomingAt <= lastSyncedAtRef.current) return;
        if (localDirtyRef.current || remoteConflictRef.current) {
          remoteConflictRef.current = row;
          clearTimeout(cloudTimer.current);
          setSyncState('conflict');
          setSyncMessage('Un altro dispositivo ha salvato modifiche mentre questo dispositivo aveva modifiche locali. Scegli quale versione mantenere.');
          return;
        }
        lastSyncedAtRef.current = incomingAt;
        skipNextSaveRef.current = true;
        setDb(normalizeDb(row.data));
        setSyncState('synced');
        setSyncMessage('Aggiornato in tempo reale da un altro dispositivo');
      })
      .subscribe((status) => {
        if (!active) return;
        if (status === 'SUBSCRIBED') {
          setRealtimeStatus('checking');
          supabase.rpc('pp_realtime_enabled').then(({ data, error }) => {
            if (active) setRealtimeStatus(!error && data === true ? 'connected' : 'not-enabled');
          }).catch(() => { if (active) setRealtimeStatus('not-enabled'); });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setRealtimeStatus('disconnected');
      });
    return () => {
      active = false;
      setRealtimeStatus('connecting');
      supabase.removeChannel(channel);
    };
  }, [user?.id, cloudReady]);

  // Il salvataggio usa un confronto atomico della versione: due dispositivi non possono
  // sovrascriversi in silenzio. Le modifiche remote arrivano tramite Realtime.
  useEffect(() => {
    if (!ready || !cloudReady || !user) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    if (remoteConflictRef.current) return;
    clearTimeout(cloudTimer.current);
    cloudTimer.current = setTimeout(async () => {
      if (savingRef.current || remoteConflictRef.current) return;
      savingRef.current = true;
      let lastSavedSnapshot = null;
      let conflictFound = false;
      let legacyFallbackUsed = false;
      try {
        do {
          syncPendingRef.current = false;
          const snapshot = latestDbRef.current;
          if (!lastSyncedAtRef.current) throw new Error('Versione cloud non disponibile. Ricarica i dati prima di salvare.');
          localWriteSnapshotRef.current = JSON.stringify(snapshot);
          setSyncState('saving'); setSyncMessage('Salvataggio e sincronizzazione con gli altri dispositivi…');
          const saved = await saveWorkspaceVersioned(user.id, snapshot, lastSyncedAtRef.current);
          localWriteSnapshotRef.current = null;
          if (!saved.saved) {
            remoteConflictRef.current = saved.latest;
            conflictFound = true;
            setSyncState('conflict');
            setSyncMessage('Un altro dispositivo ha salvato prima di questo. Le tue modifiche locali sono conservate: scegli quale versione mantenere.');
            break;
          }
          lastSyncedAtRef.current = saved.updated_at;
          lastSavedSnapshot = snapshot;
          if (latestDbRef.current === snapshot) localDirtyRef.current = false;
          if (saved.legacyFallback) legacyFallbackUsed = true;
        } while (syncPendingRef.current || latestDbRef.current !== lastSavedSnapshot);
        if (!conflictFound) {
          setSyncState('synced');
          setSyncMessage(legacyFallbackUsed
            ? 'Dati salvati con compatibilità. Per attivare il controllo conflitti e il Realtime completo, applica la migrazione SQL inclusa nel pacchetto.'
            : 'Dati salvati e aggiornamenti in tempo reale attivi sugli altri dispositivi');
        }
      } catch (error) {
        localWriteSnapshotRef.current = null;
        console.error('Salvataggio cloud:', error);
        setSyncState('error');
        setSyncMessage(`${error.message || 'Sincronizzazione non riuscita.'} Le modifiche non sono confermate nel cloud: esporta un backup prima di chiudere la pagina.`);
      } finally {
        savingRef.current = false;
        const newerSnapshotExists = Boolean(lastSavedSnapshot && latestDbRef.current !== lastSavedSnapshot && !remoteConflictRef.current);
        syncPendingRef.current = false;
        if (newerSnapshotExists) {
          clearTimeout(cloudTimer.current);
          cloudTimer.current = setTimeout(() => {
            if (user && cloudReady) setDb(current => ({ ...current }));
          }, 50);
        }
      }
    }, 650);
    return () => clearTimeout(cloudTimer.current);
  }, [db, ready, cloudReady, user]);

  const updateDb = useCallback((updater) => {
    localDirtyRef.current = true;
    setDb(previous => {
      const next = typeof updater === 'function' ? updater(previous) : updater;
      return normalizeDb(next);
    });
  }, []);

  const doLogout = async () => {
    setUserMenu(false);
    try { const { error } = await withTimeout(supabase.auth.signOut(), 10000); if (error) throw error; }
    catch (error) { notify(`Disconnessione: ${error.message || 'errore'}`); }
    setUser(null); setReady(false); setCloudReady(false); setSyncState('idle');
  };

  const linesForCategory = (category) => {
    const template = db.settings?.categoryTemplates?.[category];
    if (template?.confirmed && Array.isArray(template.lines) && template.lines.some(line => String(line || '').trim())) {
      return template.lines.filter(line => String(line || '').trim()).map((desc, index) => ({ id: `tpl-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 5)}`, desc: String(desc), internalPrice: null, showPrice: false }));
    }
    return [{ id: `l${Date.now()}`, desc: '', internalPrice: null, showPrice: false }];
  };
  const createQuote = () => {
    setRevisionHistoryOpen(false);
    // La bozza resta in memoria mentre si visitano le altre sezioni.
    if (draft) {
      setView('editor');
      setShowMobileMenu(false);
      notify('Preventivo ripreso: le modifiche in corso sono ancora disponibili.');
      return;
    }
    const next = newDraft(db);
    next.lines = linesForCategory(next.category);
    setDraft(next); setView('editor'); setShowMobileMenu(false);
  };
  const returnToArchive = () => {
    // Le modifiche dell'editor non vengono scritte nel workspace fino a Salva.
    // Un preventivo esistente resta quindi nella sua ultima versione salvata.
    finishLineDrag();
    setDraft(null);
    setView('history');
    setShowMobileMenu(false);
    notify('Modifiche non salvate annullate. La versione già presente in archivio è rimasta invariata.');
  };
  const confirmReplaceDraft = (nextAction) => {
    if (!draft) return true;
    const hasContent = Boolean(draft.id || draft.client?.trim() || draft.subtitle?.trim() ||
      draft.intro?.trim() || (draft.lines || []).some(line => String(line.desc || '').trim()));
    return !hasContent || window.confirm(`Hai un preventivo con modifiche non salvate. Vuoi annullarle e ${nextAction}?`);
  };
  const createQuoteForCategory = (category) => {
    if (!confirmReplaceDraft('creare un preventivo per questo settore')) return;
    setRevisionHistoryOpen(false);
    const next = newDraft(db);
    next.category = category;
    next.lines = linesForCategory(category);
    setDraft(next); setView('editor'); setShowMobileMenu(false);
  };
  const createQuoteForClient = (client) => {
    if (!confirmReplaceDraft('creare un nuovo preventivo per questo cliente')) return;
    setRevisionHistoryOpen(false);
    const next = newDraft(db);
    next.client = client.name;
    next.address = client.address || '';
    next.tax = client.tax || '';
    next.place = client.place || '';
    next.phone = client.phone || '';
    next.email = client.email || '';
    next.pec = client.pec || '';
    setDraft(next); setView('editor'); setShowMobileMenu(false);
  };
  const changeDraftCategory = (category) => setDraft(previous => {
    if (!previous) return previous;
    const hasTypedDescriptions = previous.lines.some(line => String(line.desc || '').trim());
    return { ...previous, category, ...(hasTypedDescriptions ? {} : { lines: linesForCategory(category) }) };
  });
  const editQuote = (quote) => {
    setRevisionHistoryOpen(false);
    if (draft?.id && draft.id === quote.id) {
      setView('editor'); setShowMobileMenu(false);
      notify('Preventivo ripreso con le modifiche ancora in corso.');
      return;
    }
    if (!confirmReplaceDraft('aprire il preventivo selezionato')) return;
    setDraft({ ...newDraft(db), ...quote, lines: (quote.lines || []).length ? quote.lines.map(line => ({ ...line, internalPrice: line.internalPrice !== undefined ? line.internalPrice : (line.amount ?? null), desc: String(line.desc || '') })) : [{ id: `l${Date.now()}`, desc: '', internalPrice: null }] });
    setView('editor'); setShowMobileMenu(false);
  };
  const updateDraft = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));
  const updateLine = (id, value) => setDraft(previous => ({ ...previous, lines: previous.lines.map(line => line.id === id ? { ...line, desc: value } : line) }));
  const reorderLineAtPoint = (drag, clientX, clientY, targetRow = document.elementFromPoint(clientX, clientY)?.closest?.('.description-line[data-line-id]')) => {
    if (!draft) return;
    const targetId = targetRow?.getAttribute('data-line-id');
    if (!targetId || targetId === drag.id) return;
    const rect = targetRow.getBoundingClientRect();
    const insertAfter = clientY > rect.top + rect.height / 2;
    const position = `${targetId}:${insertAfter ? 'after' : 'before'}`;
    if (drag.lastPosition === position) return;
    drag.lastPosition = position;
    setDraft(previous => {
      if (!previous) return previous;
      const lines = [...previous.lines];
      const from = lines.findIndex(line => line.id === drag.id);
      if (from < 0) return previous;
      const [moved] = lines.splice(from, 1);
      const targetIndex = lines.findIndex(line => line.id === targetId);
      if (targetIndex < 0) return previous;
      const destination = targetIndex + (insertAfter ? 1 : 0);
      if (destination === from) return previous;
      lines.splice(destination, 0, moved);
      return { ...previous, lines };
    });
  };
  const finishLineDrag = () => {
    clearTimeout(lineDragTimer.current);
    lineDragTimer.current = null;
    lineDragRef.current = null;
    setDraggingLineId(null);
  };
  const startLineDrag = (event, id) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    clearTimeout(lineDragTimer.current);
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    lineDragRef.current = {
      id, active: false, pointerId, lastPosition: null,
      lastClientX: event.clientX, lastClientY: event.clientY,
    };
    // Il puntatore resta agganciato al numero, mai alla casella descrizione.
    try { target.setPointerCapture?.(pointerId); } catch {}
    lineDragTimer.current = setTimeout(() => {
      const drag = lineDragRef.current;
      if (!drag || drag.id !== id || drag.pointerId !== pointerId) return;
      drag.active = true;
      setDraggingLineId(id);
      // Applica anche l'eventuale movimento avvenuto durante la pressione iniziale.
      reorderLineAtPoint(drag, drag.lastClientX, drag.lastClientY);
    }, 380);
  };
  const moveLineDrag = (event) => {
    const drag = lineDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.lastClientX = event.clientX;
    drag.lastClientY = event.clientY;
    if (!drag.active || !draft) return;
    event.preventDefault();
    const targetRow = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.description-line[data-line-id]');
    reorderLineAtPoint(drag, event.clientX, event.clientY, targetRow);
  };
  const moveLineByKeyboard = (id, direction) => setDraft(previous => {
    if (!previous) return previous;
    const from = previous.lines.findIndex(line => line.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= previous.lines.length) return previous;
    const lines = [...previous.lines];
    const [moved] = lines.splice(from, 1);
    lines.splice(to, 0, moved);
    return { ...previous, lines };
  });
  const addLine = () => setDraft(previous => ({ ...previous, lines: [...previous.lines, { id: `l${Date.now()}${Math.random()}`, desc: '', internalPrice: null, showPrice: false }] }));
  const removeLine = (id) => setDraft(previous => ({ ...previous, lines: previous.lines.length > 1 ? previous.lines.filter(line => line.id !== id) : [{ id: `l${Date.now()}`, desc: '', internalPrice: null, showPrice: false }] }));

  const saveQuote = () => {
    if (!draft.client.trim()) { notify('Inserisci il nome del cliente prima di salvare.'); return; }
    const hasWorkDescription = draft.lines.some(line => String(line.desc || '').trim()) || String(draft.subtitle || '').trim() || (String(draft.title || '').trim() && String(draft.title).trim() !== 'Preventivo per fornitura e posa in opera di');
    if (!hasWorkDescription) { notify('Inserisci almeno una descrizione del lavoro o una specifica prima di salvare.'); return; }
    const sums = calcTotal(draft);
    const now = new Date().toISOString();
    const quote = { ...draft, id: draft.id || `q-${Date.now()}`, number: draft.number || quoteNumber(db.quotes), client: draft.client.trim(), net: sums.net,
      vatRate: sums.rate, vat: sums.vat, total: sums.total, updated: now,
      lines: draft.lines.map(line => { const { amount: legacyAmount, ...rest } = line; const internalPrice = line.internalPrice !== undefined ? line.internalPrice : (legacyAmount ?? null); return { ...rest, internalPrice: internalPrice === '' ? null : (internalPrice == null ? null : Math.max(0, Number(internalPrice) || 0)), desc: String(line.desc || '').trim() }; }).filter(line => line.desc),
    };
    updateDb(previous => {
      const quotes = [...previous.quotes];
      const index = quotes.findIndex(q => q.id && q.id === quote.id);
      const existing = index >= 0 ? quotes[index] : null;
      const cleanSnapshot = (item) => {
        const { revisions, changeLog, ...snapshot } = item;
        return JSON.parse(JSON.stringify(snapshot));
      };
      const changedFields = existing ? [
        ['number', 'Numero'], ['date', 'Data'], ['status', 'Stato'], ['category', 'Settore'], ['client', 'Cliente'],
        ['address', 'Indirizzo'], ['tax', 'Codice fiscale / P. IVA'], ['place', 'Località'],
        ['phone', 'Telefono'], ['email', 'E-mail'], ['pec', 'PEC'], ['title', 'Titolo'],
        ['subtitle', 'Specifiche'], ['intro', 'Testo introduttivo'], ['lines', 'Descrizioni lavori'],
        ['closing', 'Note finali'], ['net', 'Imponibile'], ['vatRate', 'Aliquota IVA'], ['payment', 'Pagamento'],
      ].filter(([key]) => JSON.stringify(existing[key] ?? null) !== JSON.stringify(quote[key] ?? null)).map(([, label]) => label) : ['Creazione preventivo'];
      const revisions = existing ? [...(Array.isArray(existing.revisions) ? existing.revisions : []), {
        id: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        savedAt: existing.updated || existing.date || now,
        note: changedFields.length ? `Modifiche: ${changedFields.join(', ')}` : 'Salvataggio senza variazioni rilevate',
        snapshot: cleanSnapshot(existing),
      }].slice(-100) : [];
      const changeLog = [...(existing?.changeLog || []), {
        id: `chg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        at: now,
        action: existing ? 'Modifica salvata' : 'Preventivo creato',
        details: changedFields.length ? changedFields.join(', ') : 'Nessuna variazione rilevata',
      }].slice(-200);
      const saved = { ...quote, revisions, changeLog };
      if (index >= 0) quotes[index] = saved; else quotes.unshift(saved);
      const clients = [...previous.clients];
      const clientIndex = clients.findIndex(c => escapeName(c.name) === escapeName(saved.client));
      const client = { name: saved.client, address: saved.address || '', tax: saved.tax || '', place: saved.place || '', phone: saved.phone || '', email: saved.email || '', pec: saved.pec || '' };
      if (clientIndex >= 0) clients[clientIndex] = client; else clients.unshift(client);
      const items = [...previous.items];
      for (const line of saved.lines) {
        if (line.desc && !items.some(item => item.cat === saved.category && escapeName(item.desc) === escapeName(line.desc))) {
          items.unshift({ id: `i-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, cat: saved.category, desc: line.desc });
        }
      }
      return { ...previous, quotes, clients, items };
    });
    setDraft(quote);
    notify('Preventivo salvato. Sincronizzazione in corso…');
  };
  const deleteQuote = (quote) => {
    if (!window.confirm(`Spostare nel cestino il preventivo ${quote.number} di ${quote.client}? Potrai ripristinarlo dalle Impostazioni.`)) return;
    updateDb(previous => ({ ...previous, quotes: previous.quotes.filter(q => q.id !== quote.id), trash: [{ id: `trash-q-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'quote', label: `${quote.number || 'Preventivo'} · ${quote.client || 'Cliente non indicato'}`, deletedAt: new Date().toISOString(), data: quote }, ...(previous.trash || [])] }));
    if (draft?.id === quote.id) setDraft(null);
    notify('Preventivo spostato nel cestino.');
  };
  const duplicateQuote = (quote) => {
    if (!confirmReplaceDraft('duplicare il preventivo selezionato')) return;
    const copy = { ...quote, id: null, number: quoteNumber(db.quotes), date: todayISO(), status: 'Bozza', lines: (quote.lines || []).map(line => ({ ...line, id: `l${Date.now()}${Math.random()}` })) };
    setDraft(copy); setView('editor'); notify('Copia pronta da modificare.');
  };
  const saveSettings = (settings) => {
    updateDb(previous => ({ ...previous, settings: { ...DEFAULT_SETTINGS, ...settings } }));
    notify('Impostazioni aziendali salvate.');
  };
  const addCatalogItem = (category, description) => {
    const desc = description.trim();
    if (!desc) return false;
    if (db.items.some(item => item.cat === category && escapeName(item.desc) === escapeName(desc))) { notify('Questa voce è già presente nel catalogo.'); return false; }
    updateDb(previous => ({ ...previous, items: [{ id: `i-${Date.now()}`, cat: category, desc }, ...previous.items] }));
    notify('Voce aggiunta al catalogo.'); return true;
  };
  const deleteCatalogItem = (item) => {
    if (!window.confirm(`Spostare nel cestino la voce “${item.desc}”?`)) return;
    updateDb(previous => ({ ...previous, items: previous.items.filter(i => i.id !== item.id), trash: [{ id: `trash-catalog-${Date.now()}`, type: 'catalog', label: `${item.cat} · ${item.desc}`, deletedAt: new Date().toISOString(), data: item }, ...(previous.trash || [])] }));
    notify('Voce di catalogo spostata nel cestino.');
  };
  const exportBackup = () => {
    const blob = new Blob([JSON.stringify({ ...db, version: 2, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = href; link.download = `preventivi-pro-backup-${todayISO()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  const importQuoteFile = async (file) => {
    if (!file) return;
    setImportBusy(true);
    try { const extracted = await extractDocumentText(file); setQuoteImport(parseQuoteText(extracted.text, file.name, db, { layoutLines: extracted.layoutLines, ocrUsed: extracted.ocrUsed })); }
    catch (error) { notify(error?.message || 'Impossibile leggere il documento.'); }
    finally { setImportBusy(false); }
  };
  const saveImportedQuote = (parsed) => {
    if (!parsed.client.trim()) { notify('Inserisci il nome del cliente prima di importare.'); return; }
    const id = `q-import-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const clientMatch = db.clients.find(c => escapeName(c.name) === escapeName(parsed.client));
    const existingSameQuote = db.quotes.some(q => String(q.number).trim().toLowerCase() === parsed.number.trim().toLowerCase() && escapeName(q.client) === escapeName(parsed.client));
    if (existingSameQuote && !window.confirm(`Esiste già un preventivo ${parsed.number} per ${parsed.client}. Vuoi importarlo comunque come nuovo documento?`)) return;
    const net = Math.max(0, Number(parsed.total) || 0);
    const quote = { ...newDraft(db), id, number: parsed.number.trim() || quoteNumber(db.quotes), date: parsed.date || todayISO(), category: parsed.category || CATEGORIES[0], status: 'Importato', client: parsed.client.trim(), address: parsed.address || clientMatch?.address || '', tax: parsed.tax || clientMatch?.tax || '', place: parsed.place || clientMatch?.place || '', phone: parsed.phone || clientMatch?.phone || '', email: parsed.email || clientMatch?.email || '', pec: parsed.pec || clientMatch?.pec || '', title: parsed.title || '', subtitle: parsed.subtitle || '', intro: parsed.intro || '', closing: parsed.closing || '', payment: parsed.payment || db.settings.payment, lines: (parsed.lines || []).filter(l => l.desc.trim()).map((l,i) => ({ id: `imp-${Date.now()}-${i}`, desc: l.desc.trim(), internalPrice: l.amount !== null && l.amount !== undefined && l.amount !== '' ? Math.max(0, Number(l.amount) || 0) : null, showPrice: false })), net, vatRate: Number(parsed.vatRate ?? db.settings.defaultVat), importedFrom: parsed.fileName, importedAt: new Date().toISOString(), importRawText: parsed.rawText?.slice(0, 30000) };
    if (!quote.lines.length) quote.lines = [{ id: `imp-${Date.now()}`, desc: 'Verificare e completare le descrizioni importate' }];
    const sums = calcTotal(quote); quote.net = sums.net; quote.vat = sums.vat; quote.total = sums.total; quote.updated = new Date().toISOString();
    updateDb(previous => {
      const clients = [...previous.clients]; const ci = clients.findIndex(c => escapeName(c.name) === escapeName(quote.client));
      const nextClient = { ...(ci >= 0 ? clients[ci] : {}), name: quote.client, address: quote.address, tax: quote.tax || (ci >= 0 ? clients[ci].tax || '' : ''), place: quote.place, phone: quote.phone || '', email: quote.email || '', pec: quote.pec || '' };
      if (ci >= 0) clients[ci] = nextClient; else clients.unshift(nextClient);
      const items = [...previous.items]; for (const line of quote.lines) if (!items.some(item => item.cat === quote.category && escapeName(item.desc) === escapeName(line.desc))) items.unshift({ id: `i-imp-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, cat: quote.category, desc: line.desc });
      return { ...previous, quotes: [quote, ...previous.quotes], clients, items };
    });
    setQuoteImport(null); setView('history'); notify('Preventivo importato e aggiunto all’archivio senza sostituire i dati esistenti.');
  };
  const saveClient = (client, previousName) => {
    if (!client.name.trim()) { notify('Il nome del cliente è obbligatorio.'); return; }
    if (db.clients.some(c => escapeName(c.name) === escapeName(client.name) && escapeName(c.name) !== escapeName(previousName))) { notify('Esiste già un cliente con questo nome.'); return; }
    updateDb(previous => {
      const clients = [...previous.clients]; const oldIndex = clients.findIndex(c => escapeName(c.name) === escapeName(previousName));
      if (oldIndex >= 0) clients[oldIndex] = { ...clients[oldIndex], ...client, name: client.name.trim() }; else clients.unshift({ ...client, name: client.name.trim() });
      const quotes = previous.quotes.map(q => escapeName(q.client) === escapeName(previousName) ? { ...q, client: client.name.trim(), address: client.address, tax: client.tax, place: client.place, phone: client.phone || '', email: client.email || '', pec: client.pec || '' } : q);
      return { ...previous, clients, quotes };
    }); setEditingClient(null); notify('Dati cliente aggiornati.');
  };
  const deleteClient = (client) => {
    const linked = db.quotes.filter(q => escapeName(q.client) === escapeName(client.name)).length;
    if (!window.confirm(`Spostare il cliente “${client.name}” nel cestino?${linked ? ` I ${linked} preventivi collegati resteranno nell’archivio.` : ''}`)) return;
    updateDb(previous => ({ ...previous, clients: previous.clients.filter(c => escapeName(c.name) !== escapeName(client.name)), trash: [{ id: `trash-client-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'client', label: client.name, deletedAt: new Date().toISOString(), data: client }, ...(previous.trash || [])] })); notify('Cliente spostato nel cestino. I preventivi non sono stati eliminati.');
  };
  const restoreTrashItem = (entry) => {
    const exists = entry.type === 'quote' ? db.quotes.some(item => item.id === entry.data.id)
      : entry.type === 'client' ? db.clients.some(item => escapeName(item.name) === escapeName(entry.data.name))
      : db.items.some(item => item.id === entry.data.id || (item.cat === entry.data.cat && escapeName(item.desc) === escapeName(entry.data.desc)));
    if (exists) { notify(entry.type === 'client' ? 'Esiste già un cliente con questo nome. Rinominalo o modifica la rubrica prima di ripristinare.' : 'Un elemento equivalente è già presente: non è stato creato un duplicato.'); return; }
    updateDb(previous => ({ ...previous,
      quotes: entry.type === 'quote' ? [entry.data, ...previous.quotes] : previous.quotes,
      clients: entry.type === 'client' ? [entry.data, ...previous.clients] : previous.clients,
      items: entry.type === 'catalog' ? [entry.data, ...previous.items] : previous.items,
      trash: (previous.trash || []).filter(item => item.id !== entry.id),
    }));
    notify('Elemento ripristinato dal cestino.');
  };
  const permanentlyDeleteTrashItem = (entry) => {
    if (!window.confirm(`Eliminare definitivamente “${entry.label}”? Questa operazione non è reversibile.`)) return;
    updateDb(previous => ({ ...previous, trash: (previous.trash || []).filter(item => item.id !== entry.id) }));
    notify('Elemento eliminato definitivamente dal cestino.');
  };
  const saveCategoryTemplate = (category, template) => {
    updateDb(previous => ({ ...previous, settings: { ...previous.settings, categoryTemplates: { ...(previous.settings?.categoryTemplates || {}), [category]: template } } }));
    notify(template.confirmed ? `Modello predefinito confermato per ${category}.` : `Modello di ${category} aggiornato.`);
  };
  const importBackup = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || '{}'));
        const isWorkspace = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          && ['quotes', 'items', 'clients'].some(key => Array.isArray(parsed[key]))
          && (parsed.settings === undefined || (parsed.settings && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings)));
        if (!isWorkspace) throw new Error('Struttura backup non valida');
        const incoming = normalizeDb(parsed);
        if (!window.confirm('Importare il backup e sostituire i dati cloud attualmente presenti per questo account?')) return;
        updateDb(incoming); notify('Backup importato. Verrà sincronizzato nel database cloud.');
      } catch { notify('Il file selezionato non contiene un backup Preventivi Pro valido. I dati non sono stati modificati.'); }
    };
    reader.onerror = () => notify('Non è stato possibile leggere il file di backup.');
    reader.readAsText(file);
  };
  const retrySync = async () => {
    if (!user) return;
    setSyncState('saving'); setSyncMessage('Verifica connessione e sincronizzazione…');
    try {
      if (!lastSyncedAtRef.current) throw new Error('Versione cloud non disponibile: ricarica il workspace.');
      const saved = await saveWorkspaceVersioned(user.id, db, lastSyncedAtRef.current);
      if (!saved.saved) {
        remoteConflictRef.current = saved.latest;
        setSyncState('conflict');
        setSyncMessage('Esiste una versione più recente su un altro dispositivo. Scegli quale mantenere.');
        return;
      }
      lastSyncedAtRef.current = saved.updated_at;
      localDirtyRef.current = false;
      remoteConflictRef.current = null;
      setCloudReady(true); setSyncState('synced'); setSyncMessage(saved.legacyFallback ? 'Dati salvati con compatibilità. Applica la migrazione SQL per attivare il Realtime completo.' : 'Tutti i dati sono sincronizzati nel database cloud'); notify('Connessione Supabase ripristinata.');
    } catch (error) { setSyncState('error'); setSyncMessage(error.message || 'Sincronizzazione non riuscita.'); notify('Impossibile sincronizzare: controlla la configurazione Supabase.'); }
  };

  const acceptRemoteWorkspace = () => {
    const remote = remoteConflictRef.current;
    if (!remote?.data) return;
    if (!window.confirm('Caricare la versione più recente dal cloud? Le modifiche non ancora salvate su questo dispositivo verranno sostituite.')) return;
    clearTimeout(cloudTimer.current);
    remoteConflictRef.current = null;
    localDirtyRef.current = false;
    lastSyncedAtRef.current = remote.updated_at || lastSyncedAtRef.current;
    skipNextSaveRef.current = true;
    setDb(normalizeDb(remote.data));
    setSyncState('synced');
    setSyncMessage('Versione cloud caricata e sincronizzata');
    notify('È stata caricata la versione più recente.');
  };

  const keepLocalWorkspace = () => {
    const remote = remoteConflictRef.current;
    if (!remote) return;
    if (!window.confirm('Sovrascrivere la versione cloud con i dati di questo dispositivo? Le modifiche arrivate dagli altri dispositivi non verranno mantenute.')) return;
    lastSyncedAtRef.current = remote.updated_at || lastSyncedAtRef.current;
    remoteConflictRef.current = null;
    localDirtyRef.current = true;
    setSyncState('idle');
    setDb(current => normalizeDb(current));
  };

  const recentQuotes = useMemo(() => [...db.quotes].sort((a, b) => (b.updated || '').localeCompare(a.updated || '')).slice(0, 5), [db.quotes]);
  const historyQuotes = useMemo(() => {
    const term = historySearch.toLowerCase().trim();
    return [...db.quotes].filter(q => [q.number, q.client, q.category, q.status].some(value => String(value || '').toLowerCase().includes(term)))
      .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  }, [db.quotes, historySearch]);
  const catalogItems = useMemo(() => db.items.filter(item => (catalogFilter === 'Tutti' || item.cat === catalogFilter) && item.desc.toLowerCase().includes(catalogSearch.toLowerCase())), [db.items, catalogFilter, catalogSearch]);
  // Unisce le voci del Catalogo lavori e quelle dei preventivi salvati,
  // mostrando esclusivamente elementi della categoria selezionata.
  const editorCatalogItems = useMemo(() => {
    if (!draft?.category) return [];
    const category = draft.category;
    const catalogEntries = (Array.isArray(db.items) ? db.items : [])
      .filter(item => item && item.cat === category)
      .map((item, index) => ({
        id: `catalog-${category}-${item.id || index}`,
        cat: category,
        desc: String(item.desc || '').trim(),
      }));
    const quoteEntries = (Array.isArray(db.quotes) ? db.quotes : [])
      .filter(quote => quote && quote.category === category)
      .flatMap((quote, quoteIndex) => (Array.isArray(quote.lines) ? quote.lines : [])
        .map((line, lineIndex) => ({
          id: `quote-${category}-${quote.id || quoteIndex}-${line.id || lineIndex}`,
          cat: category,
          desc: String(line?.desc || '').trim(),
        })));
    const seen = new Set();
    return [...catalogEntries, ...quoteEntries].filter(item => {
      const key = item.desc.toLocaleLowerCase('it-IT');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [db.items, db.quotes, draft?.category]);
  const clientItems = useMemo(() => db.clients.filter(client => [client.name, client.address, client.tax, client.place, client.phone, client.email, client.pec].some(value => String(value || '').toLowerCase().includes(clientSearch.toLowerCase()))), [db.clients, clientSearch]);

  if (passwordRecovery) return <PasswordRecoveryScreen onComplete={async () => { const result = await supabase.auth.getUser(); if (result.error) throw result.error; setPasswordRecovery(false); if (result.data.user) await hydrateUser(result.data.user); }} />;
  if (booting) return <div className="app-loading"><span className="spinner spinner-dark" /><strong>Avvio di Preventivi Pro</strong><p>Verifica della sessione sicura…</p></div>;
  if (!user) return <AuthScreen />;
  if (!ready) return <div className="app-loading"><span className="spinner spinner-dark" /><strong>Caricamento dei tuoi dati</strong><p>Sto verificando il database cloud.</p></div>;
  if (!cloudReady) return <DatabaseUnavailable email={user.email} message={syncMessage} retrying={syncState === 'loading'} onRetry={() => hydrateUser(user)} onLogout={doLogout} />;

  const menu = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'preventivi', label: 'Preventivi', icon: FileText },
    { id: 'editor', label: draft ? 'Riprendi preventivo' : 'Nuovo preventivo', icon: FilePlus2, action: createQuote },
    { id: 'history', label: 'Archivio preventivi', icon: FileText },
    { id: 'clients', label: 'Clienti', icon: Users },
    { id: 'catalog', label: 'Catalogo lavori', icon: BookOpen },
    { id: 'settings', label: 'Impostazioni', icon: Settings },
  ];
  const setPage = (id) => {
    // La navigazione normale non elimina la bozza: per annullarla serve il tasto dedicato.
    setView(id); setShowMobileMenu(false);
  };
  const pageTitle = ({ home: 'Home', preventivi: 'Preventivi', jobs: 'Lavori Oggi', calendar: 'Calendario', sites: 'Cantieri', deadlines: 'Scadenze', invoices: 'Fatture', inventory: 'Magazzino', editor: draft?.id ? 'Modifica preventivo' : 'Nuovo preventivo', history: 'Archivio preventivi', clients: 'Anagrafica clienti', catalog: 'Catalogo lavori', settings: 'Impostazioni' })[view] || 'Panoramica';
  const activeModule = MODULE_PLACEHOLDERS[view] ? { ...MODULE_PLACEHOLDERS[view], icon: HOME_MODULES.find(item => item.id === view)?.icon || CalendarDays } : null;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="sidebar-brand"><Brand compact /></div>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="main-nav" aria-label="Navigazione principale">
        {menu.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => item.action ? item.action() : setPage(item.id)}><item.icon size={18} strokeWidth={1.8} /><span>{item.label}</span>{item.id === 'history' && db.quotes.length > 0 && <small>{db.quotes.length}</small>}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className={`sidebar-sync ${syncState === 'synced' ? 'is-good' : syncState === 'error' || syncState === 'conflict' ? 'is-error' : ''}`}><span className="sync-dot" />{syncState === 'conflict' ? 'Conflitto da risolvere' : syncState === 'synced' ? (realtimeStatus === 'connected' ? 'Cloud · Live' : 'Cloud sincronizzato') : syncState === 'error' ? 'Sincronizzazione da verificare' : syncState === 'saving' || syncState === 'loading' ? 'Sincronizzazione…' : 'Cloud in attesa'}</div>
        <div className="sidebar-user"><div className="avatar"><UserRound size={18} /></div><div className="sidebar-user-copy"><strong>Il tuo account</strong><span title={user.email}>{user.email}</span></div><button className="icon-button sidebar-menu-trigger" onClick={() => setUserMenu(!userMenu)} aria-label="Menu account"><MoreHorizontal size={18} /></button></div>
        {userMenu && <div className="account-popover"><button onClick={doLogout}><LogOut size={16} /> Esci dall’account</button></div>}
      </div>
    </aside>

    <div className="main-column">
      <header className="app-header">
        <div className="header-mobile-brand"><button className="icon-button mobile-menu-button" onClick={() => setShowMobileMenu(!showMobileMenu)} aria-label="Apri menu"><MoreHorizontal size={20} /></button><Brand compact /></div>
        <div className="breadcrumb"><span>Chiaradia Impianti</span><span className="breadcrumb-slash">/</span><strong>{pageTitle}</strong></div>
        <div className="header-actions">
          <div className={`cloud-indicator ${syncState === 'error' || syncState === 'conflict' ? 'cloud-error' : syncState === 'synced' ? 'cloud-good' : ''}`} title={syncMessage || 'Stato sincronizzazione'}>
            {syncState === 'error' || syncState === 'conflict' ? <CloudOff size={16} /> : syncState === 'synced' ? <Cloud size={16} /> : <RefreshCw size={15} className={syncState === 'saving' || syncState === 'loading' ? 'spin' : ''} />}
            <span>{syncState === 'conflict' ? 'Conflitto' : syncState === 'error' ? 'Errore cloud' : syncState === 'synced' ? (realtimeStatus === 'connected' ? 'Live' : 'Sincronizzato') : syncState === 'saving' || syncState === 'loading' ? 'Salvataggio…' : 'Cloud'}</span>
          </div>
          <button className="button button-primary header-new-button" onClick={createQuote}><Plus size={17} /> {draft ? 'Riprendi preventivo' : 'Nuovo preventivo'}</button>
        </div>
      </header>

      {showMobileMenu && <div className="mobile-menu-overlay" onClick={() => setShowMobileMenu(false)}><div className="mobile-menu-panel" onClick={e => e.stopPropagation()}><div className="mobile-menu-head"><Brand compact /><button className="icon-button" onClick={() => setShowMobileMenu(false)}><X size={19} /></button></div>{menu.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => item.action ? item.action() : setPage(item.id)}><item.icon size={18} /><span>{item.label}</span></button>)}<button className="nav-item logout-nav" onClick={doLogout}><LogOut size={18} /><span>Esci dall’account</span></button></div></div>}

      <main className={`page-content page-${view}`}>
        {draft && view !== 'editor' && <div className="draft-resume-banner" role="status">
          <div><strong>{draft.id ? `Modifica preventivo ${draft.number || ''}`.trim() : 'Nuovo preventivo in corso'}</strong><span>Le modifiche non salvate restano disponibili mentre navighi nell’app.</span></div>
          <button type="button" className="button button-secondary button-small" onClick={createQuote}><ArrowRight size={15} /> Riprendi preventivo</button>
        </div>}
        {syncState === 'error' && <div className="sync-warning"><div className="sync-warning-icon"><CloudOff size={18} /></div><div className="sync-warning-copy"><strong>Salvataggio cloud da verificare</strong><p>{syncMessage}</p></div><button className="button button-small" onClick={retrySync}><RefreshCw size={15} /> Riprova</button></div>}
        {syncState === 'conflict' && <div className="sync-warning sync-conflict-warning" role="alert"><div className="sync-warning-icon"><CloudOff size={18} /></div><div className="sync-warning-copy"><strong>Modifiche presenti su più dispositivi</strong><p>{syncMessage}</p></div><div className="sync-conflict-actions"><button type="button" className="button button-secondary button-small" onClick={acceptRemoteWorkspace}>Carica versione cloud</button><button type="button" className="button button-primary button-small" onClick={keepLocalWorkspace}>Mantieni questa versione</button></div></div>}

        {view === 'home' && <section className="module-home">
          <div className="page-heading module-home-heading"><div><div className="eyebrow">IL TUO UFFICIO DIGITALE</div><h1>{dashboardGreeting()}, {String(db.settings?.name || DEFAULT_SETTINGS.name).trim() || DEFAULT_SETTINGS.name}</h1><p>Un unico spazio per organizzare preventivi e attività aziendali.</p></div></div>
          <div className="module-launcher-grid" aria-label="Sezioni del gestionale">
            {HOME_MODULES.map(({ id, label, icon: Icon, tone }) => <button type="button" key={id} className={`module-launcher-tile module-tone-${tone}`} onClick={() => setPage(id)}>
              <span className="module-launcher-icon"><Icon size={38} strokeWidth={2.25} /></span>
              <strong>{label}</strong>
              {id === 'preventivi' && <small>{db.quotes.length} documenti · archivio e gestione completa</small>}
            </button>)}
          </div>
          <div className="module-home-footer"><span><Cloud size={17} /> {realtimeStatus === 'connected' ? 'Aggiornamenti in tempo reale attivi sui dispositivi collegati allo stesso account.' : 'Workspace cloud di Preventivi Pro. La modalità live si attiva dopo aver applicato la migrazione database inclusa.'}</span><button type="button" className="button button-primary" onClick={() => setPage('preventivi')}>Apri i preventivi <ArrowRight size={16} /></button></div>
        </section>}

        {view === 'preventivi' && <>
          <div className="page-heading"><div><div className="eyebrow">IL TUO UFFICIO DIGITALE</div><h1>{dashboardGreeting()}, {String(db.settings?.name || DEFAULT_SETTINGS.name).trim() || DEFAULT_SETTINGS.name} <span className="heading-wave">✦</span></h1><p>Gestisci preventivi, clienti e descrizioni dei lavori da un unico spazio.</p></div><button className="button button-primary" onClick={createQuote}><Plus size={17} /> Crea preventivo</button></div>
          <div className="stats-grid">
            <div className="stat-card"><div className="stat-card-top"><span>Preventivi totali</span><span className="stat-icon stat-icon-blue"><FileText size={18} /></span></div><strong>{db.quotes.length}</strong><small>Documenti archiviati</small></div>
            <div className="stat-card"><div className="stat-card-top"><span>Clienti salvati</span><span className="stat-icon stat-icon-gold"><Users size={18} /></span></div><strong>{db.clients.length}</strong><small>In rubrica</small></div>
            <div className="stat-card"><div className="stat-card-top"><span>Voci di catalogo</span><span className="stat-icon stat-icon-violet"><BookOpen size={18} /></span></div><strong>{db.items.length}</strong><small>Descrizioni riutilizzabili</small></div>
            <div className="stat-card"><div className="stat-card-top"><span>Valore preventivi</span><span className="stat-icon stat-icon-green"><Activity size={18} /></span></div><strong className="stat-money">{money(db.quotes.reduce((sum, quote) => sum + (Number(quote.total) || 0), 0))}</strong><small>Totale dei documenti salvati</small></div>
          </div>
          <div className="dashboard-grid">
            <section className="surface recent-surface"><div className="section-heading"><div><h2>Attività recente</h2><p>I preventivi aggiornati più di recente</p></div><button className="button button-secondary button-small" onClick={() => setPage('history')}>Vedi archivio <ArrowRight size={15} /></button></div>
              {recentQuotes.length === 0 ? <EmptyState icon={FileText} title="Il tuo archivio è pronto" text="Crea il primo preventivo: le bozze e i documenti salvati compariranno qui." action="Crea un preventivo" onAction={createQuote} /> : <div className="recent-list">{recentQuotes.map(q => <div className="recent-row" key={q.id}><div className="recent-doc-icon"><FileText size={18} /></div><div className="recent-main"><strong>{q.client}</strong><span>{q.number} <i>·</i> {q.category}</span></div><div className="recent-amount"><strong>{money(q.total)}</strong><span>{formatDate(q.date)}</span></div><button className="icon-button recent-open" onClick={() => editQuote(q)} aria-label={`Apri ${q.number}`}><ArrowRight size={17} /></button></div>)}</div>}
            </section>
            <section className="surface quick-surface"><div className="section-heading"><div><h2>Accessi rapidi</h2><p>Le funzioni più usate</p></div></div>
              <button className="quick-link" onClick={createQuote}><span className="quick-icon quick-blue"><FilePlus2 size={19} /></span><span><strong>Nuovo preventivo</strong><small>Crea e stampa un documento</small></span><ArrowRight size={17} /></button>
              <button className="quick-link" onClick={() => setPage('clients')}><span className="quick-icon quick-gold"><Users size={19} /></span><span><strong>Rubrica clienti</strong><small>Recupera dati già utilizzati</small></span><ArrowRight size={17} /></button>
              <button className="quick-link" onClick={() => setPage('catalog')}><span className="quick-icon quick-violet"><BookOpen size={19} /></span><span><strong>Catalogo lavori</strong><small>Riutilizza descrizioni e voci</small></span><ArrowRight size={17} /></button>
              <div className="tip-box"><span><BadgeCheck size={17} /></span><p><strong>Un unico archivio</strong><br />Quando il cloud è collegato, i preventivi si sincronizzano con gli altri dispositivi.</p></div>
            </section>
          </div>
          <section className="categories-section"><div className="section-heading"><div><h2>Settori di lavoro</h2><p>Seleziona un settore mentre prepari il documento.</p></div></div><div className="category-cards">{CATEGORIES.map((cat, index) => { const icons = [Zap, AirVent, Wrench, ShieldCheck, Activity, Building2]; const Icon = icons[index]; return <button key={cat} className="category-card" onClick={() => createQuoteForCategory(cat)}><span className={`category-icon category-tone-${index}`}><Icon size={19} /></span><span><strong>{cat}</strong><small>{db.items.filter(i => i.cat === cat).length} voci salvate</small></span><ArrowRight size={16} /></button>; })}</div></section>
        </>}

        {activeModule && <section className="module-placeholder surface">
          <div className="module-placeholder-icon"><activeModule.icon size={34} /></div>
          <div className="eyebrow">MODULO AGGIUNTO ALLA HOME</div>
          <h1>{activeModule.title}</h1>
          <p>{activeModule.description}</p>
          <div className="module-placeholder-note"><Cloud size={18} /><span>La struttura database e la sincronizzazione sono predisposte. In una fase successiva aggiungeremo inserimento, modifica, ricerca e collegamenti ai dati reali.</span></div>
          <button type="button" className="button button-secondary" onClick={() => setPage('home')}><ArrowLeft size={16} /> Torna alla Home</button>
        </section>}

        {view === 'editor' && draft && <>
          <div className="page-heading editor-page-heading"><div><div className="eyebrow">DOCUMENTO COMMERCIALE</div><h1>{draft.id ? 'Modifica preventivo' : 'Crea un preventivo'}</h1><p>Compila i dati: l’anteprima segue le modifiche e non mostra prezzi per singola voce.</p></div><div className="heading-actions"><button className="button button-secondary" onClick={returnToArchive}><ArrowLeft size={16} /> Torna all’archivio</button><button className="button button-secondary" onClick={printQuote}><Printer size={16} /> Stampa / PDF</button><button className="button button-primary" onClick={saveQuote}><Check size={17} /> Salva</button></div></div>
          <div className="editor-revision-toolbar">
            <button type="button" className="button button-secondary revision-toggle" aria-expanded={revisionHistoryOpen} aria-controls="revision-history-panel" onClick={() => setRevisionHistoryOpen(open => !open)}>
              <History size={16} /> {revisionHistoryOpen ? 'Chiudi cronologia e ripristino' : 'Cronologia e ripristino'} <ChevronDown size={15} />
            </button>
            <span className="revision-toolbar-hint">{draft.id ? 'Apri per consultare le modifiche e ripristinare una versione precedente' : 'La cronologia sarà disponibile dopo il primo salvataggio'}</span>
          </div>
          {revisionHistoryOpen && (draft.id ? (() => {
            const savedQuote = db.quotes.find(q => q.id === draft.id);
            if (!savedQuote) return <section id="revision-history-panel" className="surface form-card revision-history-card" aria-label="Cronologia del preventivo"><p className="revision-empty">Non è stato trovato lo storico di questo preventivo.</p></section>;
            const revisions = [...(savedQuote.revisions || [])].reverse();
            const changes = [...(savedQuote.changeLog || [])].reverse();
            return <section id="revision-history-panel" className="surface form-card revision-history-card" aria-label="Cronologia del preventivo">
              <div className="form-card-heading"><span className="form-step"><History size={17} /></span><div><h2>Cronologia e ripristino</h2><p>Consulta le modifiche registrate e seleziona una versione precedente per ripristinarla nell’editor.</p></div></div>
              {changes.length > 0 && <div className="revision-change-list"><h3>Modifiche registrate</h3>{changes.slice(0, 12).map(event => <div className="revision-change-row" key={event.id}><span><strong>{event.action}</strong><small>{event.details}</small></span><time>{new Date(event.at).toLocaleString('it-IT')}</time></div>)}</div>}
              {revisions.length > 0 ? <div className="revision-list"><h3>Versioni precedenti</h3>{revisions.map((revision, idx) => <div className="revision-row" key={revision.id || idx}><span><strong>{new Date(revision.savedAt).toLocaleString('it-IT')}</strong><small>{revision.note || 'Versione salvata'}</small></span><button type="button" className="button button-secondary button-small" onClick={() => { if (!revision.snapshot) { notify('Questa versione non contiene una copia ripristinabile.'); return; } if (!window.confirm('Caricare questa versione nell’editor? Dopo il controllo premi Salva per registrare il ripristino.')) return; setDraft({ ...newDraft(db), ...revision.snapshot, id: savedQuote.id, revisions: savedQuote.revisions || [], changeLog: savedQuote.changeLog || [], lines: (revision.snapshot.lines || []).map((line, i) => ({ ...line, id: line.id || `restore-${Date.now()}-${i}`, desc: String(line.desc || '') })) }); setRevisionHistoryOpen(false); notify('Versione caricata nell’editor. Premi Salva per confermare il ripristino.'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Ripristina</button></div>)}</div> : <p className="revision-empty">Non ci sono ancora versioni precedenti. La cronologia si popola dal primo salvataggio successivo a una modifica.</p>}
            </section>;
          })() : <section id="revision-history-panel" className="surface form-card revision-history-card" aria-label="Cronologia del preventivo"><p className="revision-empty">Salva prima il preventivo. Dopo il salvataggio qui troverai le modifiche registrate e le versioni da ripristinare.</p></section>)}
          <div className="editor-layout">
            <div className="edit-panel">
              <section className="surface form-card"><div className="form-card-heading"><span className="form-step">01</span><div><h2>Dati del documento</h2><p>Numero, settore, data e condizioni</p></div></div>
                <div className="form-grid form-grid-three"><div className="field"><label htmlFor="q-number">Numero preventivo</label><input id="q-number" value={draft.number} onChange={e => updateDraft('number', e.target.value)} placeholder="P 01.26" /></div><div className="field"><label htmlFor="q-date">Data</label><input id="q-date" type="date" value={draft.date} onChange={e => updateDraft('date', e.target.value)} /></div><div className="field"><label htmlFor="q-status">Stato</label><select id="q-status" value={draft.status} onChange={e => updateDraft('status', e.target.value)}><option>Bozza</option><option>Inviato</option><option>Accettato</option><option>Rifiutato</option></select></div></div>
                <div className="form-grid form-grid-two"><div className="field"><label htmlFor="q-category">Settore impiantistico</label><select id="q-category" value={draft.category} onChange={e => changeDraftCategory(e.target.value)}>{CATEGORIES.map(cat => <option key={cat}>{cat}</option>)}</select></div><div className="field"><label htmlFor="q-payment">Termini di pagamento</label><textarea id="q-payment" rows={2} value={draft.payment} onChange={e => updateDraft('payment', e.target.value)} placeholder="70% a conferma lavoro\n30% a completamento" /></div></div>
              </section>
              <section className="surface form-card"><div className="form-card-heading"><span className="form-step">02</span><div><h2>Dati del cliente</h2><p>Le informazioni saranno conservate nella rubrica</p></div></div>
                <div className="field"><label htmlFor="q-client">Nome / ragione sociale *</label><input id="q-client" list="client-suggestions" autoComplete="off" value={draft.client} onChange={e => { const value = e.target.value; updateDraft('client', value); const match = db.clients.find(c => escapeName(c.name) === escapeName(value)); if (match) setDraft(prev => ({ ...prev, client: value, address: match.address || '', tax: match.tax || '', place: match.place || '', phone: match.phone || '', email: match.email || '', pec: match.pec || '' })); }} placeholder="Es. Mario Rossi" /><datalist id="client-suggestions">{db.clients.map(c => <option value={c.name} key={c.name} />)}</datalist></div>
                <div className="form-grid form-grid-two"><div className="field"><label htmlFor="q-address">Indirizzo / descrizione cliente</label><input id="q-address" value={draft.address} onChange={e => updateDraft('address', e.target.value)} placeholder="Via, numero civico" /></div><div className="field"><label htmlFor="q-tax">Codice fiscale / P. IVA</label><input id="q-tax" value={draft.tax} onChange={e => updateDraft('tax', e.target.value)} placeholder="Codice fiscale o partita IVA" /></div></div>
                <div className="field"><label htmlFor="q-place">Località / nota anagrafica</label><input id="q-place" value={draft.place} onChange={e => updateDraft('place', e.target.value)} placeholder="CAP, città o riferimento" /></div>
                <div className="client-contact-heading"><strong>Recapiti del cliente</strong><span>Facoltativi · puoi lasciarli vuoti</span></div>
                 <div className="form-grid form-grid-three client-contact-fields">
                   <div className="field"><label htmlFor="q-phone">Numero di telefono (facoltativo)</label><input id="q-phone" type="tel" autoComplete="tel" value={draft.phone || ''} onChange={e => updateDraft('phone', e.target.value)} placeholder="Es. 333 1234567" /></div>
                   <div className="field"><label htmlFor="q-email">E-mail (facoltativa)</label><input id="q-email" type="email" autoComplete="email" value={draft.email || ''} onChange={e => updateDraft('email', e.target.value)} placeholder="nome@email.it" /></div>
                   <div className="field"><label htmlFor="q-pec">PEC (facoltativa)</label><input id="q-pec" type="email" value={draft.pec || ''} onChange={e => updateDraft('pec', e.target.value)} placeholder="nome@pec.it" /></div>
                 </div>
              </section>
              <section className="surface form-card"><div className="form-card-heading"><span className="form-step">03</span><div><h2>Descrizione dei lavori</h2><p>Inserisci le attività incluse nel preventivo; i prezzi importati sono facoltativi</p></div></div>
                <div className="field"><label htmlFor="q-title">Titolo della fornitura / del lavoro</label><textarea id="q-title" rows={2} value={draft.title} onChange={e => updateDraft('title', e.target.value)} placeholder="Preventivo per fornitura e posa in opera di…" /></div>
                <div className="field"><label htmlFor="q-subtitle">Modello, quantità o specifica (facoltativo)</label><input id="q-subtitle" value={draft.subtitle} onChange={e => updateDraft('subtitle', e.target.value)} placeholder="Es. climatizzatore mono split Hisense Console 18000 BTU A++" /></div>
                <div className="field"><label htmlFor="q-intro">Testo introduttivo (facoltativo)</label><textarea id="q-intro" rows={4} maxLength={4000} value={draft.intro} onChange={e => updateDraft('intro', e.target.value)} placeholder="Si precisa quanto segue…" /></div>
                <div className="line-items-heading"><div><strong>Attività incluse</strong><span>{draft.lines.filter(line => String(line.desc || '').trim()).length} voci compilate · tieni premuto il numero per trascinare; Alt + ↑ / ↓ per spostare</span></div><button className="button button-secondary button-small" onClick={addLine}><Plus size={15} /> Aggiungi voce</button></div>
                <div className="description-lines">{draft.lines.map((line, index) => { const options = editorCatalogItems; return <div className={`description-line${draggingLineId === line.id ? ' is-dragging' : ''}`} data-line-id={line.id} key={line.id}><button type="button" className="description-bullet description-drag-handle" aria-label={`Trascina la voce ${index + 1}`} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" title="Tieni premuto il numero per trascinare; Alt + freccia su/giù per spostare" onPointerDown={e => startLineDrag(e, line.id)} onPointerMove={moveLineDrag} onPointerUp={finishLineDrag} onPointerCancel={finishLineDrag} onLostPointerCapture={finishLineDrag} onKeyDown={e => { if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); moveLineByKeyboard(line.id, -1); } else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); moveLineByKeyboard(line.id, 1); } }} onContextMenu={e => { if (lineDragRef.current?.active) e.preventDefault(); }}>{index + 1}</button><div className="line-input-wrap"><textarea aria-label={`Descrizione lavoro ${index + 1}`} rows={2} list={`suggestions-${line.id}`} value={line.desc} onChange={e => updateLine(line.id, e.target.value)} placeholder="Descrivi una lavorazione o una fornitura…" /><datalist id={`suggestions-${line.id}`}>{options.map(item => <option value={item.desc} key={item.id} />)}</datalist><select className="insert-suggestion" aria-label="Inserisci una voce dal catalogo" value="" onChange={e => { if (e.target.value) updateLine(line.id, e.target.value); }}><option value="">{options.length > 0 ? 'Inserisci dal catalogo…' : 'Catalogo vuoto — aggiungi voci nel catalogo lavori'}</option>{options.map(item => <option value={item.desc} key={item.id}>{item.desc}{item.cat ? ` · ${item.cat}` : ''}</option>)}</select></div><div className="import-editor-line-price"><label htmlFor={`internal-price-${line.id}`}>Prezzo €</label><div className="line-price-controls"><input id={`internal-price-${line.id}`} type="number" min="0" step="0.01" inputMode="decimal" value={line.internalPrice !== undefined ? (line.internalPrice ?? '') : (line.amount ?? '')} onChange={e=>setDraft(prev=>({...prev,lines:prev.lines.map(item=>item.id===line.id?{...item,internalPrice:e.target.value===''?null:Math.max(0,Number(e.target.value)||0)}:item)}))} /><button type="button" className={`icon-button line-price-visibility${line.showPrice === true ? ' is-visible' : ''}`} aria-label={line.showPrice === true ? `Nascondi il prezzo della voce ${index + 1} nella stampa` : `Mostra il prezzo della voce ${index + 1} nella stampa`} aria-pressed={line.showPrice === true} title={line.showPrice === true ? 'Prezzo visibile nella stampa: fai clic per nasconderlo' : 'Prezzo nascosto nella stampa: fai clic per mostrarlo'} onClick={()=>setDraft(prev=>({...prev,lines:prev.lines.map(item=>item.id===line.id?{...item,showPrice:item.showPrice!==true}:item)}))}>{line.showPrice === true ? <Eye size={16}/> : <EyeOff size={16}/>}</button></div><span className={`line-price-state${line.showPrice === true ? ' is-visible' : ''}`}>{line.showPrice === true ? 'Visibile in stampa' : 'Nascosto in stampa'}</span></div><button className="icon-button remove-line" onClick={() => removeLine(line.id)} title="Rimuovi voce" aria-label="Rimuovi voce"><X size={17} /></button></div>; })}</div><div className="internal-cost-summary"><span>Somma dei prezzi delle attività</span><strong>{money(draft.lines.reduce((sum, line) => sum + Math.max(0, Number(line.internalPrice !== undefined ? line.internalPrice : line.amount) || 0), 0))}</strong><button type="button" className="button button-secondary button-small" onClick={() => { const sum = Math.round((draft.lines.reduce((acc, line) => acc + Math.max(0, Number(line.internalPrice !== undefined ? line.internalPrice : line.amount) || 0), 0) + Number.EPSILON) * 100) / 100; updateDraft('net', sum); notify('Somma dei costi interni copiata nel campo imponibile; controlla il valore prima di salvare.'); }}>Usa come imponibile</button></div>
                <div className="field closing-field"><label htmlFor="q-closing">Altre condizioni / note finali</label><textarea id="q-closing" rows={3} value={draft.closing} onChange={e => updateDraft('closing', e.target.value)} placeholder="Es. escluso opere murarie, tracce e ripristini…" /></div>
              </section>
              <section className="surface form-card"><div className="form-card-heading"><span className="form-step">04</span><div><h2>Riepilogo economico</h2><p>Un solo imponibile complessivo, IVA configurabile</p></div></div>
                <div className="financial-fields"><div className="field"><label htmlFor="q-net">Totale imponibile (€)</label><div className="money-input"><span>€</span><input id="q-net" type="number" min="0" step="0.01" inputMode="decimal" value={draft.net} onChange={e => updateDraft('net', e.target.value)} placeholder="0,00" /></div></div><div className="field"><label htmlFor="q-vat">Aliquota IVA</label><div className="vat-input"><select aria-label="Aliquota IVA predefinita" value={['0','4','5','10','22'].includes(String(draft.vatRate)) ? String(draft.vatRate) : 'custom'} onChange={e => { if (e.target.value !== 'custom') updateDraft('vatRate', Number(e.target.value)); }}><option value="0">0%</option><option value="4">4%</option><option value="5">5%</option><option value="10">10%</option><option value="22">22%</option><option value="custom">Personalizzata</option></select><input type="number" min="0" max="100" step="0.1" aria-label="Aliquota IVA personalizzata percentuale" value={draft.vatRate} onChange={e => updateDraft('vatRate', e.target.value)} /></div></div></div>
                <div className="calculated-total"><div><span>Imponibile</span><strong>{money(calcTotal(draft).net)}</strong></div><div><span>IVA {Number(draft.vatRate) || 0}%</span><strong>{money(calcTotal(draft).vat)}</strong></div><div className="calculated-grand"><span>Totale documento</span><strong>{money(calcTotal(draft).total)}</strong></div></div>
              </section>
              <div className="editor-bottom-actions"><button className="button button-secondary" onClick={printQuote}><Printer size={17} /> Stampa / Salva PDF</button><button className="button button-primary" onClick={saveQuote}><Check size={17} /> Salva preventivo</button></div>
            </div>
            <aside className="preview-panel"><div className="preview-panel-top"><div><span className="preview-live-dot" /><strong>Anteprima documento</strong></div><button className="icon-button" onClick={printQuote} title="Stampa o esporta PDF" aria-label="Stampa"><Printer size={17} /></button></div><div className="preview-paper-wrap"><QuoteDocument draft={draft} settings={db.settings} /></div><div className="preview-hint"><CircleHelp size={16} /><span>L’anteprima rispecchia la stampa. Usa l’occhio accanto al prezzo per decidere quali importi mostrare nella stampa.</span></div></aside>
          </div>
        </>}

        {view === 'history' && <>
          <div className="page-heading"><div><div className="eyebrow">ARCHIVIO DOCUMENTI</div><h1>Archivio preventivi</h1><p>Ritrova, modifica, duplica o stampa i documenti salvati.</p></div><div className="heading-actions"><label className="button button-secondary import-quote-label"><FilePlus2 size={17} /> {importBusy ? 'Lettura documento…' : 'Importa PDF / Word'}<input type="file" accept=".pdf,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" disabled={importBusy} onChange={e => { importQuoteFile(e.target.files?.[0]); e.target.value = ''; }} /></label><button className="button button-primary" onClick={createQuote}><Plus size={17} /> Nuovo preventivo</button></div></div>
          <section className="surface table-surface"><div className="table-toolbar"><div className="table-count"><strong>{historyQuotes.length}</strong> <span>{historyQuotes.length === 1 ? 'preventivo' : 'preventivi'}</span></div><div className="search-field"><Search size={17} /><input value={historySearch} onChange={e => setHistorySearch(e.target.value)} placeholder="Cerca per numero, cliente, settore…" aria-label="Cerca preventivi" /><Filter size={15} className="search-filter-icon" /></div></div>
            {historyQuotes.length === 0 ? <EmptyState icon={FileText} title={db.quotes.length ? 'Nessun risultato' : 'Ancora nessun preventivo'} text={db.quotes.length ? 'Prova a modificare la ricerca.' : 'I preventivi creati e salvati compariranno in questo archivio.'} action={db.quotes.length ? undefined : 'Crea un preventivo'} onAction={createQuote} /> : <div className="responsive-table-wrap"><table className="data-table"><thead><tr><th>Documento</th><th>Cliente</th><th>Settore</th><th>Stato</th><th className="align-right">Totale</th><th className="align-right">Azioni</th></tr></thead><tbody>{historyQuotes.map(q => <tr key={q.id}><td><button className="table-primary-text" onClick={() => editQuote(q)}>{q.number}</button><span className="table-secondary-text">{formatDate(q.date)}</span></td><td><strong className="table-client">{q.client}</strong></td><td><span className="category-pill">{q.category}</span></td><td><span className={`status-pill status-${String(q.status || 'bozza').toLowerCase()}`}>{q.status || 'Bozza'}</span></td><td className="align-right total-cell">{money(q.total)}</td><td><div className="table-actions"><button className="icon-button" title="Apri" aria-label="Apri" onClick={() => editQuote(q)}><Pencil size={16} /></button><button className="icon-button" title="Duplica" aria-label="Duplica" onClick={() => duplicateQuote(q)}><Copy size={16} /></button><button className="icon-button danger-icon" title="Elimina" aria-label="Elimina" onClick={() => deleteQuote(q)}><Trash2 size={16} /></button></div></td></tr>)}</tbody></table></div>}
          </section>
        </>}

        {view === 'clients' && <>
          <div className="page-heading"><div><div className="eyebrow">ANAGRAFICA</div><h1>Clienti</h1><p>La rubrica si aggiorna quando salvi un preventivo.</p></div><button className="button button-primary" onClick={createQuote}><Plus size={17} /> Nuovo preventivo</button></div>
          <section className="surface table-surface"><div className="table-toolbar"><div className="table-count"><strong>{clientItems.length}</strong> <span>{clientItems.length === 1 ? 'cliente' : 'clienti'}</span></div><div className="search-field"><Search size={17} /><input value={clientSearch} onChange={e => setClientSearch(e.target.value)} placeholder="Cerca cliente o indirizzo…" aria-label="Cerca cliente" /></div></div>
            {clientItems.length === 0 ? <EmptyState icon={Users} title={db.clients.length ? 'Nessun cliente trovato' : 'La rubrica è vuota'} text={db.clients.length ? 'Prova a cambiare il testo della ricerca.' : 'Salva un preventivo con i dati del cliente per aggiungerlo automaticamente.'} action={db.clients.length ? undefined : 'Crea preventivo'} onAction={createQuote} /> : <div className="responsive-table-wrap"><table className="data-table"><thead><tr><th>Cliente</th><th>Indirizzo</th><th>Codice fiscale / P. IVA</th><th>Preventivi</th><th /></tr></thead><tbody>{clientItems.map(client => <tr key={client.name}><td><div className="client-name-cell"><span className="avatar avatar-small"><UserRound size={15} /></span><strong>{client.name}</strong></div></td><td>{client.address || client.place || '—'}</td><td>{client.tax || '—'}</td><td><span className="category-pill">{db.quotes.filter(q => escapeName(q.client) === escapeName(client.name)).length} documenti</span></td><td><div className="table-actions"><button className="button button-secondary button-small" onClick={() => setEditingClient({ ...client, originalName: client.name })}><Pencil size={14} /> Modifica</button><button className="icon-button danger-icon" title="Elimina cliente" aria-label="Elimina cliente" onClick={() => deleteClient(client)}><Trash2 size={16} /></button><button className="button button-secondary button-small" onClick={() => createQuoteForClient(client)}>Crea preventivo</button></div></td></tr>)}</tbody></table></div>}
          </section>
        </>}

        {view === 'catalog' && <>
          <div className="page-heading"><div><div className="eyebrow">LAVORI RIUTILIZZABILI</div><h1>Catalogo lavori</h1><p>Salva descrizioni che usi spesso e richiamale nei prossimi preventivi.</p></div></div>
          <CatalogManager items={catalogItems} total={db.items.length} search={catalogSearch} setSearch={setCatalogSearch} filter={catalogFilter} setFilter={setCatalogFilter} onAdd={addCatalogItem} onDelete={deleteCatalogItem} />
        </>}

        {view === 'settings' && <>
          <div className="page-heading"><div><div className="eyebrow">PERSONALIZZAZIONE</div><h1>Impostazioni</h1><p>Gestisci intestazione aziendale, IVA predefinita e copie di sicurezza.</p></div></div>
          <SettingsManager settings={db.settings} save={saveSettings} exportBackup={exportBackup} importBackup={importBackup} syncState={syncState} syncMessage={syncMessage} retrySync={retrySync} /><TrashAndTemplates db={db} onRestore={restoreTrashItem} onDeleteForever={permanentlyDeleteTrashItem} onSaveTemplate={saveCategoryTemplate} />
        </>}
      </main>
      <footer className="app-footer"><span>© {new Date().getFullYear()} Chiaradia Impianti</span><span>Preventivi Pro <i>·</i> React + Supabase</span></footer>
    </div>
    {quoteImport && <ImportQuoteModal initial={quoteImport} onClose={() => setQuoteImport(null)} onSave={saveImportedQuote} />}
    {editingClient && <ClientEditModal client={editingClient} onClose={() => setEditingClient(null)} onSave={(client) => saveClient(client, editingClient.originalName)} />}
    <nav className="mobile-bottom-nav" aria-label="Navigazione rapida"><button className={view === 'home' ? 'active' : ''} onClick={() => setPage('home')}><Home size={19} /><span>Home</span></button><button className={view === 'history' ? 'active' : ''} onClick={() => setPage('history')}><FileText size={19} /><span>Archivio</span></button><button className="mobile-create" onClick={createQuote}><Plus size={24} /><span>Nuovo</span></button><button className={view === 'clients' ? 'active' : ''} onClick={() => setPage('clients')}><Users size={19} /><span>Clienti</span></button><button className={view === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><Settings size={19} /><span>Altro</span></button></nav>
    {toast && <div className="toast-notification" role="status"><CheckCircle2 size={18} /><span>{toast}</span><button className="icon-button" onClick={() => setToast('')} aria-label="Chiudi messaggio"><X size={15} /></button></div>}
  </div>;
}

function CatalogManager({ items, total, search, setSearch, filter, setFilter, onAdd, onDelete }) {
  const [addOpen, setAddOpen] = useState(false);
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [description, setDescription] = useState('');
  const submit = (event) => { event.preventDefault(); if (onAdd(category, description)) { setDescription(''); setAddOpen(false); } };
  return <div className="catalog-layout"><section className="surface catalog-main"><div className="table-toolbar catalog-toolbar"><div className="table-count"><strong>{items.length}</strong> <span>di {total} voci</span></div><button className="button button-primary button-small" onClick={() => setAddOpen(!addOpen)}>{addOpen ? <X size={16} /> : <Plus size={16} />}{addOpen ? 'Annulla' : 'Aggiungi voce'}</button></div>
    {addOpen && <form className="catalog-add-form" onSubmit={submit}><div className="field"><label htmlFor="catalog-category">Settore</label><select id="catalog-category" value={category} onChange={e => setCategory(e.target.value)}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></div><div className="field"><label htmlFor="catalog-description">Descrizione</label><textarea autoFocus id="catalog-description" required rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="Descrizione della fornitura o attività…" /></div><button className="button button-primary" type="submit"><Check size={16} /> Salva voce</button></form>}
    <div className="catalog-filters"><div className="search-field"><Search size={17} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca nel catalogo…" aria-label="Cerca catalogo" /></div><select value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filtra settore"><option>Tutti</option>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></div>
    {items.length === 0 ? <EmptyState icon={BookOpen} title={total ? 'Nessuna voce trovata' : 'Costruiamo il tuo catalogo'} text={total ? 'Prova a cambiare la ricerca o il settore.' : 'Aggiungi le descrizioni che utilizzi più spesso. Le nuove voci saranno suggerite durante la compilazione.'} action={total ? undefined : 'Aggiungi prima voce'} onAction={() => setAddOpen(true)} /> : <div className="catalog-list">{items.map(item => <div className="catalog-row" key={item.id}><span className="catalog-item-icon"><FileText size={17} /></span><div className="catalog-row-copy"><strong>{item.desc}</strong><span>{item.cat}</span></div><button className="icon-button danger-icon" title="Elimina voce" aria-label={`Elimina ${item.desc}`} onClick={() => { if (window.confirm('Rimuovere questa descrizione dal catalogo?')) onDelete(item); }}><Trash2 size={16} /></button></div>)}</div>}
  </section><aside className="surface catalog-side"><span className="side-illustration"><BookOpen size={24} /></span><h2>Il tuo archivio di descrizioni</h2><p>Le descrizioni salvate sono riutilizzabili nei preventivi dello stesso settore e sincronizzate sul cloud.</p><div className="catalog-side-stat"><strong>{total}</strong><span>voci totali</span></div><div className="catalog-side-stat"><strong>{CATEGORIES.length}</strong><span>settori disponibili</span></div></aside></div>;
}

function SettingsManager({ settings, save, exportBackup, importBackup, syncState, syncMessage, retrySync }) {
  const [form, setForm] = useState({ ...DEFAULT_SETTINGS, ...settings });
  const fileRef = useRef(null);
  useEffect(() => setForm({ ...DEFAULT_SETTINGS, ...settings }), [settings]);
  const field = (key, value) => setForm(previous => ({ ...previous, [key]: value }));
  const uploadLogo = (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    if (file.size > 1.8 * 1024 * 1024) { alert('Scegli un’immagine più piccola di 1,8 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => field('logoData', String(reader.result));
    reader.onerror = () => alert('Impossibile leggere il file logo selezionato.');
    reader.readAsDataURL(file);
  };
  return <div className="settings-layout"><section className="surface form-card settings-main"><div className="form-card-heading"><span className="settings-heading-icon"><Building2 size={19} /></span><div><h2>Dati aziendali</h2><p>Questi dati saranno stampati nell’intestazione del preventivo.</p></div></div>
    <form onSubmit={e => { e.preventDefault(); save(form); }}><div className="settings-logo-row"><div className="settings-logo-preview"><img src={form.logoData || LOGO_URL} alt="Logo aziendale" /></div><div><strong>Logo Chiaradia Impianti</strong><p>È già impostato il logo che hai fornito. Puoi sostituirlo solo se necessario.</p><div className="inline-actions"><button type="button" className="button button-secondary button-small" onClick={() => fileRef.current?.click()}><ArrowDownToLine size={15} /> Carica logo</button>{form.logoData && <button type="button" className="text-button" onClick={() => field('logoData', '')}>Ripristina logo originale</button>}</div><input className="file-input-hidden" ref={fileRef} type="file" accept="image/*" onChange={e => { uploadLogo(e.target.files?.[0]); e.target.value = ''; }} /></div></div>
    <div className="form-grid form-grid-two"><div className="field"><label htmlFor="s-name">Ragione sociale / intestazione</label><input id="s-name" value={form.name} onChange={e => field('name', e.target.value)} /></div><div className="field"><label htmlFor="s-contact">Referente</label><input id="s-contact" value={form.contact} onChange={e => field('contact', e.target.value)} /></div></div>
    <div className="form-grid form-grid-two"><div className="field"><label htmlFor="s-address">Indirizzo</label><input id="s-address" value={form.address} onChange={e => field('address', e.target.value)} /></div><div className="field"><label htmlFor="s-city">CAP e città</label><input id="s-city" value={form.city} onChange={e => field('city', e.target.value)} /></div></div>
    <div className="form-grid form-grid-two"><div className="field"><label htmlFor="s-vat">Partita IVA</label><input id="s-vat" value={form.vat} onChange={e => field('vat', e.target.value)} /></div><div className="field"><label htmlFor="s-phone">Cellulare</label><input id="s-phone" value={form.phone} onChange={e => field('phone', e.target.value)} /></div></div>
    <div className="form-grid form-grid-two"><div className="field"><label htmlFor="s-pec">PEC</label><input id="s-pec" type="email" value={form.pec} onChange={e => field('pec', e.target.value)} /></div><div className="field"><label htmlFor="s-email">E-mail</label><input id="s-email" type="email" value={form.email} onChange={e => field('email', e.target.value)} /></div></div>
    <div className="form-grid form-grid-two"><div className="field"><label htmlFor="s-vat-default">IVA predefinita (%)</label><input id="s-vat-default" type="number" min="0" max="100" step="0.1" value={form.defaultVat} onChange={e => field('defaultVat', e.target.value)} /></div><div className="field"><label htmlFor="s-payment-default">Termini predefiniti</label><textarea id="s-payment-default" rows={2} value={form.payment} onChange={e => field('payment', e.target.value)} /></div></div>
    <div className="settings-form-footer"><button className="button button-primary" type="submit"><Check size={17} /> Salva impostazioni</button></div></form>
  </section><aside className="settings-side-stack"><section className="surface settings-side-card"><span className="side-illustration"><Cloud size={23} /></span><h2>Backup e sincronizzazione</h2><p>Il cloud salva preventivi, rubrica, catalogo e impostazioni. Puoi anche esportare una copia indipendente.</p><div className={`sync-status-block ${syncState === 'error' ? 'is-error' : syncState === 'synced' ? 'is-good' : ''}`}><span className="sync-dot" /><div><strong>{syncState === 'synced' ? 'Collegato' : syncState === 'error' ? 'Da verificare' : 'In aggiornamento'}</strong><small>{syncMessage || 'Stato della sincronizzazione'}</small></div></div><button className="button button-secondary button-wide" onClick={retrySync}><RefreshCw size={16} /> Sincronizza adesso</button></section><section className="surface settings-side-card"><span className="side-illustration side-illustration-gold"><Download size={22} /></span><h2>Backup manuale</h2><p>Scarica tutti i dati in formato JSON o ripristina un backup precedente.</p><button className="button button-secondary button-wide" onClick={exportBackup}><Download size={16} /> Esporta backup</button><BackupInput onImport={importBackup} /></section></aside></div>;
}
function TrashAndTemplates({ db, onRestore, onDeleteForever, onSaveTemplate }) {
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [templateText, setTemplateText] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const currentTemplate = db.settings?.categoryTemplates?.[category] || null;
  const trash = Array.isArray(db.trash) ? [...db.trash].sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || ''))) : [];
  const suggestions = useMemo(() => {
    const counts = new Map();
    let order = 0;
    for (const quote of db.quotes || []) {
      if (quote.category !== category) continue;
      for (const line of quote.lines || []) {
        const desc = String(line.desc || '').trim().replace(/\s+/g, ' ');
        if (!desc) continue;
        const key = desc.toLocaleLowerCase('it-IT');
        const found = counts.get(key);
        if (found) found.count += 1;
        else counts.set(key, { desc, count: 1, order: order++ });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.order - b.order).slice(0, 30);
  }, [db.quotes, category]);
  useEffect(() => {
    setTemplateText(currentTemplate?.lines?.join('\n') || suggestions.slice(0, 10).map(item => item.desc).join('\n'));
    setUnlocked(!currentTemplate?.confirmed);
  }, [category, currentTemplate?.confirmed, JSON.stringify(currentTemplate?.lines || []), JSON.stringify(suggestions.map(item => item.desc))]);
  const applySuggestions = () => setTemplateText(suggestions.slice(0, 10).map(item => item.desc).join('\n'));
  const saveTemplate = () => {
    const lines = [...new Set(templateText.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
    if (!lines.length) { window.alert('Inserisci almeno una voce nel modello.'); return; }
    if (!window.confirm(`Confermi il modello predefinito per “${category}”? Dopo la conferma non cambierà automaticamente con i nuovi preventivi; per modificarlo dovrai sbloccarlo manualmente.`)) return;
    onSaveTemplate(category, { confirmed: true, confirmedAt: new Date().toISOString(), lines });
    setUnlocked(false);
  };
  const typeLabel = (entry) => entry.type === 'quote' ? 'Preventivo' : entry.type === 'client' ? 'Cliente' : 'Voce catalogo';
  return <div className="trash-template-layout">
    <section className="surface form-card">
      <div className="form-card-heading"><span className="settings-heading-icon"><Trash2 size={19} /></span><div><h2>Cestino</h2><p>Gli elementi eliminati vengono conservati qui finché non li ripristini o li elimini definitivamente.</p></div></div>
      <div className="trash-count-row"><strong>{trash.length}</strong><span>{trash.length === 1 ? 'elemento eliminato' : 'elementi eliminati'}</span></div>
      {trash.length === 0 ? <div className="empty-state compact-empty"><Trash2 size={24}/><strong>Il cestino è vuoto</strong><p>Preventivi, clienti e voci di catalogo che elimini compariranno qui.</p></div> : <div className="trash-list">{trash.map(entry => <div className="trash-item" key={entry.id}><div className="trash-item-copy"><strong>{entry.label}</strong><span>{typeLabel(entry)} · {entry.deletedAt ? new Date(entry.deletedAt).toLocaleString('it-IT') : 'data non disponibile'}</span></div><div className="trash-item-actions"><button type="button" className="button button-secondary button-small" onClick={() => onRestore(entry)}><RefreshCw size={14}/> Ripristina</button><button type="button" className="icon-button danger-icon" title="Elimina definitivamente" aria-label={`Elimina definitivamente ${entry.label}`} onClick={() => onDeleteForever(entry)}><Trash2 size={16}/></button></div></div>)}</div>}
    </section>
    <section className="surface form-card">
      <div className="form-card-heading"><span className="settings-heading-icon"><BookOpen size={19} /></span><div><h2>Modelli predefiniti per categoria</h2><p>Le voci vengono suggerite dai preventivi salvati, ordinate per frequenza. Dopo la tua conferma il modello non viene modificato automaticamente.</p></div></div>
      <div className="field"><label htmlFor="template-category">Categoria del modello</label><select id="template-category" value={category} onChange={event => setCategory(event.target.value)}>{CATEGORIES.map(item => <option key={item}>{item}</option>)}</select></div>
      {currentTemplate?.confirmed ? <div className="message message-info"><strong>Modello confermato e bloccato</strong><p>Ultima conferma: {currentTemplate.confirmedAt ? new Date(currentTemplate.confirmedAt).toLocaleString('it-IT') : 'data non disponibile'}. I nuovi preventivi di questa categoria useranno queste voci.</p></div> : <div className="message message-info"><strong>Modello non ancora confermato</strong><p>Controlla le voci suggerite e conferma solo quando il modello rappresenta la tua struttura abituale.</p></div>}
      <div className="template-suggestion-heading"><strong>Voci ricorrenti rilevate</strong><span>{suggestions.length} voci</span></div>
      {suggestions.length ? <ul className="template-suggestions">{suggestions.slice(0, 12).map(item => <li key={item.desc}><span>{item.desc}</span><small>{item.count} {item.count === 1 ? 'utilizzo' : 'utilizzi'}</small></li>)}</ul> : <p className="muted-note">Non ci sono ancora preventivi salvati con descrizioni in questa categoria. Puoi comunque creare un modello manualmente.</p>}
      <div className="template-editor-toolbar"><label htmlFor="template-lines">Voci del modello (una per riga)</label>{!unlocked && <button type="button" className="button button-secondary button-small" onClick={() => { if (window.confirm('Sbloccare la modifica manuale del modello predefinito? Dovrai confermarlo di nuovo per renderlo attivo.')) setUnlocked(true); }}><Pencil size={14}/> Sblocca modifica</button>}</div>
      <textarea id="template-lines" className="template-lines-editor" rows={9} value={templateText} readOnly={!unlocked} onChange={event => setTemplateText(event.target.value)} placeholder="Una descrizione di lavorazione per riga…" />
      <div className="template-actions"><button type="button" className="button button-secondary" disabled={!unlocked || !suggestions.length} onClick={applySuggestions}>Usa voci più frequenti</button><button type="button" className="button button-primary" disabled={!unlocked} onClick={saveTemplate}><ShieldCheck size={16}/> Conferma modello predefinito</button></div>
      <p className="muted-note">Il modello viene salvato nelle impostazioni del workspace esistente. Il blocco è una protezione dell’interfaccia: non è un sistema di autorizzazioni separato per ruoli o utenti.</p>
    </section>
  </div>;
}

function ImportQuoteModal({ initial, onClose, onSave }) {
  const [form, setForm] = useState(() => ({ ...initial, lines: initial.lines.map(l => ({ ...l })), address: initial.address || '', tax: initial.tax || '', place: initial.place || '', title: initial.title || '', subtitle: initial.subtitle || '', intro: initial.intro || '', closing: initial.closing || '', payment: initial.payment || '', vatRate: initial.vatRate ?? 10 }));
  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
  const setLine = (index, value) => setForm(prev => ({ ...prev, lines: prev.lines.map((line, i) => i === index ? { ...line, desc: value } : line) }));
  return <div className="modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className="surface import-modal" role="dialog" aria-modal="true" aria-labelledby="import-modal-title"><div className="modal-heading"><div><span className="eyebrow">IMPORTAZIONE DOCUMENTO</span><h2 id="import-modal-title">Controlla i dati riconosciuti</h2><p>Il documento originale non viene modificato. L'importazione aggiunge un nuovo preventivo, senza sostituire quelli già presenti.</p></div><button className="icon-button" onClick={onClose} aria-label="Chiudi"><X size={20}/></button></div><div className="import-file-note"><FileText size={18}/><span>{form.fileName}</span></div>{form.warnings?.length > 0 && <div className="message message-info"><strong>Verifica manuale consigliata</strong><ul>{form.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></div>}<div className="import-form-grid"><div className="field"><label>Cliente / ragione sociale *</label><input value={form.client} onChange={e=>set('client',e.target.value)} /></div><div className="field"><label>Numero preventivo</label><input value={form.number} onChange={e=>set('number',e.target.value)} /></div><div className="field"><label>Data emissione</label><input type="date" value={form.date} onChange={e=>set('date',e.target.value)} /></div><div className="field"><label>Settore</label><select value={form.category} onChange={e=>set('category',e.target.value)}>{CATEGORIES.map(c=><option key={c}>{c}</option>)}</select></div><div className="field"><label>Indirizzo cliente</label><input value={form.address} onChange={e=>set('address',e.target.value)} /></div><div className="field"><label>Codice fiscale / P. IVA</label><input value={form.tax} onChange={e=>set('tax',e.target.value)} /></div><div className="field"><label>Località / nota anagrafica</label><input value={form.place} onChange={e=>set('place',e.target.value)} /></div><div className="field"><label>Imponibile (€)</label><input type="number" min="0" step="0.01" value={form.total} onChange={e=>set('total',e.target.value)} /></div><div className="field"><label>IVA (%)</label><input type="number" min="0" max="100" step="0.1" value={form.vatRate} onChange={e=>set('vatRate',e.target.value)} /></div></div><div className="field"><label>Titolo del preventivo</label><textarea rows={2} value={form.title} onChange={e=>set('title',e.target.value)} /></div><div className="field"><label>Modello / specifiche</label><textarea rows={2} value={form.subtitle} onChange={e=>set('subtitle',e.target.value)} /></div><div className="field"><label>Testo introduttivo</label><textarea rows={3} value={form.intro} onChange={e=>set('intro',e.target.value)} /></div><div className="field"><label>Termini di pagamento</label><textarea rows={2} value={form.payment} onChange={e=>set('payment',e.target.value)} /></div><div className="field"><label>Altre condizioni / note finali</label><textarea rows={2} value={form.closing} onChange={e=>set('closing',e.target.value)} /></div><div className="field"><label>Voci descrittive rilevate (correggibili)</label>{form.lines.map((line,i)=><div className="import-line-row" key={i}><textarea className="import-line-edit" rows={2} value={line.desc} onChange={e=>setLine(i,e.target.value)} placeholder={`Voce ${i+1}`} /><label className="import-line-price"><span>Costo interno (€)</span><input type="number" min="0" step="0.01" value={line.amount ?? ''} onChange={e=>setForm(prev=>({...prev,lines:prev.lines.map((item,j)=>j===i?{...item,amount:e.target.value===''?null:Number(e.target.value)}:item)}))} /></label></div>)}<button type="button" className="button button-secondary button-small" onClick={()=>set('lines',[...form.lines,{desc:'',amount:null}])}><Plus size={14}/> Aggiungi voce</button></div><details className="import-raw-details"><summary>Mostra testo estratto dal documento</summary><pre>{form.rawText}</pre></details><div className="modal-actions"><button className="button button-secondary" onClick={onClose}>Annulla</button><button className="button button-primary" onClick={()=>onSave(form)}><Check size={16}/> Importa nell’archivio</button></div></section></div>;
}
function ClientEditModal({ client, onClose, onSave }) {
  const [form, setForm] = useState({ name:client.name || '', address:client.address || '', tax:client.tax || '', place:client.place || '', phone:client.phone || '', email:client.email || '', pec:client.pec || '' });
  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
  return <div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="surface client-edit-modal" role="dialog" aria-modal="true" aria-labelledby="client-edit-title"><div className="modal-heading"><div><h2 id="client-edit-title">Modifica dati cliente</h2><p>Le modifiche al nome vengono riportate anche nei preventivi collegati.</p></div><button className="icon-button" onClick={onClose} aria-label="Chiudi"><X size={20}/></button></div><div className="field"><label>Nome / ragione sociale *</label><input value={form.name} onChange={e=>set('name',e.target.value)}/></div><div className="field"><label>Indirizzo</label><input value={form.address} onChange={e=>set('address',e.target.value)}/></div><div className="field"><label>Codice fiscale / P. IVA</label><input value={form.tax} onChange={e=>set('tax',e.target.value)}/></div><div className="field"><label>Località</label><input value={form.place} onChange={e=>set('place',e.target.value)}/></div><div className="field"><label>Numero di telefono</label><input type="tel" value={form.phone} onChange={e=>set('phone',e.target.value)}/></div><div className="field"><label>E-mail</label><input type="email" value={form.email} onChange={e=>set('email',e.target.value)}/></div><div className="field"><label>PEC</label><input type="email" value={form.pec} onChange={e=>set('pec',e.target.value)}/></div><div className="modal-actions"><button className="button button-secondary" onClick={onClose}>Annulla</button><button className="button button-primary" onClick={()=>onSave(form)}><Check size={16}/> Salva cliente</button></div></section></div>;
}

function BackupInput({ onImport }) {
  const inputRef = useRef(null);
  return <><input className="file-input-hidden" ref={inputRef} type="file" accept="application/json,.json" onChange={e => { onImport(e.target.files?.[0]); e.target.value = ''; }} /><button className="text-button import-backup-button" onClick={() => inputRef.current?.click()}>Scegli file di backup</button></>;
}
