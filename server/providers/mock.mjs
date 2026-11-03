/**
 * Faux opérateur Mobile Money : les soldes vivent dans la table `accounts`. Aucun argent réel.
 *
 * C'est le CONTRAT que chaque vrai opérateur doit respecter (voir providers/real.example.mjs) :
 *   link({ operator, phone, currency })     -> { balance }   (montants en unités entières : francs CDF, cents USD)
 *   getBalance({ id, operator, phone })     -> number
 *   transfer({ account, toPhone, amount })  -> { ok: true, balance } | { ok: false, reason }   (même devise que account)
 *   pay({ account, amount, description, creditAccountId? }) -> { ok: true, balance } | { ok: false, reason }   (creditAccountId : vendeur KinPay à créditer)
 *   payout({ account, amount, description }) -> { ok: true, balance } | { ok: false, reason }   (versement du séquestre KinPay vers un compte)
 */
export class MockProvider {
  constructor(db) {
    this.db = db;
  }

  async link({ currency }) {
    return { balance: currency === 'USD' ? 5000 : 100000 }; // solde de démonstration : 50,00 USD ou 100 000 CDF
  }

  async getBalance(account) {
    const row = this.db.prepare('SELECT balance FROM accounts WHERE id = ?').get(account.id);
    return row ? row.balance : 0;
  }

  async transfer({ account, toPhone, amount }) {
    return this.#move(account.id, amount, toPhone, account.currency ?? 'CDF');
  }

  /** creditAccountId : compte KinPay du vendeur, crédité dans la même transaction (paiement d'un QR utilisateur). */
  async pay({ account, amount, creditAccountId }) {
    return this.#move(account.id, amount, null, account.currency ?? 'CDF', creditAccountId);
  }

  /**
   * Versement depuis le compte marchand KinPay (séquestre) vers un compte : vente machine confirmée
   * (propriétaire crédité) ou remboursement du client. Chez un vrai opérateur : API de « disbursement ».
   */
  async payout({ account, amount }) {
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: 'INVALID_AMOUNT' };
    const r = this.db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?').run(amount, account.id);
    if (Number(r.changes) !== 1) return { ok: false, reason: 'UNKNOWN_ACCOUNT' };
    return { ok: true, balance: this.db.prepare('SELECT balance FROM accounts WHERE id = ?').get(account.id).balance };
  }

  #move(accountId, amount, creditPhone, currency, creditAccountId) {
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
        db.prepare('UPDATE accounts SET balance = balance + ? WHERE phone = ? AND currency = ? AND id <> ?').run(amount, creditPhone, currency, accountId);
      }
      if (creditAccountId) {
        db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ? AND currency = ?').run(amount, creditAccountId, currency);
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
