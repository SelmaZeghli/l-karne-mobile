import { initializeApp, getApps } from 'firebase/app';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  runTransaction,
  where,
  writeBatch
} from 'firebase/firestore';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

export const firebaseConfigured = Object.values(config).every(Boolean);

const USER_LINKS = 'UserAuthLinks';
const ACCOUNT_INVITES = 'AccountInvites';
const minimumPasswordLength = 12;

let auth;
let database;
let persistenceReady;
let schemaCache = {};
let unsubscribeAuth;
let unsubscribeListeners = [];
let authGeneration = 0;

function getFirebaseServices() {
  if (!firebaseConfigured) {
    throw new Error('La configuration Firebase publique est incomplète.');
  }
  const app = getApps().find((candidate) => candidate.name === 'lkarne') ||
    initializeApp(config, 'lkarne');
  auth = auth || getAuth(app);
  persistenceReady = persistenceReady || setPersistence(auth, browserLocalPersistence);
  database = database || getFirestore(app);
  return { auth, database };
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function usernameEmail(username) {
  return `${normalizeUsername(username)}@auth.lkarne.invalid`;
}

function parseBoolean(value) {
  return value === true || String(value).toUpperCase() === 'TRUE';
}

function roundMoney(value) {
  const rounded = Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function randomHex(bytes = 16) {
  const values = new Uint8Array(bytes);
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Ce navigateur ne permet pas de créer un code sécurisé.');
  }
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function makeTransactionId(prefix) {
  return `${prefix}-${Date.now()}-${randomHex(8)}`;
}

function errorMessage(error) {
  const code = String(error?.code || '');
  if (code.includes('auth/invalid-credential') || code.includes('auth/wrong-password') ||
      code.includes('auth/user-not-found')) {
    return 'Identifiant ou mot de passe incorrect.';
  }
  if (code.includes('auth/email-already-in-use')) {
    return 'Ce compte existe déjà. Si le mot de passe est oublié, demandez à l’administrateur de réinitialiser l’accès.';
  }
  if (code.includes('auth/weak-password')) {
    return `Choisissez un mot de passe d’au moins ${minimumPasswordLength} caractères.`;
  }
  if (code.includes('auth/too-many-requests')) {
    return 'Trop de tentatives. Attendez un peu avant de réessayer.';
  }
  if (code.includes('permission-denied')) {
    return 'Firebase a refusé cette opération. Vérifiez votre compte et les règles Firestore.';
  }
  return error?.message || 'Une erreur Firebase inattendue est survenue.';
}

function displayProductName(name) {
  return /^(?:coffee\s*)?l['’]?or\b/i.test(String(name || '').trim()) ||
    /^capsule\s+l['’]?or\b/i.test(String(name || '').trim()) ||
    /^coffee$/i.test(String(name || '').trim())
    ? "Capsule L'or"
    : String(name || '');
}

function isCoffeeVariant(name) {
  return /^(?:coffee\b|capsule\s+l['’]?or\b)/i.test(String(name || '').trim());
}

function unitsPerSale(name, id) {
  if (String(id || '').trim() === 'p47' || String(id || '').trim() === 'p60') return 3;
  return /^(?:tea|trident)\s*\(\s*3\s*pc\s*\)$/i.test(String(name || '').trim()) ? 3 : 1;
}

function userPrice(user, name, price) {
  const isAchraf = /^achraf(?:\b|$)/i.test(String(user.name || '').trim()) ||
    /^achraf$/i.test(String(user.username || '').trim());
  const isLor = /^(?:coffee\s*)?l['’]?or\b/i.test(String(name || '').trim()) ||
    /^capsule\s+l['’]?or\b/i.test(String(name || '').trim()) ||
    /^coffee$/i.test(String(name || '').trim());
  return isAchraf && isLor ? 3.5 : Number(price || 0);
}

function isCompleted(transaction) {
  const status = String(transaction.status || '').trim().toUpperCase();
  return !status || status === 'COMPLETE';
}

async function currentContext(user = getFirebaseServices().auth.currentUser) {
  if (!user) throw new Error('Connectez-vous pour accéder à l’application.');
  const { database: db } = getFirebaseServices();
  const linkSnapshot = await getDoc(doc(db, USER_LINKS, user.uid));
  if (!linkSnapshot.exists()) {
    throw new Error('Ce compte Firebase n’est pas encore associé à un profil. Utilisez votre code d’activation ou contactez l’administrateur.');
  }
  const link = linkSnapshot.data();
  const profileSnapshot = await getDoc(doc(db, 'PublicUsers', String(link.user_id || '')));
  if (!profileSnapshot.exists()) throw new Error('Le profil associé à ce compte est introuvable.');
  const profile = profileSnapshot.data();
  const role = String(profile.role || 'user').toLowerCase();
  if (String(link.role || '').toLowerCase() !== role ||
      normalizeUsername(link.username) !== normalizeUsername(profile.username)) {
    throw new Error('L’association du compte et du profil doit être vérifiée par l’administrateur.');
  }
  return {
    authUser: user,
    link,
    profile: {
      ...profile,
      id: String(profile.id || link.user_id),
      role,
      username: normalizeUsername(profile.username),
      balance_mad: roundMoney(profile.balance_mad || 0)
    },
    isAdmin: role === 'admin'
  };
}

async function requireAdmin() {
  const context = await currentContext();
  if (!context.isAdmin) throw new Error('Accès réservé aux administrateurs.');
  return context;
}

async function collectionRecords(collectionName, userId) {
  const { database: db } = getFirebaseServices();
  const reference = collection(db, collectionName);
  const snapshot = userId
    ? await getDocs(query(reference, where('user_id', '==', userId)))
    : await getDocs(reference);
  return snapshot.docs
    .filter((item) => item.id !== '_schema')
    .map((item) => ({ ...item.data(), id: String(item.data().id || item.id) }));
}

async function schemaFor(collectionName) {
  if (schemaCache[collectionName]) return schemaCache[collectionName];
  const { database: db } = getFirebaseServices();
  const snapshot = await getDoc(doc(db, collectionName, '_schema'));
  if (!snapshot.exists() || !Array.isArray(snapshot.data()._row)) {
    throw new Error(`Le schéma Firestore de ${collectionName} est absent ou invalide.`);
  }
  schemaCache[collectionName] = snapshot.data()._row.map((field) => String(field).toLowerCase());
  return schemaCache[collectionName];
}

function documentWithRow(record, headers, position) {
  const row = headers.map((header) => {
    const value = record[header];
    return value === undefined ? '' : value;
  });
  const data = { ...record, _row: row };
  if (position !== undefined) data._position = position;
  return data;
}

async function setRowInTransaction(transaction, collectionName, id, changes, headers) {
  const { database: db } = getFirebaseServices();
  const reference = doc(db, collectionName, id);
  const snapshot = await transaction.get(reference);
  if (!snapshot.exists()) throw new Error('L’enregistrement demandé est introuvable.');
  const previous = snapshot.data();
  const next = { ...previous, ...changes, id: String(changes.id || id) };
  transaction.set(reference, documentWithRow(next, headers, previous._position), { merge: true });
  return next;
}

function publicUserFromLink(context) {
  const profile = { ...context.profile };
  delete profile.pin_hash;
  delete profile.session_version;
  delete profile.pin_reset_required;
  delete profile.pin_reset_requested_at;
  return profile;
}

async function signIn(username, password) {
  const normalized = normalizeUsername(username);
  if (!/^[a-z0-9._-]{3,30}$/.test(normalized) || !password) {
    throw new Error('Saisissez votre identifiant et votre mot de passe.');
  }
  const { auth: firebaseAuth } = getFirebaseServices();
  await persistenceReady;
  const credential = await signInWithEmailAndPassword(firebaseAuth, usernameEmail(normalized), password);
  try {
    const context = await currentContext(credential.user);
    return { success: true, user: publicUserFromLink(context) };
  } catch (error) {
    await signOut(firebaseAuth);
    throw error;
  }
}

async function registerAccount(payload) {
  const username = normalizeUsername(payload.username);
  const password = String(payload.password || '');
  const code = String(payload.inviteCode || '').trim().toUpperCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
    throw new Error('L’identifiant doit contenir 3 à 30 lettres, chiffres, points, tirets ou tirets bas.');
  }
  if (password.length < minimumPasswordLength || password.length > 128) {
    throw new Error(`Le nouveau mot de passe doit contenir entre ${minimumPasswordLength} et 128 caractères.`);
  }
  if (!/^[A-F0-9]{32}$/.test(code)) throw new Error('Saisissez le code d’activation remis par l’administrateur.');

  const { auth: firebaseAuth, database: db } = getFirebaseServices();
  await persistenceReady;
  const inviteReference = doc(db, ACCOUNT_INVITES, code);
  const invitationSnapshot = await getDoc(inviteReference);
  if (!invitationSnapshot.exists() || invitationSnapshot.data().claimed_by) {
    throw new Error('Code invalide, expiré ou déjà utilisé. Contactez l’administrateur.');
  }
  const invitation = invitationSnapshot.data();
  const userId = String(invitation.user_id || '');
  const expectedUsername = normalizeUsername(invitation.username);
  if (!userId || (expectedUsername && username !== expectedUsername)) {
    throw new Error('Le code ne correspond pas à cet identifiant. Vérifiez le code auprès de l’administrateur.');
  }

  let credential;
  let createdAccount = false;
  try {
    credential = await createUserWithEmailAndPassword(firebaseAuth, usernameEmail(username), password);
    createdAccount = true;
  } catch (error) {
    if (error?.code !== 'auth/email-already-in-use') throw error;
    credential = await signInWithEmailAndPassword(firebaseAuth, usernameEmail(username), password);
  }

  try {
    const profileReference = doc(db, 'PublicUsers', userId);
    const linkReference = doc(db, USER_LINKS, credential.user.uid);
    await runTransaction(db, async (transaction) => {
      const [inviteSnapshot, linkSnapshot] = await Promise.all([
        transaction.get(inviteReference),
        transaction.get(linkReference)
      ]);
      if (inviteSnapshot.exists() && inviteSnapshot.data().claimed_by === credential.user.uid &&
          linkSnapshot.exists() && String(linkSnapshot.data().user_id) === userId) return;
      if (!inviteSnapshot.exists() || inviteSnapshot.data().claimed_by) {
        throw new Error('Ce code d’activation a déjà été utilisé.');
      }
      if (linkSnapshot.exists()) {
        const existingLink = linkSnapshot.data();
        if (String(existingLink.user_id) === userId) {
          throw new Error('Ce compte est déjà activé. Connectez-vous avec votre identifiant et votre mot de passe.');
        }
        throw new Error('Ce compte Firebase est déjà associé à un autre profil.');
      }
      const invite = inviteSnapshot.data();
      if (String(invite.user_id) !== userId ||
          (normalizeUsername(invite.username) && normalizeUsername(invite.username) !== username)) {
        throw new Error('Le code ne correspond pas à ce profil.');
      }
      transaction.set(linkReference, {
        user_id: userId,
        username,
        role: 'user',
        linked_at: new Date().toISOString(),
        invite_code: code
      });
      transaction.update(inviteReference, {
        claimed_by: credential.user.uid,
        claimed_at: new Date().toISOString()
      });
      transaction.update(profileReference, { username });
    });
    const context = await currentContext(credential.user);
    return { success: true, user: publicUserFromLink(context) };
  } catch (error) {
    await signOut(firebaseAuth);
    if (createdAccount) {
      console.error('Firebase account was created but profile activation did not complete.', error);
    }
    throw error;
  }
}

function stopListeners() {
  unsubscribeListeners.forEach((unsubscribe) => unsubscribe());
  unsubscribeListeners = [];
}

export async function watchFirebaseSession(onSession, onUpdate, onError) {
  const { auth: firebaseAuth, database: db } = getFirebaseServices();
  await persistenceReady;
  if (unsubscribeAuth) unsubscribeAuth();
  unsubscribeAuth = onAuthStateChanged(firebaseAuth, async (user) => {
    const generation = ++authGeneration;
    stopListeners();
    if (!user) {
      onSession(null);
      return;
    }
    try {
      const context = await currentContext(user);
      if (generation !== authGeneration || firebaseAuth.currentUser?.uid !== user.uid) return;
      onSession(publicUserFromLink(context));
      const listen = (reference, kind) => unsubscribeListeners.push(onSnapshot(
        reference,
        () => onUpdate(kind),
        onError
      ));
      listen(collection(db, 'Products'), 'products');
      if (context.isAdmin) {
        listen(collection(db, 'PublicUsers'), 'users');
        listen(collection(db, 'Transactions'), 'transactions');
        listen(collection(db, 'Settings'), 'settings');
        listen(collection(db, USER_LINKS), 'users');
      } else {
        listen(doc(db, 'PublicUsers', context.profile.id), 'profile');
        listen(query(collection(db, 'Transactions'), where('user_id', '==', context.profile.id)), 'transactions');
      }
    } catch (error) {
      if (generation === authGeneration) onSession(null, error);
    }
  }, onError);
  return () => {
    authGeneration++;
    if (unsubscribeAuth) unsubscribeAuth();
    unsubscribeAuth = null;
    stopListeners();
  };
}

export async function disconnectFirebaseRealtime() {
  stopListeners();
  const { auth: firebaseAuth } = getFirebaseServices();
  if (firebaseAuth.currentUser) await signOut(firebaseAuth);
}

async function getProducts() {
  const products = await collectionRecords('Products');
  return products.map((product) => ({
    ...product,
    price_mad: Number(product.price_mad || 0),
    stock_qty: parseInt(product.stock_qty, 10) || 0,
    is_active: parseBoolean(product.is_active)
  }));
}

async function getUserTransactions(userId) {
  const records = await collectionRecords('Transactions', userId);
  return records.filter(isCompleted).sort((a, b) =>
    String(b.timestamp || '').localeCompare(String(a.timestamp || ''))
  );
}

async function getAllTransactions() {
  const records = await collectionRecords('Transactions');
  return records.filter(isCompleted).sort((a, b) =>
    String(b.timestamp || '').localeCompare(String(a.timestamp || ''))
  );
}

function makeStoreProducts(user, products) {
  const activeCoffee = products
    .filter((product) => product.id && isCoffeeVariant(product.name) && product.is_active && product.stock_qty > 0)
    .sort((a, b) => b.stock_qty - a.stock_qty);
  const selectedCoffeeId = activeCoffee.length ? String(activeCoffee[0].id) : '';
  return products.filter((product) => {
    const requiredUnits = unitsPerSale(product.name, product.id);
    return product.is_active && product.stock_qty >= requiredUnits &&
      (!isCoffeeVariant(product.name) || String(product.id) === selectedCoffeeId);
  }).map((product) => ({
    id: String(product.id),
    name: displayProductName(product.name),
    category: String(product.category || 'Divers'),
    price_mad: userPrice(user, product.name, product.price_mad),
    stock_qty: product.stock_qty,
    inventory_units_per_sale: unitsPerSale(product.name, product.id),
    image_url: String(product.image_url || '')
  }));
}

async function colleagueDashboard() {
  const context = await currentContext();
  const [products, transactions] = await Promise.all([
    getProducts(),
    getUserTransactions(context.profile.id)
  ]);
  return {
    success: true,
    user: context.profile,
    products: makeStoreProducts(context.profile, products),
    transactions: transactions.slice(0, 50).map((transaction) => ({
      ...transaction,
      item_name: displayProductName(transaction.item_name || ''),
      amount_mad: roundMoney(transaction.amount_mad || 0),
      cancel_status: String(transaction.cancel_status || '')
    }))
  };
}

async function adminOverview() {
  await requireAdmin();
  const [users, products, transactions, settings] = await Promise.all([
    collectionRecords('PublicUsers'),
    getProducts(),
    getAllTransactions(),
    collectionRecords('Settings')
  ]);
  const adminUsers = users.filter((user) => user.id);
  const debt = adminUsers.reduce((sum, user) => {
    const balance = roundMoney(user.balance_mad || 0);
    return balance > 0 ? sum + balance : sum;
  }, 0);
  const activeCoffee = products.filter((product) =>
    product.is_active && isCoffeeVariant(product.name)
  ).sort((a, b) => b.stock_qty - a.stock_qty);
  const selectedCoffeeId = activeCoffee.length ? String(activeCoffee[0].id) : '';
  const shownProducts = products.filter((product) => product.is_active &&
    (!isCoffeeVariant(product.name) || String(product.id) === selectedCoffeeId));
  const settingValue = (key) => settings.find((setting) => setting.id === key)?.value ?? '';
  const openingCashRaw = settingValue('opening_cash_mad');
  const openingCash = openingCashRaw === '' ? 0 : Number(openingCashRaw);
  const openingCashSet = openingCashRaw !== '';
  const openingCashTimestamp = new Date(settingValue('opening_cash_timestamp') || 0).getTime() || 0;
  let cashReceived = 0;
  transactions.forEach((transaction) => {
    if (new Date(transaction.timestamp || 0).getTime() < openingCashTimestamp) return;
    const type = String(transaction.type || '');
    const paidPurchase = type === 'purchase' && parseBoolean(transaction.paid);
    if (type === 'payment' || paidPurchase) cashReceived += Number(transaction.amount_mad || 0);
    else if (type === 'inventory_purchase' ||
        (type === 'purchase_cancellation' && parseBoolean(transaction.paid))) {
      cashReceived -= Number(transaction.amount_mad || 0);
    }
  });
  const recentTransactions = transactions.filter((transaction) => transaction.id)
    .slice(0, 100).map((transaction) => ({
      ...transaction,
      item_name: displayProductName(transaction.item_name || ''),
      amount_mad: roundMoney(transaction.amount_mad || 0),
      cancel_status: String(transaction.cancel_status || '')
    }));
  return {
    success: true,
    metrics: {
      totalOfficeDebt: roundMoney(debt),
      currentEarnings: roundMoney(openingCash + cashReceived),
      openingCashSet,
      userCount: adminUsers.filter((user) =>
        String(user.role || '').toLowerCase() !== 'admin' && normalizeUsername(user.username)
      ).length,
      productCount: shownProducts.length,
      lowStockCount: shownProducts.filter((product) => product.stock_qty <= 3).length
    },
    users: adminUsers.map((user) => ({
      ...user,
      balance_mad: roundMoney(user.balance_mad || 0),
      role: String(user.role || 'user')
    })),
    products: shownProducts.map((product) => ({
      ...product,
      name: displayProductName(product.name)
    })),
    transactions: recentTransactions
  };
}

async function createAccountInvites(users, recovery = false) {
  const { database: db } = getFirebaseServices();
  const invites = users.map((user) => ({
    name: String(user.name || ''),
    username: normalizeUsername(user.username),
    inviteCode: randomHex(16),
    userId: String(user.id)
  }));
  for (let index = 0; index < invites.length; index += 450) {
    const batch = writeBatch(db);
    invites.slice(index, index + 450).forEach((invite) => {
      batch.set(doc(db, ACCOUNT_INVITES, invite.inviteCode), {
        user_id: invite.userId,
        username: invite.username,
        claimed_by: '',
        claimed_at: '',
        recovery,
        created_at: new Date().toISOString()
      });
    });
    await batch.commit();
  }
  return invites;
}

async function exportInvites() {
  await requireAdmin();
  const { database: db } = getFirebaseServices();
  const [users, links] = await Promise.all([
    collectionRecords('PublicUsers'),
    getDocs(collection(db, USER_LINKS))
  ]);
  const linkedIds = new Set(links.docs.map((link) => String(link.data().user_id || '')));
  const pending = users.filter((user) =>
    String(user.role || '').toLowerCase() !== 'admin' &&
    user.id && !linkedIds.has(String(user.id))
  );
  const invites = await createAccountInvites(pending);
  return {
    success: true,
    invites: invites.map(({ name, username, inviteCode }) => ({ name, username, inviteCode }))
  };
}

async function issueRecoveryCode(userId) {
  await requireAdmin();
  const { database: db } = getFirebaseServices();
  const userSnapshot = await getDoc(doc(db, 'PublicUsers', String(userId)));
  if (!userSnapshot.exists()) throw new Error('Utilisateur introuvable.');
  const user = userSnapshot.data();
  if (String(user.role || 'user').toLowerCase() === 'admin') {
    throw new Error('La récupération d’un compte administrateur doit être effectuée par un autre administrateur.');
  }
  if (!normalizeUsername(user.username)) {
    throw new Error('Cet utilisateur n’a pas encore d’identifiant; créez ou attribuez son identifiant avant la récupération.');
  }
  const links = await getDocs(query(
    collection(db, USER_LINKS),
    where('user_id', '==', String(userId))
  ));
  const inviteCode = randomHex(16);
  const batch = writeBatch(db);
  links.docs.forEach((link) => batch.delete(link.ref));
  batch.set(doc(db, ACCOUNT_INVITES, inviteCode), {
    user_id: String(userId),
    username: normalizeUsername(user.username),
    claimed_by: '',
    claimed_at: '',
    recovery: true,
    created_at: new Date().toISOString()
  });
  await batch.commit();
  return {
    success: true,
    name: String(user.name || ''),
    inviteCode,
    message: 'Code de réactivation créé.'
  };
}

async function addUser(body) {
  await requireAdmin();
  const name = String(body.name || '').trim();
  const username = normalizeUsername(body.username);
  if (!name || name.length > 120 || !/^[a-z0-9._-]{3,30}$/.test(username)) {
    throw new Error('Saisissez un nom et un identifiant valide (3 à 30 caractères).');
  }
  const { database: db } = getFirebaseServices();
  const users = await collectionRecords('PublicUsers');
  if (users.some((user) => normalizeUsername(user.username) === username)) {
    throw new Error('Cet identifiant est déjà attribué à un profil.');
  }
  const id = `user_${randomHex(12).toLowerCase()}`;
  const userHeaders = await schemaFor('PublicUsers');
  const user = {
    id,
    name,
    username,
    role: 'user',
    balance_mad: 0,
    created_at: new Date().toISOString(),
  };
  const inviteCode = randomHex(16);
  const batch = writeBatch(db);
  batch.set(doc(db, 'PublicUsers', id), documentWithRow(user, userHeaders, Date.now()));
  batch.set(doc(db, ACCOUNT_INVITES, inviteCode), {
    user_id: id,
    username,
    claimed_by: '',
    claimed_at: '',
    recovery: false,
    created_at: new Date().toISOString()
  });
  await batch.commit();
  return {
    success: true,
    message: `Compte créé pour ${name}. Remettez le code de configuration au collègue.`,
    id,
    inviteCode
  };
}

async function purchase(body) {
  const context = await currentContext();
  const productId = String(body.productId || '').trim();
  const quantity = Number(body.quantity);
  const paid = body.paid === true || String(body.paid).toLowerCase() === 'true';
  const requestId = String(body.requestId || '').trim();
  if (!productId || !Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error('Produit ou quantité invalide.');
  }
  if (requestId && !/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
    throw new Error('Identifiant de demande invalide.');
  }
  const txId = requestId
    ? `TX-REQ-${context.profile.id}-${requestId}`
    : makeTransactionId('TX');
  const { database: db } = getFirebaseServices();
  const productReference = doc(db, 'Products', productId);
  const profileReference = doc(db, 'PublicUsers', context.profile.id);
  const transactionReference = doc(db, 'Transactions', txId);
  const headers = await schemaFor('Transactions');
  let result;
  await runTransaction(db, async (transaction) => {
    const [productSnapshot, profileSnapshot, existingTransaction] = await Promise.all([
      transaction.get(productReference),
      transaction.get(profileReference),
      transaction.get(transactionReference)
    ]);
    if (existingTransaction.exists()) {
      const old = existingTransaction.data();
      if (old.user_id !== context.profile.id || old.type !== 'purchase' ||
          old.item_id !== productId || Number(old.quantity) !== quantity ||
          parseBoolean(old.paid) !== paid) {
        throw new Error('Cette demande a déjà été utilisée pour une autre opération; demandez une vérification avant de réessayer.');
      }
      if (!isCompleted(old)) throw new Error('Cette opération existe déjà et doit être vérifiée par l’administrateur.');
      result = {
        id: txId,
        itemName: String(old.item_name || ''),
        quantity,
        amount: roundMoney(old.amount_mad),
        paid,
        newBalance: roundMoney(profileSnapshot.data()?.balance_mad || context.profile.balance_mad),
        newStock: parseInt(productSnapshot.data()?.stock_qty, 10) || 0
      };
      return;
    }
    if (!productSnapshot.exists() || !profileSnapshot.exists()) {
      throw new Error('Produit ou compte utilisateur introuvable.');
    }
    const product = productSnapshot.data();
    const profile = profileSnapshot.data();
    if (!parseBoolean(product.is_active)) throw new Error('Produit introuvable ou inactif.');
    const requiredUnits = unitsPerSale(product.name, productId);
    const currentStock = parseInt(product.stock_qty, 10) || 0;
    const removeUnits = quantity * requiredUnits;
    if (currentStock < removeUnits) {
      const available = Math.floor(currentStock / requiredUnits);
      throw new Error(`Stock insuffisant ! Il ne reste que ${available}${requiredUnits === 3 ? ' lot(s) de 3 pièces.' : ' pièce(s).'}`);
    }
    const unitPrice = userPrice(context.profile, product.name, product.price_mad);
    const amount = roundMoney(unitPrice * quantity);
    const currentBalance = Number(profile.balance_mad || 0);
    const newBalance = paid ? currentBalance : roundMoney(currentBalance + amount);
    const newStock = currentStock - removeUnits;
    const now = new Date().toISOString();
    const transactionRecord = {
      id: txId,
      timestamp: now,
      user_id: context.profile.id,
      user_name: String(context.profile.name || ''),
      type: 'purchase',
      item_id: productId,
      item_name: displayProductName(product.name),
      quantity,
      amount_mad: amount,
      notes: (paid ? 'Achat payé sur place' : 'Achat libre-service') +
        (requiredUnits > 1 ? ` (${removeUnits} unités de stock retirées)` : ''),
      paid,
      status: 'COMPLETE',
      cancel_status: '',
      cancel_requested_at: '',
      cancel_decided_at: '',
      cancel_decided_by: ''
    };
    transaction.update(productReference, {
      stock_qty: newStock,
      _last_user_purchase_id: txId
    });
    transaction.update(profileReference, {
      balance_mad: newBalance,
      _last_user_purchase_id: txId
    });
    transaction.set(transactionReference, documentWithRow(transactionRecord, headers, Date.now()));
    result = {
      id: txId,
      itemName: transactionRecord.item_name,
      quantity,
      amount,
      paid,
      newBalance,
      newStock
    };
  });
  return { success: true, message: 'Achat enregistré.', transaction: result };
}

async function requestPurchaseCancellation(body) {
  const context = await currentContext();
  const transactionId = String(body.transactionId || '').trim();
  if (!transactionId) throw new Error('Transaction invalide.');
  const { database: db } = getFirebaseServices();
  const reference = doc(db, 'Transactions', transactionId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) throw new Error('Transaction introuvable.');
    const purchase = snapshot.data();
    if (String(purchase.user_id) !== context.profile.id) throw new Error('Cette transaction ne vous appartient pas.');
    if (purchase.type !== 'purchase' || !isCompleted(purchase)) {
      throw new Error('Seul un achat terminé peut faire l’objet d’une demande d’annulation.');
    }
    const status = String(purchase.cancel_status || '').toUpperCase();
    if (status === 'REQUESTED') return;
    if (status === 'APPROVED') throw new Error('Cet achat a déjà été annulé.');
    transaction.update(reference, {
      cancel_status: 'REQUESTED',
      cancel_requested_at: new Date().toISOString(),
      cancel_decided_at: '',
      cancel_decided_by: ''
    });
  });
  return { success: true, message: 'Demande envoyée à l’administrateur.' };
}

async function decidePurchaseCancellation(body) {
  const context = await requireAdmin();
  const transactionId = String(body.transactionId || '').trim();
  const approve = body.approve === true || String(body.approve).toLowerCase() === 'true';
  if (!transactionId) throw new Error('Transaction invalide.');
  const { database: db } = getFirebaseServices();
  const txReference = doc(db, 'Transactions', transactionId);
  const headers = await schemaFor('Transactions');
  if (!approve) {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(txReference);
      if (!snapshot.exists()) throw new Error('Transaction introuvable.');
      const purchaseRecord = snapshot.data();
      if (purchaseRecord.type !== 'purchase' || !isCompleted(purchaseRecord) ||
          String(purchaseRecord.cancel_status || '').toUpperCase() !== 'REQUESTED') {
        throw new Error('Aucune demande d’annulation en attente pour cet achat.');
      }
      const rejected = {
        ...purchaseRecord,
        cancel_status: 'REJECTED',
        cancel_decided_at: new Date().toISOString(),
        cancel_decided_by: context.profile.id
      };
      transaction.set(txReference, documentWithRow(rejected, headers, purchaseRecord._position), { merge: true });
    });
    return { success: true, message: 'Demande d’annulation refusée.' };
  }

  const purchaseSnapshot = await getDoc(txReference);
  if (!purchaseSnapshot.exists()) throw new Error('Transaction introuvable.');
  const purchaseRecord = purchaseSnapshot.data();
  const eventId = `TX-CANCEL-${transactionId}`;
  const eventReference = doc(db, 'Transactions', eventId);
  const productId = String(purchaseRecord.item_id || '');
  const userId = String(purchaseRecord.user_id || '');
  const productReference = doc(db, 'Products', productId);
  const profileReference = doc(db, 'PublicUsers', userId);
  const productHeaders = await schemaFor('Products');
  const profileHeaders = await schemaFor('PublicUsers');
  await runTransaction(db, async (transaction) => {
    const [currentPurchase, existingEvent, productSnapshot, profileSnapshot] = await Promise.all([
      transaction.get(txReference),
      transaction.get(eventReference),
      transaction.get(productReference),
      transaction.get(profileReference)
    ]);
    if (!currentPurchase.exists()) throw new Error('Transaction introuvable.');
    if (existingEvent.exists() && isCompleted(existingEvent.data())) return;
    const purchase = currentPurchase.data();
    if (purchase.type !== 'purchase' || !isCompleted(purchase) ||
        String(purchase.cancel_status || '').toUpperCase() !== 'REQUESTED') {
      throw new Error('Aucune demande d’annulation en attente pour cet achat.');
    }
    if (!productSnapshot.exists() || !profileSnapshot.exists()) {
      throw new Error('Produit ou profil introuvable; une vérification est nécessaire.');
    }
    const quantity = Number(purchase.quantity);
    const amount = roundMoney(purchase.amount_mad);
    const paid = parseBoolean(purchase.paid);
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || amount <= 0) {
      throw new Error('Les informations de l’achat sont invalides.');
    }
    const product = productSnapshot.data();
    const profile = profileSnapshot.data();
    const restoredUnits = unitsPerSale(purchase.item_name, productId) * quantity;
    const nextStock = (parseInt(product.stock_qty, 10) || 0) + restoredUnits;
    const nextBalance = paid
      ? roundMoney(profile.balance_mad || 0)
      : roundMoney(Number(profile.balance_mad || 0) - amount);
    const now = new Date().toISOString();
    const event = {
      id: eventId,
      timestamp: now,
      user_id: userId,
      user_name: String(purchase.user_name || ''),
      type: 'purchase_cancellation',
      item_id: productId,
      item_name: String(purchase.item_name || ''),
      quantity,
      amount_mad: amount,
      notes: `Annulation de la transaction ${transactionId}`,
      paid,
      status: 'COMPLETE',
      cancel_status: '',
      cancel_requested_at: '',
      cancel_decided_at: '',
      cancel_decided_by: ''
    };
    const approved = {
      ...purchase,
      cancel_status: 'APPROVED',
      cancel_decided_at: now,
      cancel_decided_by: context.profile.id
    };
    transaction.set(productReference, documentWithRow({
      ...product,
      stock_qty: nextStock
    }, productHeaders, product._position), { merge: true });
    transaction.set(profileReference, documentWithRow({
      ...profile,
      balance_mad: nextBalance
    }, profileHeaders, profile._position), { merge: true });
    transaction.set(txReference, documentWithRow(approved, headers, purchase._position), { merge: true });
    transaction.set(eventReference, documentWithRow(event, headers, Date.now()));
  });
  return { success: true, message: 'Achat annulé et solde/stock corrigés.' };
}

async function settle(body) {
  const context = await requireAdmin();
  const userId = String(body.userId || '').trim();
  const amount = roundMoney(body.amount);
  const notes = String(body.notes || 'Paiement en espèces réglé').trim().slice(0, 200);
  if (!userId || !Number.isFinite(amount) || amount === 0) {
    throw new Error('Le montant doit être différent de zéro et l’utilisateur valide.');
  }
  const { database: db } = getFirebaseServices();
  const profileReference = doc(db, 'PublicUsers', userId);
  const txId = makeTransactionId('TX-PAY');
  const txReference = doc(db, 'Transactions', txId);
  const headers = await schemaFor('Transactions');
  const profileHeaders = await schemaFor('PublicUsers');
  let userName = '';
  let newBalance = 0;
  await runTransaction(db, async (transaction) => {
    const profileSnapshot = await transaction.get(profileReference);
    if (!profileSnapshot.exists()) throw new Error('Utilisateur introuvable.');
    const profile = profileSnapshot.data();
    userName = String(profile.name || '');
    newBalance = roundMoney(Number(profile.balance_mad || 0) - amount);
    transaction.set(profileReference, documentWithRow({
      ...profile,
      balance_mad: newBalance
    }, profileHeaders, profile._position), { merge: true });
    transaction.set(txReference, documentWithRow({
      id: txId,
      timestamp: new Date().toISOString(),
      user_id: userId,
      user_name: userName,
      type: 'payment',
      item_id: '',
      item_name: amount > 0 ? 'Règlement dette' : 'Correction paiement',
      quantity: 1,
      amount_mad: amount,
      notes,
      paid: false,
      status: 'COMPLETE'
    }, headers, Date.now()));
  });
  return {
    success: true,
    message: `${amount > 0 ? 'Règlement de ' : 'Correction de '}${Math.abs(amount).toFixed(2)} DH enregistré pour ${userName}`,
    userId,
    newBalance
  };
}

async function restock(body, inventoryPurchase = false) {
  await requireAdmin();
  const productId = String(body.productId || '').trim();
  const quantity = Number(inventoryPurchase ? body.quantity : body.addedQty);
  const cost = inventoryPurchase ? roundMoney(body.cost) : 0;
  const notes = String(body.notes || '').trim().slice(0, 200);
  if (!productId || !Number.isSafeInteger(quantity) ||
      (inventoryPurchase ? quantity <= 0 || !Number.isFinite(cost) || cost <= 0 : quantity === 0)) {
    throw new Error(inventoryPurchase
      ? 'Produit valide, quantité entière positive et coût total supérieur à zéro requis.'
      : 'Quantité de correction invalide.');
  }
  const { database: db } = getFirebaseServices();
  const productReference = doc(db, 'Products', productId);
  const productHeaders = await schemaFor('Products');
  const transactionHeaders = await schemaFor('Transactions');
  const txId = makeTransactionId(inventoryPurchase ? 'TX-INV' : 'TX-RST');
  const txReference = doc(db, 'Transactions', txId);
  let newStock = 0;
  let productName = '';
  await runTransaction(db, async (transaction) => {
    const productSnapshot = await transaction.get(productReference);
    if (!productSnapshot.exists()) throw new Error('Produit introuvable.');
    const product = productSnapshot.data();
    productName = String(product.name || '');
    const currentStock = parseInt(product.stock_qty, 10) || 0;
    newStock = currentStock + quantity;
    if (!Number.isSafeInteger(newStock) || newStock < 0) {
      throw new Error('Le stock corrigé doit être un entier positif ou nul.');
    }
    await setRowInTransaction(transaction, 'Products', productId, { stock_qty: newStock }, productHeaders);
    const type = inventoryPurchase ? 'inventory_purchase' : 'restock';
    const label = inventoryPurchase
      ? `Achat de stock${notes ? `: ${notes}` : ''}`
      : `${quantity > 0 ? 'Réapprovisionnement' : 'Correction de stock'}: ${quantity > 0 ? '+' : ''}${quantity} (Nouveau stock: ${newStock})`;
    transaction.set(txReference, documentWithRow({
      id: txId,
      timestamp: new Date().toISOString(),
      user_id: context.profile.id,
      user_name: 'Admin',
      type,
      item_id: productId,
      item_name: productName,
      quantity,
      amount_mad: inventoryPurchase ? cost : 0,
      notes: label,
      paid: false,
      status: 'COMPLETE'
    }, transactionHeaders, Date.now()));
  });
  return {
    success: true,
    message: inventoryPurchase ? 'Achat de stock enregistré et coût déduit de la caisse.' :
      (quantity > 0 ? 'Stock réapprovisionné.' : 'Correction du stock enregistrée.'),
    productId,
    newStock,
    cost
  };
}

async function setOpeningCash(body) {
  await requireAdmin();
  if (body.amount === undefined || String(body.amount).trim() === '') {
    throw new Error('Veuillez saisir un montant initial valide (zéro ou plus).');
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('Veuillez saisir un montant initial valide (zéro ou plus).');
  }
  const headers = await schemaFor('Settings');
  const { database: db } = getFirebaseServices();
  const now = new Date().toISOString();
  await runTransaction(db, async (transaction) => {
    const cashReference = doc(db, 'Settings', 'opening_cash_mad');
    const timestampReference = doc(db, 'Settings', 'opening_cash_timestamp');
    const [cashSnapshot, timestampSnapshot] = await Promise.all([
      transaction.get(cashReference),
      transaction.get(timestampReference)
    ]);
    const writeSetting = (snapshot, key, value) => {
      const record = snapshot.exists() ? snapshot.data() : { key, value };
      record.key = key;
      record.value = value;
      transaction.set(
        snapshot.ref,
        documentWithRow(record, headers, snapshot.exists() ? record._position : Date.now()),
        { merge: true }
      );
    };
    writeSetting(cashSnapshot, 'opening_cash_mad', roundMoney(amount));
    writeSetting(timestampSnapshot, 'opening_cash_timestamp', now);
  });
  return { success: true, message: 'Caisse de départ enregistrée.' };
}

async function addProduct(body) {
  const context = await requireAdmin();
  const name = String(body.name || '').trim();
  const category = String(body.category || 'Snacks').trim();
  const price = Number(body.price_mad);
  const stock = body.stock_qty === undefined || body.stock_qty === '' ? 0 : Number(body.stock_qty);
  const rawCost = body.cost === undefined || body.cost === '' ? 0 : Number(body.cost);
  const cost = roundMoney(rawCost);
  const imageUrl = String(body.image_url || '🍫').trim();
  if (!name || !category || !Number.isFinite(price) || price < 0 ||
      !Number.isSafeInteger(stock) || stock < 0 || !Number.isFinite(rawCost) || rawCost < 0 ||
      (cost > 0 && stock === 0)) {
    throw new Error('Nom, catégorie, prix, stock initial et coût total valides requis.');
  }
  if (!(/^https:\/\/[^/?#\s]+(?:[/?#][^\s]*)?$/i.test(imageUrl) ||
      (imageUrl.length > 0 && imageUrl.length <= 8 && !/[<>"'`]/.test(imageUrl)))) {
    throw new Error('Utilisez une URL HTTPS publique valide ou un emoji comme image.');
  }
  const { database: db } = getFirebaseServices();
  const id = `prod_${randomHex(12).toLowerCase()}`;
  const txId = cost > 0 ? makeTransactionId('TX-INV') : '';
  const productHeaders = await schemaFor('Products');
  const transactionHeaders = cost > 0 ? await schemaFor('Transactions') : [];
  await runTransaction(db, async (transaction) => {
    const productReference = doc(db, 'Products', id);
    const productSnapshot = await transaction.get(productReference);
    if (productSnapshot.exists()) throw new Error('Un produit portant cet identifiant existe déjà.');
    const product = {
      id, name, category, price_mad: roundMoney(price), stock_qty: stock,
      image_url: imageUrl, is_active: true
    };
    transaction.set(productReference, documentWithRow(product, productHeaders, Date.now()));
    if (cost > 0) {
      transaction.set(doc(db, 'Transactions', txId), documentWithRow({
        id: txId,
        timestamp: new Date().toISOString(),
        user_id: context.profile.id,
        user_name: 'Admin',
        type: 'inventory_purchase',
        item_id: id,
        item_name: name,
        quantity: stock,
        amount_mad: cost,
        notes: 'Achat de stock initial (nouveau produit)',
        paid: false,
        status: 'COMPLETE'
      }, transactionHeaders, Date.now()));
    }
  });
  return {
    success: true,
    message: cost > 0 ? 'Produit ajouté; coût du stock initial déduit de la caisse.' : 'Produit ajouté avec succès !',
    id,
    cost
  };
}

async function updateProduct(body, updateImage = false) {
  await requireAdmin();
  const productId = String(body.productId || '').trim();
  const { database: db } = getFirebaseServices();
  const reference = doc(db, 'Products', productId);
  const headers = await schemaFor('Products');
  let changes;
  if (updateImage) {
    const imageUrl = String(body.image_url || '').trim();
    if (!productId || !(/^https:\/\/[^/?#\s]+(?:[/?#][^\s]*)?$/i.test(imageUrl) ||
        (imageUrl.length > 0 && imageUrl.length <= 8 && !/[<>"'`]/.test(imageUrl)))) {
      throw new Error('Produit ou URL d’image invalide. Utilisez une URL HTTPS publique ou un emoji.');
    }
    changes = { image_url: imageUrl };
  } else {
    const name = String(body.name || '').trim();
    const category = String(body.category || '').trim();
    const price = Number(body.price_mad);
    if (!productId || !name || name.length > 120 || !category || category.length > 60 ||
        !Number.isFinite(price) || price < 0) {
      throw new Error('Nom, catégorie et prix de vente valides requis.');
    }
    changes = { name, category, price_mad: roundMoney(price) };
  }
  await runTransaction(db, async (transaction) => {
    await setRowInTransaction(transaction, 'Products', productId, changes, headers);
  });
  return { success: true, message: updateImage ? 'Image du produit mise à jour.' : 'Nom, catégorie et prix de vente mis à jour.' };
}

async function dispatchAction(action, payload = {}) {
  switch (action) {
    case 'auth/login':
      return signIn(payload.username, payload.password);
    case 'auth/register':
      return registerAccount(payload);
    case 'auth/session': {
      const context = await currentContext();
      return { success: true, user: publicUserFromLink(context) };
    }
    case 'auth/logout':
      await disconnectFirebaseRealtime();
      return { success: true };
    case 'colleague/dashboard':
      return colleagueDashboard();
    case 'colleague/purchase':
      return purchase(payload);
    case 'colleague/request_purchase_cancellation':
      return requestPurchaseCancellation(payload);
    case 'admin/overview':
      return adminOverview();
    case 'admin/export_invites':
      return exportInvites();
    case 'admin/issue_recovery_code':
      return issueRecoveryCode(payload.userId);
    case 'admin/settle':
      return settle(payload);
    case 'admin/decide_purchase_cancellation':
      return decidePurchaseCancellation(payload);
    case 'admin/set_opening_cash':
      return setOpeningCash(payload);
    case 'admin/restock':
      return restock(payload);
    case 'admin/purchase_inventory':
      return restock(payload, true);
    case 'admin/add_product':
      return addProduct(payload);
    case 'admin/update_product_image':
      return updateProduct(payload, true);
    case 'admin/update_product_details':
      return updateProduct(payload, false);
    case 'admin/add_user':
      return addUser(payload);
    default:
      throw new Error(`Opération Firebase inconnue : ${action}`);
  }
}

export async function requestFirebaseAction(action, payload) {
  try {
    return await dispatchAction(action, payload);
  } catch (error) {
    console.error(`Firebase action failed (${action}):`, error);
    return { success: false, error: errorMessage(error) };
  }
}
