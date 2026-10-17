/**
 * ==============================================================================
 * L-KARNÉ (SnackBox & Kridi Tracker) - Backend Engine
 * Platform: Google Apps Script (GAS) Web App
 * Backed by: Google Sheets on Admin's Google Drive
 * ==============================================================================
 */

// Configuration & Sheet Names
const CONFIG = {
  SHEET_PRODUCTS: 'Products',
  SHEET_USERS: 'Users',
  SHEET_TRANSACTIONS: 'Transactions',
  SHEET_SETTINGS: 'Settings',
  SHEET_INVITES: 'Invites',
  TOKEN_EXPIRY_HOURS: 72, // 3 days session validity
  LOCK_TIMEOUT_MS: 15000,  // 15s lock wait to handle concurrent kiosk taps
};

function roundMoney(value) {
  const rounded = Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function ensureTransactionStatusColumn(sheet) {
  const lastColumn = sheet.getLastColumn();
  if (!lastColumn) throw new Error('L’onglet Transactions ne contient pas de ligne d’en-tête.');
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    .map(function (header) { return String(header).trim().toLowerCase(); });
  if (headers.indexOf('id') < 0) {
    throw new Error('La colonne id est absente de l’onglet Transactions.');
  }
  let statusColumn = headers.indexOf('status') + 1;
  if (!statusColumn) {
    headers.push('status');
    statusColumn = headers.length;
    sheet.getRange(1, statusColumn).setValue('status');
    sheet.getRange(1, statusColumn).setFontWeight('bold').setBackground('#e2e8f0');
  }
  ['cancel_status', 'cancel_requested_at', 'cancel_decided_at', 'cancel_decided_by'].forEach(function (name) {
    if (headers.indexOf(name) < 0) {
      const column = sheet.getLastColumn() + 1;
      sheet.getRange(1, column).setValue(name);
      sheet.getRange(1, column).setFontWeight('bold').setBackground('#e2e8f0');
      headers.push(name);
    }
  });
  return statusColumn;
}

function findTransactionColumn(headers, name) {
  const column = headers.indexOf(name);
  if (column < 0) throw new Error('Colonne ' + name + ' absente de l’onglet Transactions.');
  return column;
}

function transactionStatus(sheet) {
  ensureTransactionStatusColumn(sheet);
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (header) { return String(header).trim().toLowerCase(); });
}

function cancellationEventId(transactionId) {
  return 'TX-CANCEL-' + transactionId;
}

function getTransactionRowById(data, idColumn, transactionId) {
  return data.findIndex(function (row, index) {
    return index > 0 && String(row[idColumn]) === transactionId;
  });
}

function isCompletedTransaction(row, statusColumnIndex) {
  if (statusColumnIndex < 0 ||
      row[statusColumnIndex] === '' ||
      row[statusColumnIndex] === null ||
      row[statusColumnIndex] === undefined) return true;
  return String(row[statusColumnIndex]).trim().toUpperCase() === 'COMPLETE';
}

function ensureUserPinRecoveryColumns(sheet) {
  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    .map(function (header) { return String(header).trim().toLowerCase(); });
  if (headers.indexOf('id') < 0 || headers.indexOf('pin_hash') < 0) {
    throw new Error('Schéma Users invalide pour la récupération du PIN.');
  }
  ['pin_reset_required', 'pin_reset_requested_at', 'session_version'].forEach(function (name) {
    if (headers.indexOf(name) < 0) {
      const column = sheet.getLastColumn() + 1;
      sheet.getRange(1, column).setValue(name);
      sheet.getRange(1, column).setFontWeight('bold').setBackground('#e2e8f0');
      headers.push(name);
    }
  });
  return headers;
}

function isLorCoffee(name) {
  return /^(?:coffee\s*)?l['’]?or\b/i.test(String(name || '').trim()) ||
    /^capsule\s+l['’]?or\b/i.test(String(name || '').trim()) ||
    /^coffee$/i.test(String(name || '').trim());
}

function displayProductName(name) {
  return isLorCoffee(name) || /^coffee$/i.test(String(name || '').trim())
    ? "Capsule L'or"
    : String(name || '');
}

function isAchraf(user) {
  return /^achraf(?:\b|$)/i.test(String(user.name || '').trim()) ||
    /^achraf$/i.test(String(user.username || '').trim());
}

function getUserProductPrice(user, name, defaultPrice) {
  return isAchraf(user) && isLorCoffee(name) ? 3.5 : Number(defaultPrice || 0);
}

function getProductInventoryUnitsPerSale(name, productId) {
  const id = String(productId || '').trim();
  if (id === 'p47' || id === 'p60') return 3;
  return /^(?:tea|trident)\s*\(\s*3\s*pc\s*\)$/i.test(String(name || '').trim()) ? 3 : 1;
}

function isValidProductImageValue(value) {
  const imageValue = String(value || '').trim();
  if (/^https:\/\//i.test(imageValue)) {
    return /^https:\/\/[^/?#\s]+(?:[/?#][^\s]*)?$/i.test(imageValue);
  }
  return imageValue.length > 0 && imageValue.length <= 8 &&
    !/[<>"'`]/.test(imageValue) && !/^https?:/i.test(imageValue);
}

function isCoffeeVariant(name) {
  return /^(?:coffee\b|capsule\s+l['’]?or\b)/i.test(String(name || '').trim());
}

function normalizeCoffeeProducts(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return;
  const headers = data[0].map(function (header) { return String(header).trim().toLowerCase(); });
  const idCol = headers.indexOf('id');
  const nameCol = headers.indexOf('name');
  const stockCol = headers.indexOf('stock_qty');
  const activeCol = headers.indexOf('is_active');
  if ([idCol, nameCol, stockCol, activeCol].some(function (col) { return col < 0; })) return;

  const variants = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] && isCoffeeVariant(data[i][nameCol])) {
      variants.push({
        row: i + 1,
        id: String(data[i][idCol]),
        name: String(data[i][nameCol]),
        stock: Math.max(0, parseInt(data[i][stockCol], 10) || 0)
      });
    }
  }
  if (variants.length <= 1) {
    if (variants.length === 1 && isLorCoffee(variants[0].name)) {
      sheet.getRange(variants[0].row, nameCol + 1).setValue("Capsule L'or");
    }
    return;
  }

  const inStock = variants.filter(function (product) { return product.stock > 0; });
  inStock.sort(function (a, b) { return b.stock - a.stock; });
  const selected = inStock[0] || variants.find(function (product) {
    return isLorCoffee(product.name);
  }) || variants[0];

  variants.forEach(function (product) {
    const isSelected = product.id === selected.id;
    sheet.getRange(product.row, activeCol + 1).setValue(isSelected);
    if (isLorCoffee(product.name)) {
      sheet.getRange(product.row, nameCol + 1).setValue("Capsule L'or");
    }
  });
}

/**
 * Helper to get or create a persistent secret key for HMAC token signing
 */
function getSecretKey() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('JWT_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + '-' + Utilities.getUuid();
    props.setProperty('JWT_SECRET', secret);
  }
  return secret;
}

/**
 * SHA-256 Hash for User PINs
 */
function hashPin(pin) {
  const rawHash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(pin).trim(),
    Utilities.Charset.UTF_8
  );
  return rawHash.map(function (byte) {
    const v = (byte < 0 ? byte + 256 : byte).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

/**
 * Generate a tamper-proof session token: userId.role.expiresAt.signature
 */
function generateSessionToken(userId, role, sessionVersion) {
  const expiresAt = Date.now() + CONFIG.TOKEN_EXPIRY_HOURS * 3600 * 1000;
  const payload = userId + '.' + role + '.' + expiresAt + '.' + (Number(sessionVersion) || 0);
  const signatureBytes = Utilities.computeHmacSha256Signature(payload, getSecretKey());
  const signature = Utilities.base64EncodeWebSafe(signatureBytes);
  return payload + '.' + signature;
}

/**
 * Verify session token and return user session object or null
 */
function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4 && parts.length !== 5) return null;

  const [userId, role, expiresAtStr] = parts;
  const tokenVersion = parts.length === 5 ? Number(parts[3]) : 0;
  const receivedSig = parts[parts.length - 1];
  const expiresAt = parseInt(expiresAtStr, 10);
  if (isNaN(expiresAt) || Date.now() > expiresAt || !Number.isSafeInteger(tokenVersion) || tokenVersion < 0) {
    return null; // Expired
  }

  const payload = parts.length === 5
    ? userId + '.' + role + '.' + expiresAtStr + '.' + tokenVersion
    : userId + '.' + role + '.' + expiresAtStr;
  const expectedSigBytes = Utilities.computeHmacSha256Signature(payload, getSecretKey());
  const expectedSig = Utilities.base64EncodeWebSafe(expectedSigBytes);

  if (receivedSig !== expectedSig) {
    return null; // Tampered or invalid
  }

  const usersSheet = getSpreadsheet().getSheetByName(CONFIG.SHEET_USERS);
  if (!usersSheet) return null;
  const headers = ensureUserPinRecoveryColumns(usersSheet);
  const data = usersSheet.getDataRange().getValues();
  const idCol = headers.indexOf('id');
  const versionCol = headers.indexOf('session_version');
  const resetCol = headers.indexOf('pin_reset_required');
  const userRow = data.find(function (row, index) {
    return index > 0 && String(row[idCol]) === userId;
  });
  if (!userRow || (Number(userRow[versionCol]) || 0) !== tokenVersion) return null;
  return {
    userId: userId,
    role: role,
    expiresAt: expiresAt,
    sessionVersion: tokenVersion,
    pinResetRequired: String(userRow[resetCol]).toUpperCase() === 'TRUE'
  };
}

/**
 * Get the active Spreadsheet instance
 */
function getSpreadsheet() {
  if (isFirestoreBackendEnabled()) return getFirestoreSpreadsheet();
  return getSourceSpreadsheet();
}

function getSourceSpreadsheet() {
  const activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (activeSpreadsheet) return activeSpreadsheet;
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('SOURCE_SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('Set SOURCE_SPREADSHEET_ID when this script is not bound to a spreadsheet.');
  }
  return SpreadsheetApp.openById(spreadsheetId);
}

/**
 * CORS and JSON Response Helper
 */
function createJsonResponse(data) {
  flushApplicationData();
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Handle HTTP GET Requests (Health check, diagnostics, or ping)
 */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'ping';
  const callback = e && e.parameter && e.parameter.callback;

  let responseData = { success: false, error: 'Action GET invalide' };

  if (action === 'ping') {
    responseData = {
      success: true,
      service: 'L-Karné Web App API',
      status: 'online',
      timestamp: new Date().toISOString()
    };
  } else if (action === 'auth/list_public_users') {
    responseData = handleListPublicUsers();
  }

  // Support JSONP for environments with strict CORS policies or file:// origins
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + JSON.stringify(responseData) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return createJsonResponse(responseData);
}

/**
 * Handle HTTP POST Requests (Main API Gateway)
 */
function doPost(e) {
  try {
    let body = {};
    if (e && e.postData && e.postData.contents) {
      try {
        body = JSON.parse(e.postData.contents);
      } catch (err) {
        return createJsonResponse({ success: false, error: 'Malformed JSON payload: ' + err.message });
      }
    } else if (e && e.parameter) {
      body = e.parameter;
    }

    const action = body.action || (e && e.parameter && e.parameter.action);

    // Route public endpoints
    if (action === 'auth/login') {
      return createJsonResponse(handleLogin(body));
    }
    if (action === 'auth/register') {
      return createJsonResponse(handleRegister(body));
    }
    if (action === 'auth/request_pin_reset') {
      return createJsonResponse(handlePinResetRequest(body));
    }
    if (action === 'auth/list_public_users') {
      return createJsonResponse(handleListPublicUsers());
    }

    // Validate authentication token for protected endpoints
    const token = body.token || (e && e.parameter && e.parameter.token);
    const session = verifySessionToken(token);
    if (!session) {
      return createJsonResponse({
        success: false,
        error: 'Unauthorized: Session invalid or expired. Please sign in again.'
      });
    }
    if (session.pinResetRequired &&
        action !== 'colleague/change_temporary_pin' &&
        action !== 'colleague/dashboard') {
      return createJsonResponse({
        success: false,
        error: 'Change your temporary PIN before using the application.'
      });
    }

    // Route protected endpoints
    switch (action) {
      case 'auth/firebase_token':
        if (!isFirestoreBackendEnabled()) {
          return createJsonResponse({ success: false, error: 'Firebase authentication is not enabled.' });
        }
        return createJsonResponse({
          success: true,
          firebaseCustomToken: createFirebaseCustomToken(
            session.userId, session.role, session.sessionVersion
          )
        });

      // Colleague routes
      case 'colleague/dashboard':
        return createJsonResponse(handleColleagueDashboard(session));

      case 'colleague/purchase':
        return createJsonResponse(handleColleaguePurchase(session, body));

      case 'colleague/request_purchase_cancellation':
        return createJsonResponse(handleColleaguePurchaseCancellationRequest(session, body));

      case 'colleague/change_temporary_pin':
        return createJsonResponse(handleChangeTemporaryPin(session, body));

      // Admin routes
      case 'admin/overview':
        if (session.role !== 'admin') {
          return createJsonResponse({ success: false, error: 'Forbidden: Admin privilege required' });
        }
        return createJsonResponse(handleAdminOverview());

      case 'admin/export_invites':
        if (session.role !== 'admin') {
          return createJsonResponse({ success: false, error: 'Forbidden: Admin privilege required' });
        }
        return createJsonResponse(handleAdminExportInvites());

      case 'admin/restock':
        if (session.role !== 'admin') {
          return createJsonResponse({ success: false, error: 'Forbidden: Admin privilege required' });
        }
        return createJsonResponse(handleAdminRestock(session, body));

      case 'admin/purchase_inventory':
        if (session.role !== 'admin') {
          return createJsonResponse({ success: false, error: 'Forbidden: Admin privilege required' });
        }
        return createJsonResponse(handleAdminPurchaseInventory(session, body));

      case 'admin/settle':
        if (session.role !== 'admin') {
          return createJsonResponse({ success: false, error: 'Forbidden: Admin privilege required' });
        }
        return createJsonResponse(handleAdminSettle(session, body));

      case 'admin/decide_purchase_cancellation':
        if (session.role !== 'admin') {
          return createJsonResponse({ success: false, error: 'Forbidden: Admin privilege required' });
        }
        return createJsonResponse(handleAdminPurchaseCancellationDecision(session, body));

      case 'admin/reset_user_pin':
        if (session.role !== 'admin') {
          return createJsonResponse({ success: false, error: 'Forbidden: Admin privilege required' });
        }
        return createJsonResponse(handleAdminResetUserPin(body));

      case 'admin/set_opening_cash':
        if (session.role !== 'admin') {
          return createJsonResponse({ success: false, error: 'Forbidden: Admin privilege required' });
        }
        return createJsonResponse(handleAdminSetOpeningCash(body));

      case 'admin/add_product':
        if (session.role !== 'admin') {
          return createJsonResponse({ success: false, error: 'Forbidden: Admin privilege required' });
        }
        return createJsonResponse(handleAdminAddProduct(session, body));

      case 'admin/update_product_image':
        if (session.role !== 'admin') {
          return createJsonResponse({ success: false, error: 'Forbidden: Admin privilege required' });
        }
        return createJsonResponse(handleAdminUpdateProductImage(body));

      case 'admin/update_product_details':
        if (session.role !== 'admin') {
          return createJsonResponse({ success: false, error: 'Forbidden: Admin privilege required' });
        }
        return createJsonResponse(handleAdminUpdateProductDetails(body));

      case 'admin/add_user':
        if (session.role !== 'admin') {
          return createJsonResponse({ success: false, error: 'Forbidden: Admin privilege required' });
        }
        return createJsonResponse(handleAdminAddUser(session, body));

      default:
        return createJsonResponse({ success: false, error: 'Unknown action: ' + action });
    }
  } catch (globalError) {
    return createJsonResponse({
      success: false,
      error: 'Internal Server Error: ' + globalError.toString()
    });
  }
}

/**
 * Public User List includes registered names only, never balances or PIN hashes.
 */
function handleListPublicUsers() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_USERS);
  if (!sheet) return { success: false, error: 'Users sheet not found' };

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { success: true, users: [] };

  const headers = data[0].map(h => String(h).trim().toLowerCase());
  const idxId = headers.indexOf('id');
  const idxName = headers.indexOf('name');
  const idxUsername = headers.indexOf('username');
  const idxRole = headers.indexOf('role');
  if ([idxId, idxName, idxUsername, idxRole].some(function (col) { return col < 0; })) {
    return { success: false, error: 'Schéma utilisateurs invalide.' };
  }

  const users = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[idxId] && String(row[idxUsername] || '').trim()) {
      users.push({
        id: String(row[idxId]),
        name: String(row[idxName] || ''),
        username: String(row[idxUsername] || ''),
        role: String(row[idxRole] || 'user')
      });
    }
  }

  return { success: true, users: users };
}

