# Revisione tecnica — Preventivi Pro · Chiaradia Impianti

Data revisione: 30 ottobre 2026

## Esito della revisione

Il pacchetto unificato combina il progetto completo caricato dall'utente con la correzione del parser PDF/Word e le modifiche richieste all'editor. I file di importazione usano il layout e le coordinate estratte dal documento; l'editor conserva le bozze durante la navigazione e rende disponibili le voci di catalogo dell'account corrente.

## Funzioni incluse e verificate

- **Importazione PDF/Word:** `parseQuoteText` riceve il quarto parametro `options` e usa `options.layoutLines` per separare intestazione, cliente, dati del preventivo, condizioni di pagamento, descrizioni e riepilogo. Mantiene le righe ripetute e usa il numero presente nel documento prima del fallback dal nome file.
- **Editor catalogo:** sotto ogni campo descrizione è presente il menu `Inserisci dal catalogo…`, alimentato da tutte le voci di `db.items`, senza filtro sul settore del preventivo. Il menu resta visibile anche se il catalogo dell'account non contiene ancora voci.
- **Separazione account:** il codice continua a leggere `preventivi_workspace` filtrando per `user_id`. La funzione del catalogo è disponibile a tutti gli account, ma gli archivi restano privati e non vengono mescolati automaticamente.
- **Riordino attività:** il numero a sinistra è una maniglia circolare. Una pressione prolungata avvia il trascinamento; il puntatore viene catturato sulla maniglia e la riga di destinazione viene individuata sotto il puntatore. Sono disponibili anche `Alt + freccia su/giù`.
- **Anteprima:** le attività non vuote sono mostrate con marcatori puntati espliciti.
- **Bozza in navigazione:** la navigazione tra Panoramica, Archivio, Clienti, Catalogo e Impostazioni non elimina la bozza. Un banner permette di riprenderla.
- **Abbandono esplicito:** `Torna all'archivio` elimina solo la bozza non salvata. Un preventivo esistente conserva la versione che era già stata salvata. Le azioni che avviano un secondo preventivo chiedono conferma prima di sostituire la bozza corrente.
- **PDF.js su GitHub Pages:** il worker viene importato con `?url`, quindi Vite lo emette come asset con il percorso relativo configurato in `vite.config.js`. Il workflow controlla che l'asset del worker sia presente e non sia HTML prima della pubblicazione.
- **Supabase:** non sono state modificate tabelle, policy, chiavi o dati.

## File principali

| Percorso | Contenuto verificato |
|---|---|
| `src/App.jsx` | Editor, archivio, gestione bozze, importazione file, catalogo, preview e interazioni. |
| `src/lib/importQuote.js` | Parser di importazione aggiornato per coordinate/layout. |
| `src/lib/domain.js` | Modello dati, normalizzazione, numerazione, IVA, date e importi. |
| `src/lib/supabase.js` | Client Supabase e sessione autenticata. |
| `src/styles.css` | Maniglia di trascinamento, menu catalogo, banner bozza, marcatori preview e layout responsive. |
| `tests/domain.test.js` | Test per dominio, catalogo, bozza, anteprima e trascinamento. |
| `tests/import-quote.test.js` | Test del parser PDF/Word e regressioni di riconoscimento. |
| `tests/pdf-worker-config.test.js` | Test di configurazione del worker PDF.js e workflow. |
| `package.json` | Dipendenze e script `test`, `build`, `dev`, `preview`. |
| `.github/workflows/deploy.yml` | Deploy manuale, installazione, test, build, verifica asset PDF.js e pubblicazione GitHub Pages. |

## Esiti dei controlli locali

- `node --test`: **30 test superati, 0 falliti**.
- Parsing sintattico di JSX/JavaScript: **0 diagnostiche** sui cinque file applicativi controllati.
- `package.json`: JSON valido.
- `vite.config.js`: percorsi relativi `base: './'`.
- `.github/workflows/deploy.yml`: YAML leggibile; trigger esclusivamente manuale (`workflow_dispatch`), job `build` e `deploy` presenti; nessun deploy automatico a ogni push; deploy limitato a `main`.
- ZIP finale: verificato dopo la creazione.

## Limite del collaudo

La build Vite completa non è stata eseguita localmente: `npm install` è andato in timeout in questo ambiente. Non viene quindi dichiarata una build locale riuscita. Il workflow aggiornato esegue `npm run build` e blocca la pubblicazione se non trova l'asset PDF.js Worker emesso da Vite.

## Indicazioni per il caricamento

Estrarre lo ZIP e caricare nella radice del repository il contenuto della cartella `chiardiaimpianti67-main/`, mantenendo tutti i percorsi inclusa `.github/workflows/deploy.yml`. Il workflow non si avvia sui push. Dopo l'aggiornamento di tutti i file, avviare manualmente il deploy da Actions sul branch `main`.

Non eseguire `SUPABASE_SETUP.sql` se Supabase è già configurato.


## Aggiornamenti 31/10/2026

La build Vite emette un service worker versionato sugli asset hashati. Il client lo registra su GitHub Pages usando la base relativa del repository; al successivo avvio con rete il service worker rileva il deploy, attiva la nuova cache e ricarica l'app. Il parser anagrafico limita l'estrazione P. IVA alla porzione del documento successiva al riconoscimento del destinatario.
