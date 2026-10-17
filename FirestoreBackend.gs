/**
 * Firestore-backed adapter for the existing Sheets-shaped business logic.
 *
 * Migration is opt-in. The original spreadsheet remains intact as a backup.
 */
var FIRESTORE_COLLECTIONS = {
  Products: 'Products',
  Users: 'UserSecrets',
  Transactions: 'Transactions',
  Settings: 'Settings',
  Invites: 'Invites'
};
var firestoreSpreadsheetCache = null;

function isFirestoreBackendEnabled() {
  return PropertiesService.getScriptProperties().getProperty('FIRESTORE_ENABLED') === 'true';
}

function getFirestoreProjectId() {
  const projectId = PropertiesService.getScriptProperties().getProperty('FIREBASE_PROJECT_ID');
  if (!projectId) throw new Error('Set FIREBASE_PROJECT_ID in Apps Script properties before using Firestore.');
  return projectId;
}

function firestoreDocumentsUrl(collection) {
  return 'https://firestore.googleapis.com/v1/projects/' +
    encodeURIComponent(getFirestoreProjectId()) + '/databases/(default)/documents/' + collection;
}

function firestoreRequest(method, url, payload) {
  const options = {
    method: method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  };
  if (payload !== undefined) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  const response = UrlFetchApp.fetch(url, options);
  const status = response.getResponseCode();
  const text = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('Firestore request failed (' + status + '): ' + text.slice(0, 500));
  }
  return text ? JSON.parse(text) : {};
}

function firestoreEncodeValue(value) {
  if (value === null || value === undefined || value === '') return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(firestoreEncodeValue) } };
  }
  return { stringValue: String(value) };
}

function firestoreDecodeValue(value) {
  if (value === undefined || value === null) return '';
  if (Object.prototype.hasOwnProperty.call(value, 'nullValue')) return '';
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'booleanValue')) return value.booleanValue;
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, 'timestampValue')) return value.timestampValue;
  if (Object.prototype.hasOwnProperty.call(value, 'arrayValue')) {
    return (value.arrayValue.values || []).map(firestoreDecodeValue);
  }
  return '';
}

function firestoreEncodeFields(fields) {
  const encoded = {};
  Object.keys(fields).forEach(function (key) {
    encoded[key] = firestoreEncodeValue(fields[key]);
  });
  return encoded;
}

function firestoreDecodeFields(fields) {
  const decoded = {};
  Object.keys(fields || {}).forEach(function (key) {
    decoded[key] = firestoreDecodeValue(fields[key]);
  });
  return decoded;
}

function firestoreDocumentId(documentName) {
  const parts = String(documentName || '').split('/');
  return decodeURIComponent(parts[parts.length - 1]);
}

function firestoreListDocuments(collection) {
  const documents = [];
  let pageToken = '';
  do {
    let url = firestoreDocumentsUrl(collection) + '?pageSize=1000';
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    const result = firestoreRequest('get', url);
    (result.documents || []).forEach(function (document) {
      documents.push({
        id: firestoreDocumentId(document.name),
        fields: firestoreDecodeFields(document.fields)
      });
    });
    pageToken = result.nextPageToken || '';
  } while (pageToken);
  return documents;
}

function firestoreWriteUrl() {
  return 'https://firestore.googleapis.com/v1/projects/' +
    encodeURIComponent(getFirestoreProjectId()) + '/databases/(default)/documents:commit';
}

function firestoreCommit(writes) {
  if (!writes.length) return;
  for (let start = 0; start < writes.length; start += 400) {
    firestoreRequest('post', firestoreWriteUrl(), { writes: writes.slice(start, start + 400) });
  }
}

function firestoreDocumentName(collection, id) {
  return 'projects/' + getFirestoreProjectId() + '/databases/(default)/documents/' +
    collection + '/' + encodeURIComponent(String(id));
}

function firestoreRowId(header, row, position) {
  const normalized = header.map(function (value) {
    return String(value || '').trim().toLowerCase();
  });
  const preferred = ['id', 'key', 'invite_code', 'code', 'user_id'];
  for (let i = 0; i < preferred.length; i++) {
    const column = normalized.indexOf(preferred[i]);
    if (column >= 0 && row[column] !== '' && row[column] !== null && row[column] !== undefined) {
      return String(row[column]);
    }
  }
  return 'row_' + position;
}