/**
 * Return outstanding one-time invitation codes to the authenticated admin only.
 */
function handleAdminExportInvites() {
  const ss = getSpreadsheet();
  const usersSheet = ss.getSheetByName(CONFIG.SHEET_USERS);
  const invitesSheet = ss.getSheetByName(CONFIG.SHEET_INVITES);
  if (!usersSheet || !invitesSheet) {
    return { success: false, error: 'Données d’invitation introuvables. Initialisez la base.' };
  }

  const userHeaders = ensureUserPinRecoveryColumns(usersSheet);
  const users = usersSheet.getDataRange().getValues();
  const userIdCol = userHeaders.indexOf('id');
  const nameCol = userHeaders.indexOf('name');
  const usernameCol = userHeaders.indexOf('username');
  if ([userIdCol, nameCol, usernameCol].some(function (col) { return col < 0; })) {
    return { success: false, error: 'Schéma utilisateurs invalide.' };
  }

  const invites = invitesSheet.getDataRange().getValues();
  const inviteHeaders = invites[0].map(function (header) { return String(header).trim().toLowerCase(); });
  const inviteUserIdCol = inviteHeaders.indexOf('user_id');
  const inviteCodeCol = inviteHeaders.indexOf('claim_code');
  const inviteUsedCol = inviteHeaders.indexOf('used_at');
  if ([inviteUserIdCol, inviteCodeCol, inviteUsedCol].some(function (col) { return col < 0; })) {
    return { success: false, error: 'Schéma des invitations invalide.' };
  }

  const usersById = {};
  for (let i = 1; i < users.length; i++) {
    usersById[String(users[i][userIdCol] || '')] = users[i];
  }

  const pending = [];
  for (let i = 1; i < invites.length; i++) {
    const invite = invites[i];
    const user = usersById[String(invite[inviteUserIdCol] || '')];
    const code = String(invite[inviteCodeCol] || '').trim();
    if (user && !invite[inviteUsedCol] && !String(user[usernameCol] || '').trim() && code) {
      pending.push({
        name: String(user[nameCol] || ''),
        inviteCode: code
      });
    }
  }

  return { success: true, invites: pending };
}

/**
 * Create an account against a pre-imported client record using its one-time code.
 */
