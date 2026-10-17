import { useEffect, useRef, useState } from 'react';

const firebaseRealtimeConfigured = [
  import.meta.env.VITE_FIREBASE_API_KEY,
  import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  import.meta.env.VITE_FIREBASE_PROJECT_ID,
  import.meta.env.VITE_FIREBASE_APP_ID
].every(Boolean);

const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export default function App() {
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [syncStatus, setSyncStatus] = useState('idle');
  const frameRef = useRef(null);
  const refreshTimer = useRef(null);
  const firebaseRealtimeRef = useRef(null);

  useEffect(() => {
    setIsStandalone(
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );

    const onInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    window.addEventListener('beforeinstallprompt', onInstallPrompt);
    const onFrameMessage = (event) => {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
      const message = event.data || {};
      if (message.type === 'lkarne:session') {
        activateRealtime(message).catch((error) => {
          console.error('Firebase real-time connection failed:', error);
          setSyncStatus('error');
        });
      } else if (message.type === 'lkarne:logout') {
        firebaseRealtimeRef.current?.disconnectFirebaseRealtime().catch((error) => {
          console.error('Firebase sign-out failed:', error);
          setSyncStatus('error');
        });
        setSyncStatus('idle');
      }
    };
    window.addEventListener('message', onFrameMessage);
    return () => {
      window.removeEventListener('beforeinstallprompt', onInstallPrompt);
      window.removeEventListener('message', onFrameMessage);
      window.clearTimeout(refreshTimer.current);
      firebaseRealtimeRef.current?.disconnectFirebaseRealtime().catch((error) => {
        console.error('Firebase sign-out failed:', error);
      });
    };
  }, []);

  async function activateRealtime(message) {
    if (!firebaseRealtimeConfigured) return;
    const firebaseRealtime = await import('./firebaseRealtime.js');
    firebaseRealtimeRef.current = firebaseRealtime;
    setSyncStatus('connecting');
    let customToken = message.firebaseCustomToken;
    if (!customToken && message.apiUrl && message.token) {
      const response = await fetch(message.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'auth/firebase_token', token: message.token })
      });
      const result = await response.json();
      if (!result.success || !result.firebaseCustomToken) {
        throw new Error(result.error || 'The backend did not issue a Firebase login token.');
      }
      customToken = result.firebaseCustomToken;
    }
    if (!customToken) throw new Error('The backend did not provide a Firebase login token.');
    await firebaseRealtime.connectFirebaseRealtime(
      customToken,
      (kind) => {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => {
          frameRef.current?.contentWindow?.postMessage(
            { type: 'lkarne:firestore-update', kind },
            window.location.origin
          );
        }, 180);
      },
      (error) => {
        console.error('Firestore listener error:', error);
        setSyncStatus('error');
        frameRef.current?.contentWindow?.postMessage(
          { type: 'lkarne:realtime-status', connected: false },
          window.location.origin
        );
      }
    );
    setSyncStatus('connected');
    frameRef.current?.contentWindow?.postMessage(
      { type: 'lkarne:realtime-status', connected: true },
      window.location.origin
    );
  }

  async function installApp() {
    if (installPrompt) {
      await installPrompt.prompt();
      setInstallPrompt(null);
      return;
    }
    setShowInstallHelp(true);
  }

  return (
    <main className="app-shell">
      <iframe
        className="legacy-app"
        src={`${import.meta.env.BASE_URL}legacy.html`}
        title="L-Karné"
        allow="clipboard-read; clipboard-write"
        ref={frameRef}
      />

      {firebaseRealtimeConfigured && syncStatus !== 'idle' && (
        <div className={`sync-status ${syncStatus}`} role="status">
          <span aria-hidden="true" className="sync-dot" />
          {syncStatus === 'connected' ? 'Synchronisé en direct' :
            syncStatus === 'connecting' ? 'Connexion sécurisée…' : 'Synchronisation indisponible'}
        </div>
      )}

      {!isStandalone && (installPrompt || isAppleMobile) && (
        <button className="install-button" onClick={installApp} type="button">
          Installer
        </button>
      )}

      {showInstallHelp && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setShowInstallHelp(false)}>
          <section
            aria-labelledby="install-title"
            aria-modal="true"
            className="install-dialog"
            role="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              aria-label="Fermer"
              className="dialog-close"
              onClick={() => setShowInstallHelp(false)}
              type="button"
            >
              ×
            </button>
            <div aria-hidden="true" className="app-icon">🍪</div>
            <h1 id="install-title">Ajouter L-Karné à l’écran d’accueil</h1>
            {isAppleMobile ? (
              <ol>
                <li>Dans Safari, touchez le bouton <strong>Partager</strong>.</li>
                <li>Choisissez <strong>Sur l’écran d’accueil</strong>.</li>
                <li>Touchez <strong>Ajouter</strong>.</li>
              </ol>
            ) : (
              <p>Ouvrez le menu du navigateur et choisissez « Installer l’application ».</p>
            )}
            <p className="install-note">
              L’installation ajoute un raccourci; connectez-vous avec votre identifiant et votre PIN habituels.
            </p>
          </section>
        </div>
      )}
    </main>
  );
}
