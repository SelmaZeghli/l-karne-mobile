# Firebase-only deployment and cutover

The live app uses Firebase Authentication and Cloud Firestore directly from the browser. **It does not call Google Sheets or Apps Script.** The existing spreadsheet is only a possible one-time migration source. Do not deploy this version or invite users until you have verified that the Firestore project contains the latest correct data and have tested the rules below.

## 1. Protect and verify the existing data

1. Pause purchases and admin changes while you prepare the cutover.
2. Make a private export/backup of the current Firestore data and keep the source Sheet as a separate archival backup. Never upload either to GitHub or send it in chat.
3. In Firebase Console, confirm the project ID and inspect `PublicUsers`, `Products`, `Transactions`, and `Settings`. Compare user counts, balances, stock, and recent transaction IDs with the current authoritative data.
4. Check recent activity for duplicate purchases before retrying any operation that previously failed in the old app.
5. If the Firestore data is already complete, **do not rerun the Sheet migration**. It is a one-time snapshot, not a live sync. If the latest records exist only in Sheets, finish one final, verified import before switching; then stop using the Sheet operationally.

Do not delete or overwrite the existing Firestore collections. The app retains existing `PublicUsers` and `Transactions` document IDs so the balances and history remain linked to the same profiles.

## 2. Configure Firebase Authentication

1. In the Firebase Console, open **Authentication → Sign-in method** and enable **Email/Password**. Email verification is not used.
2. Under **Authentication → Settings → Authorized domains**, ensure the published GitHub Pages host (for example, `selmazeghli.github.io`) is present.
3. The app maps each lowercase username to a synthetic Firebase Auth address of the form `username@auth.lkarne.invalid`. Colleagues do not need an email address and should sign in using only their username and password.
4. Existing PIN hashes cannot be converted into passwords. Each colleague will set a new password of at least 12 characters when activating their account.

Firebase Auth accounts with this synthetic address are internal sign-in identities, not contact addresses. There is no user-facing email password reset; password recovery requires an administrator.

## 3. Configure Firestore and test the rules

1. Confirm that the `(default)` Firestore database contains the verified live data. Do not create a second project/database by mistake.
2. Test `firestore.rules` against the data shape and operations in a Firestore Emulator before publishing:
   - unauthenticated reads/writes are denied, except a direct read of an unclaimed 32-character invite code;
   - a user can read active products, their own profile, and only their own transactions;
   - a user cannot read another user's profile/history, change a balance, change a product price/stock freely, or create payments/admin transactions;
   - invite claiming links one Auth UID to exactly one existing user profile, and a code cannot be claimed twice;
   - a valid purchase atomically creates a transaction and changes only that user's balance and the relevant product stock;
   - users can request, but not approve, purchase cancellation;
   - an admin can perform the dashboard, payment, cancellation, inventory, product, invite, and settings actions.
3. Publish [`firestore.rules`](./firestore.rules) only after those checks pass. Do not replace them with test/open rules such as `allow read, write: if true`.

The source intentionally uses direct browser writes and has no Cloud Functions. Firestore Security Rules are therefore the security boundary for every operation.

## 4. Bootstrap the first administrator

The first admin must be linked manually in Firebase Console because there is no existing Firebase Auth admin account to authorize that step:

1. In **Authentication → Users**, add an Email/Password user whose email is `adminusername@auth.lkarne.invalid`, using the lowercase username already stored on the existing admin profile. Set a strong temporary password and give it to the administrator privately.
2. Copy the new user's Firebase **UID**.
3. In Firestore, locate the existing administrator document in `PublicUsers` and confirm its document ID, `id`, `username`, and `role`.
4. Create `UserAuthLinks/{UID}` with these fields:

   | Field | Value |
   | --- | --- |
   | `user_id` | Existing admin profile document ID as a string |
   | `username` | Existing username in lowercase |
   | `role` | `admin` |
   | `linked_at` | Current ISO-8601 date/time string |
   | `invite_code` | Empty string |

