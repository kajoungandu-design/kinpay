/**
 * Adaptateur HTTP vers un réseau Mobile Money externe : simulateur de réseau, agrégateur ou opérateur.
 *
 * Activation (server/.env) :
 *   PROVIDER_MODULE=./providers/http-network.mjs
 *   NETWORK_API_URL=http://localhost:4000      (adresse de l'API du simulateur)
 *   NETWORK_API_KEY=...                         (envoyée en « Authorization: Bearer ... »)
 *
 * CONTRAT attendu côté réseau (montants entiers : francs CDF, cents USD) — voir docs/INTEGRATION.md :
 *   POST /accounts/verify   { operator, phone, currency }                                   -> { balance }
 *   POST /accounts/balance  { operator, phone, currency }                                   -> { balance }
 *   POST /transfers         { reference, operator, phone, currency, amount, toPhone }       -> { ok: true, balance } | { ok: false, reason }
 *   POST /payments          { reference, operator, phone, currency, amount, description }   -> { ok: true, balance } | { ok: false, reason }
 *   POST /payouts           { reference, operator, phone, currency, amount, description }   -> { ok: true, balance } | { ok: false, reason }
 * reason : INSUFFICIENT_FUNDS | INVALID_AMOUNT | UNKNOWN_ACCOUNT. « reference » est unique : un rejeu ne débite pas deux fois.
 *
 * Si l'API de votre simulateur a d'autres noms ou formats, modifiez seulement la fonction `call` et les 5 méthodes ci-dessous.
 */
import { randomUUID } from 'node:crypto';

const REASONS = ['INSUFFICIENT_FUNDS', 'INVALID_AMOUNT', 'UNKNOWN_ACCOUNT'];

export default class HttpNetworkProvider {
  constructor({ db, env }) {
    this.db = db;
    this.baseUrl = String(env.NETWORK_API_URL ?? '').replace(/\/+$/, '');
    this.apiKey = env.NETWORK_API_KEY ?? '';
    this.timeoutMs = Number(env.NETWORK_TIMEOUT_MS ?? 15000);
    if (!this.baseUrl) throw new Error('NETWORK_API_URL manquant dans server/.env');
  }

  /** Un appel au réseau. Délai dépassé ou erreur serveur : exception = résultat inconnu (l'opération reste « pending »). */
  async call(path, body) {
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: 'Bearer ' + this.apiKey } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = await res.json().catch(() => null);
    if (res.status >= 500 || !json) throw new Error('Réseau : HTTP ' + res.status);
    return json;
  }

  result(json) {
    if (json.ok === true && Number.isInteger(json.balance)) return { ok: true, balance: json.balance };
    return { ok: false, reason: REASONS.includes(json.reason) ? json.reason : 'UNKNOWN_ACCOUNT' };
  }

  async link({ operator, phone, currency }) {
    const json = await this.call('/accounts/verify', { operator, phone, currency });
    if (!Number.isInteger(json.balance)) throw new Error('Compte refusé par le réseau');
    return { balance: json.balance };
  }

  async getBalance(account) {
    try {
      const json = await this.call('/accounts/balance', { operator: account.operator, phone: account.phone, currency: account.currency });
      return Number.isInteger(json.balance) ? json.balance : 0;
    } catch {
      // Réseau injoignable : dernier solde connu plutôt qu'une erreur sur tout l'écran d'accueil.
      return this.db.prepare('SELECT balance FROM accounts WHERE id = ?').get(account.id)?.balance ?? 0;
    }
  }

  async transfer({ account, toPhone, amount }) {
    const json = await this.call('/transfers', { reference: randomUUID(), operator: account.operator, phone: account.phone, currency: account.currency, amount, toPhone });
    return this.result(json);
  }

  /** creditAccountId : vendeur ou agent KinPay à créditer après le débit du client (paiement QR, retrait agent). */
  async pay({ account, amount, description, creditAccountId }) {
    const r = this.result(await this.call('/payments', { reference: randomUUID(), operator: account.operator, phone: account.phone, currency: account.currency, amount, description }));
    if (r.ok && creditAccountId) {
      const seller = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(creditAccountId);
      if (seller) await this.payout({ account: seller, amount, description: 'Encaissement ' + (description ?? '') });
    }
    return r;
  }

  async payout({ account, amount, description }) {
    return this.result(await this.call('/payouts', { reference: randomUUID(), operator: account.operator, phone: account.phone, currency: account.currency, amount, description }));
  }
}