function firestoreRowFields(header, row) {
  const fields = {};
  header.forEach(function (name, index) {
    const field = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (/^[a-z_][a-z0-9_]*$/.test(field)) fields[field] = row[index];
  });
  return fields;
}

function firestoreBuildRowDocument(collection, header, row, position) {
  const rowId = firestoreRowId(header, row, position);
  const data = firestoreRowFields(header, row);
  data._row = row;
  data._position = position;
  const writes = [{
    update: {
      name: firestoreDocumentName(FIRESTORE_COLLECTIONS[collection], rowId),
      fields: firestoreEncodeFields(data)
    }
  }];
  if (collection === 'Users' && data.id) {
    const publicProfile = Object.assign({}, data);
    delete publicProfile.pin_hash;
    delete publicProfile._row;
    delete publicProfile._position;
    publicProfile.session_version = Number(data.session_version) || 0;
    publicProfile.pin_reset_required =
      data.pin_reset_required === true || String(data.pin_reset_required).toUpperCase() === 'TRUE';
    writes.push({
      update: {
        name: firestoreDocumentName('PublicUsers', String(data.id)),
        fields: firestoreEncodeFields(publicProfile)
      }
    });
  }
  return writes;
}

function firestorePrepareMigrationSheet(sheetName, values) {
  const rows = values.map(function (row) {
    return row.map(function (value) {
      return value instanceof Date ? value.toISOString() : value;
    });
  });
  if (!rows.length) rows.push([]);
  const header = rows[0].map(function (value) { return String(value || '').trim().toLowerCase(); });
  const required = sheetName === 'Users'
    ? ['pin_reset_required', 'pin_reset_requested_at', 'session_version']
    : sheetName === 'Transactions'
      ? ['status', 'cancel_status', 'cancel_requested_at', 'cancel_decided_at', 'cancel_decided_by']
      : [];
  required.forEach(function (field) {
    if (header.indexOf(field) < 0) {
      header.push(field);
      rows[0].push(field);
      for (let i = 1; i < rows.length; i++) {
        rows[i].push(field === 'pin_reset_required' ? false :
          field === 'session_version' ? 0 : '');
      }
    }
  });
  if (sheetName === 'Settings') {
    if (header.indexOf('key') < 0 || header.indexOf('value') < 0) {
      throw new Error('Settings sheet must contain key and value columns.');
    }
    ['opening_cash_mad', 'opening_cash_timestamp'].forEach(function (key) {
      const keyIndex = header.indexOf('key');
      if (!rows.some(function (row, index) { return index > 0 && String(row[keyIndex]) === key; })) {
        const row = new Array(header.length).fill('');
        row[keyIndex] = key;
        rows.push(row);
      }
    });
  }
  return { header: header, rows: rows };
}

function getFirestoreSpreadsheet() {
  if (!firestoreSpreadsheetCache) firestoreSpreadsheetCache = new FirestoreSpreadsheetAdapter();
  return firestoreSpreadsheetCache;
}

function flushApplicationData() {
  if (isFirestoreBackendEnabled()) {
    getFirestoreSpreadsheet().flush();
  } else {
    SpreadsheetApp.flush();
  }
}

function FirestoreSpreadsheetAdapter() {
  this.sheets = {};
}

FirestoreSpreadsheetAdapter.prototype.getSheetByName = function (name) {
  if (!Object.prototype.hasOwnProperty.call(FIRESTORE_COLLECTIONS, name)) return null;
  if (!this.sheets[name]) this.sheets[name] = new FirestoreSheetAdapter(this, name);
  return this.sheets[name];
};

FirestoreSpreadsheetAdapter.prototype.insertSheet = function (name) {
  if (!Object.prototype.hasOwnProperty.call(FIRESTORE_COLLECTIONS, name)) {
    throw new Error('Unsupported Firestore collection: ' + name);
  }
  const sheet = new FirestoreSheetAdapter(this, name);
  sheet.header = [];
  sheet.loaded = true;
  this.sheets[name] = sheet;
  sheet.headerDirty = true;
  return sheet;
};

FirestoreSpreadsheetAdapter.prototype.flush = function () {
  Object.keys(this.sheets).forEach(function (name) {
    this.sheets[name].flush();
  }, this);
};

