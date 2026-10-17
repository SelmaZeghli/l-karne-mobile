import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  inMemoryPersistence,
  setPersistence,
  signInWithCustomToken,
  signOut
} from 'firebase/auth';
import {
  collection,
  doc,
  getFirestore,
  onSnapshot,
  query,
  where
} from 'firebase/firestore';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

export const firebaseRealtimeConfigured = Object.values(config).every(Boolean);

let auth;
let database;
let persistenceReady;
let unsubscribeListeners = [];

function getFirebaseServices() {
  if (!firebaseRealtimeConfigured) throw new Error('Firebase public app configuration is missing.');
  const app = getApps().length ? getApps()[0] : initializeApp(config);
  auth = auth || getAuth(app);
  persistenceReady = persistenceReady || setPersistence(auth, inMemoryPersistence);
  database = database || getFirestore(app);
  return { auth, database };
}

function listen(reference, onUpdate, onError) {
  unsubscribeListeners.push(onSnapshot(
    reference,
    () => onUpdate(),
    (error) => {
      console.error('Firestore listener failed:', error);
      onError(error);
    }
  ));
}

export async function connectFirebaseRealtime(customToken, onUpdate, onError) {
  await disconnectFirebaseRealtime();
  const services = getFirebaseServices();
  await persistenceReady;
  const credential = await signInWithCustomToken(services.auth, customToken);
  const token = await credential.user.getIdTokenResult();
  const uid = credential.user.uid;
  const isAdmin = token.claims.role === 'admin';

  listen(collection(services.database, 'Products'), () => onUpdate('products'), onError);
  if (isAdmin) {
    listen(collection(services.database, 'PublicUsers'), () => onUpdate('users'), onError);
    listen(collection(services.database, 'Transactions'), () => onUpdate('transactions'), onError);
    listen(collection(services.database, 'Settings'), () => onUpdate('settings'), onError);
  } else {
    listen(doc(services.database, 'PublicUsers', uid), () => onUpdate('profile'), onError);
    listen(query(
      collection(services.database, 'Transactions'),
      where('user_id', '==', uid)
    ), () => onUpdate('transactions'), onError);
  }
}

export function disconnectFirebaseRealtime() {
  unsubscribeListeners.forEach((unsubscribe) => unsubscribe());
  unsubscribeListeners = [];
  if (auth?.currentUser) {
    return signOut(auth).catch((error) => {
      console.error('Firebase sign-out failed:', error);
      throw error;
    });
  }
  return Promise.resolve();
}
