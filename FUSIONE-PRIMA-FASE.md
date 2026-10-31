# Preventivi Pro + Fill App — Prima fase integrata

## Perimetro di questa consegna
- Home unica con riquadri colorati ispirati allo screenshot di Fill App.
- Canvas, header, superfici e identità generale di Preventivi Pro conservati.
- La scheda `Preventivi` apre la dashboard Preventivi Pro esistente; non duplica né sostituisce editor, archivio, catalogo, clienti o impostazioni.
- Clienti e impostazioni aprono le sezioni già esistenti di Preventivi Pro.
- Le nuove sezioni operative sono destinazioni vuote esplicite, senza record demo e senza importare i dati fittizi di Fill App.
- Realtime client integrato sul workspace `preventivi_workspace`, con filtro per `user_id`.
- Gestione dei conflitti tra dispositivi: se sono presenti modifiche locali e remote, il sistema non sceglie silenziosamente una versione; chiede se caricare la versione cloud o mantenere quella locale.
- La migrazione prepara un salvataggio compare-and-swap tramite RPC e le tabelle per i moduli operativi.

## Dati e provenienza
Non viene importato alcun cliente, cantiere, lavoro, scadenza, fattura o articolo del progetto Fill App. La migrazione `pp_clients` copia esclusivamente i clienti già presenti in `public.preventivi_workspace` di Preventivi Pro. Il valore fiscale precedente viene conservato in `legacy_tax_identifier`, senza attribuirlo automaticamente a `tax_code` o `vat_number`.

Il workspace JSONB attuale non viene cancellato o riscritto durante la migrazione. Le tabelle `pp_*` sono predisposte per i successivi moduli operativi.

## Tabelle predisposte
- `pp_clients`, `pp_company_settings`
- `pp_sites`, `pp_jobs`, `pp_deadlines`, `pp_site_documents`
- `pp_inventory_items`, `pp_inventory_movements`
- `pp_invoices`, `pp_invoice_lines`, `pp_payments`

Tutte hanno `owner_id`, RLS e policy di proprietà. Le relazioni composite impediscono di collegare lavori, cantieri, documenti e fatture a clienti appartenenti ad altri account. Il bucket documentale è privato e usa il prefisso del percorso uguale all'ID utente.

## Applicazione del database
Destinazione esclusiva: progetto Preventivi Pro `nzvzoamhtmucshsrarqq`.
Non applicare allo storico progetto Fill App `ykumlaitukrxwkyetlzg`.

La connessione Supabase disponibile non ha autorizzato l'accesso amministrativo al progetto `nzvzoamhtmucshsrarqq`; quindi il file SQL è stato preparato ma non eseguito. Prima del deploy che richiede sincronizzazione realtime occorre applicarlo nel SQL Editor del progetto corretto e verificare:
1. presenza delle tabelle `pp_*` e delle policy RLS;
2. `preventivi_workspace` e le nuove tabelle nella publication `supabase_realtime`;
3. esito del test advisor sicurezza e prestazioni;
4. prova con due dispositivi autenticati sul medesimo account;
5. prova di conflitto simultaneo: il secondo salvataggio deve essere rifiutato dal compare-and-swap, non sovrascrivere il primo.

## Stato delle schermate nuove
Lavori Oggi, Calendario, Cantieri, Scadenze, Fatture e Magazzino sono solo entry point. Non mostrano contatori inventati e non consentono ancora inserimento/modifica. Le funzioni e i relativi test end-to-end saranno aggiunti successivamente.
