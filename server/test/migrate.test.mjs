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
    INSERT INTO users VALUES ('usr_1', '+243890000011', 's', 'h', 0, 0, 1);
    INSERT INTO accounts VALUES ('acc_1', 'usr_1', 'orange', 'Orange Money', '+243890000011', 77000);
    INSERT INTO transactions (id, user_id, account_id, kind, label, amount, status, created_at) VALUES ('tx_1', 'usr_1', 'acc_1', 'bill', 'Eau', 23000, 'success', 2);
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
  // les clés étrangères pointent toujours vers la table des comptes
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
  openDb(path).close(); // une deuxième ouverture ne refait rien
  rmSync(dir, { recursive: true, force: true });
});