function FirestoreSheetAdapter(owner, name) {
  this.owner = owner;
  this.name = name;
  this.collection = FIRESTORE_COLLECTIONS[name];
  this.loaded = false;
  this.header = [];
  this.rows = [];
  this.dirty = {};
  this.deleted = {};
  this.headerDirty = false;
}

FirestoreSheetAdapter.prototype.load = function () {
  if (this.loaded) return;
  const documents = firestoreListDocuments(this.collection);
  const headerDocument = documents.find(function (document) { return document.id === '_schema'; });
  this.header = headerDocument && Array.isArray(headerDocument.fields._row)
    ? headerDocument.fields._row : [];
  this.rows = documents.filter(function (document) {
    return document.id !== '_schema' && Array.isArray(document.fields._row);
  }).map(function (document) {
    return {
      id: document.id,
      position: Number(document.fields._position) || 0,
      values: document.fields._row
    };
  }).sort(function (a, b) {
    return a.position - b.position;
  });
  this.loaded = true;
};

FirestoreSheetAdapter.prototype.getLastColumn = function () {
  this.load();
  return this.header.length;
};

FirestoreSheetAdapter.prototype.getLastRow = function () {
  this.load();
  return this.header.length || this.rows.length ? this.rows.length + (this.header.length ? 1 : 0) : 0;
};

FirestoreSheetAdapter.prototype.getDataRange = function () {
  this.load();
  const values = this.header.length ? [this.header.slice()] : [];
  this.rows.forEach(function (row) {
    const valuesRow = row.values.slice();
    while (valuesRow.length < this.header.length) valuesRow.push('');
    values.push(valuesRow);
  }, this);
  return new FirestoreRangeAdapter(this, 1, 1, values.length, this.getLastColumn(), values);
};

FirestoreSheetAdapter.prototype.getRange = function (row, column, numRows, numColumns) {
  this.load();
  return new FirestoreRangeAdapter(this, row, column, numRows || 1, numColumns || 1);
};

FirestoreSheetAdapter.prototype.appendRow = function (values) {
  this.load();
  if (!this.header.length) {
    this.header = values.slice();
    this.headerDirty = true;
    return this;
  }
  const position = this.rows.length + 2;
  const id = firestoreRowId(this.header, values, position);
  if (this.rows.some(function (row) { return row.id === id; })) {
    throw new Error('Duplicate Firestore record id in ' + this.name + ': ' + id);
  }
  const record = { id: id, position: position, values: values.slice() };
  this.rows.push(record);
  this.dirty[id] = record;
  return this;
};

FirestoreSheetAdapter.prototype.clearContents = function () {
  this.load();
  this.rows.forEach(function (row) { this.deleted[row.id] = true; }, this);
  this.rows = [];
  this.header = [];
  this.headerDirty = true;
};

FirestoreSheetAdapter.prototype.setCell = function (rowIndex, columnIndex, value) {
  this.load();
  if (rowIndex === 1) {
    while (this.header.length < columnIndex) this.header.push('');
    this.header[columnIndex - 1] = value;
    this.headerDirty = true;
    return;
  }
  while (this.rows.length < rowIndex - 1) {
    const position = this.rows.length + 2;
    const blank = { id: 'row_' + position, position: position, values: [] };
    this.rows.push(blank);
    this.dirty[blank.id] = blank;
  }
  const record = this.rows[rowIndex - 2];
  while (record.values.length < columnIndex) record.values.push('');
  record.values[columnIndex - 1] = value;
  const newId = firestoreRowId(this.header, record.values, record.position);
  if (newId !== record.id) {
    this.deleted[record.id] = true;
    record.id = newId;
  }
  this.dirty[record.id] = record;
};

FirestoreSheetAdapter.prototype.setValues = function (rowIndex, columnIndex, values) {
  values.forEach(function (row, index) {
    row.forEach(function (value, columnOffset) {
      this.setCell(rowIndex + index, columnIndex + columnOffset, value);
    }, this);
  }, this);
};

FirestoreSheetAdapter.prototype.getCell = function (rowIndex, columnIndex) {
  this.load();
  if (rowIndex === 1) return this.header[columnIndex - 1] === undefined ? '' : this.header[columnIndex - 1];
  const record = this.rows[rowIndex - 2];
  return record && record.values[columnIndex - 1] !== undefined
    ? record.values[columnIndex - 1] : '';
};

