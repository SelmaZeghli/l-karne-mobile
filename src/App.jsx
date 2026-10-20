import { useEffect, useRef, useState } from 'react';
import {
  disconnectFirebaseRealtime,
  firebaseConfigured,
  requestFirebaseAction,
  watchFirebaseSession
} from './firebaseBackend.js';

const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export default function App() {
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [syncStatus, setSyncStatus] = useState('idle');
  const frameRef = useRef(null);
  const refreshTimer = useRef(null);
  const stopFirebaseSessionRef = useRef(null);

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
      if (message.type === 'lkarne:api-call') {
        requestFirebaseAction(message.action, message.payload).then((result) => {
          frameRef.current?.contentWindow?.postMessage(
            { type: 'lkarne:api-result', id: message.id, result },
            window.location.origin
          );
        });
      } else if (message.type === 'lkarne:ready') {
        requestFirebaseAction('auth/session').then((result) => {
          frameRef.current?.contentWindow?.postMessage(
            {
              type: 'lkarne:auth-state',
              user: result.success ? result.user : null,
              error: result.success ? '' : result.error
            },
            window.location.origin
          );
        });
      }
    };
    window.addEventListener('message', onFrameMessage);
    if (firebaseConfigured) {
      watchFirebaseSession(
        (user, error) => {
          setSyncStatus(user ? 'connected' : 'idle');
          frameRef.current?.contentWindow?.postMessage(
            { type: 'lkarne:auth-state', user, error: error?.message || '' },
            window.location.origin
          );
        },
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
            { type: 'lkarne:realtime-status', connected: false, error: error.message },
            window.location.origin
          );
        }
      ).then((stop) => {
        stopFirebaseSessionRef.current = stop;
      }).catch((error) => {
        console.error('Firebase initialization failed:', error);
        setSyncStatus('error');
      });
    } else {
      setSyncStatus('error');
    }
    return () => {
      window.removeEventListener('beforeinstallprompt', onInstallPrompt);
      window.removeEventListener('message', onFrameMessage);
      window.clearTimeout(refreshTimer.current);
      stopFirebaseSessionRef.current?.();
      disconnectFirebaseRealtime().catch((error) => {
        console.error('Firebase sign-out failed:', error);
      });
    };
  }, []);

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

      {firebaseConfigured && syncStatus !== 'idle' && (
        <div className={`sync-status ${syncStatus}`} role="status">
          <span aria-hidden="true" className="sync-dot" />
          {syncStatus === 'connected' ? 'Synchronisé en direct' :
            syncStatus === 'connecting' ? 'Connexion sécurisée…' : 'Connexion Firebase indisponible'}
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
              L’installation ajoute un raccourci; connectez-vous avec votre identifiant et votre nouveau mot de passe.
            </p>
          </section>
        </div>
      )}
    </main>
  );
}
