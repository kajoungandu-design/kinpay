// Une base créée par une version précédente doit s'ouvrir sans perte de données.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../lib/db.mjs';

test('migration : comptes et opérations sans devise deviennent CDF', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinpay-'));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, pin_salt TEXT NOT NULL, pin_hash TEXT NOT NULL,
      failed_logins INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), operator TEXT NOT NULL, label TEXT NOT NULL,
      phone TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0), UNIQUE (user_id, operator, phone));
    CREATE TABLE transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), account_id TEXT NOT NULL REFERENCES accounts(id),
      kind TEXT NOT NULL, label TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0), status TEXT NOT NULL, failure TEXT, idem_key TEXT,
      created_at INTEGER NOT NULL, UNIQUE (user_id, idem_key));
    CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL);
    CREATE TABLE qr_requests (nonce TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id), amount INTEGER NOT NULL,
      item TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE external_orders (machine_id TEXT NOT NULL, order_id TEXT NOT NULL, machine_name TEXT NOT NULL, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
      item TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'paying', refund_recorded INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, PRIMARY KEY (machine_id, order_id));
    INSERT INTO machines VALUES ('DIST-1', 'Distributeur', 'h');
    INSERT INTO qr_requests VALUES ('abcdabcdabcdabcd', 'DIST-1', 1500, 'Eau', 9, 'paid');
    INSERT INTO users VALUES ('usr_1', '+243890000011', 's', 'h', 0, 0, 1);
    INSERT INTO accounts VALUES ('acc_1', 'usr_1', 'orange', 'Orange Money', '+243890000011', 77000);
    INSERT INTO transactions (id, user_id, account_id, kind, label, amount, status, created_at) VALUES ('tx_1', 'usr_1', 'acc_1', 'bill', 'Eau', 23000, 'success', 2);
    INSERT INTO external_orders (machine_id, order_id, machine_name, user_id, account_id, item, amount, currency, status, created_at) VALUES
      ('laverie-1', 'lav_abc', 'laverie-1', 'usr_1', 'acc_1', 'Commande', 1500, 'CDF', 'paid', 3),
      ('dist-1', 'ord_abc', 'Boissons', 'usr_1', 'acc_1', 'Cola', 1500, 'CDF', 'paid', 3);
  `);
  old.close();

  const db = openDb(path);
  assert.deepEqual({ ...db.prepare('SELECT balance, currency FROM accounts WHERE id = ?').get('acc_1') }, { balance: 77000, currency: 'CDF' });
  assert.equal(db.prepare('SELECT currency FROM transactions WHERE id = ?').get('tx_1').currency, 'CDF');
  // la nouvelle contrainte permet un compte USD sur le même numéro, pas un doublon
  db.prepare("INSERT INTO accounts (id, user_id, operator, label, phone, currency, balance) VALUES ('acc_2', 'usr_1', 'orange', 'Orange Money', '+243890000011', 'USD', 5000)").run();
  assert.throws(() =>
    db.prepare("INSERT INTO accounts (id, user_id, operator, label, phone, currency, balance) VALUES ('acc_3', 'usr_1', 'orange', 'Orange Money', '+243890000011', 'USD', 1)").run(),
  );
  // anciens QR machine conservés en CDF ; un QR peut désormais appartenir à un utilisateur (sans machine)
  assert.deepEqual({ ...db.prepare('SELECT machine_id, currency, status FROM qr_requests').get() }, { machine_id: 'DIST-1', currency: 'CDF', status: 'paid' });
  db.prepare("INSERT INTO qr_requests (nonce, payee_user_id, payee_account_id, amount, currency, item, expires_at) VALUES ('n2', 'usr_1', 'acc_1', 100, 'CDF', 'Course', 1)").run();
  // phases C et D : agents, machines connectées (anciennes machines : distributeur CDF sans propriétaire)
  assert.equal(db.prepare('SELECT is_agent FROM users').get().is_agent, 0);
  assert.deepEqual({ ...db.prepare('SELECT kind, currency, owner_user_id, last_seen_at FROM machines').get() }, { kind: 'vending', currency: 'CDF', owner_user_id: null, last_seen_at: 0 });
  db.prepare("UPDATE machines SET owner_user_id = 'usr_1'").run();
  db.prepare("INSERT INTO machine_slots (machine_id, slot, name, price) VALUES ('DIST-1', 1, 'Eau', 1000)").run();
  // cycles de laverie payés avant leur prise en charge : reconnus ; les commandes restent des commandes
  assert.deepEqual(db.prepare('SELECT order_id, kind, refunded, topup, topup_status FROM external_orders ORDER BY order_id').all().map((r) => [r.order_id, r.kind, r.refunded, r.topup, r.topup_status]), [['lav_abc', 'laundry', 0, 0, null], ['ord_abc', 'machine', 0, 0, null]]);
  // les clés étrangères pointent toujours vers la table des comptes
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
  openDb(path).close(); // une deuxième ouverture ne refait rien
  rmSync(dir, { recursive: true, force: true });
});