FirestoreSheetAdapter.prototype.flush = function () {
  this.load();
  const writes = [];
  if (this.headerDirty) {
    if (this.header.length) {
      writes.push({
        update: {
          name: firestoreDocumentName(this.collection, '_schema'),
          fields: firestoreEncodeFields({ _row: this.header })
        }
      });
    } else {
      writes.push({ delete: firestoreDocumentName(this.collection, '_schema') });
    }
  }
  Object.keys(this.deleted).forEach(function (id) {
    writes.push({ delete: firestoreDocumentName(this.collection, id) });
    if (this.name === 'Users') {
      writes.push({ delete: firestoreDocumentName('PublicUsers', id) });
    }
  }, this);
  Object.keys(this.dirty).forEach(function (id) {
    const record = this.dirty[id];
    Array.prototype.push.apply(
      writes,
      firestoreBuildRowDocument(this.name, this.header, record.values, record.position)
    );
  }, this);
  firestoreCommit(writes);
  this.dirty = {};
  this.deleted = {};
  this.headerDirty = false;
};

function FirestoreRangeAdapter(sheet, row, column, numRows, numColumns, values) {
  this.sheet = sheet;
  this.row = row;
  this.column = column;
  this.numRows = numRows;
  this.numColumns = numColumns;
  this.values = values || null;
}

FirestoreRangeAdapter.prototype.getValues = function () {
  if (this.values) return this.values.map(function (row) { return row.slice(); });
  const result = [];
  for (let r = 0; r < this.numRows; r++) {
    const row = [];
    for (let c = 0; c < this.numColumns; c++) {
      row.push(this.sheet.getCell(this.row + r, this.column + c));
    }
    result.push(row);
  }
  return result;
};

FirestoreRangeAdapter.prototype.getValue = function () {
  return this.sheet.getCell(this.row, this.column);
};

FirestoreRangeAdapter.prototype.setValue = function (value) {
  this.sheet.setCell(this.row, this.column, value);
  return this;
};

FirestoreRangeAdapter.prototype.setValues = function (values) {
  this.sheet.setValues(this.row, this.column, values);
  return this;
};

FirestoreRangeAdapter.prototype.setFontWeight = function () { return this; };
FirestoreRangeAdapter.prototype.setBackground = function () { return this; };

