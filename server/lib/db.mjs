import { DatabaseSync } from 'node:sqlite';
import { newId, newToken, sha256 } from './crypto.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  is_agent INTEGER NOT NULL DEFAULT 0,
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
-- kind : vending (snacks, boissons), laundry (laverie, relais), fuel (pompe, pré-autorisation), atm (retrait d'espèces)
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'vending',
  currency TEXT NOT NULL DEFAULT 'CDF',
  webhook_url TEXT,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
-- Emplacements d'une machine (produit, programme de lavage...). stock NULL = illimité.
CREATE TABLE IF NOT EXISTS machine_slots (
  machine_id TEXT NOT NULL REFERENCES machines(id),
  slot INTEGER NOT NULL,
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),
  stock INTEGER,
  PRIMARY KEY (machine_id, slot)
);
-- Vente machine sous séquestre : held (argent bloqué) -> dispensed (propriétaire crédité) ou refunded (client remboursé).
CREATE TABLE IF NOT EXISTS vends (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  slot INTEGER,
  ref TEXT,
  source TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  item TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  final_amount INTEGER,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',
  reason TEXT,
  created_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS vends_held ON vends (status, deadline);
-- Retrait d'espèces : code à 8 chiffres à montrer à un agent agréé ou à saisir au distributeur (DAB).
CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  failure TEXT,
  agent_user_id TEXT REFERENCES users(id),
  machine_id TEXT REFERENCES machines(id),
  vend_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
-- Demande de paiement par QR : affichée par une machine (machine_id) ou par un utilisateur qui encaisse (payee_*).
CREATE TABLE IF NOT EXISTS qr_requests (
  nonce TEXT PRIMARY KEY,
  machine_id TEXT REFERENCES machines(id),
  payee_user_id TEXT REFERENCES users(id),
  payee_account_id TEXT REFERENCES accounts(id),
  payer_user_id TEXT REFERENCES users(id),
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CDF',
  item TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
-- Catalogue d'un commerçant (plats, articles) : le prix est toujours lu ici, jamais envoyé par l'application.
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),
  currency TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Commande d'une machine d'un réseau externe (simulateur rdcpay://) payée depuis KinPay. Le séquestre est tenu par ce réseau.
CREATE TABLE IF NOT EXISTS external_orders (
  machine_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  machine_name TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  item TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paying',
  refund_recorded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'machine',
  detail TEXT,
  refunded INTEGER NOT NULL DEFAULT 0,
  topup INTEGER NOT NULL DEFAULT 0,
  topup_status TEXT,
  PRIMARY KEY (machine_id, order_id)
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
  if (!columns(db, 'qr_requests').includes('currency')) {
    // machine_id devient facultatif : un QR peut aussi être affiché par un utilisateur qui encaisse.
    db.exec(`
      BEGIN;
      CREATE TABLE qr_requests_new (
        nonce TEXT PRIMARY KEY,
        machine_id TEXT REFERENCES machines(id),
        payee_user_id TEXT REFERENCES users(id),
        payee_account_id TEXT REFERENCES accounts(id),
        payer_user_id TEXT REFERENCES users(id),
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'CDF',
        item TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      INSERT INTO qr_requests_new (nonce, machine_id, amount, item, expires_at, status) SELECT nonce, machine_id, amount, item, expires_at, status FROM qr_requests;
      DROP TABLE qr_requests;
      ALTER TABLE qr_requests_new RENAME TO qr_requests;
      COMMIT;
    `);
  }
  // Colonnes simples ajoutées après coup (phases C et D).
  const add = (table, column, def) => {
    if (!columns(db, table).includes(column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + def);
  };
  add('users', 'is_agent', 'INTEGER NOT NULL DEFAULT 0');
  add('machines', 'owner_user_id', 'TEXT REFERENCES users(id)');
  add('machines', 'kind', "TEXT NOT NULL DEFAULT 'vending'");
  add('machines', 'currency', "TEXT NOT NULL DEFAULT 'CDF'");
  add('machines', 'webhook_url', 'TEXT');
  add('machines', 'last_seen_at', 'INTEGER NOT NULL DEFAULT 0');
  add('machines', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
  // kind : machine (commande) ou laundry (cycle de laverie) ; detail : libellé de la machine ; refunded : montant rendu par le réseau.
  if (!columns(db, 'external_orders').includes('kind')) {
    add('external_orders', 'kind', "TEXT NOT NULL DEFAULT 'machine'");
    db.exec("UPDATE external_orders SET kind = 'laundry' WHERE order_id LIKE 'lav\\_%' ESCAPE '\\'");
  }
  add('external_orders', 'detail', 'TEXT');
  add('external_orders', 'refunded', 'INTEGER NOT NULL DEFAULT 0');
  // topup : complément versé par KinPay quand la règle demande un remboursement total (coupure de courant).
  add('external_orders', 'topup', 'INTEGER NOT NULL DEFAULT 0');
  add('external_orders', 'topup_status', 'TEXT');
}

export const MACHINE_KINDS = ['vending', 'laundry', 'fuel', 'atm'];

/**
 * Compte KinPay qui reçoit un transfert vers un numéro : même devise, de préférence chez le même opérateur
 * que l'expéditeur. Un seul compte est crédité (jamais tous les comptes du numéro).
 */
export function findRecipient(db, phone, currency, { excludeId = '', operator } = {}) {
  const rows = db.prepare('SELECT * FROM accounts WHERE phone = ? AND currency = ? AND id <> ? ORDER BY rowid').all(phone, currency, excludeId);
  return rows.find((r) => r.operator === operator) ?? rows[0] ?? null;
}

/** Enregistre une machine (distributeur) et retourne sa clé secrète, à n'afficher qu'une seule fois. */
export function createMachine(db, { id, name, kind = 'vending', currency = 'CDF', ownerUserId = null, now = Date.now() }) {
  const key = 'mk_' + newToken();
  db.prepare('INSERT INTO machines (id, name, key_hash, kind, currency, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id ?? newId('mach'),
    name,
    sha256(key),
    kind,
    currency,
    ownerUserId,
    now,
  );
  return key;
}

/** Nouvelle clé pour une machine (l'ancienne cesse de fonctionner). */
export function rotateMachineKey(db, id) {
  const key = 'mk_' + newToken();
  db.prepare('UPDATE machines SET key_hash = ? WHERE id = ?').run(sha256(key), id);
  return key;
}
