# L-Karné PWA and Firebase Setup Guide

This is the step-by-step guide for deploying the React PWA, migrating the existing records to Firestore, and testing the new app. The existing deployed app and source spreadsheet must remain available until the new version has passed testing.

## Before you start

- The app works on iPhone and Android. Users open the same public web link and can add it to their Home Screen.
- The design uses Firebase Spark, Firestore, GitHub Pages, and Google Apps Script. It does not use Cloud Functions. Free usage is subject to Firebase and Apps Script quotas; it is not an unlimited service.
- The workbook `_L-Karné.xlsx` has the expected tabs and column headers: `Products`, `Users`, `Transactions`, `Settings`, and `Invites`. Its `Invites` tab already contains the invitation records; **do not import `codes-invitation-clients.csv` separately**.
- The workbook contains private client information, PIN hashes, balances, transaction history, and invitation codes. Keep it private. Do not upload it to GitHub, attach it to a public issue, or send passwords, private keys, or invitation codes in chat.
- The migration code reads a Google spreadsheet using its ID; Apps Script cannot read a Windows path such as `C:\Users\...\_L-Karné.xlsx`.

### Choose the correct source of data

Use the **current Google Sheet** as the migration source if it has the latest activity. This avoids converting an older export. If the Excel workbook is the authoritative and most recent copy, upload it to your own Google Drive and convert a copy to Google Sheets:

1. In Google Drive, choose **New → File upload** and select `_L-Karné.xlsx`.
2. When the upload finishes, right-click the uploaded file and choose **Open with → Google Sheets**.
3. In Google Sheets, choose **File → Save as Google Sheets** (or the equivalent **Save as Google Sheets** option). This creates a Google Sheets copy; keep the original Excel file unchanged as a backup.
4. Open the converted copy and confirm that it has the five tabs listed above and that the rows are present. Compare the client, invitation, product, and transaction counts with the source before continuing.
5. Copy the converted spreadsheet's ID from its URL. It is the text between `/d/` and `/edit`.

Do not combine an older workbook export with records from the live sheet. If anything changed after the workbook was downloaded, use the current sheet or make a fresh export before migration.

## Quick setup

### 1. Create a Firebase project on Spark

