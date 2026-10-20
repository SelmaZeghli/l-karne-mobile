# L-Karné — SnackBox & Kridi Tracker

L-Karné is a self-service snack kiosk and shared debt ledger delivered as a React progressive web app on GitHub Pages. **Firebase Authentication and Cloud Firestore are the only live authentication and data services.** The browser talks directly to Firebase; Google Sheets and Apps Script are not part of normal app use.

## Firebase-only sign-in

- Each colleague signs in with a username and a new password of at least 12 characters. No personal email address is required; Firebase Auth stores a synthetic sign-in address internally.
- An administrator gives each colleague a one-time activation code in person. The colleague enters the code and chooses a password. Existing PIN hashes cannot be converted into passwords.
- Password recovery is admin-assisted because users do not have email addresses for password-reset links. After verifying the colleague in person, the admin deletes the old Firebase Authentication account, issues a recovery code from the app, and gives the code to the colleague to choose a new password.
- Existing Firestore user profiles and transaction document IDs remain in place, so historical balances and transactions stay associated with the same profile.

See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for backups, Firebase configuration, admin bootstrap, onboarding, and cutover steps. Do not deploy the new client until the Firestore rules have been tested against the target project and the existing data has been verified.

## Features

- Colleague storefront with stock-aware purchases, immediate-payment or debt options, and personal transaction history.
- Atomic Firestore purchase, stock, and balance updates; repeat purchase requests use an idempotency key.
- Purchase cancellation requests with administrator approval or rejection.
- Administrator dashboard for balances, payments, stock, products, and cash tracking.
- Real-time updates through Firestore listeners.
- PWA installation on iOS and Android.

The app does not use Cloud Functions, Cloud Storage, Firebase Hosting, or a custom application server. Spark quotas still apply; Firestore and Authentication are not unlimited.

## Local development

Create a local `.env` file with the four public Firebase web-app values:

```text
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_APP_ID=...
```

Then run:

```powershell
npm install
npm run dev
```

Build for GitHub Pages with `npm run build`. The Pages workflow reads the same values from repository Actions variables. These web-app configuration values are public; never put a service-account key or password in the frontend or repository.

## Data and legacy files

- `src/firebaseBackend.js` implements Firebase Auth and direct Firestore operations.
- `firestore.rules` defines client read/write permissions and validates user-initiated purchase updates.
- `src/App.jsx` hosts Firebase and relays requests from the legacy interface.
- `public/legacy.html` contains the existing application screens.
- `Code.gs`, `FirestoreBackend.gs`, and `appsscript.json` are retained as historical/one-time migration tooling only. They are not called by the running app and must not be deployed as its backend.
- The migration from a source spreadsheet is a one-time import, not ongoing synchronization. Keep a private backup of the source and Firestore before cutover.
