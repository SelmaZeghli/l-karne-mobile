// Seeds the local Firebase emulators with test data for previewing the app.
// Usage: start the emulators (firebase emulators:start --only auth,firestore), then
//   node scripts/seed-emulator.mjs
// Test logins (emulator only):
//   admin    / admin-test-pass
//   testuser / user-test-pass
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()])
);
const projectId = env.VITE_FIREBASE_PROJECT_ID;
const AUTH = 'http://127.0.0.1:9099';
const FIRESTORE = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;

const SCHEMAS = {
  PublicUsers: ['id', 'name', 'username', 'role', 'balance_mad'],
  Products: ['id', 'name', 'category', 'price_mad', 'stock_qty', 'image_url', 'is_active'],
  Transactions: [
    'id', 'timestamp', 'user_id', 'user_name', 'type', 'item_id', 'item_name', 'quantity',
    'amount_mad', 'notes', 'paid', 'status', 'cancel_status', 'cancel_requested_at',
    'cancel_decided_at', 'cancel_decided_by'
  ],
  Settings: ['key', 'value']
};

function toValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: String(value) };
}

async function setDoc(collection, id, data) {
  const row = SCHEMAS[collection] ? SCHEMAS[collection].map((field) => data[field] ?? '') : undefined;
  const record = row && id !== '_schema' ? { ...data, _row: row, _position: Date.now() } : data;
  const fields = Object.fromEntries(Object.entries(record).map(([key, value]) => [key, toValue(value)]));
  const response = await fetch(`${FIRESTORE}/${collection}/${id}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!response.ok) throw new Error(`${collection}/${id}: ${await response.text()}`);
}

async function createAuthUser(username, password) {
  const response = await fetch(
    `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `${username}@auth.lkarne.invalid`,
        password,
        returnSecureToken: true
      })
    }
  );
  const body = await response.json();
  if (!response.ok) throw new Error(`auth ${username}: ${JSON.stringify(body.error)}`);
  return body.localId;
}

async function addAccount({ id, name, username, role, password, balance }) {
  await setDoc('PublicUsers', id, { id, name, username, role, balance_mad: balance });
  const uid = await createAuthUser(username, password);
  await setDoc('UserAuthLinks', uid, {
    user_id: id, username, role, linked_at: new Date().toISOString(), invite_code: ''
  });
}

for (const [collection, fields] of Object.entries(SCHEMAS)) {
  await setDoc(collection, '_schema', { _row: fields });
}

await addAccount({ id: 'u_admin', name: 'Admin', username: 'admin', role: 'admin', password: 'admin-test-pass', balance: 0 });
await addAccount({ id: 'u_test', name: 'Test User', username: 'testuser', role: 'user', password: 'user-test-pass', balance: 12.5 });
await addAccount({ id: 'u_achraf', name: 'Achraf', username: 'achraf', role: 'user', password: 'user-test-pass', balance: 0 });

const products = [
  { id: 'p1', name: 'Coca-Cola', category: 'Boissons', price_mad: 6, stock_qty: 24, image_url: '🥤' },
  { id: 'p2', name: 'Snickers', category: 'Snacks', price_mad: 5, stock_qty: 30, image_url: '🍫' },
  { id: 'p3', name: 'Coffee', category: 'Café', price_mad: 4, stock_qty: 50, image_url: '☕' },
  { id: 'p4', name: 'Chips', category: 'Snacks', price_mad: 3.5, stock_qty: 0, image_url: '🥔' }
];
for (const product of products) {
  await setDoc('Products', product.id, { ...product, is_active: true });
}

await setDoc('Settings', 'opening_cash_mad', { key: 'opening_cash_mad', value: 100 });
await setDoc('Settings', 'opening_cash_timestamp', { key: 'opening_cash_timestamp', value: new Date().toISOString() });

console.log('Emulator seeded: admin / admin-test-pass, testuser / user-test-pass');