function migrateCurrentSheetsToFirestore() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('FIRESTORE_MIGRATION_COMPLETE') === 'true') {
    throw new Error('Migration already completed. The source spreadsheet was not changed; refusing to overwrite Firestore.');
  }
  getFirestoreProjectId();
  if (!props.getProperty('FIREBASE_SERVICE_ACCOUNT_EMAIL') ||
      !props.getProperty('FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY')) {
    throw new Error('Set the Firebase service account email and private key before migrating.');
  }
  createFirebaseCustomToken('migration-check', 'user', 0);
  const spreadsheet = getSourceSpreadsheet();
  const writes = [];
  const counts = {};
  const expectedRows = {};
  const expectedHeaders = {};
  Object.keys(FIRESTORE_COLLECTIONS).forEach(function (sheetName) {
    const sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet && sheetName !== 'Settings') throw new Error('Required source sheet is missing: ' + sheetName);
    const rawValues = sheet ? sheet.getDataRange().getValues() :
      [['key', 'value'], ['opening_cash_mad', ''], ['opening_cash_timestamp', '']];
    const prepared = firestorePrepareMigrationSheet(sheetName, rawValues);
    const values = prepared.rows;
    if (!values.length || !values[0].length) throw new Error('Source sheet has no header row: ' + sheetName);
    const header = prepared.header;
    expectedHeaders[sheetName] = header;
    const seenIds = {};
    expectedRows[sheetName] = {};
    writes.push({
      update: {
        name: firestoreDocumentName(FIRESTORE_COLLECTIONS[sheetName], '_schema'),
        fields: firestoreEncodeFields({ _row: header })
      }
    });
    for (let index = 1; index < values.length; index++) {
      const row = values[index].map(function (value) {
        return value instanceof Date ? value.toISOString() : value;
      });
      if (!row.some(function (value) { return value !== '' && value !== null; })) continue;
      const id = firestoreRowId(header, row, index + 1);
      if (seenIds[id]) throw new Error('Duplicate record id in ' + sheetName + ': ' + id);
      seenIds[id] = true;
      expectedRows[sheetName][id] = row;
      Array.prototype.push.apply(writes, firestoreBuildRowDocument(sheetName, header, row, index + 1));
      counts[sheetName] = (counts[sheetName] || 0) + 1;
    }
  });
  firestoreCommit(writes);
  Object.keys(FIRESTORE_COLLECTIONS).forEach(function (sheetName) {
    const actualRows = firestoreListDocuments(FIRESTORE_COLLECTIONS[sheetName])
      .filter(function (document) {
        return document.id !== '_schema' && Array.isArray(document.fields._row);
      });
    const expected = expectedRows[sheetName];
    if (actualRows.length !== (counts[sheetName] || 0)) {
      throw new Error('Migration verification failed for ' + sheetName + ': expected ' +
        (counts[sheetName] || 0) + ' records, found ' + actualRows.length + '.');
    }
    actualRows.forEach(function (document) {
      if (!Object.prototype.hasOwnProperty.call(expected, document.id) ||
          JSON.stringify(document.fields._row) !== JSON.stringify(expected[document.id])) {
        throw new Error('Migration verification failed for ' + sheetName + '/' + document.id + '.');
      }
    });
    if (actualRows.length !== Object.keys(expected).length) {
      throw new Error('Migration verification failed: unexpected Firestore records were found in ' + sheetName + '.');
    }
  });
  const expectedProfiles = {};
  const userIdColumn = expectedHeaders.Users.indexOf('id');
  Object.keys(expectedRows.Users).forEach(function (id) {
    const row = expectedRows.Users[id];
    if (userIdColumn < 0 || !row[userIdColumn]) return;
    const profile = firestoreRowFields(expectedHeaders.Users, row);
    expectedProfiles[String(row[userIdColumn])] = {
      name: profile.name || '',
      username: profile.username || '',
      role: profile.role || 'user',
      balance_mad: Number(profile.balance_mad) || 0,
      session_version: Number(profile.session_version) || 0,
      pin_reset_required: profile.pin_reset_required === true ||
        String(profile.pin_reset_required).toUpperCase() === 'TRUE'
    };
  });
  const actualProfiles = firestoreListDocuments('PublicUsers');
  if (actualProfiles.length !== Object.keys(expectedProfiles).length ||
      actualProfiles.some(function (profile) {
        const expected = expectedProfiles[profile.id];
        if (!expected) return true;
        return Object.keys(expected).some(function (field) {
          return profile.fields[field] !== expected[field];
        }) || Object.prototype.hasOwnProperty.call(profile.fields, 'pin_hash');
      })) {
    throw new Error('Migration verification failed for PublicUsers profiles.');
  }
  props.setProperty('FIRESTORE_MIGRATION_COMPLETE', 'true');
  props.setProperty('FIRESTORE_ENABLED', 'true');
  Logger.log('Firestore migration verified: ' + JSON.stringify(counts));
  return { success: true, counts: counts, message: 'Firestore migration verified. The source Google Sheet was not modified.' };
}

function createFirebaseCustomToken(userId, role, sessionVersion) {
  const props = PropertiesService.getScriptProperties();
  const email = props.getProperty('FIREBASE_SERVICE_ACCOUNT_EMAIL');
  const key = props.getProperty('FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY');
  if (!email || !key) throw new Error('Set the Firebase service account email and private key in Apps Script properties.');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: email,
    sub: email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid: String(userId),
    claims: {
      role: role === 'admin' ? 'admin' : 'user',
      sessionVersion: Number(sessionVersion) || 0
    }
  };
  const unsigned = firebaseBase64Url(JSON.stringify(header)) + '.' + firebaseBase64Url(JSON.stringify(payload));
  const privateKey = key.replace(/\\n/g, '\n');
  const signature = Utilities.computeRsaSha256Signature(unsigned, privateKey);
  return unsigned + '.' + firebaseBase64Url(signature);
}

function firebaseBase64Url(value) {
  return Utilities.base64EncodeWebSafe(value).replace(/=+$/g, '');
}