5. Sign in through the app using the username and temporary password. Verify the admin dashboard and sign out. The admin should then use a private password manager to retain their password.

The profile's `role` must identify the intended administrator. Never create an admin by trusting a browser-supplied role or by changing a user profile from the client.

## 5. Configure GitHub Pages

The repository's Vite base path is currently `/l-karne-mobile/`. Deploy only to the GitHub Pages repository whose URL matches that path. If the existing Sheet-backed site uses another repository/URL, keep it unchanged as a fallback and publish this app as a separate repository/site.

1. In the target GitHub repository, set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**.
2. Under **Settings → Secrets and variables → Actions → Variables**, create:

   | Variable | Value from Firebase web app configuration |
   | --- | --- |
   | `VITE_FIREBASE_API_KEY` | `apiKey` |
   | `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` |
   | `VITE_FIREBASE_PROJECT_ID` | `projectId` |
   | `VITE_FIREBASE_APP_ID` | `appId` |

   These web configuration values are public. Never store a service-account private key, password, client data, or invite code in GitHub variables.
3. Check that the target repository's Pages URL and `vite.config.js` base path agree. The configured path currently builds for `https://selmazeghli.github.io/l-karne-mobile/`.
4. Push the reviewed code to the target repository and wait for the **Deploy L-Karné to GitHub Pages** workflow to complete successfully.
5. Open the published page and verify the Firebase status. If configuration is absent, the app must remain unavailable rather than falling back to Apps Script.

## 6. Issue user activation codes

1. Sign in as the bootstrapped admin.
2. In the admin dashboard, choose **Exporter les codes**. The app creates a one-time code for each non-admin `PublicUsers` profile that does not yet have a `UserAuthLinks` mapping.
3. Give each colleague their own code in person. The code is a credential: do not post it in chat, tickets, or public files. Delete local CSV exports after secure distribution.
4. The colleague opens the PWA, selects **Activer mon compte avec un code**, enters the code and their existing username (or chooses one if their imported profile did not yet have a username), then chooses a unique password of at least 12 characters.
5. Have the colleague sign out and sign in again with the new username/password. Confirm their existing balance and transaction history are visible.

The **Ajouter Colleague** action creates a new profile and activation code. It does not ask for or store a personal email address.

## 7. Password recovery

Firebase cannot send a password-reset link because these users do not have email addresses. When a colleague forgets a password:

1. Verify the colleague's identity in person.
2. In Firebase Console **Authentication → Users**, delete that colleague's old Auth account. Do not delete their `PublicUsers` profile or transaction records.
3. In the app's recovery section, create a recovery code for the existing profile and give it directly to the colleague. This also removes the profile's old `UserAuthLinks` mapping, immediately blocking Firestore access from any still-cached session.
4. The colleague activates using the same username and that new code, then chooses a new password.

Deleting the Auth account and removing its auth-link mapping affect credentials only; neither action deletes the profile or historical records. The new Auth UID receives a new link during activation. If the only administrator loses access, bootstrap a replacement administrator through Firebase Console rather than issuing a colleague recovery code.

## 8. Smoke-test, then cut over

Before allowing normal purchases, use a designated test user/product and verify all of the following:

- Admin login and dashboard; colleague login with the new password.
- Correct existing balances and transaction history; one colleague cannot access another colleague's records.
- A purchase updates exactly one transaction, the correct stock, and the correct user's balance; retry behavior does not double-charge.
- Admin payment, inventory, cash, product-edit, cancellation approval/rejection, invite export, and recovery-code flows.
- Realtime changes appear on a second browser/device.
- Invalid login, invalid/used invite, insufficient stock, and denied unauthorized writes produce clear errors.

Once checks pass, announce the single new PWA link and tell users to stop using the previous app. Keep the old site and Sheet private and read-only as backups; they are not synchronization targets. For any uncertain or failed purchase, check the Firestore transaction, balance, and stock before retrying.

Purchases and admin operations require an Internet connection. Firebase Spark quotas and service limits still apply. Monitor Firebase usage and keep regular private backups.
