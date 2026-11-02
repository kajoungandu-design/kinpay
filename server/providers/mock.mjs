/**
 * Faux opérateur Mobile Money : les soldes vivent dans la table `accounts`. Aucun argent réel.
 *
 * C'est le CONTRAT que chaque vrai opérateur doit respecter (voir providers/real.example.mjs) :
 *   link({ operator, phone })               -> { balance }
 *   getBalance({ id, operator, phone })     -> number
 *   transfer({ account, toPhone, amount })  -> { ok: true, balance } | { ok: false, reason }
 *   pay({ account, amount, description })   -> { ok: true, balance } | { ok: false, reason }
 */
export class MockProvider {
  constructor(db) {
    this.db = db;
  }

  async link() {
    return { balance: 100000 }; // solde de démonstration
  }

  async getBalance(account) {
    const row = this.db.prepare('SELECT balance FROM accounts WHERE id = ?').get(account.id);
    return row ? row.balance : 0;
  }

  async transfer({ account, toPhone, amount }) {
    return this.#move(account.id, amount, toPhone);
  }

  async pay({ account, amount }) {
    return this.#move(account.id, amount, null);
  }

  #move(accountId, amount, creditPhone) {
    const db = this.db;
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: 'INVALID_AMOUNT' };
    db.exec('BEGIN IMMEDIATE');
    try {
      const acc = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(accountId);
      if (!acc) {
        db.exec('ROLLBACK');
        return { ok: false, reason: 'UNKNOWN_ACCOUNT' };
      }
      if (acc.balance < amount) {
        db.exec('ROLLBACK');
        return { ok: false, reason: 'INSUFFICIENT_FUNDS' };
      }
      db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?').run(amount, accountId);
      if (creditPhone) {
        db.prepare('UPDATE accounts SET balance = balance + ? WHERE phone = ? AND id <> ?').run(amount, creditPhone, accountId);
      }
      const { balance } = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(accountId);
      db.exec('COMMIT');
      return { ok: true, balance };
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw e;
    }
  }
}