1. Go to the [Firebase console](https://console.firebase.google.com/) and create a project. Keep it on the **Spark** plan; do not upgrade to Blaze or create Cloud Functions.
2. In **Authentication**, enable Firebase Authentication so the app can accept the custom sign-in tokens issued by Apps Script. The app continues to check each user's existing username and PIN in Apps Script.
3. In **Firestore Database**, create the `(default)` database in production mode. For users in Morocco, choose **`europe-southwest1` (Madrid)** if it is offered in the location list; it is the closest listed Firestore region. The database location cannot be changed later.
4. Open Firestore **Rules**, replace the starter rules with the contents of [`firestore.rules`](./firestore.rules), and publish them. Browser writes are denied; the Apps Script backend performs writes.
5. Register the Firebase web app and copy its configuration:
   1. In the Firebase Console, open your project and click the **gear icon** next to **Project Overview** in the left sidebar.
   2. Select **Project settings**, then stay on the **General** tab.
   3. Scroll down to **Your apps**. Click the **Web** icon (`</>`). If you do not see the icon, click **Add app** and choose **Web**.
   4. Enter an app nickname such as `L-Karne PWA`. Leave **Also set up Firebase Hosting** unchecked, then click **Register app**.
   5. On the **Add Firebase SDK** screen, either **Use npm** or **Use a `<script>` tag** can be selected; neither choice affects these values. Look in the code sample for the comment **Your web app's Firebase configuration**. Copy only `apiKey`, `authDomain`, `projectId`, and `appId` from the `firebaseConfig` object. You can ignore `storageBucket`, `messagingSenderId`, and `measurementId`. If you leave this screen, return later to **Project settings → General → Your apps**, select the registered web app, and open **SDK setup and configuration** to find the same block.

   These four web configuration values are public; they are not private keys. Never copy or publish the service-account private key here.

### 2. Create a separate Apps Script backend

Do not edit or redeploy the Apps Script project currently used by the old app.

1. Sign in to [Apps Script](https://script.google.com/) with the Google account that can read the chosen source spreadsheet. Create a **new standalone project**.
2. Add the two code files and the manifest to the **new** Apps Script project:
   1. In the editor's left **Files** panel, open `Code.gs` (created by default). Select all its starter text and replace it with the complete contents of this repository's [`Code.gs`](./Code.gs). Save (`Ctrl+S`).
   2. Beside **Files**, click **Add a file (+) → Script**. Name it `FirestoreBackend` (Apps Script adds the `.gs` extension). Replace its starter text with the complete contents of [`FirestoreBackend.gs`](./FirestoreBackend.gs), then save.
   3. Click **Project Settings** (the gear icon in the left sidebar). Under **General settings**, enable **Show "appsscript.json" manifest file in editor**.
   4. Return to **Editor**. In the **Files** panel, open `appsscript.json`. Replace its contents with the complete contents of this repository's [`appsscript.json`](./appsscript.json), then save. Confirm the file now appears alongside the two `.gs` files.
   5. Check that the files are named exactly `Code.gs`, `FirestoreBackend.gs`, and `appsscript.json`. Do not add the service-account JSON key file to this project.

   This project must be a new standalone Apps Script project, not the script bound to the old Google Sheet. Replacing the starter `Code.gs` here does not alter the old app.
3. Link Apps Script to the Firebase Google Cloud project and grant the script owner Firestore access:
   1. In Firebase Console, open **Project settings → General**. In **Your project**, copy the **Project number** (a number, not the Project ID).
   2. Open the [Google Cloud Console](https://console.cloud.google.com/). Use the project selector at the top to select the **same project as Firebase**. Verify its project ID and number match **Firebase Console → Project settings → General** before changing anything. For example, if Firebase shows project ID `l-karne`, do not continue while the Cloud Console selector shows `angular-login`. If Google displays **Configure your OAuth consent screen** or **Configure your OAuth consent details**, follow the next step before trying to link Apps Script.
   3. Set up the OAuth consent screen: go to **Google Auth Platform → Branding** (or open the **OAuth consent screen** setup link shown in Apps Script). Click **Get started** if prompted. Enter `L-Karne Apps Script Backend` as the app name and choose your own email for **User support email**. Continue to **Audience**:
      - If your Google account is a regular Gmail account, choose **External**.
      - Choose **Internal** only if this is a Google Workspace account and only people in that same Workspace organization will authorize the script.
      Then enter your email as the **Contact information** email, accept the policy, and click **Create**. Leave the app in **Testing**; do not publish it or request verification for this personal Apps Script setup. If **Test users → Add users** is available and accepts your account, you may add it. If Google reports your Gmail account as ineligible or the test-user section is absent, do not switch the app to **Internal** or publish it; continue to link the new Apps Script project below, then authorize the script when prompted. If authorization shows a specific tester restriction, stop and resolve that error before running the migration.
   4. Return to the new Apps Script project and open **Project Settings** (gear icon). Under **Google Cloud Platform (GCP) Project**, click **Change project**. If the page still shows the OAuth consent warning, finish the consent setup and reload Project Settings.
   5. Paste the Firebase **Project number** into **GCP project number** and click **Set project**. Do not use the Project ID. Read the warning and confirm only if the page still shows the intended Firebase project number.

      **Important:** Google warns that changing the Cloud project revokes existing authorizations for the Apps Script project and cannot be reverted to an Apps Script-managed project. This guide has you create a new standalone script specifically so the old deployed script and its authorizations remain untouched. Do not change the Cloud project of the old script.
   6. In Google Cloud Console, make sure the project selector shows **L-Karne** / project ID `l-karne` (the Apps Script Settings screenshot should also show project number `83066107206`). Open **IAM & Admin** from the left navigation menu, then click **IAM**.
   7. On the IAM page, click **Grant access** near the top. In **New principals**, type the Google email address of the account that will own and deploy the new Apps Script web app. Use the same account you plan to choose for **Execute as** during deployment; do not enter a client email.
   8. Click **Select a role**. In the role search box, type `Cloud Datastore User`, select **Cloud Datastore User** (role ID `roles/datastore.user`), then click **Save**. Do not grant Owner or Editor. If the account already has this role, leave the existing grant in place rather than adding a duplicate.
   9. Enable/check the Firestore API: in the Cloud Console left navigation, open **APIs & Services → Enabled APIs & services**. Search the enabled API list for **Cloud Firestore API**. If it appears as enabled, continue. If not, click **Enable APIs and services**, search for **Cloud Firestore API**, open its result, and click **Enable**. Wait until the API page confirms it is enabled.

   The Apps Script manifest already requests the `datastore` OAuth scope. When you first run the migration, Apps Script will ask you to authorize its requested Sheets, Firestore, and external-request access. For more information, see Google's [Apps Script Cloud projects guide](https://developers.google.com/apps-script/guides/cloud-platform-projects) and [Firestore IAM documentation](https://cloud.google.com/firestore/docs/security/iam).
4. Create the service account and download its JSON key for signing Firebase custom-auth tokens:
   1. In the Google Cloud Console, confirm the selected project is **L-Karne** (`l-karne`). Open **☰ Navigation menu → IAM & Admin → Service Accounts**. You can also open the [Service Accounts page for L-Karne](https://console.cloud.google.com/iam-admin/serviceaccounts?project=l-karne).
   2. Click **Create service account**. For the name, enter `l-karne-token-signer`; let Google fill the service account ID. Optionally enter `Signs Firebase custom login tokens` as the description, then click **Create and continue**.
   3. On **Grant this service account access to project**, do not add a project role for this token-signing-only account; click **Continue**, then **Done**. The Apps Script user's Cloud Datastore User role is separate and is already granted in the previous step.
   4. In the service accounts list, click `l-karne-token-signer`. Open the **Keys** tab, click **Add key → Create new key**, select **JSON**, then click **Create**. Google downloads a `.json` key file. If key creation is blocked by an organization policy, stop; do not weaken the policy or share another service account's key. Ask the Google Cloud organization administrator to review the restriction.
   5. Keep the downloaded JSON file private on your computer. Open it locally with a text editor. In Apps Script **Project Settings → Script properties**, copy only `client_email` into `FIREBASE_SERVICE_ACCOUNT_EMAIL` and the complete `private_key` string into `FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY`. Preserve the entire `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` value. Never upload the JSON file to GitHub, put it in the web app, or send it in chat. Do not delete the local JSON file until you have successfully tested custom-token login; after that, store it in a secure password manager or securely delete it.
5. In Apps Script **Project Settings → Script properties**, add:

   | Property | Value |
   | --- | --- |
   | `SOURCE_SPREADSHEET_ID` | The ID from the Google Sheet URL (between `/d/` and `/edit`) |
   | `FIREBASE_PROJECT_ID` | The Firebase **Project ID** from Firebase Console → Project settings → General |
   | `FIREBASE_SERVICE_ACCOUNT_EMAIL` | `client_email` from the downloaded service-account JSON key |
   | `FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY` | The complete `private_key` value from that JSON key, including its `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines |

   From the values collected so far, use the Sheet ID you provided for `SOURCE_SPREADSHEET_ID` and `l-karne` for `FIREBASE_PROJECT_ID`. The Apps Script project number (`83066107206`) is **not** the value for `FIREBASE_PROJECT_ID`.

   The `apiKey`, `authDomain`, and `appId` from the Firebase **Web app config** do **not** go in Script Properties. Add them later as GitHub Actions repository variables in Step 5. `FIREBASE_SERVICE_ACCOUNT_EMAIL` and `FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY` come from the service-account JSON key created in Step 4; do not paste that JSON, its private key, or any PIN/invitation code into chat or the repository. In the private-key property, preserve the full key exactly; if it is shown with literal `\n` sequences, keep them as provided.

   Keep the private key only in Apps Script Script Properties. Do not set `FIRESTORE_ENABLED` manually; the migration enables it after verification.

### 3. Migrate the records

The migration copies data into Firestore. It does not modify the source spreadsheet, but **it writes data and must be run only once against the intended empty Firestore database**.

#### Before running it

1. **Pause changes in the old app** for the migration window. The import is a one-time snapshot; purchases, payments, stock changes, or account edits made to the old Sheet after the import will not automatically appear in Firestore.
2. In the Firebase Console, open **Firestore Database → Data**. Confirm this is project `l-karne` and the `(default)` database has no collections/documents. If you already see data, stop; do not run this import over it.
3. Open the source Sheet identified by `SOURCE_SPREADSHEET_ID`. Confirm it is the intended, most recent spreadsheet and contains these tabs: `Products`, `Users`, `Transactions`, `Settings`, and `Invites`. Check the row counts look plausible. Use the current Sheet if it is newer than the downloaded Excel copy.
4. In Apps Script **Project Settings → Script properties**, verify that `SOURCE_SPREADSHEET_ID` is the ID of that exact Sheet, `FIREBASE_PROJECT_ID` is `l-karne`, and the service-account email/private-key properties are present. Never paste the private key into the execution log or share it.
5. Make sure the new standalone Apps Script project is selected—not the script bound to the old Sheet. The source spreadsheet remains unchanged by this standalone project.

#### Run and verify

1. In the new Apps Script editor, open **Editor** from the left sidebar.
2. At the top toolbar, open the function selector (beside **Run** and **Debug**) and choose **`migrateCurrentSheetsToFirestore`**. If the function is missing, confirm `FirestoreBackend.gs` was added and saved, then reload the editor.
3. Click **Run**. On the first run, Google shows an authorization dialog. Select the Google account that owns/runs this new script, review the requested access to the spreadsheet, Firestore, and external requests, then click **Allow**. If Google displays an organization/tester restriction or an unexpected permission request, stop and resolve that before continuing; do not publish the OAuth app or change the old script.
4. Wait for the run to finish. In the left sidebar, open **Executions** (clock/list icon), select the latest `migrateCurrentSheetsToFirestore` execution, and check that its status is **Completed**. Open its logs and confirm there is a line beginning `Firestore migration verified:` followed by counts for each imported collection. The execution must not show an error.
5. The migration verifies every imported source row and each public user profile before it sets `FIRESTORE_MIGRATION_COMPLETE` and `FIRESTORE_ENABLED`. After successful verification, do not run the migration again. Continue to deploy the new web app in Step 4.

If the execution fails, times out, is denied permission, or does not show the verification log, stop. **Do not click Run again**: some Firestore writes may already have succeeded, and the migration intentionally refuses a second run only after a fully verified run. Keep the old app and Sheet as they are, and resolve the specific error before deciding how to clean up or resume. You may share the non-sensitive error text, but remove email addresses, spreadsheet IDs, PINs, invite codes, and all key material.

The import preserves source rows, including user PIN hashes and invitations. PIN hashes are stored in the private `UserSecrets` collection; sanitized profiles are stored in `PublicUsers`. The source Sheet is read, not deleted or edited.

### 4. Deploy the new Apps Script web app

The migration execution must show **Completed** and a log beginning `Firestore migration verified:` before you deploy. Once it has verified successfully, do not run the migration again.

1. In the new standalone Apps Script project, click **Deploy** (top-right) → **New deployment**.
2. In the dialog, click the **gear icon** beside **Select type** and choose **Web app**.
3. For **Description**, enter `L-Karne Firebase backend`.
4. For **Execute as**, choose **Me** (the Google account that owns this new script and has Firestore access).
5. For **Who has access**, choose **Anyone**. This allows the public PWA to call the endpoint; it does not grant direct Firestore access. The backend still validates application sessions and roles. If **Anyone** is unavailable or your organization blocks public Apps Script web apps, stop and resolve that restriction rather than changing the old deployment.
6. Click **Deploy**. If prompted, review and authorize the Apps Script permissions. If Google shows an access/tester restriction or a permission request you do not expect, stop and share the non-sensitive error text before continuing.
7. When deployment completes, copy the **Web app URL**. It should begin `https://script.google.com/macros/s/` and end `/exec`. Store it somewhere private; you will paste it into the PWA settings in Step 6. Do not use the development `/dev` URL.
8. Leave the old Apps Script deployment and its URL unchanged. This new `/exec` URL is only for the new PWA backend.

The old Apps Script deployment and its URL should remain unchanged as a fallback until cutover is complete.

### 5. Publish the PWA on GitHub Pages

**Important:** the existing `l-karne` repository's `main` branch currently deploys your old app. Do **not** merge the PWA into that branch or change that repository's Pages settings if you want the old deployed site to keep working. GitHub Pages provides one site per repository; deploying this PWA to the same repository URL would replace the old site.

The safest option is to create a separate public repository, for example `l-karne-mobile`, for the PWA. Its deployment can use `main` because it is a different repository; the existing `l-karne` repository and deployed URL remain unchanged.

1. On GitHub, create a new **empty** public repository named `l-karne-mobile` under `SelmaZeghli`. Do not initialize it with a README, license, or `.gitignore`.
2. In this local project, change the GitHub Pages base path in [`vite.config.js`](./vite.config.js) from `/l-karne/` to `/l-karne-mobile/`, then save. The deployment URL for the new repository will be `https://selmazeghli.github.io/l-karne-mobile/`.
3. In VS Code **Source Control**, review the changes on branch `mobile-version` and commit them before pushing. Do not stage or force-add the ignored invitation CSV, Excel exports, credentials, or service-account JSON key.
4. Add the new repository as a second Git remote, preserving the existing `origin` remote:

   ```powershell
   git remote add pwa https://github.com/SelmaZeghli/l-karne-mobile.git
   git push pwa mobile-version:main
   ```

   Run these commands from the project folder in PowerShell. This publishes the current `mobile-version` branch to `main` in the **new** repository; it does not push to or change the old repository.
5. In the new `l-karne-mobile` GitHub repository, open **Settings → Pages** and set the build source to **GitHub Actions**.
6. Open **Settings → Secrets and variables → Actions → Variables** in the new repository and add these four repository variables:

   | Variable | Firebase Web app value |
   | --- | --- |
   | `VITE_FIREBASE_API_KEY` | `apiKey` |
   | `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` |
   | `VITE_FIREBASE_PROJECT_ID` | `projectId` |
   | `VITE_FIREBASE_APP_ID` | `appId` |

   These are public web configuration values. **Never put the service-account private key here.**
7. In the new repository's **Actions** tab, wait for **Deploy L-Karne to GitHub Pages** to finish successfully.
8. Open `https://selmazeghli.github.io/l-karne-mobile/` and follow Step 6 to configure and test the backend connection.

### 6. Connect and test the app

1. In the PWA, open **Settings** (the gear icon or backend status badge).
2. Paste the new Apps Script `/exec` URL into **Web App URL**, choose **Test connection**, and then **Save**. Configure it once on each device/browser; this setting is stored on that device.
3. Log in as the admin and check the imported products, stock, balances, cash setting, and transaction history.
4. Test a client account with its existing username and PIN. Confirm it sees only its own balance and transaction history.
5. On two separate devices, test an operation and confirm the other device updates. Test purchases, payments, stock restock, and the admin actions you rely on. Use transactions that can safely be reversed; do not use real customer transactions as tests.
6. On Android, open the published link in Chrome and choose **Install** or **Add to Home screen**. On iPhone, open it in Safari and choose **Share → Add to Home Screen**.

### 7. Cut over without losing activity

1. Keep the old app and spreadsheet available during testing.
2. When ready to switch, pause new activity in the old app. If any final changes occurred after the migration, they must be accounted for before cutover; the migration is a one-time snapshot and does not continuously copy changes from the old sheet.
3. Confirm the new PWA works for the admin and at least one client, and confirm real-time updates on two devices.
4. Give users the one published PWA link and ask them to use only the new app. Keep the old spreadsheet as a private backup.

Purchases require an Internet connection. Firebase and Apps Script have free quotas; if a quota is reached, operations may temporarily fail. Check usage periodically. See the official [Firestore quotas](https://firebase.google.com/docs/firestore/quotas), [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas), and [Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans).

## About migrating the workbook with assistance

The workbook can be inspected and its format checked locally, but this assistant cannot sign in to your Google, GitHub, or Firebase accounts or access your Firebase database without account authorization. Do **not** send account passwords, service-account keys, client PINs, or invitation codes. The safest route is to run the migration function above from your own Apps Script project: it reads the spreadsheet inside your Google account and writes to your Firebase project without sending client records to this chat.

The supplied workbook's tab names and headers match the migration format, and its `Invites` tab already contains invitation data. There is no need to upload the workbook or CSV here again. If the workbook is not the newest copy, use the live Google Sheet or make a new export before migration.

## Historical Google Sheets-only setup

The steps below are for the original Sheets-backed deployment only. They are not part of the Firestore migration. Do not run `setupDatabase` or `replaceDemoDataWithWorkbook` in the new Firestore project after migration.

1. Create or open the original Google Sheet and its bound Apps Script project. The new PWA uses the same existing screens, now packaged in React; see [`public/legacy.html`](./public/legacy.html).
2. To deploy a Sheets-only backend, use the Apps Script code and manifest, run `setupDatabase` only when initializing a new database, and deploy it as a web app executing as you and accessible to anyone.
3. In the app's **Settings**, save that deployment's `/exec` URL and test the connection.
4. Only run `replaceDemoDataWithWorkbook` if you explicitly intend to erase the existing products, users, transactions, cash settings, and invitations. It is destructive and invalidates existing sessions.

For the PWA/Firebase deployment, follow the Spark setup above instead of this historical section.
