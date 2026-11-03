import { DatabaseSync } from 'node:sqlite';
import { newId, newToken, sha256 } from './crypto.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  operator TEXT NOT NULL,
  label TEXT NOT NULL,
  phone TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CDF',
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  UNIQUE (user_id, operator, phone, currency)
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'CDF',
  status TEXT NOT NULL,
  failure TEXT,
  idem_key TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, idem_key)
);
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS qr_requests (
  nonce TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  amount INTEGER NOT NULL,
  item TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS payment_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = OFF;'); // node:sqlite les active par défaut ; réactivées après la migration
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

const columns = (db, table) => db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name);

// Met à niveau une base créée par une version précédente. Les clés étrangères doivent être désactivées
// pendant qu'on recrée une table (SQLite ne sait pas modifier une contrainte UNIQUE).
function migrate(db) {
  if (!columns(db, 'accounts').includes('currency')) {
    db.exec(`
      BEGIN;
      CREATE TABLE accounts_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        operator TEXT NOT NULL,
        label TEXT NOT NULL,
        phone TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'CDF',
        balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
        UNIQUE (user_id, operator, phone, currency)
      );
      INSERT INTO accounts_new (id, user_id, operator, label, phone, balance) SELECT id, user_id, operator, label, phone, balance FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_new RENAME TO accounts;
      COMMIT;
    `);
  }
  if (!columns(db, 'transactions').includes('currency')) {
    db.exec("ALTER TABLE transactions ADD COLUMN currency TEXT NOT NULL DEFAULT 'CDF'");
  }
}

/** Enregistre une machine (distributeur) et retourne sa clé secrète, à n'afficher qu'une seule fois. */
export function createMachine(db, { id, name }) {
  const key = 'mk_' + newToken();
  db.prepare('INSERT INTO machines (id, name, key_hash) VALUES (?, ?, ?)').run(id ?? newId('mach'), name, sha256(key));
  return key;
}
