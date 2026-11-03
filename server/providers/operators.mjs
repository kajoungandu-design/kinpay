/**
 * Aiguilleur des opérateurs : chaque compte KinPay est servi par l'API de son opérateur si elle est configurée
 * (Airtel : AIRTEL_*, M-Pesa : MPESA_*), sinon par le faux opérateur intégré (Orange, Africell...).
 *
 *   PROVIDER_MODULE=./providers/operators.mjs     (voir docs/INTEGRATION.md, section C)
 *
 * Comment l'argent circule chez un opérateur réel :
 *   - débit (payer, envoyer, retirer chez un agent) : encaissement USSD push, le client confirme avec son PIN ;
 *     l'argent arrive sur le compte marchand KinPay chez cet opérateur ;
 *   - crédit (vendeur, agent, destinataire, propriétaire de machine, remboursement) : versement B2C ;
 *   - client qui confirme après le délai : KinPay a répondu « non confirmé », l'encaissement est remboursé.
 * Montants KinPay en entiers (francs CDF, cents USD) ; les API opérateurs en unités (2.5 USD).
 */
import { MockProvider } from './mock.mjs';
import { findRecipient } from '../lib/db.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const toUnits = (amount, currency) => (currency === 'USD' ? amount / 100 : amount);
export const fromUnits = (value, currency) => Math.round(Number(value) * (currency === 'USD' ? 100 : 1));

export default class OperatorsProvider {
  constructor({ db, env }) {
    this.db = db;
    this.env = env;
    this.fallback = new MockProvider(db);
    this.apis = {};
    this.httpTimeoutMs = Number(env.HTTP_TIMEOUT_MS ?? 15_000);
    // Bac à sable : soldes des abonnés (l'API réelle ne les donne pas à un marchand) et machines rdcpay://.
    const origin = (u, suffix) => (u && u.includes(suffix) ? u.slice(0, u.indexOf(suffix)) : null);
    this.sandbox = env.SANDBOX_URL ?? origin(env.AIRTEL_BASE_URL, '/airtel') ?? origin(env.MPESA_BASE_URL, '/mpesa') ?? null;
  }

  /** Charge les API configurées (appelé une fois au démarrage par server.mjs, et par les tests). */
  async init() {
    if (this.env.AIRTEL_BASE_URL) {
      const { AirtelApi } = await import('./airtel.mjs');
      this.apis.airtel = new AirtelApi(this.env);
    }
    if (this.env.MPESA_BASE_URL) {
      const { MpesaApi } = await import('./mpesa.mjs');
      this.apis.mpesa = new MpesaApi(this.env);
    }
    return this;
  }

  /** Opérateurs branchés sur une vraie API (ceux qui peuvent payer une machine du réseau). */
  get operators() {
    return Object.keys(this.apis);
  }

  api = (account) => this.apis[account?.operator] ?? null;

  async subscriber(phone) {
    if (!this.sandbox) return null;
    const r = await fetch(this.sandbox + '/sandbox/phone/' + String(phone).replace(/^\+243/, ''), { signal: AbortSignal.timeout(this.httpTimeoutMs) });
    if (r.status === 404) return { missing: true };
    if (!r.ok) throw new Error('Bac à sable : HTTP ' + r.status);
    return r.json();
  }

  async link({ operator, phone, currency }) {
    const api = this.apis[operator];
    if (!api) return this.fallback.link({ operator, phone, currency });
    await api.ready(); // identifiants marchand valides ?
    const sub = await this.subscriber(phone);
    const refuse = (msg) => Object.assign(new Error(msg), { code: 'OPERATOR_REFUSED' });
    if (sub?.missing) throw refuse('Numéro inconnu chez ' + operator);
    if (sub && sub.operator && sub.operator !== operator) throw refuse('Ce numéro est chez ' + sub.operator);
    if (sub && sub.status !== 'ACTIVE') throw refuse('Compte bloqué');
    return { balance: sub ? fromUnits(sub.balances?.[currency] ?? 0, currency) : 0 };
  }

  /**
   * État du compte vu de l'opérateur, pour l'application :
   *   live = servi par la vraie API, demo = faux opérateur, unknown = numéro inconnu de l'opérateur, offline = opérateur injoignable.
   * Mis à jour à chaque lecture du solde.
   */
  accountStatus(account) {
    if (!this.api(account)) return 'demo';
    return this.statuses.get(account.id) ?? 'live';
  }

  statuses = new Map();

  async getBalance(account) {
    if (!this.api(account)) return this.fallback.getBalance(account);
    try {
      const sub = await this.subscriber(account.phone);
      if (sub && !sub.missing) {
        const balance = fromUnits(sub.balances?.[account.currency] ?? 0, account.currency);
        this.db.prepare('UPDATE accounts SET balance = ? WHERE id = ?').run(balance, account.id); // dernier solde connu
        this.statuses.set(account.id, sub.operator && sub.operator !== account.operator ? 'unknown' : 'live');
        return balance;
      }
      this.statuses.set(account.id, sub?.missing ? 'unknown' : 'live');
    } catch {
      // bac à sable injoignable : dernier solde connu
      this.statuses.set(account.id, 'offline');
    }
    return this.db.prepare('SELECT balance FROM accounts WHERE id = ?').get(account.id)?.balance ?? 0;
  }

  async payout({ account, amount, description }) {
    const api = this.api(account);
    if (!api) return this.fallback.payout({ account, amount, description });
    const r = await api.credit(account.phone, account.currency, amount, description);
    return r.ok ? { ok: true, balance: await this.getBalance(account) } : r;
  }

  async debit(account, amount, reference) {
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: 'INVALID_AMOUNT' };
    const api = this.api(account);
    if (api) return api.debit(account.phone, account.currency, amount, reference);
    return this.fallback.pay({ account, amount });
  }

  async undo(account, amount, debit) {
    const api = this.api(account);
    if (api && debit.ref) await api.refund(debit.ref, account.currency);
    else if (!api) await this.fallback.payout({ account, amount });
  }

  /** reference : numéro de commande d'une machine du réseau (rdcpay), transmis tel quel à l'opérateur. */
  async pay({ account, amount, description, creditAccountId, reference }) {
    const r = await this.debit(account, amount, reference ?? description);
    if (!r.ok) return r;
    if (creditAccountId) {
      const seller = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(creditAccountId);
      if (seller) {
        const p = await this.payout({ account: seller, amount, description: 'KinPay ' + (description ?? '') });
        if (!p.ok) console.error('Versement à ' + creditAccountId + ' échoué (' + p.reason + ') : à régulariser.');
      }
    }
    return { ok: true, balance: await this.getBalance(account) };
  }

  async transfer({ account, toPhone, amount }) {
    const r = await this.debit(account, amount, 'Transfert KinPay');
    if (!r.ok) return r;
    const to = findRecipient(this.db, toPhone, account.currency, { excludeId: account.id, operator: account.operator });
    const api = this.api(account);
    let credited;
    if (to) credited = await this.payout({ account: to, amount, description: 'Transfert KinPay' });
    else if (api) credited = await api.credit(toPhone, account.currency, amount, 'Transfert KinPay'); // numéro hors KinPay, même opérateur
    else credited = { ok: true }; // faux opérateur : simple débit, comme avant
    if (!credited.ok) {
      await this.undo(account, amount, r); // bénéficiaire impossible à créditer : l'expéditeur est remboursé
      return { ok: false, reason: 'UNKNOWN_ACCOUNT' };
    }
    return { ok: true, balance: await this.getBalance(account) };
  }
}