function handleRegister(body) {
  const inviteCode = String(body.inviteCode || '').trim().toUpperCase();
  const username = String(body.username || '').trim().toLowerCase();
  const pin = String(body.pin || '').trim();

  if (!/^[A-F0-9]{16}$/.test(inviteCode) ||
      !/^[a-z0-9._-]{3,30}$/.test(username) ||
      !/^\d{4,6}$/.test(pin)) {
    return { success: false, error: 'Code d’invitation, identifiant (3 à 30 caractères) et PIN (4 à 6 chiffres) requis.' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return { success: false, error: 'Serveur occupé. Veuillez réessayer.' };
  }
  try {
    const ss = getSpreadsheet();
    const usersSheet = ss.getSheetByName(CONFIG.SHEET_USERS);
    const invitesSheet = ss.getSheetByName(CONFIG.SHEET_INVITES);
    if (!usersSheet || !invitesSheet) {
      return { success: false, error: 'Inscription non initialisée. Contactez l’administrateur.' };
    }

    const users = usersSheet.getDataRange().getValues();
    const userHeaders = users[0].map(function (header) { return String(header).trim().toLowerCase(); });
    const userIdCol = userHeaders.indexOf('id');
    const nameCol = userHeaders.indexOf('name');
    const usernameCol = userHeaders.indexOf('username');
    const pinHashCol = userHeaders.indexOf('pin_hash');
    const roleCol = userHeaders.indexOf('role');
    const balanceCol = userHeaders.indexOf('balance_mad');

    if ([userIdCol, nameCol, usernameCol, pinHashCol, roleCol, balanceCol].some(function (col) { return col < 0; })) {
      return { success: false, error: 'Schéma utilisateurs invalide. Contactez l’administrateur.' };
    }

    for (let i = 1; i < users.length; i++) {
      if (String(users[i][usernameCol] || '').trim().toLowerCase() === username) {
        return { success: false, error: 'Cet identifiant est déjà utilisé.' };
      }
    }

    const invites = invitesSheet.getDataRange().getValues();
    const inviteHeaders = invites[0].map(function (header) { return String(header).trim().toLowerCase(); });
    const inviteUserIdCol = inviteHeaders.indexOf('user_id');
    const inviteHashCol = inviteHeaders.indexOf('code_hash');
    const inviteCodeCol = inviteHeaders.indexOf('claim_code');
    const inviteUsedCol = inviteHeaders.indexOf('used_at');
    if ([inviteUserIdCol, inviteHashCol, inviteCodeCol, inviteUsedCol].some(function (col) { return col < 0; })) {
      return { success: false, error: 'Schéma des invitations invalide. Contactez l’administrateur.' };
    }
    const inviteCodeHash = hashPin(inviteCode);
    let inviteRow = -1;
    let targetUserRow = -1;
    let targetUser = null;

    for (let i = 1; i < invites.length; i++) {
      if (String(invites[i][inviteHashCol] || '').toLowerCase() === inviteCodeHash.toLowerCase() &&
          !invites[i][inviteUsedCol]) {
        inviteRow = i + 1;
        const targetUserId = String(invites[i][inviteUserIdCol] || '');
        for (let j = 1; j < users.length; j++) {
          if (String(users[j][userIdCol]) === targetUserId &&
              !String(users[j][usernameCol] || '').trim() &&
              !String(users[j][pinHashCol] || '').trim() &&
              String(users[j][roleCol] || '').toLowerCase() !== 'admin') {
            targetUserRow = j + 1;
            targetUser = users[j];
            break;
          }
        }
        break;
      }
    }

    if (inviteRow < 0 || targetUserRow < 0 || !targetUser) {
      return { success: false, error: 'Code invalide ou déjà utilisé. Vérifiez le code auprès de l’administrateur.' };
    }

    const now = new Date().toISOString();
    usersSheet.getRange(targetUserRow, usernameCol + 1).setValue(username);
    usersSheet.getRange(targetUserRow, pinHashCol + 1).setValue(hashPin(pin));
    invitesSheet.getRange(inviteRow, inviteCodeCol + 1).setValue('');
    invitesSheet.getRange(inviteRow, inviteUsedCol + 1).setValue(now);

    const user = {
      id: String(targetUser[userIdCol]),
      name: String(targetUser[nameCol] || ''),
      username: username,
      role: 'user',
      balance_mad: Number(targetUser[balanceCol] || 0)
    };
    return {
      success: true,
      token: generateSessionToken(user.id, user.role, Number(user.session_version) || 0),
      firebaseCustomToken: isFirestoreBackendEnabled()
        ? createFirebaseCustomToken(user.id, user.role, Number(user.session_version) || 0)
        : '',
      user: user
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Handle Login (Authenticates username + PIN, produces session token)
 */
function handleLogin(body) {
  const username = String(body.username || '').trim().toLowerCase();
  const pin = String(body.pin || '').trim();

  if (!username || !pin) {
    return { success: false, error: 'Veuillez saisir votre identifiant et votre code PIN.' };
  }

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_USERS);
  if (!sheet) return { success: false, error: 'Users sheet not initialized' };
  const headers = ensureUserPinRecoveryColumns(sheet);

  const data = sheet.getDataRange().getValues();

  const idxId = headers.indexOf('id');
  const idxName = headers.indexOf('name');
  const idxUsername = headers.indexOf('username');
  const idxPinHash = headers.indexOf('pin_hash');
  const idxRole = headers.indexOf('role');
  const idxBalance = headers.indexOf('balance_mad');

  const hashedInputPin = hashPin(pin);

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rowUser = String(row[idxUsername]).trim().toLowerCase();

    if (rowUser === username) {
      const storedHash = String(row[idxPinHash]).trim();
      if (storedHash.toLowerCase() === hashedInputPin.toLowerCase()) {
        const userId = String(row[idxId]);
        const role = String(row[idxRole] || 'user');
        const sessionVersion = Number(row[headers.indexOf('session_version')]) || 0;
        const pinResetRequired =
          String(row[headers.indexOf('pin_reset_required')]).toUpperCase() === 'TRUE';
        const token = generateSessionToken(userId, role, sessionVersion);

        return {
          success: true,
          token: token,
          firebaseCustomToken: isFirestoreBackendEnabled() && !pinResetRequired
            ? createFirebaseCustomToken(userId, role, sessionVersion)
            : '',
          user: {
            id: userId,
            name: String(row[idxName]),
            username: rowUser,
            role: role,
            balance_mad: Number(row[idxBalance] || 0),
            pin_reset_required: pinResetRequired
          }
        };
      } else {
        return { success: false, error: 'Code PIN incorrect.' };
      }
    }
  }

  return { success: false, error: 'Utilisateur introuvable.' };
}

function handlePinResetRequest(body) {
  const username = String(body.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
    return { success: false, error: 'Saisissez votre identifiant pour demander la réinitialisation.' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return { success: false, error: 'Service momentanément indisponible. Veuillez réessayer.' };
  }
  try {
    const sheet = getSpreadsheet().getSheetByName(CONFIG.SHEET_USERS);
    if (!sheet) throw new Error('Onglet Users introuvable.');
    const headers = ensureUserPinRecoveryColumns(sheet);
    const data = sheet.getDataRange().getValues();
    const usernameCol = headers.indexOf('username');
    const roleCol = headers.indexOf('role');
    const requestedAtCol = headers.indexOf('pin_reset_requested_at');
    const rowIndex = data.findIndex(function (row, index) {
      return index > 0 &&
        String(row[usernameCol] || '').trim().toLowerCase() === username &&
        String(row[roleCol] || '').toLowerCase() !== 'admin';
    });
    if (rowIndex > 0 && !data[rowIndex][requestedAtCol]) {
      sheet.getRange(rowIndex + 1, requestedAtCol + 1).setValue(new Date().toISOString());
      flushApplicationData();
    }
    return {
      success: true,
      message: 'Si l’identifiant correspond à un compte, une demande sera visible par l’administrateur. Contactez-le en personne pour vérifier votre identité.'
    };
  } finally {
    lock.releaseLock();
  }
}

function handleChangeTemporaryPin(session, body) {
  const newPin = String(body.newPin || '').trim();
  if (!/^\d{4,6}$/.test(newPin)) {
    return { success: false, error: 'Le nouveau PIN doit contenir 4 à 6 chiffres.' };
  }
  if (session.role === 'admin') {
    return { success: false, error: 'La récupération par PIN temporaire est réservée aux comptes clients.' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return { success: false, error: 'Service momentanément indisponible. Veuillez réessayer.' };
  }
  try {
    const sheet = getSpreadsheet().getSheetByName(CONFIG.SHEET_USERS);
    if (!sheet) throw new Error('Onglet Users introuvable.');
    const headers = ensureUserPinRecoveryColumns(sheet);
    const data = sheet.getDataRange().getValues();
    const idCol = headers.indexOf('id');
    const pinHashCol = headers.indexOf('pin_hash');
    const resetRequiredCol = headers.indexOf('pin_reset_required');
    const requestedAtCol = headers.indexOf('pin_reset_requested_at');
    const versionCol = headers.indexOf('session_version');
    const rowIndex = data.findIndex(function (row, index) {
      return index > 0 && String(row[idCol]) === session.userId;
    });
    if (rowIndex < 1) return { success: false, error: 'Compte utilisateur introuvable.' };
    if (String(data[rowIndex][resetRequiredCol]).toUpperCase() !== 'TRUE') {
      return { success: false, error: 'Aucun changement de PIN temporaire n’est requis.' };
    }
    if (String(data[rowIndex][pinHashCol]).toLowerCase() === hashPin(newPin).toLowerCase()) {
      return { success: false, error: 'Choisissez un PIN différent du PIN temporaire.' };
    }

    const newVersion = (Number(data[rowIndex][versionCol]) || 0) + 1;
    sheet.getRange(rowIndex + 1, pinHashCol + 1).setValue(hashPin(newPin));
    sheet.getRange(rowIndex + 1, resetRequiredCol + 1).setValue(false);
    sheet.getRange(rowIndex + 1, requestedAtCol + 1).setValue('');
    sheet.getRange(rowIndex + 1, versionCol + 1).setValue(newVersion);
    flushApplicationData();
    const updatedRow = sheet.getRange(rowIndex + 1, 1, 1, sheet.getLastColumn()).getValues()[0];
    if (String(updatedRow[pinHashCol]).toLowerCase() !== hashPin(newPin).toLowerCase() ||
        String(updatedRow[resetRequiredCol]).toUpperCase() === 'TRUE' ||
        updatedRow[requestedAtCol] !== '' ||
        Number(updatedRow[versionCol]) !== newVersion) {
      throw new Error('La mise à jour du PIN n’a pas pu être vérifiée.');
    }
    return {
      success: true,
      token: generateSessionToken(session.userId, session.role, newVersion),
      message: 'PIN modifié. Vous pouvez maintenant utiliser votre nouveau PIN.'
    };
  } finally {
    lock.releaseLock();
  }
}

function handleAdminResetUserPin(body) {
  const targetUserId = String(body.userId || '').trim();
  if (!targetUserId) return { success: false, error: 'Utilisateur invalide.' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return { success: false, error: 'Service momentanément indisponible. Veuillez réessayer.' };
  }
  try {
    const sheet = getSpreadsheet().getSheetByName(CONFIG.SHEET_USERS);
    if (!sheet) throw new Error('Onglet Users introuvable.');
    const headers = ensureUserPinRecoveryColumns(sheet);
    const data = sheet.getDataRange().getValues();
    const idCol = headers.indexOf('id');
    const roleCol = headers.indexOf('role');
    const pinHashCol = headers.indexOf('pin_hash');
    const requestedAtCol = headers.indexOf('pin_reset_requested_at');
    const resetRequiredCol = headers.indexOf('pin_reset_required');
    const versionCol = headers.indexOf('session_version');
    const rowIndex = data.findIndex(function (row, index) {
      return index > 0 && String(row[idCol]) === targetUserId;
    });
    if (rowIndex < 1 || String(data[rowIndex][roleCol] || '').toLowerCase() === 'admin') {
      return { success: false, error: 'Compte client introuvable.' };
    }
    if (!data[rowIndex][requestedAtCol] &&
        String(data[rowIndex][resetRequiredCol]).toUpperCase() !== 'TRUE') {
      return { success: false, error: 'Aucune demande de réinitialisation en attente pour ce compte.' };
    }

    const temporaryPin = Utilities.getUuid().replace(/\D/g, '').padEnd(6, '0').substring(0, 6);
    const newVersion = (Number(data[rowIndex][versionCol]) || 0) + 1;
    sheet.getRange(rowIndex + 1, pinHashCol + 1).setValue(hashPin(temporaryPin));
    sheet.getRange(rowIndex + 1, resetRequiredCol + 1).setValue(true);
    sheet.getRange(rowIndex + 1, versionCol + 1).setValue(newVersion);
    flushApplicationData();
    const updatedRow = sheet.getRange(rowIndex + 1, 1, 1, sheet.getLastColumn()).getValues()[0];
    if (String(updatedRow[pinHashCol]).toLowerCase() !== hashPin(temporaryPin).toLowerCase() ||
        String(updatedRow[resetRequiredCol]).toUpperCase() !== 'TRUE' ||
        Number(updatedRow[versionCol]) !== newVersion) {
      throw new Error('La réinitialisation du PIN n’a pas pu être vérifiée.');
    }
    return {
      success: true,
      name: String(data[rowIndex][headers.indexOf('name')] || ''),
      temporaryPin: temporaryPin
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Colleague Dashboard: STRICT PRIVACY ENFORCED
 * Returns ONLY the caller's balance, personal transactions, and product catalog.
 */
function handleColleagueDashboard(session) {
  const ss = getSpreadsheet();

  // 1. Get User Profile & Balance
  const usersSheet = ss.getSheetByName(CONFIG.SHEET_USERS);
  const recoveryHeaders = ensureUserPinRecoveryColumns(usersSheet);
  const usersData = usersSheet.getDataRange().getValues();
  const uHeaders = usersData[0].map(h => String(h).trim().toLowerCase());
  const uIdCol = uHeaders.indexOf('id');
  const uNameCol = uHeaders.indexOf('name');
  const uUsernameCol = uHeaders.indexOf('username');
  const uRoleCol = uHeaders.indexOf('role');
  const uBalCol = uHeaders.indexOf('balance_mad');

  let currentUser = null;
  for (let i = 1; i < usersData.length; i++) {
    const row = usersData[i];
    if (String(row[uIdCol]) === session.userId) {
      currentUser = {
        id: String(row[uIdCol]),
        name: String(row[uNameCol]),
        username: String(row[uUsernameCol]),
        role: String(row[uRoleCol] || 'user'),
        balance_mad: roundMoney(row[uBalCol] || 0),
        pin_reset_required: String(row[recoveryHeaders.indexOf('pin_reset_required')]).toUpperCase() === 'TRUE'
      };
      break;
    }
  }

  if (!currentUser) {
    return { success: false, error: 'Compte utilisateur introuvable.' };
  }
  if (currentUser.pin_reset_required) {
    return { success: true, user: currentUser, products: [], transactions: [] };
  }

  // 2. Get Products (Only active products)
  const productsSheet = ss.getSheetByName(CONFIG.SHEET_PRODUCTS);
  const pData = productsSheet.getDataRange().getValues();
  const pHeaders = pData[0].map(h => String(h).trim().toLowerCase());
  const pIdCol = pHeaders.indexOf('id');
  const pNameCol = pHeaders.indexOf('name');
  const pCatCol = pHeaders.indexOf('category');
  const pPriceCol = pHeaders.indexOf('price_mad');
  const pStockCol = pHeaders.indexOf('stock_qty');
  const pImgCol = pHeaders.indexOf('image_url');
  const pActiveCol = pHeaders.indexOf('is_active');

  const coffeeVariants = pData.slice(1).filter(function (row) {
    return row[pIdCol] && isCoffeeVariant(row[pNameCol]) &&
      (row[pActiveCol] === true || String(row[pActiveCol]).toUpperCase() === 'TRUE') &&
      (parseInt(row[pStockCol], 10) || 0) > 0;
  }).sort(function (a, b) {
    return (parseInt(b[pStockCol], 10) || 0) - (parseInt(a[pStockCol], 10) || 0);
  });
  const selectedCoffeeId = coffeeVariants.length ? String(coffeeVariants[0][pIdCol]) : '';
  const products = [];
  for (let i = 1; i < pData.length; i++) {
    const row = pData[i];
    const isActive = row[pActiveCol] === true || String(row[pActiveCol]).toUpperCase() === 'TRUE';
    const stock = parseInt(row[pStockCol], 10) || 0;
    const inventoryUnitsPerSale = getProductInventoryUnitsPerSale(row[pNameCol], row[pIdCol]);
    if (isActive && stock >= inventoryUnitsPerSale) {
      if (isCoffeeVariant(row[pNameCol]) && String(row[pIdCol]) !== selectedCoffeeId) continue;
      products.push({
        id: String(row[pIdCol]),
        name: displayProductName(row[pNameCol]),
        category: String(row[pCatCol] || 'Divers'),
        price_mad: getUserProductPrice(currentUser, row[pNameCol], row[pPriceCol]),
        stock_qty: stock,
        inventory_units_per_sale: inventoryUnitsPerSale,
        image_url: String(row[pImgCol] || '')
      });
    }
  }

  // 3. Get Personal Transactions (FILTERED STRICTLY TO CURRENT USER ONLY)
  const txSheet = ss.getSheetByName(CONFIG.SHEET_TRANSACTIONS);
  const txHeaders = transactionStatus(txSheet);
  const txData = txSheet.getDataRange().getValues();
  const tIdCol = txHeaders.indexOf('id');
  const tTimeCol = txHeaders.indexOf('timestamp');
  const tUserCol = txHeaders.indexOf('user_id');
  const tTypeCol = txHeaders.indexOf('type');
  const tItemIdCol = txHeaders.indexOf('item_id');
  const tItemNameCol = txHeaders.indexOf('item_name');
  const tQtyCol = txHeaders.indexOf('quantity');
  const tAmtCol = txHeaders.indexOf('amount_mad');
  const tNotesCol = txHeaders.indexOf('notes');
  const tPaidCol = txHeaders.indexOf('paid');
  const tStatusCol = txHeaders.indexOf('status');

  const personalTransactions = [];
  // Read in reverse to get most recent first
  for (let i = txData.length - 1; i >= 1; i--) {
    const row = txData[i];
    if (isCompletedTransaction(row, tStatusCol) &&
        String(row[tUserCol]) === session.userId) {
      personalTransactions.push({
        id: String(row[tIdCol]),
        timestamp: row[tTimeCol],
        type: String(row[tTypeCol]),
        item_id: String(row[tItemIdCol] || ''),
        item_name: displayProductName(row[tItemNameCol] || ''),
        quantity: parseInt(row[tQtyCol], 10) || 1,
        amount_mad: roundMoney(row[tAmtCol] || 0),
        notes: String(row[tNotesCol] || ''),
        paid: tPaidCol >= 0 && (row[tPaidCol] === true || String(row[tPaidCol]).toUpperCase() === 'TRUE'),
        cancel_status: String(row[txHeaders.indexOf('cancel_status')] || ''),
        cancel_requested_at: row[txHeaders.indexOf('cancel_requested_at')] || ''
      });
      if (personalTransactions.length >= 50) break; // Limit to 50 recent records
    }
  }

  return {
    success: true,
    user: currentUser,
    products: products,
    transactions: personalTransactions
  };
}

/**
 * Colleague purchase with compensating rollback for failed sheet writes.
 */
function handleColleaguePurchase(session, body) {
  const productId = String(body.productId || '').trim();
  const quantity = Number(body.quantity);
  const isPaid = body.paid === true || String(body.paid).toLowerCase() === 'true';
  const requestId = String(body.requestId || '').trim();

  if (!productId || !Number.isSafeInteger(quantity) || quantity <= 0) {
    return { success: false, error: 'Produit ou quantité invalide.' };
  }
  if (requestId && !/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
    return { success: false, error: 'Identifiant de demande invalide.' };
  }

  const lock = LockService.getScriptLock();
  try {
    const hasLock = lock.tryLock(CONFIG.LOCK_TIMEOUT_MS);
    if (!hasLock) {
      return { success: false, error: 'Serveur occupé. Veuillez réessayer dans quelques instants.' };
    }

    const ss = getSpreadsheet();
    const pSheet = ss.getSheetByName(CONFIG.SHEET_PRODUCTS);
    const uSheet = ss.getSheetByName(CONFIG.SHEET_USERS);
    const tSheet = ss.getSheetByName(CONFIG.SHEET_TRANSACTIONS);
    if (!pSheet || !uSheet || !tSheet) {
      return { success: false, error: 'Onglet Products, Users ou Transactions introuvable.' };
    }
    const statusColumn = ensureTransactionStatusColumn(tSheet);
    const statusColumnIndex = statusColumn - 1;

    // 1. Locate Product
    const pData = pSheet.getDataRange().getValues();
    const pHeaders = pData[0].map(h => String(h).trim().toLowerCase());
    const pIdCol = pHeaders.indexOf('id');
    const pNameCol = pHeaders.indexOf('name');
    const pPriceCol = pHeaders.indexOf('price_mad');
    const pStockCol = pHeaders.indexOf('stock_qty');
    const pActiveCol = pHeaders.indexOf('is_active');

    let productRowIndex = -1;
    let productObj = null;
    let originalStockValue = null;

    for (let i = 1; i < pData.length; i++) {
      if (String(pData[i][pIdCol]) === productId) {
        productRowIndex = i + 1; // 1-indexed for Sheets API
        originalStockValue = pData[i][pStockCol];
        productObj = {
          name: String(pData[i][pNameCol]),
          price: Number(pData[i][pPriceCol]),
          stock: parseInt(pData[i][pStockCol], 10) || 0,
          isActive: pData[i][pActiveCol] === true || String(pData[i][pActiveCol]).toUpperCase() === 'TRUE'
        };
        break;
      }
    }

    if (!productObj || !productObj.isActive) {
      return { success: false, error: 'Produit introuvable ou inactif.' };
    }

    const inventoryUnitsPerSale = getProductInventoryUnitsPerSale(productObj.name, productId);
    const inventoryUnitsToRemove = quantity * inventoryUnitsPerSale;

    // 2. Locate User
    const uData = uSheet.getDataRange().getValues();
    const uHeaders = uData[0].map(h => String(h).trim().toLowerCase());
    const uIdCol = uHeaders.indexOf('id');
    const uNameCol = uHeaders.indexOf('name');
    const uUsernameCol = uHeaders.indexOf('username');
    const uBalCol = uHeaders.indexOf('balance_mad');

    let userRowIndex = -1;
    let purchaseUser = null;
    let currentBalance = 0;
    let originalBalanceValue = null;

    for (let i = 1; i < uData.length; i++) {
      if (String(uData[i][uIdCol]) === session.userId) {
        userRowIndex = i + 1;
        originalBalanceValue = uData[i][uBalCol];
        purchaseUser = {
          name: String(uData[i][uNameCol] || ''),
          username: String(uData[i][uUsernameCol] || '')
        };
        currentBalance = Number(uData[i][uBalCol] || 0);
        break;
      }
    }

    if (userRowIndex === -1) {
      return { success: false, error: 'Utilisateur non trouvé.' };
    }

    // 3. Compute new values
    productObj.price = getUserProductPrice(purchaseUser, productObj.name, productObj.price);
    productObj.name = displayProductName(productObj.name);
    const totalCost = roundMoney(productObj.price * quantity);
    const newStock = productObj.stock - inventoryUnitsToRemove;
    const newBalance = isPaid
      ? currentBalance
      : roundMoney(currentBalance + totalCost);

    const txId = requestId
      ? 'TX-REQ-' + session.userId + '-' + requestId
      : 'TX-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    if (requestId) {
      const tData = tSheet.getDataRange().getValues();
      const tHeaders = tData[0].map(function (header) { return String(header).trim().toLowerCase(); });
      const tIdCol = tHeaders.indexOf('id');
      for (let i = 1; i < tData.length; i++) {
        if (tIdCol >= 0 && String(tData[i][tIdCol]) === txId) {
          const tUserCol = tHeaders.indexOf('user_id');
          const tTypeCol = tHeaders.indexOf('type');
          const tItemCol = tHeaders.indexOf('item_id');
          const tQuantityCol = tHeaders.indexOf('quantity');
          const tAmountCol = tHeaders.indexOf('amount_mad');
          const tPaidCol = tHeaders.indexOf('paid');
          const requiredColumnsPresent = [
            tUserCol, tTypeCol, tItemCol, tQuantityCol, tAmountCol, tPaidCol
          ].every(function (column) { return column >= 0; });
          const sameRequest = requiredColumnsPresent &&
            String(tData[i][tUserCol]) === session.userId &&
            String(tData[i][tTypeCol]) === 'purchase' &&
            String(tData[i][tItemCol]) === productId &&
            Number(tData[i][tQuantityCol]) === quantity &&
            roundMoney(tData[i][tAmountCol]) === totalCost &&
            (tData[i][tPaidCol] === true || String(tData[i][tPaidCol]).toUpperCase() === 'TRUE') === isPaid;
          if (!sameRequest) {
            return {
              success: false,
              retrySafe: false,
              error: 'Cette demande a déjà été utilisée pour une autre opération. Demandez à l’administrateur de vérifier avant de réessayer.'
            };
          }
          const existingStatus = String(tData[i][statusColumnIndex] || '').trim().toUpperCase();
          if (existingStatus !== 'COMPLETE') {
            return {
              success: false,
              retrySafe: existingStatus === 'FAILED',
              error: existingStatus === 'FAILED'
                ? 'La tentative précédente a été annulée. Vous pouvez réessayer.'
                : 'Cette demande est encore en attente de vérification. Ne réessayez pas; demandez à l’administrateur de vérifier les onglets Products, Users et Transactions.'
            };
          }
          return {
            success: true,
            message: 'Achat déjà enregistré.',
            transaction: {
              id: txId,
              itemName: productObj.name,
              quantity: quantity,
              amount: totalCost,
              paid: isPaid,
              newBalance: currentBalance,
              newStock: productObj.stock
            }
          };
        }
      }
    }

    if (productObj.stock < inventoryUnitsToRemove) {
      const availableSales = Math.floor(productObj.stock / inventoryUnitsPerSale);
      return {
        success: false,
        error: 'Stock insuffisant ! Il ne reste que ' + availableSales +
          (inventoryUnitsPerSale === 3 ? ' lot(s) de 3 pièces.' : ' pièce(s).')
      };
    }

    const timestamp = new Date().toISOString();
    const transactionRow = [
      txId,
      timestamp,
      session.userId,
      purchaseUser.name,
      'purchase',
      productId,
      productObj.name,
      quantity,
      totalCost,
      (isPaid ? 'Achat payé sur place' : 'Achat libre-service') +
        (inventoryUnitsPerSale > 1
          ? ' (' + inventoryUnitsToRemove + ' unités de stock retirées)'
          : ''),
      isPaid
    ];
    while (transactionRow.length < statusColumn) transactionRow.push('');
    transactionRow[statusColumnIndex] = 'PENDING';

    let stockWriteAttempted = false;
    let balanceWriteAttempted = false;
    let transactionWriteAttempted = false;
    let transactionRowIndex = -1;
    try {
      transactionWriteAttempted = true;
      tSheet.appendRow(transactionRow);
      flushApplicationData();

      let savedTransactions = tSheet.getDataRange().getValues();
      let savedHeaders = savedTransactions[0].map(function (header) {
        return String(header).trim().toLowerCase();
      });
      let savedIdCol = savedHeaders.indexOf('id');
      transactionRowIndex = savedTransactions.findIndex(function (row, index) {
        return index > 0 && savedIdCol >= 0 && String(row[savedIdCol]) === txId;
      });
      if (transactionRowIndex < 1 ||
          String(savedTransactions[transactionRowIndex][statusColumnIndex]).toUpperCase() !== 'PENDING') {
        throw new Error('Pending transaction could not be verified.');
      }

      stockWriteAttempted = true;
      pSheet.getRange(productRowIndex, pStockCol + 1).setValue(newStock);

      if (!isPaid) {
        balanceWriteAttempted = true;
        uSheet.getRange(userRowIndex, uBalCol + 1).setValue(newBalance);
      }

      flushApplicationData();
      if (pSheet.getRange(productRowIndex, pStockCol + 1).getValue() !== newStock) {
        throw new Error('Stock update could not be verified.');
      }
      if (!isPaid && uSheet.getRange(userRowIndex, uBalCol + 1).getValue() !== newBalance) {
        throw new Error('Balance update could not be verified.');
      }

      tSheet.getRange(transactionRowIndex + 1, statusColumn).setValue('COMPLETE');
      flushApplicationData();
      if (String(tSheet.getRange(transactionRowIndex + 1, statusColumn).getValue()).toUpperCase() !== 'COMPLETE') {
        throw new Error('Transaction completion could not be verified.');
      }
    } catch (purchaseError) {
      const rollbackErrors = [];
      let currentTransactions = [];
      let currentTransactionStatus = '';
      try {
        currentTransactions = tSheet.getDataRange().getValues();
        const currentHeaders = currentTransactions[0].map(function (header) {
          return String(header).trim().toLowerCase();
        });
        const currentIdCol = currentHeaders.indexOf('id');
        transactionRowIndex = currentTransactions.findIndex(function (row, index) {
          return index > 0 && currentIdCol >= 0 && String(row[currentIdCol]) === txId;
        });
        if (transactionRowIndex >= 1) {
          currentTransactionStatus = String(currentTransactions[transactionRowIndex][statusColumnIndex] || '')
            .trim().toUpperCase();
        }
      } catch (transactionReadError) {
        rollbackErrors.push('transaction status: ' + transactionReadError);
      }

      if (currentTransactionStatus === 'COMPLETE' &&
          pSheet.getRange(productRowIndex, pStockCol + 1).getValue() === newStock &&
          (isPaid || uSheet.getRange(userRowIndex, uBalCol + 1).getValue() === newBalance)) {
        Logger.log('Purchase committed despite response error for ' + txId + ': ' + purchaseError);
        return {
          success: true,
          message: 'Bssaha ! Article enregistré.',
          transaction: {
            id: txId,
            itemName: productObj.name,
            quantity: quantity,
            amount: totalCost,
            paid: isPaid,
            newBalance: newBalance,
            newStock: newStock
          }
        };
      }

      if (transactionRowIndex >= 1 && currentTransactionStatus === 'COMPLETE') {
        try {
          tSheet.getRange(transactionRowIndex + 1, statusColumn).setValue('PENDING');
          flushApplicationData();
        } catch (rollbackError) {
          rollbackErrors.push('transaction pending status: ' + rollbackError);
        }
      }

      if (stockWriteAttempted) {
        try {
          const stockCell = pSheet.getRange(productRowIndex, pStockCol + 1);
          if (stockCell.getValue() !== originalStockValue) stockCell.setValue(originalStockValue);
        } catch (rollbackError) {
          rollbackErrors.push('stock: ' + rollbackError);
        }
      }
      if (balanceWriteAttempted) {
        try {
          const balanceCell = uSheet.getRange(userRowIndex, uBalCol + 1);
          if (balanceCell.getValue() !== originalBalanceValue) balanceCell.setValue(originalBalanceValue);
        } catch (rollbackError) {
          rollbackErrors.push('solde: ' + rollbackError);
        }
      }

      try {
        flushApplicationData();
        if (stockWriteAttempted &&
            pSheet.getRange(productRowIndex, pStockCol + 1).getValue() !== originalStockValue) {
          rollbackErrors.push('stock restoration could not be verified');
        }
        if (balanceWriteAttempted &&
            uSheet.getRange(userRowIndex, uBalCol + 1).getValue() !== originalBalanceValue) {
          rollbackErrors.push('balance restoration could not be verified');
        }
        if (transactionWriteAttempted && transactionRowIndex >= 1) {
          if (stockWriteAttempted &&
              pSheet.getRange(productRowIndex, pStockCol + 1).getValue() !== originalStockValue) {
            throw new Error('Cannot cancel transaction before stock rollback is verified.');
          }
          if (balanceWriteAttempted &&
              uSheet.getRange(userRowIndex, uBalCol + 1).getValue() !== originalBalanceValue) {
            throw new Error('Cannot cancel transaction before balance rollback is verified.');
          }
          tSheet.getRange(transactionRowIndex + 1, statusColumn).setValue('FAILED');
          flushApplicationData();
          const failedTransactions = tSheet.getDataRange().getValues();
          const failedHeaders = failedTransactions[0].map(function (header) {
            return String(header).trim().toLowerCase();
          });
          const failedIdCol = failedHeaders.indexOf('id');
          const failedRowIndex = failedTransactions.findIndex(function (row, index) {
            return index > 0 && failedIdCol >= 0 && String(row[failedIdCol]) === txId;
          });
          if (failedRowIndex < 1 ||
              String(failedTransactions[failedRowIndex][statusColumnIndex]).toUpperCase() !== 'FAILED') {
            rollbackErrors.push('failed transaction status could not be verified');
          }
        }
      } catch (verificationError) {
        rollbackErrors.push('rollback verification: ' + verificationError);
      }

      Logger.log('Purchase write failed for ' + txId + ': ' + purchaseError);
      if (rollbackErrors.length) {
        Logger.log('Purchase rollback requires manual review for ' + txId + ': ' + rollbackErrors.join('; '));
        return {
          success: false,
          retrySafe: false,
          error: 'Achat non confirmé et annulation impossible à vérifier. Ne réessayez pas pour le moment; demandez à l’administrateur de vérifier le solde, le stock et Transactions. Référence: ' + txId
        };
      }
      return {
        success: false,
        retrySafe: true,
        error: 'Achat non enregistré. Le stock et le solde ont été rétablis; vous pouvez réessayer.'
      };
    }

    return {
      success: true,
      message: 'Bssaha ! Article enregistré.',
      transaction: {
        id: txId,
        itemName: productObj.name,
        quantity: quantity,
        amount: totalCost,
        paid: isPaid,
        newBalance: newBalance,
        newStock: newStock
      }
    };
  } finally {
    lock.releaseLock();
  }
}

function handleColleaguePurchaseCancellationRequest(session, body) {
  const transactionId = String(body.transactionId || '').trim();
  if (!transactionId) return { success: false, error: 'Transaction invalide.' };

  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
      return { success: false, error: 'Serveur occupé. Veuillez réessayer.' };
    }

    const sheet = getSpreadsheet().getSheetByName(CONFIG.SHEET_TRANSACTIONS);
    if (!sheet) return { success: false, error: 'Onglet Transactions introuvable.' };
    const headers = transactionStatus(sheet);
    const idCol = findTransactionColumn(headers, 'id');
    const data = sheet.getDataRange().getValues();
    const rowIndex = getTransactionRowById(data, idCol, transactionId);
    if (rowIndex < 1) return { success: false, error: 'Transaction introuvable.' };

    const userCol = findTransactionColumn(headers, 'user_id');
    const typeCol = findTransactionColumn(headers, 'type');
    const statusCol = findTransactionColumn(headers, 'status');
    const cancelStatusCol = findTransactionColumn(headers, 'cancel_status');
    const requestTimeCol = findTransactionColumn(headers, 'cancel_requested_at');
    const decidedAtCol = findTransactionColumn(headers, 'cancel_decided_at');
    const decidedByCol = findTransactionColumn(headers, 'cancel_decided_by');
    const row = data[rowIndex];
    if (String(row[userCol]) !== session.userId) {
      return { success: false, error: 'Cette transaction ne vous appartient pas.' };
    }
    if (String(row[typeCol]) !== 'purchase' || !isCompletedTransaction(row, statusCol)) {
      return { success: false, error: 'Seul un achat terminé peut faire l’objet d’une demande d’annulation.' };
    }

    const currentStatus = String(row[cancelStatusCol] || '').trim().toUpperCase();
    if (currentStatus === 'REQUESTED') {
      return { success: true, message: 'Votre demande est déjà en attente de l’administrateur.' };
    }
    if (currentStatus === 'APPROVED') {
      return { success: false, error: 'Cet achat a déjà été annulé.' };
    }

    const requestedAt = new Date().toISOString();
    sheet.getRange(rowIndex + 1, cancelStatusCol + 1).setValue('REQUESTED');
    sheet.getRange(rowIndex + 1, requestTimeCol + 1).setValue(requestedAt);
    sheet.getRange(rowIndex + 1, decidedAtCol + 1).setValue('');
    sheet.getRange(rowIndex + 1, decidedByCol + 1).setValue('');
    flushApplicationData();
    if (String(sheet.getRange(rowIndex + 1, cancelStatusCol + 1).getValue()).toUpperCase() !== 'REQUESTED') {
      throw new Error('La demande d’annulation n’a pas pu être vérifiée.');
    }
    return { success: true, message: 'Demande envoyée à l’administrateur.' };
  } finally {
    lock.releaseLock();
  }
}

function handleAdminPurchaseCancellationDecision(session, body) {
  const transactionId = String(body.transactionId || '').trim();
  const approve = body.approve === true || String(body.approve).toLowerCase() === 'true';
  if (!transactionId) return { success: false, error: 'Transaction invalide.' };

  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
      return { success: false, error: 'Serveur occupé. Veuillez réessayer.' };
    }

    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_TRANSACTIONS);
    const productsSheet = ss.getSheetByName(CONFIG.SHEET_PRODUCTS);
    const usersSheet = ss.getSheetByName(CONFIG.SHEET_USERS);
    if (!sheet || !productsSheet || !usersSheet) {
      return { success: false, error: 'Onglet Transactions, Products ou Users introuvable.' };
    }

    const statusColumn = ensureTransactionStatusColumn(sheet);
    const statusColumnIndex = statusColumn - 1;
    const headers = transactionStatus(sheet);
    const data = sheet.getDataRange().getValues();
    const idCol = findTransactionColumn(headers, 'id');
    const transactionRowIndex = getTransactionRowById(data, idCol, transactionId);
    if (transactionRowIndex < 1) return { success: false, error: 'Transaction introuvable.' };
    const originalRow = data[transactionRowIndex];
    const typeCol = findTransactionColumn(headers, 'type');
    const purchaseStatusCol = findTransactionColumn(headers, 'status');
    const cancelStatusCol = findTransactionColumn(headers, 'cancel_status');
    const requestTimeCol = findTransactionColumn(headers, 'cancel_requested_at');
    const decidedAtCol = findTransactionColumn(headers, 'cancel_decided_at');
    const decidedByCol = findTransactionColumn(headers, 'cancel_decided_by');

    if (String(originalRow[typeCol]) !== 'purchase' ||
        !isCompletedTransaction(originalRow, purchaseStatusCol)) {
      return { success: false, error: 'Seul un achat terminé peut être annulé.' };
    }

    const currentCancellationStatus = String(originalRow[cancelStatusCol] || '').trim().toUpperCase();
    if (!approve) {
      if (currentCancellationStatus !== 'REQUESTED') {
        return { success: false, error: 'Aucune demande d’annulation en attente pour cet achat.' };
      }
      sheet.getRange(transactionRowIndex + 1, cancelStatusCol + 1).setValue('REJECTED');
      sheet.getRange(transactionRowIndex + 1, decidedAtCol + 1).setValue(new Date().toISOString());
      sheet.getRange(transactionRowIndex + 1, decidedByCol + 1).setValue(session.userId);
      flushApplicationData();
      if (String(sheet.getRange(transactionRowIndex + 1, cancelStatusCol + 1).getValue()).toUpperCase() !== 'REJECTED') {
        throw new Error('Le refus de la demande n’a pas pu être vérifié.');
      }
      return { success: true, message: 'Demande d’annulation refusée.' };
    }

    const eventId = cancellationEventId(transactionId);
    const existingEventIndex = getTransactionRowById(data, idCol, eventId);
    if (existingEventIndex >= 1) {
      const eventStatus = String(data[existingEventIndex][statusColumnIndex] || '').toUpperCase();
      if (eventStatus === 'COMPLETE') {
        return { success: true, message: 'Cette transaction a déjà été annulée.' };
      }
      if (eventStatus !== 'FAILED') {
        return {
          success: false,
          retrySafe: false,
          error: 'Une annulation est déjà en cours ou nécessite une vérification manuelle. Vérifiez Products, Users et Transactions.'
        };
      }
    }
    if (currentCancellationStatus === 'APPROVED') {
      return {
        success: false,
        retrySafe: false,
        error: 'Cet achat est déjà marqué comme annulé. Vérifiez l’événement d’annulation avant toute nouvelle action.'
      };
    }

    const productIdCol = findTransactionColumn(headers, 'item_id');
    const quantityCol = findTransactionColumn(headers, 'quantity');
    const amountCol = findTransactionColumn(headers, 'amount_mad');
    const userIdCol = findTransactionColumn(headers, 'user_id');
    const userNameCol = findTransactionColumn(headers, 'user_name');
    const itemNameCol = findTransactionColumn(headers, 'item_name');
    const notesCol = findTransactionColumn(headers, 'notes');
    const paidCol = findTransactionColumn(headers, 'paid');
    const productId = String(originalRow[productIdCol]);
    const quantity = Number(originalRow[quantityCol]);
    const amount = roundMoney(originalRow[amountCol]);
    const wasPaid = originalRow[paidCol] === true ||
      String(originalRow[paidCol]).toUpperCase() === 'TRUE';
    if (!productId || !Number.isSafeInteger(quantity) || quantity <= 0 ||
        !Number.isFinite(amount) || amount <= 0) {
      return { success: false, error: 'Les informations de l’achat sont invalides; vérification manuelle requise.' };
    }

    const productData = productsSheet.getDataRange().getValues();
    const productHeaders = productData[0].map(function (header) { return String(header).trim().toLowerCase(); });
    const pIdCol = productHeaders.indexOf('id');
    const pStockCol = productHeaders.indexOf('stock_qty');
    const productIndex = productData.findIndex(function (row, index) {
      return index > 0 && String(row[pIdCol]) === productId;
    });
    if (productIndex < 1 || pStockCol < 0) {
      return { success: false, error: 'Produit ou colonne stock introuvable.' };
    }

    const userData = usersSheet.getDataRange().getValues();
    const userHeaders = userData[0].map(function (header) { return String(header).trim().toLowerCase(); });
    const uIdCol = userHeaders.indexOf('id');
    const uBalanceCol = userHeaders.indexOf('balance_mad');
    const userIndex = userData.findIndex(function (row, index) {
      return index > 0 && String(row[uIdCol]) === String(originalRow[userIdCol]);
    });
    if (userIndex < 1 || (!wasPaid && uBalanceCol < 0)) {
      return { success: false, error: 'Utilisateur ou colonne de solde introuvable.' };
    }

    const inventoryUnits = getProductInventoryUnitsPerSale(originalRow[itemNameCol], productId) * quantity;
    const originalStockValue = productData[productIndex][pStockCol];
    const currentStock = parseInt(originalStockValue, 10) || 0;
    const restoredStock = currentStock + inventoryUnits;
    if (!Number.isSafeInteger(restoredStock)) {
      return { success: false, error: 'Le stock après annulation dépasse la limite autorisée.' };
    }
    const originalBalanceValue = wasPaid ? null : userData[userIndex][uBalanceCol];
    const currentBalance = wasPaid ? 0 : Number(originalBalanceValue || 0);
    const restoredBalance = wasPaid ? 0 : roundMoney(currentBalance - amount);
    const originalCancellationStatus = originalRow[cancelStatusCol] || '';
    const originalRequestedAt = originalRow[requestTimeCol] || '';
    const originalDecidedAt = originalRow[decidedAtCol] || '';
    const originalDecidedBy = originalRow[decidedByCol] || '';
    const cancellationRow = new Array(sheet.getLastColumn()).fill('');
    cancellationRow[idCol] = eventId;
    cancellationRow[findTransactionColumn(headers, 'timestamp')] = new Date().toISOString();
    cancellationRow[userIdCol] = originalRow[userIdCol];
    cancellationRow[userNameCol] = originalRow[userNameCol];
    cancellationRow[typeCol] = 'purchase_cancellation';
    cancellationRow[productIdCol] = productId;
    cancellationRow[itemNameCol] = originalRow[itemNameCol];
    cancellationRow[quantityCol] = quantity;
    cancellationRow[amountCol] = amount;
    cancellationRow[notesCol] = 'Annulation de la transaction ' + transactionId;
    cancellationRow[paidCol] = wasPaid;
    cancellationRow[statusColumnIndex] = 'PENDING';

    let eventRowIndex = existingEventIndex;
    let eventWriteAttempted = false;
    let stockWriteAttempted = false;
    let balanceWriteAttempted = false;
    let originalRowUpdated = false;
    try {
      if (existingEventIndex >= 1) {
        eventRowIndex = existingEventIndex;
        eventWriteAttempted = true;
        sheet.getRange(eventRowIndex + 1, 1, 1, cancellationRow.length).setValues([cancellationRow]);
      } else {
        eventWriteAttempted = true;
        sheet.appendRow(cancellationRow);
        flushApplicationData();
        const refreshed = sheet.getDataRange().getValues();
        eventRowIndex = getTransactionRowById(refreshed, idCol, eventId);
      }
      flushApplicationData();
      if (eventRowIndex < 1 ||
          String(sheet.getRange(eventRowIndex + 1, statusColumn).getValue()).toUpperCase() !== 'PENDING') {
        throw new Error('L’événement d’annulation en attente n’a pas pu être vérifié.');
      }

      stockWriteAttempted = true;
      productsSheet.getRange(productIndex + 1, pStockCol + 1).setValue(restoredStock);
      if (!wasPaid) {
        balanceWriteAttempted = true;
        usersSheet.getRange(userIndex + 1, uBalanceCol + 1).setValue(restoredBalance);
      }
      flushApplicationData();
      if (productsSheet.getRange(productIndex + 1, pStockCol + 1).getValue() !== restoredStock) {
        throw new Error('Le retour du stock n’a pas pu être vérifié.');
      }
      if (!wasPaid && usersSheet.getRange(userIndex + 1, uBalanceCol + 1).getValue() !== restoredBalance) {
        throw new Error('La correction du solde n’a pas pu être vérifiée.');
      }

      originalRowUpdated = true;
      sheet.getRange(transactionRowIndex + 1, cancelStatusCol + 1).setValue('APPROVED');
      sheet.getRange(transactionRowIndex + 1, decidedAtCol + 1).setValue(new Date().toISOString());
      sheet.getRange(transactionRowIndex + 1, decidedByCol + 1).setValue(session.userId);
      flushApplicationData();
      sheet.getRange(eventRowIndex + 1, statusColumn).setValue('COMPLETE');
      flushApplicationData();
      if (String(sheet.getRange(eventRowIndex + 1, statusColumn).getValue()).toUpperCase() !== 'COMPLETE') {
        throw new Error('La confirmation de l’annulation n’a pas pu être vérifiée.');
      }
      return {
        success: true,
        message: wasPaid
          ? 'Achat annulé. Le stock est rétabli et le remboursement est déduit de la caisse.'
          : 'Achat annulé. Le stock est rétabli et la dette du client est corrigée.',
        transactionId: transactionId
      };
    } catch (cancellationError) {
      const rollbackErrors = [];
      if (eventWriteAttempted) {
        try {
          const currentData = sheet.getDataRange().getValues();
          eventRowIndex = getTransactionRowById(currentData, idCol, eventId);
          if (eventRowIndex >= 1 &&
              String(currentData[eventRowIndex][statusColumnIndex]).toUpperCase() === 'COMPLETE' &&
              String(sheet.getRange(transactionRowIndex + 1, cancelStatusCol + 1).getValue()).toUpperCase() === 'APPROVED' &&
              productsSheet.getRange(productIndex + 1, pStockCol + 1).getValue() === restoredStock &&
              (wasPaid || usersSheet.getRange(userIndex + 1, uBalanceCol + 1).getValue() === restoredBalance)) {
            Logger.log('Purchase cancellation completed despite response error for ' + transactionId + ': ' + cancellationError);
            return {
              success: true,
              message: wasPaid
                ? 'Achat annulé. Le stock est rétabli et le remboursement est déduit de la caisse.'
                : 'Achat annulé. Le stock est rétabli et la dette du client est corrigée.',
              transactionId: transactionId
            };
          }
          const eventStatusCell = eventRowIndex >= 1
            ? sheet.getRange(eventRowIndex + 1, statusColumn)
            : null;
          if (eventStatusCell && String(eventStatusCell.getValue()).toUpperCase() === 'COMPLETE') {
            eventStatusCell.setValue('PENDING');
            flushApplicationData();
            if (String(eventStatusCell.getValue()).toUpperCase() !== 'PENDING') {
              rollbackErrors.push('remise en attente de l’événement d’annulation non vérifiée');
            }
          }
        } catch (rollbackError) {
          rollbackErrors.push('lecture ou statut de l’événement: ' + rollbackError);
        }
      }
      if (originalRowUpdated) {
        try {
          sheet.getRange(transactionRowIndex + 1, cancelStatusCol + 1).setValue(originalCancellationStatus);
          sheet.getRange(transactionRowIndex + 1, requestTimeCol + 1).setValue(originalRequestedAt);
          sheet.getRange(transactionRowIndex + 1, decidedAtCol + 1).setValue(originalDecidedAt);
          sheet.getRange(transactionRowIndex + 1, decidedByCol + 1).setValue(originalDecidedBy);
        } catch (rollbackError) {
          rollbackErrors.push('statut de l’achat: ' + rollbackError);
        }
      }
      if (stockWriteAttempted) {
        try {
          const stockCell = productsSheet.getRange(productIndex + 1, pStockCol + 1);
          if (stockCell.getValue() !== originalStockValue) stockCell.setValue(originalStockValue);
        } catch (rollbackError) {
          rollbackErrors.push('stock: ' + rollbackError);
        }
      }
      if (balanceWriteAttempted) {
        try {
          const balanceCell = usersSheet.getRange(userIndex + 1, uBalanceCol + 1);
          if (balanceCell.getValue() !== originalBalanceValue) balanceCell.setValue(originalBalanceValue);
        } catch (rollbackError) {
          rollbackErrors.push('solde: ' + rollbackError);
        }
      }
      try {
        flushApplicationData();
        if (stockWriteAttempted &&
            productsSheet.getRange(productIndex + 1, pStockCol + 1).getValue() !== originalStockValue) {
          rollbackErrors.push('restauration du stock non vérifiée');
        }
        if (balanceWriteAttempted &&
            usersSheet.getRange(userIndex + 1, uBalanceCol + 1).getValue() !== originalBalanceValue) {
          rollbackErrors.push('restauration du solde non vérifiée');
        }
        if (originalRowUpdated) {
          const restoredOriginal = sheet.getRange(transactionRowIndex + 1, 1, 1, sheet.getLastColumn()).getValues()[0];
          if (restoredOriginal[cancelStatusCol] !== originalCancellationStatus ||
              restoredOriginal[requestTimeCol] !== originalRequestedAt ||
              restoredOriginal[decidedAtCol] !== originalDecidedAt ||
              restoredOriginal[decidedByCol] !== originalDecidedBy) {
            rollbackErrors.push('restauration du statut de demande non vérifiée');
          }
        }
        if (!rollbackErrors.length && eventWriteAttempted && eventRowIndex >= 1) {
          sheet.getRange(eventRowIndex + 1, statusColumn).setValue('FAILED');
          flushApplicationData();
          if (String(sheet.getRange(eventRowIndex + 1, statusColumn).getValue()).toUpperCase() !== 'FAILED') {
            rollbackErrors.push('annulation FAILED non vérifiée');
          }
        } else if (eventWriteAttempted && eventRowIndex < 1 && !rollbackErrors.length) {
          const verifyData = sheet.getDataRange().getValues();
          eventRowIndex = getTransactionRowById(verifyData, idCol, eventId);
          if (eventRowIndex >= 1) {
            rollbackErrors.push('l’événement d’annulation existe mais son statut n’a pas pu être lu');
          }
        }
      } catch (rollbackError) {
        rollbackErrors.push('vérification de l’annulation: ' + rollbackError);
      }
      Logger.log('Purchase cancellation failed for ' + transactionId + ': ' + cancellationError);
      if (rollbackErrors.length) {
        Logger.log('Purchase cancellation rollback requires manual review for ' + transactionId + ': ' + rollbackErrors.join('; '));
        return {
          success: false,
          retrySafe: false,
          error: 'Annulation non confirmée et retour arrière impossible à vérifier. Vérifiez Products, Users et Transactions avant toute nouvelle action. Référence: ' + transactionId
        };
      }
      return {
        success: false,
        retrySafe: true,
        error: 'Annulation non effectuée; les valeurs précédentes ont été rétablies. Vous pouvez réessayer.'
      };
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Admin Overview (User balances, total office debt, full inventory metrics)
 */
function handleAdminOverview() {
  const ss = getSpreadsheet();

  // Users overview
  const uSheet = ss.getSheetByName(CONFIG.SHEET_USERS);
  const uHeaders = ensureUserPinRecoveryColumns(uSheet);
  const uData = uSheet.getDataRange().getValues();
  const uIdCol = uHeaders.indexOf('id');
  const uNameCol = uHeaders.indexOf('name');
  const uUsernameCol = uHeaders.indexOf('username');
  const uRoleCol = uHeaders.indexOf('role');
  const uBalCol = uHeaders.indexOf('balance_mad');
  const uCreatedCol = uHeaders.indexOf('created_at');
  const resetRequiredCol = uHeaders.indexOf('pin_reset_required');
  const resetRequestedCol = uHeaders.indexOf('pin_reset_requested_at');

  const users = [];
  const pinResetRequests = [];
  let totalOfficeDebt = 0;
  for (let i = 1; i < uData.length; i++) {
    const row = uData[i];
    if (row[uIdCol]) {
      if (String(row[uRoleCol] || '').toLowerCase() !== 'admin' &&
          (row[resetRequestedCol] || String(row[resetRequiredCol]).toUpperCase() === 'TRUE')) {
        pinResetRequests.push({
          id: String(row[uIdCol]),
          name: String(row[uNameCol] || ''),
          username: String(row[uUsernameCol] || ''),
          resetRequired: String(row[resetRequiredCol]).toUpperCase() === 'TRUE'
        });
      }
      const balance = roundMoney(row[uBalCol] || 0);
      if (balance > 0) totalOfficeDebt += balance;

      users.push({
        id: String(row[uIdCol]),
        name: String(row[uNameCol]),
        username: String(row[uUsernameCol]),
        role: String(row[uRoleCol] || 'user'),
        balance_mad: balance,
        created_at: row[uCreatedCol]
      });
    }
  }

  // Products overview
  const pSheet = ss.getSheetByName(CONFIG.SHEET_PRODUCTS);
  const pData = pSheet.getDataRange().getValues();
  const pHeaders = pData[0].map(h => String(h).trim().toLowerCase());
  const pIdCol = pHeaders.indexOf('id');
  const pNameCol = pHeaders.indexOf('name');
  const pCatCol = pHeaders.indexOf('category');
  const pPriceCol = pHeaders.indexOf('price_mad');
  const pStockCol = pHeaders.indexOf('stock_qty');
  const pImgCol = pHeaders.indexOf('image_url');
  const pActiveCol = pHeaders.indexOf('is_active');

  const coffeeVariants = pData.slice(1).filter(function (row) {
    return row[pIdCol] && isCoffeeVariant(row[pNameCol]) &&
      (row[pActiveCol] === true || String(row[pActiveCol]).toUpperCase() === 'TRUE');
  }).sort(function (a, b) {
    return (parseInt(b[pStockCol], 10) || 0) - (parseInt(a[pStockCol], 10) || 0);
  });
  const selectedCoffeeId = coffeeVariants.length ? String(coffeeVariants[0][pIdCol]) : '';
  const products = [];
  let lowStockCount = 0;
  for (let i = 1; i < pData.length; i++) {
    const row = pData[i];
    if (row[pIdCol]) {
      const stock = parseInt(row[pStockCol], 10) || 0;
      const isActive = row[pActiveCol] === true || String(row[pActiveCol]).toUpperCase() === 'TRUE';
      const includeProduct = row[pIdCol] && isActive &&
        (!isCoffeeVariant(row[pNameCol]) || String(row[pIdCol]) === selectedCoffeeId);
      if (includeProduct && stock <= 3) lowStockCount++;

      if (includeProduct) products.push({
        id: String(row[pIdCol]),
        name: displayProductName(row[pNameCol]),
        category: String(row[pCatCol] || 'Divers'),
        price_mad: Number(row[pPriceCol] || 0),
        stock_qty: stock,
        image_url: String(row[pImgCol] || ''),
        is_active: isActive
      });
    }
  }

  // Recent 100 Transactions across the office
  const tSheet = ss.getSheetByName(CONFIG.SHEET_TRANSACTIONS);
  const tHeaders = transactionStatus(tSheet);
  const tData = tSheet.getDataRange().getValues();
  const tIdCol = tHeaders.indexOf('id');
  const tTimeCol = tHeaders.indexOf('timestamp');
  const tUserCol = tHeaders.indexOf('user_id');
  const tUserNameCol = tHeaders.indexOf('user_name');
  const tTypeCol = tHeaders.indexOf('type');
  const tItemIdCol = tHeaders.indexOf('item_id');
  const tItemNameCol = tHeaders.indexOf('item_name');
  const tQtyCol = tHeaders.indexOf('quantity');
  const tAmtCol = tHeaders.indexOf('amount_mad');
  const tNotesCol = tHeaders.indexOf('notes');
  const tPaidCol = tHeaders.indexOf('paid');
  const tStatusCol = tHeaders.indexOf('status');
  const tCancelStatusCol = tHeaders.indexOf('cancel_status');

  const recentTransactions = [];
  for (let i = tData.length - 1; i >= 1; i--) {
    const row = tData[i];
    if (!isCompletedTransaction(row, tStatusCol)) continue;
    const transactionType = String(row[tTypeCol] || '');
    const isPaidPurchase = transactionType === 'purchase' &&
      (tPaidCol >= 0
        ? row[tPaidCol] === true || String(row[tPaidCol]).toUpperCase() === 'TRUE'
        : row[10] === true || String(row[10]).toUpperCase() === 'TRUE');
    const hasPendingCancellation = transactionType === 'purchase' &&
      String(row[tCancelStatusCol] || '').toUpperCase() === 'REQUESTED';
    if (row[tIdCol] && (recentTransactions.length < 100 || hasPendingCancellation)) {
      recentTransactions.push({
        id: String(row[tIdCol]),
        timestamp: row[tTimeCol],
        user_id: String(row[tUserCol]),
        user_name: String(row[tUserNameCol]),
        type: transactionType,
        item_id: String(row[tItemIdCol] || ''),
        item_name: displayProductName(row[tItemNameCol] || ''),
        quantity: parseInt(row[tQtyCol], 10) || 1,
        amount_mad: roundMoney(row[tAmtCol] || 0),
        notes: String(row[tNotesCol] || ''),
        paid: isPaidPurchase,
        cancel_status: String(row[tHeaders.indexOf('cancel_status')] || ''),
        cancel_requested_at: row[tHeaders.indexOf('cancel_requested_at')] || '',
        cancel_decided_at: row[tHeaders.indexOf('cancel_decided_at')] || ''
      });
    }
  }

  const settingsSheet = getOrCreateSettingsSheet();
  const settingsData = settingsSheet.getDataRange().getValues();
  const openingCashRow = settingsData.find(function (row, index) {
    return index > 0 && String(row[0]) === 'opening_cash_mad';
  });
  const openingCashTimestampRow = settingsData.find(function (row, index) {
    return index > 0 && String(row[0]) === 'opening_cash_timestamp';
  });
  const openingCashSet = !!openingCashRow && openingCashRow[1] !== '';
  const openingCash = openingCashSet ? Number(openingCashRow[1]) : 0;
  const parsedOpeningCashTimestamp = openingCashTimestampRow
    ? new Date(openingCashTimestampRow[1]).getTime()
    : 0;
  const openingCashTimestamp = isFinite(parsedOpeningCashTimestamp) ? parsedOpeningCashTimestamp : 0;
  let cashReceived = 0;
  for (let i = 1; i < tData.length; i++) {
    const row = tData[i];
    if (!isCompletedTransaction(row, tStatusCol)) continue;
    const transactionType = String(row[tTypeCol] || '');
    const isPaidPurchase = transactionType === 'purchase' &&
      (tPaidCol >= 0
        ? row[tPaidCol] === true || String(row[tPaidCol]).toUpperCase() === 'TRUE'
        : row[10] === true || String(row[10]).toUpperCase() === 'TRUE');
    const transactionTimestamp = new Date(row[tTimeCol]).getTime();
    if (transactionTimestamp >= openingCashTimestamp) {
      if (transactionType === 'payment' || isPaidPurchase) {
        cashReceived += Number(row[tAmtCol] || 0);
      } else if (transactionType === 'inventory_purchase') {
        cashReceived -= Number(row[tAmtCol] || 0);
      } else if (transactionType === 'purchase_cancellation' &&
          tPaidCol >= 0 &&
          (row[tPaidCol] === true || String(row[tPaidCol]).toUpperCase() === 'TRUE')) {
        cashReceived -= Number(row[tAmtCol] || 0);
      }
    }
  }

  return {
    success: true,
    metrics: {
      totalOfficeDebt: Math.round(totalOfficeDebt * 100) / 100,
      currentEarnings: Math.round((openingCash + cashReceived) * 100) / 100,
      openingCashSet: openingCashSet,
      userCount: users.filter(function (user) {
        return user.role !== 'admin' && String(user.username || '').trim() !== '';
      }).length,
      productCount: products.length,
      lowStockCount: lowStockCount
    },
    users: users,
    pinResetRequests: pinResetRequests,
    products: products,
    transactions: recentTransactions
  };
}

/**
 * Admin Restock: Adjust product stock quantity and log transaction
 */
function handleAdminRestock(session, body) {
  const productId = String(body.productId || '').trim();
  const addedQty = Number(body.addedQty);

  if (!productId || !Number.isSafeInteger(addedQty) || addedQty === 0) {
    return { success: false, error: 'Quantité de correction invalide.' };
  }

  const lock = LockService.getScriptLock();
  try {
    const hasLock = lock.tryLock(CONFIG.LOCK_TIMEOUT_MS);
    if (!hasLock) return { success: false, error: 'Serveur occupé.' };

    const ss = getSpreadsheet();
    const pSheet = ss.getSheetByName(CONFIG.SHEET_PRODUCTS);
    const tSheet = ss.getSheetByName(CONFIG.SHEET_TRANSACTIONS);

    const pData = pSheet.getDataRange().getValues();
    const pHeaders = pData[0].map(h => String(h).trim().toLowerCase());
    const pIdCol = pHeaders.indexOf('id');
    const pNameCol = pHeaders.indexOf('name');
    const pStockCol = pHeaders.indexOf('stock_qty');

    let pRowIndex = -1;
    let pName = '';
    let currentStock = 0;

    for (let i = 1; i < pData.length; i++) {
      if (String(pData[i][pIdCol]) === productId) {
        pRowIndex = i + 1;
        pName = String(pData[i][pNameCol]);
        currentStock = parseInt(pData[i][pStockCol], 10) || 0;
        break;
      }
    }

    if (pRowIndex === -1) return { success: false, error: 'Produit introuvable.' };

    const newStock = currentStock + addedQty;
    if (!Number.isSafeInteger(newStock) || newStock < 0) {
      return { success: false, error: 'Le stock corrigé doit être un entier positif ou nul.' };
    }
    pSheet.getRange(pRowIndex, pStockCol + 1).setValue(newStock);

    const adjustmentLabel = addedQty > 0 ? 'Réapprovisionnement' : 'Correction de stock';
    const txId = 'TX-RST-' + Date.now();
    tSheet.appendRow([
      txId,
      new Date().toISOString(),
      session.userId,
      'Admin Restock',
      'restock',
      productId,
      pName,
      addedQty,
      0,
      adjustmentLabel + ': ' + (addedQty > 0 ? '+' : '') + addedQty + ' (Nouveau stock: ' + newStock + ')'
    ]);
    flushApplicationData();

    return {
      success: true,
      message: addedQty > 0 ? 'Stock réapprovisionné.' : 'Correction du stock enregistrée.',
      productId: productId,
      newStock: newStock
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Admin: Record a paid inventory purchase, increase stock, and track its cash cost.
 */
function handleAdminPurchaseInventory(session, body) {
  const productId = String(body.productId || '').trim();
  const quantity = Number(body.quantity);
  const cost = roundMoney(body.cost);
  const notes = String(body.notes || '').trim().slice(0, 200);

  if (!productId || !Number.isSafeInteger(quantity) || quantity <= 0 ||
      !isFinite(cost) || cost <= 0) {
    return { success: false, error: 'Produit valide, quantité entière positive et coût total supérieur à zéro requis.' };
  }

  const lock = LockService.getScriptLock();
  try {
    const hasLock = lock.tryLock(CONFIG.LOCK_TIMEOUT_MS);
    if (!hasLock) return { success: false, error: 'Serveur occupé.' };

    const ss = getSpreadsheet();
    const pSheet = ss.getSheetByName(CONFIG.SHEET_PRODUCTS);
    const tSheet = ss.getSheetByName(CONFIG.SHEET_TRANSACTIONS);
    if (!pSheet || !tSheet) return { success: false, error: 'Onglet Products ou Transactions introuvable.' };

    const pData = pSheet.getDataRange().getValues();
    if (!pData.length) return { success: false, error: 'Onglet Products vide.' };
    const pHeaders = pData[0].map(function (header) { return String(header).trim().toLowerCase(); });
    const pIdCol = pHeaders.indexOf('id');
    const pNameCol = pHeaders.indexOf('name');
    const pStockCol = pHeaders.indexOf('stock_qty');
    if ([pIdCol, pNameCol, pStockCol].some(function (column) { return column < 0; })) {
      return { success: false, error: 'Schéma de produits invalide.' };
    }

    let productRow = -1;
    let productName = '';
    let currentStock = 0;
    for (let i = 1; i < pData.length; i++) {
      if (String(pData[i][pIdCol]) === productId) {
        productRow = i + 1;
        productName = String(pData[i][pNameCol]);
        currentStock = parseInt(pData[i][pStockCol], 10) || 0;
        break;
      }
    }
    if (productRow < 0) return { success: false, error: 'Produit introuvable.' };

    const newStock = currentStock + quantity;
    if (!Number.isSafeInteger(newStock)) {
      return { success: false, error: 'La quantité totale dépasse la limite autorisée.' };
    }

    const txId = 'TX-INV-' + Date.now();
    const description = 'Achat de stock' + (notes ? ': ' + notes : '');
    pSheet.getRange(productRow, pStockCol + 1).setValue(newStock);
    tSheet.appendRow([
      txId,
      new Date().toISOString(),
      session.userId,
      'Admin',
      'inventory_purchase',
      productId,
      productName,
      quantity,
      cost,
      description
    ]);
    flushApplicationData();

    return {
      success: true,
      message: 'Achat de stock enregistré et coût déduit de la caisse.',
      productId: productId,
      newStock: newStock,
      cost: cost
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Admin Settle: Record colleague cash payment and reduce/clear debt
 */
function handleAdminSettle(session, body) {
  const targetUserId = String(body.userId || '').trim();
  const amountPaid = roundMoney(body.amount);
  const notes = String(body.notes || 'Paiement en espèces réglé').trim();

  if (!targetUserId || !isFinite(amountPaid) || amountPaid === 0) {
    return { success: false, error: 'Le montant doit être différent de zéro et l’utilisateur valide.' };
  }

  const lock = LockService.getScriptLock();
  try {
    const hasLock = lock.tryLock(CONFIG.LOCK_TIMEOUT_MS);
    if (!hasLock) return { success: false, error: 'Serveur occupé.' };

    const ss = getSpreadsheet();
    const uSheet = ss.getSheetByName(CONFIG.SHEET_USERS);
    const tSheet = ss.getSheetByName(CONFIG.SHEET_TRANSACTIONS);

    const uData = uSheet.getDataRange().getValues();
    const uHeaders = uData[0].map(h => String(h).trim().toLowerCase());
    const uIdCol = uHeaders.indexOf('id');
    const uNameCol = uHeaders.indexOf('name');
    const uBalCol = uHeaders.indexOf('balance_mad');

    let uRowIndex = -1;
    let userName = '';
    let currentBalance = 0;

    for (let i = 1; i < uData.length; i++) {
      if (String(uData[i][uIdCol]) === targetUserId) {
        uRowIndex = i + 1;
        userName = String(uData[i][uNameCol]);
        currentBalance = Number(uData[i][uBalCol] || 0);
        break;
      }
    }

    if (uRowIndex === -1) return { success: false, error: 'Utilisateur introuvable.' };

    const newBalance = roundMoney(currentBalance - amountPaid);
    uSheet.getRange(uRowIndex, uBalCol + 1).setValue(newBalance);

    // Log payment transaction
    const txId = 'TX-PAY-' + Date.now();
    tSheet.appendRow([
      txId,
      new Date().toISOString(),
      targetUserId,
      userName,
      'payment',
      '',
      amountPaid > 0 ? 'Règlement dette' : 'Correction paiement',
      1,
      amountPaid,
      notes
    ]);
    flushApplicationData();

    return {
      success: true,
      message: (amountPaid > 0 ? 'Règlement de ' : 'Correction de ') +
        Math.abs(amountPaid).toFixed(2) + ' DH enregistré pour ' + userName,
      userId: targetUserId,
      newBalance: newBalance
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Set the one-time starting cash balance for the earnings total.
 */
function handleAdminSetOpeningCash(body) {
  if (body.amount === undefined || String(body.amount).trim() === '') {
    return { success: false, error: 'Veuillez saisir un montant initial valide (zéro ou plus).' };
  }
  const amount = Number(body.amount);
  if (!isFinite(amount) || amount < 0) {
    return { success: false, error: 'Veuillez saisir un montant initial valide (zéro ou plus).' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return { success: false, error: 'Serveur occupé. Veuillez réessayer.' };
  }
  try {
    const sheet = getOrCreateSettingsSheet();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === 'opening_cash_mad') {
        const timestampRow = data.findIndex(function (row, index) {
          return index > 0 && String(row[0]) === 'opening_cash_timestamp';
        });
        if (timestampRow >= 1) {
          sheet.getRange(timestampRow + 1, 2).setValue(new Date().toISOString());
        }
        sheet.getRange(i + 1, 2).setValue(Math.round(amount * 100) / 100);
        flushApplicationData();
        return { success: true, message: 'Montant compté enregistré.' };
      }
    }

    return { success: false, error: 'Paramètre de caisse initial introuvable. Relancez setupDatabase.' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Admin: Add New Product
 */
function handleAdminAddProduct(session, body) {
  const name = String(body.name || '').trim();
  const category = String(body.category || 'Snacks').trim();
  const price = Number(body.price_mad);
  const stock = body.stock_qty === undefined || body.stock_qty === ''
    ? 0
    : Number(body.stock_qty);
  const rawCost = body.cost === undefined || body.cost === ''
    ? 0
    : Number(body.cost);
  const cost = roundMoney(rawCost);
  const imageUrl = String(body.image_url || '🍫').trim();

  if (!name || !category || !isFinite(price) || price < 0 ||
      !Number.isSafeInteger(stock) || stock < 0 || !isFinite(rawCost) || rawCost < 0 ||
      (cost > 0 && stock === 0)) {
    return { success: false, error: 'Nom, catégorie, prix, stock initial et coût total valides requis.' };
  }
  if (!isValidProductImageValue(imageUrl)) {
    return { success: false, error: 'Utilisez une URL HTTPS publique valide ou un emoji comme image.' };
  }

  const lock = LockService.getScriptLock();
  try {
    const hasLock = lock.tryLock(CONFIG.LOCK_TIMEOUT_MS);
    if (!hasLock) return { success: false, error: 'Serveur occupé. Veuillez réessayer.' };

    const ss = getSpreadsheet();
    const pSheet = ss.getSheetByName(CONFIG.SHEET_PRODUCTS);
    if (!pSheet) return { success: false, error: 'Onglet Products introuvable.' };
    const tSheet = cost > 0 ? ss.getSheetByName(CONFIG.SHEET_TRANSACTIONS) : null;
    if (cost > 0 && !tSheet) return { success: false, error: 'Onglet Transactions introuvable.' };
    const id = 'prod_' + Date.now();

    pSheet.appendRow([
      id,
      name,
      category,
      price,
      stock,
      imageUrl,
      true
    ]);

    if (cost > 0) {
      tSheet.appendRow([
        'TX-INV-' + Date.now(),
        new Date().toISOString(),
        session.userId,
        'Admin',
        'inventory_purchase',
        id,
        name,
        stock,
        cost,
        'Achat de stock initial (nouveau produit)'
      ]);
    }
    flushApplicationData();

    return {
      success: true,
      message: cost > 0
        ? 'Produit ajouté; coût du stock initial déduit de la caisse.'
        : 'Produit ajouté avec succès !',
      id: id,
      cost: cost
    };
  } finally {
    lock.releaseLock();
  }
}

function handleAdminUpdateProductImage(body) {
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) return { success: false, error: 'Serveur occupé.' };
    const result = handleAdminUpdateProductImageLocked(body);
    if (result.success) flushApplicationData();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function handleAdminUpdateProductImageLocked(body) {
  const productId = String(body.productId || '').trim();
  const imageUrl = String(body.image_url || '').trim();
  if (!productId || !isValidProductImageValue(imageUrl)) {
    return { success: false, error: 'Produit ou URL d’image invalide. Utilisez une URL HTTPS publique ou un emoji.' };
  }

  const sheet = getSpreadsheet().getSheetByName(CONFIG.SHEET_PRODUCTS);
  if (!sheet) return { success: false, error: 'Onglet Products introuvable.' };
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(function (header) { return String(header).trim().toLowerCase(); });
  const idCol = headers.indexOf('id');
  const imageCol = headers.indexOf('image_url');
  if (idCol < 0 || imageCol < 0) {
    return { success: false, error: 'Schéma de produits invalide.' };
  }

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === productId) {
      sheet.getRange(i + 1, imageCol + 1).setValue(imageUrl);
      return { success: true, message: 'Image du produit mise à jour.' };
    }
  }
  return { success: false, error: 'Produit introuvable.' };
}

function handleAdminUpdateProductDetails(body) {
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) return { success: false, error: 'Serveur occupé.' };
    const result = handleAdminUpdateProductDetailsLocked(body);
    if (result.success) flushApplicationData();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function handleAdminUpdateProductDetailsLocked(body) {
  const productId = String(body.productId || '').trim();
  const name = String(body.name || '').trim();
  const category = String(body.category || '').trim();
  const price = Number(body.price_mad);
  if (!productId || !name || name.length > 120 || !category || category.length > 60 ||
      !isFinite(price) || price < 0) {
    return { success: false, error: 'Nom, catégorie et prix de vente valides requis.' };
  }

  const sheet = getSpreadsheet().getSheetByName(CONFIG.SHEET_PRODUCTS);
  if (!sheet) return { success: false, error: 'Onglet Products introuvable.' };
  const data = sheet.getDataRange().getValues();
  if (!data.length) return { success: false, error: 'Onglet Products vide.' };
  const headers = data[0].map(function (header) { return String(header).trim().toLowerCase(); });
  const idCol = headers.indexOf('id');
  const nameCol = headers.indexOf('name');
  const categoryCol = headers.indexOf('category');
  const priceCol = headers.indexOf('price_mad');
  if ([idCol, nameCol, categoryCol, priceCol].some(function (column) { return column < 0; })) {
    return { success: false, error: 'Schéma de produits invalide.' };
  }

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === productId) {
      sheet.getRange(i + 1, nameCol + 1).setValue(name);
      sheet.getRange(i + 1, categoryCol + 1).setValue(category);
      sheet.getRange(i + 1, priceCol + 1).setValue(roundMoney(price));
      return { success: true, message: 'Nom, catégorie et prix de vente du produit mis à jour.' };
    }
  }
  return { success: false, error: 'Produit introuvable.' };
}

/**
 * Admin: Add New User
 */
function handleAdminAddUser(session, body) {
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) return { success: false, error: 'Serveur occupé.' };
    const result = handleAdminAddUserLocked(session, body);
    if (result.success) flushApplicationData();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function handleAdminAddUserLocked(session, body) {
  const name = String(body.name || '').trim();
  const username = String(body.username || '').trim().toLowerCase();
  const pin = String(body.pin || '').trim();

  if (!name || !/^[a-z0-9._-]{3,30}$/.test(username) || !/^\d{4,6}$/.test(pin)) {
    return { success: false, error: 'Nom, identifiant valide et PIN de 4 à 6 chiffres requis.' };
  }

  const ss = getSpreadsheet();
  const uSheet = ss.getSheetByName(CONFIG.SHEET_USERS);
  const uData = uSheet.getDataRange().getValues();
  const uHeaders = uData[0].map(h => String(h).trim().toLowerCase());
  const idxId = uHeaders.indexOf('id');
  const idxName = uHeaders.indexOf('name');
  const idxUser = uHeaders.indexOf('username');
  const idxPinHash = uHeaders.indexOf('pin_hash');
  const idxRole = uHeaders.indexOf('role');
  const idxBalance = uHeaders.indexOf('balance_mad');

  for (let i = 1; i < uData.length; i++) {
    if (String(uData[i][idxUser]).trim().toLowerCase() === username) {
      return { success: false, error: "Cet identifiant d'utilisateur existe déjà." };
    }
  }

  const pinHash = hashPin(pin);
  const existingClientIndex = uData.findIndex(function (row, index) {
    return index > 0 &&
      String(row[idxName] || '').trim().toLowerCase() === name.toLowerCase() &&
      !String(row[idxUser] || '').trim() &&
      !String(row[idxPinHash] || '').trim() &&
      String(row[idxRole] || '').toLowerCase() !== 'admin';
  });

  if (existingClientIndex > 0) {
    const rowNumber = existingClientIndex + 1;
    uSheet.getRange(rowNumber, idxUser + 1).setValue(username);
    uSheet.getRange(rowNumber, idxPinHash + 1).setValue(pinHash);
    const invitesSheet = ss.getSheetByName(CONFIG.SHEET_INVITES);
    if (invitesSheet) {
      const invites = invitesSheet.getDataRange().getValues();
      for (let i = 1; i < invites.length; i++) {
        if (String(invites[i][0]) === String(uData[existingClientIndex][idxId]) && !invites[i][3]) {
          invitesSheet.getRange(i + 1, 3).setValue('');
          invitesSheet.getRange(i + 1, 4).setValue(new Date().toISOString());
          break;
        }
      }
    }
    return {
      success: true,
      message: 'Compte créé et solde existant conservé pour ' + String(uData[existingClientIndex][idxName]),
      id: String(uData[existingClientIndex][idxId])
    };
  }

  const id = 'user_' + Date.now();

  uSheet.appendRow([
    id,
    name,
    username,
    pinHash,
    'user',
    0,
    new Date().toISOString()
  ]);

  return { success: true, message: 'Utilisateur ' + name + ' créé avec succès !', id: id };
}

/**
 * Setup and seed the database from the supplied client and product workbook.
 * Run this function once from Apps Script Editor.
 */
function setupDatabase() {
  const ss = getSpreadsheet();

  // 1. Tab: Products
  let pSheet = ss.getSheetByName(CONFIG.SHEET_PRODUCTS);
  if (!pSheet) {
    pSheet = ss.insertSheet(CONFIG.SHEET_PRODUCTS);
  }
  if (pSheet.getLastRow() === 0) {
    pSheet.appendRow(['id', 'name', 'category', 'price_mad', 'stock_qty', 'image_url', 'is_active']);
    pSheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#e2e8f0');

    const seedProducts = [
      ['Henris', 'Biscuits', 1.5, '🍪'], ['Tonik', 'Biscuits', 1.5, '🍪'],
      ['Tagger', 'Biscuits', 2, '🍪'], ['Golden', 'Biscuits', 2, '🍪'],
      ['Biscotti', 'Biscuits', 2, '🍪'], ['Be Fluffy', 'Biscuits', 2.5, '🍪'],
      ['Be Top', 'Biscuits', 2.5, '🍪'], ['Be Supreme', 'Biscuits', 2.5, '🍪'],
      ['Be Melty', 'Biscuits', 2.5, '🍪'], ['Be Donut', 'Biscuits', 2.5, '🍪'],
      ['Be Bunny', 'Biscuits', 1.5, '🍪'], ['Be Brownie', 'Biscuits', 2.5, '🍪'],
      ['Be Crunchy', 'Biscuits', 2.5, '🍪'], ['Dolce', 'Biscuits', 2.5, '🍪'],
      ['Pickers', 'Biscuits', 3.5, '🍪'], ['Pickers Gaufrette', 'Biscuits', 4.5, '🍪'],
      ['King cookies gd', 'Biscuits', 3.5, '🍪'], ['Brownie', 'Biscuits', 3.5, '🍪'],
      ['Mr Bite pixel', 'Biscuits', 3.5, '🍪'], ['Madeleine Delice', 'Biscuits', 3.5, '🍪'],
      ['Mr Bite Gauffre', 'Biscuits', 3.5, '🍪'], ['Mr Bite chocolat waff', 'Biscuits', 3.5, '🍪'],
      ['Tiramisu', 'Biscuits', 3.5, '🍪'], ['Masimo cake', 'Biscuits', 3, '🍪'],
      ['Genova', 'Biscuits', 2.5, '🍪'], ['Tobigo Pyramide', 'Biscuits', 2.5, '🍪'],
      ['Eyoo', 'Biscuits', 2.5, '🍪'], ['Tobigo Donut', 'Biscuits', 2.5, '🍪'],
      ['Crusty Waffers', 'Biscuits', 2.5, '🍪'], ['Crusty Cookies', 'Biscuits', 2.5, '🍪'],
      ['King Cookies', 'Biscuits', 2.5, '🍪'], ['Pauz', 'Biscuits', 2.5, '🍪'],
      ['Capri', 'Biscuits', 2.5, '🍪'], ['Tobigo Gauffre', 'Biscuits', 2.5, '🍪'],
      ['Nooco', 'Biscuits', 2.5, '🍪'], ['Mouchoir de Poche', 'Biscuits', 1.5, '🍪'],
      ['Coco Bar', 'Chocolat', 2.5, '🍫'], ['Caramel Bar', 'Chocolat', 2.5, '🍫'],
      ['Choco Bar', 'Chocolat', 2.5, '🍫'], ['Gomm Chocolate', 'Chocolat', 2.5, '🍫'],
      ['Pistache Choco', 'Chocolat', 2.5, '🍫'],
      ['Sidi Ali 2L', 'Boissons', 6.5, '🥤'], ['Sidi Ali 1,5L', 'Boissons', 6, '🥤'],
      ["Coffee L'or", 'Boissons', 4.5, '☕'], ['Coffee Noisette', 'Boissons', 4.5, '☕'],
      ['Coffee Chocolate', 'Boissons', 4.5, '☕'], ['Tea (3pc)', 'Boissons', 3.5, '☕'],
      ['Soda Canette', 'Boissons', 6, '🥤'], ['Soda Bottle', 'Boissons', 4.5, '🥤'],
      ['Soda Lemon', 'Boissons', 5, '🥤'], ['Shwips Mojito/Soda Bubble', 'Boissons', 7, '🥤'],
      ['Juice (abtal)', 'Boissons', 3.5, '🧃'], ['Linx', 'Boissons', 12, '🥤'],
      ['Rostoy', 'Boissons', 6, '🥤'], ['Sting Energy drink', 'Boissons', 7, '🥤'],
      ['Conicos', 'Snacks', 4, '🥨'], ['Pipas', 'Snacks', 4, '🥨'],
      ['Kaskys', 'Snacks', 4.5, '🥨'], ['Mix Nuts', 'Snacks', 4, '🥨'],
      ['Trident (3pc)', 'Snacks', 2, '🥨'], ['Conicos gd', 'Snacks', 10, '🥨'],
      ['Pringles', 'Snacks', 12.5, '🥨'], ['Pringles gd', 'Snacks', 23, '🥨'],
      ['Fakiat', 'Snacks', 2, '🥨'], ['Pipas gr', 'Snacks', 6.5, '🥨']
    ].map(function (product, index) {
      return ['p' + (index + 1), product[0], product[1], product[2], 0, product[3], true];
    });
    pSheet.getRange(2, 1, seedProducts.length, 7).setValues(seedProducts);
  }
  normalizeCoffeeProducts(pSheet);

  // 2. Tab: Users
  let uSheet = ss.getSheetByName(CONFIG.SHEET_USERS);
  if (!uSheet) {
    uSheet = ss.insertSheet(CONFIG.SHEET_USERS);
  }
  if (uSheet.getLastRow() === 0) {
    uSheet.appendRow(['id', 'name', 'username', 'pin_hash', 'role', 'balance_mad', 'created_at']);
    uSheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#e2e8f0');

    const adminPin = Utilities.getUuid().replace(/\D/g, '').padEnd(6, '0').substring(0, 6);
    const now = new Date().toISOString();
    const importedClients = [
      ['Soufiane', -0.5], ['Khaireddine', 40], ['Machmachi', 17], ['Amal', 5],
      ['Lamiae', 12.5], ['Hanane', 6.5], ['Yasmina', 0], ['Achraf (coffee 3,5)', -2],
      ['SELMA', 2.5], ['Hatim', 42.5], ['Aziz', 0], ['Douae', 17.5],
      ['Ilyas dahhane', 12], ['Safa A', 0], ['Hajar', 6.5], ['khaoula', 0],
      ['Oussama AY', 10], ['Karim', 0], ['Safae Je', -7.5], ['Jad EL Hak', 0],
      ['Nour ElHouda', 2], ['Mohammed El Mimoni', -20.5], ['Kaoutar Ben', 0],
      ['Imad', 0], ['Yhan Nabil', 0], ['Taoufik', 0], ['Ilyas lazaar', -0.5],
      ['Omar Kh', -0.5], ['Abdoul wadoud', 0], ['Naoual B', 0],
      ['Fatima zahra', 1], ['yassin', 0], ['Siham', -0.5], ['Mostafa', 0],
      ['Bouchra', -0.5], ['Nassiba', 6]
    ];
    const seedUsers = [['u_admin', 'Admin Bureau', 'admin', hashPin(adminPin), 'admin', 0, now]]
      .concat(importedClients.map(function (client, index) {
        return ['u_client_' + (index + 1), client[0], '', '', 'user', client[1], now];
      }));
    uSheet.getRange(2, 1, seedUsers.length, 7).setValues(seedUsers);
    Logger.log('Initial admin PIN (save this securely): ' + adminPin);
  }
  ensureUserPinRecoveryColumns(uSheet);

  // One private, single-use code is created for each imported client.
  let invitesSheet = ss.getSheetByName(CONFIG.SHEET_INVITES);
  if (!invitesSheet) invitesSheet = ss.insertSheet(CONFIG.SHEET_INVITES);
  if (invitesSheet.getLastRow() === 0) {
    invitesSheet.appendRow(['user_id', 'code_hash', 'claim_code', 'used_at']);
    invitesSheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#e2e8f0');
  }
  const inviteData = invitesSheet.getDataRange().getValues();
  const invitedUserIds = {};
  for (let i = 1; i < inviteData.length; i++) invitedUserIds[String(inviteData[i][0])] = true;
  const userData = uSheet.getDataRange().getValues();
  const userHeaders = userData[0].map(function (header) { return String(header).trim().toLowerCase(); });
  const userIdCol = userHeaders.indexOf('id');
  const usernameCol = userHeaders.indexOf('username');
  const roleCol = userHeaders.indexOf('role');
  for (let i = 1; i < userData.length; i++) {
    const user = userData[i];
    const userId = String(user[userIdCol] || '');
    if (userId && !String(user[usernameCol] || '').trim() &&
        String(user[roleCol] || '').toLowerCase() !== 'admin' && !invitedUserIds[userId]) {
      const claimCode = Utilities.getUuid().replace(/-/g, '').substring(0, 16).toUpperCase();
      invitesSheet.appendRow([userId, hashPin(claimCode), claimCode, '']);
    }
  }

  // 3. Tab: Transactions
  let tSheet = ss.getSheetByName(CONFIG.SHEET_TRANSACTIONS);
  if (!tSheet) {
    tSheet = ss.insertSheet(CONFIG.SHEET_TRANSACTIONS);
  }
  if (tSheet.getLastRow() === 0) {
    tSheet.appendRow(['id', 'timestamp', 'user_id', 'user_name', 'type', 'item_id', 'item_name', 'quantity', 'amount_mad', 'notes', 'paid', 'status']);
    tSheet.getRange(1, 1, 1, 12).setFontWeight('bold').setBackground('#e2e8f0');
  } else {
    const txHeaders = tSheet.getRange(1, 1, 1, tSheet.getLastColumn()).getValues()[0]
      .map(function (header) { return String(header).trim().toLowerCase(); });
    if (txHeaders.indexOf('paid') === -1) {
      const paidColumn = tSheet.getLastColumn() + 1;
      tSheet.getRange(1, paidColumn).setValue('paid');
      tSheet.getRange(1, paidColumn).setFontWeight('bold').setBackground('#e2e8f0');
    }
  }
  ensureTransactionStatusColumn(tSheet);

  getOrCreateSettingsSheet();

  return {
    success: true,
    message: 'Base initialisée avec les données importées. Stocks initiaux à zéro; codes de compte dans l’onglet Invites.'
  };
}

/**
 * Replace demo data with the workbook import. Run manually from the Apps Script editor.
 * This clears all existing balances, products, transactions, settings and invite codes.
 */
function replaceDemoDataWithWorkbook() {
  const ss = getSpreadsheet();
  [
    CONFIG.SHEET_PRODUCTS,
    CONFIG.SHEET_USERS,
    CONFIG.SHEET_TRANSACTIONS,
    CONFIG.SHEET_SETTINGS,
    CONFIG.SHEET_INVITES
  ].forEach(function (sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    if (sheet) sheet.clearContents();
  });
  PropertiesService.getScriptProperties().deleteProperty('JWT_SECRET');
  return setupDatabase();
}

function getOrCreateSettingsSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_SETTINGS);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_SETTINGS);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['key', 'value']);
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#e2e8f0');
  }

  const data = sheet.getDataRange().getValues();
  const hasOpeningCash = data.some(function (row, index) {
    return index > 0 && String(row[0]) === 'opening_cash_mad';
  });
  if (!hasOpeningCash) sheet.appendRow(['opening_cash_mad', '']);
  const hasOpeningCashTimestamp = data.some(function (row, index) {
    return index > 0 && String(row[0]) === 'opening_cash_timestamp';
  });
  if (!hasOpeningCashTimestamp) sheet.appendRow(['opening_cash_timestamp', '']);
  return sheet;
}