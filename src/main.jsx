import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

class AppErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Errore durante il rendering di Preventivi Pro:', error, info); }
  render() {
    if (this.state.error) return <main className="fatal-error" role="alert">
      <h1>Preventivi Pro non è riuscito ad avviarsi</h1>
      <p>Si è verificato un errore nell’interfaccia. Ricarica la pagina; se persiste, invia questo messaggio all’assistenza.</p>
      <pre>{String(this.state.error?.message || this.state.error)}</pre>
      <button type="button" onClick={() => window.location.reload()}>Ricarica applicazione</button>
    </main>;
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Elemento #root mancante in index.html');
createRoot(rootElement).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>
);


// Aggiorna automaticamente le installazioni PWA dopo ogni deploy.
// Il browser controlla il service worker quando l'app viene aperta online;
// se trova una nuova versione, la attiva e ricarica la pagina una sola volta.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloadingForUpdate = false;
  let appServiceWorkerRegistration = null;
  const checkForAppUpdate = () => appServiceWorkerRegistration?.update().catch(error => console.warn('Controllo aggiornamenti non riuscito:', error));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloadingForUpdate) {
      reloadingForUpdate = true;
      window.location.reload();
    }
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .then(registration => { appServiceWorkerRegistration = registration; return registration.update(); })
      .catch(error => console.warn('Aggiornamento automatico non disponibile:', error));
  }, { once: true });
  window.addEventListener('online', checkForAppUpdate);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForAppUpdate(); });
}
