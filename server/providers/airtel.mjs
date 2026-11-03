/**
 * Airtel Money (Airtel Africa Open API), testé avec le simulateur « RDC Mobile Money Sandbox ».
 * Comptes Airtel → API Airtel. Autres opérateurs (Orange, M-Pesa, Africell) → faux opérateur intégré, en attendant leur API.
 *
 * server/.env :
 *   PROVIDER_MODULE=./providers/airtel.mjs
 *   AIRTEL_BASE_URL=http://localhost:4010/airtel
 *   AIRTEL_CLIENT_ID=kinpay-airtel
 *   AIRTEL_CLIENT_SECRET=kinpay-airtel-secret
 *   AIRTEL_COUNTRY=CD
 *   AIRTEL_CURRENCY=CDF                 (devise par défaut ; chaque compte KinPay envoie sa propre devise)
 *   AIRTEL_SANDBOX_URL=http://localhost:4010   (facultatif : solde des abonnés, propre au bac à sable ; déduit de AIRTEL_BASE_URL)
 *   AIRTEL_CONFIRM_TIMEOUT_MS=50000     (temps laissé au client pour taper son PIN sur le téléphone)
 *
 * Comment l'argent circule :
 *   - pay / transfer : « collection » (USSD push). Le client confirme avec son PIN Airtel, l'argent arrive sur le
 *     compte marchand KinPay chez Airtel. On interroge le statut chaque seconde (TS = réussi, TF = échec).
 *   - payout (vendeur, agent, propriétaire de machine, remboursement) : « disbursement » B2C depuis le compte marchand.
 *   - Si le client ne confirme pas à temps : on répond NOT_CONFIRMED, et si la collection réussit plus tard,
 *     elle est remboursée automatiquement (le client n'est jamais débité sans opération KinPay).
 *
 * Montants : KinPay compte en entiers (francs CDF, cents USD) ; l'API Airtel en unités (2.5 USD).
 */
import { randomUUID } from 'node:crypto';
import { MockProvider } from './mock.mjs';
import { findRecipient } from '../lib/db.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default class AirtelProvider {
  constructor({ db, env }) {
    this.db = db;
    this.base = String(env.AIRTEL_BASE_URL ?? '').replace(/\/+$/, '');
    this.clientId = env.AIRTEL_CLIENT_ID;
    this.clientSecret = env.AIRTEL_CLIENT_SECRET;
    if (!this.base || !this.clientId || !this.clientSecret) throw new Error('AIRTEL_BASE_URL, AIRTEL_CLIENT_ID et AIRTEL_CLIENT_SECRET sont obligatoires (server/.env)');
    this.country = env.AIRTEL_COUNTRY ?? 'CD';
    this.defaultCurrency = env.AIRTEL_CURRENCY ?? 'CDF';
    this.confirmTimeoutMs = Number(env.AIRTEL_CONFIRM_TIMEOUT_MS ?? 50_000);
    this.pollMs = Number(env.AIRTEL_POLL_MS ?? 1000);
    this.httpTimeoutMs = Number(env.AIRTEL_HTTP_TIMEOUT_MS ?? 15_000);
    // Bac à sable uniquement : l'API Airtel réelle ne donne pas le solde d'un abonné à un marchand.
    this.sandbox = env.AIRTEL_SANDBOX_URL ?? (this.base.endsWith('/airtel') ? this.base.slice(0, -'/airtel'.length) : null);
    this.fallback = new MockProvider(db);
    this.token = null;
  }

  isAirtel = (account) => account?.operator === 'airtel';
  msisdn = (phone) => String(phone).replace(/^\+243/, '');
  toApi = (amount, currency) => (currency === 'USD' ? amount / 100 : amount);
  fromApi = (value, currency) => Math.round(Number(value) * (currency === 'USD' ? 100 : 1));

  // ---------- HTTP ----------

  async accessToken(force = false) {
    if (!force && this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const r = await fetch(this.base + '/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: '*/*' },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.access_token) throw new Error('Airtel : jeton refusé (' + r.status + ')');
    this.token = { value: j.access_token, expiresAt: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** Appel API Airtel. Erreur réseau ou 5xx : exception (résultat inconnu). */
  async call(method, path, { body, currency } = {}, retried = false) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: '*/*',
        authorization: 'Bearer ' + (await this.accessToken()),
        'X-Country': this.country,
        'X-Currency': currency ?? this.defaultCurrency,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (res.status === 401 && !retried) {
      this.token = null;
      return this.call(method, path, { body, currency }, true);
    }
    const json = await res.json().catch(() => null);
    if (res.status >= 500 || !json) throw new Error('Airtel : HTTP ' + res.status);
    return { status: res.status, json };
  }

  reasonOf(message, sandboxReason) {
    const m = String(message ?? '').toLowerCase();
    if (sandboxReason === 'INSUFFICIENT_FUNDS' || m.includes('balance')) return 'INSUFFICIENT_FUNDS';
    if (m.includes('barred') || m.includes('not found') || m.includes('invalid msisdn')) return 'UNKNOWN_ACCOUNT';
    return 'PAYMENT_DECLINED';
  }

  // ---------- comptes ----------

  async subscriber(phone) {
    if (!this.sandbox) return null;
    const r = await fetch(this.sandbox + '/sandbox/phone/' + this.msisdn(phone), { signal: AbortSignal.timeout(this.httpTimeoutMs) });
    if (r.status === 404) return { missing: true };
    if (!r.ok) throw new Error('Bac à sable : HTTP ' + r.status);
    return r.json();
  }

  async link({ operator, phone, currency }) {
    if (operator !== 'airtel') return this.fallback.link({ operator, phone, currency });
    await this.accessToken(); // identifiants marchand valides ?
    const sub = await this.subscriber(phone);
    if (sub?.missing) throw Object.assign(new Error('Numéro inconnu chez Airtel'), { code: 'OPERATOR_REFUSED' });
    if (sub && sub.status !== 'ACTIVE') throw Object.assign(new Error('Compte Airtel bloqué'), { code: 'OPERATOR_REFUSED' });
    return { balance: sub ? this.fromApi(sub.balances?.[currency] ?? 0, currency) : 0 };
  }

  async getBalance(account) {
    if (!this.isAirtel(account)) return this.fallback.getBalance(account);
    try {
      const sub = await this.subscriber(account.phone);
      if (sub && !sub.missing) {
        const balance = this.fromApi(sub.balances?.[account.currency] ?? 0, account.currency);
        this.db.prepare('UPDATE accounts SET balance = ? WHERE id = ?').run(balance, account.id); // dernier solde connu
        return balance;
      }
    } catch {
      // bac à sable injoignable : dernier solde connu
    }
    return this.db.prepare('SELECT balance FROM accounts WHERE id = ?').get(account.id)?.balance ?? 0;
  }

  // ---------- débit (collection USSD push) ----------

  async collect(account, amount, reference) {
    const id = 'kp-' + randomUUID();
    const currency = account.currency;
    const start = await this.call('POST', '/merchant/v1/payments/', {
      currency,
      body: {
        reference: String(reference ?? 'KinPay').slice(0, 64),
        subscriber: { country: this.country, currency, msisdn: this.msisdn(account.phone) },
        transaction: { amount: this.toApi(amount, currency), country: this.country, currency, id },
      },
    });
    if (!start.json?.status?.success) return { ok: false, reason: this.reasonOf(start.json?.status?.message) };
    const deadline = Date.now() + this.confirmTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.pollMs);
      let st;
      try {
        st = await this.call('GET', '/standard/v1/payments/' + encodeURIComponent(id), { currency });
      } catch {
        continue; // coupure passagère : on réessaie jusqu'au délai
      }
      const tx = st.json?.data?.transaction;
      if (tx?.status === 'TS') return { ok: true, airtelId: tx.airtel_money_id };
      if (tx?.status === 'TF') return { ok: false, reason: this.reasonOf(tx.message, st.json?.data?.x_sandbox?.reason) };
    }
    this.refundIfLate(id, currency);
    return { ok: false, reason: 'NOT_CONFIRMED' };
  }

  /** Le client confirme après notre délai : KinPay a déjà répondu « non confirmé », donc on le rembourse. */
  async refundIfLate(id, currency) {
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until) {
      await sleep(5000);
      try {
        const st = await this.call('GET', '/standard/v1/payments/' + encodeURIComponent(id), { currency });
        const tx = st.json?.data?.transaction;
        if (tx?.status === 'TF') return;
        if (tx?.status === 'TS') {
          await this.call('POST', '/standard/v1/payments/refund', { currency, body: { transaction: { airtel_money_id: tx.airtel_money_id } } });
          console.log('Airtel : collection ' + id + ' confirmée trop tard, remboursée.');
          return;
        }
      } catch {
        // on réessaie
      }
    }
  }

  async refund(airtelId, currency) {
    await this.call('POST', '/standard/v1/payments/refund', { currency, body: { transaction: { airtel_money_id: airtelId } } }).catch(() => {});
  }

  // ---------- versement (disbursement B2C) ----------

  async disburse(phone, currency, amount, description) {
    const id = 'kp-po-' + randomUUID();
    const r = await this.call('POST', '/standard/v1/disbursements/', {
      currency,
      body: {
        payee: { msisdn: this.msisdn(phone), wallet_type: 'NORMAL' },
        reference: String(description ?? 'KinPay').slice(0, 64),
        pin: '',
        transaction: { amount: this.toApi(amount, currency), id, type: 'B2C' },
      },
    });
    let tx = r.json?.data?.transaction;
    if (!r.json?.status?.success) return { ok: false, reason: this.reasonOf(r.json?.status?.message) };
    for (let i = 0; tx?.status === 'TIP' && i < 30; i++) {
      await sleep(this.pollMs);
      tx = (await this.call('GET', '/standard/v1/disbursements/' + encodeURIComponent(id), { currency })).json?.data?.transaction ?? tx;
    }
    return tx?.status === 'TS' ? { ok: true } : { ok: false, reason: this.reasonOf(tx?.message) };
  }

  // ---------- contrat KinPay ----------

  async payout({ account, amount, description }) {
    if (!this.isAirtel(account)) return this.fallback.payout({ account, amount, description });
    const r = await this.disburse(account.phone, account.currency, amount, description);
    return r.ok ? { ok: true, balance: await this.getBalance(account) } : r;
  }

  async debit(account, amount, reference) {
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: 'INVALID_AMOUNT' };
    if (this.isAirtel(account)) return this.collect(account, amount, reference);
    return this.fallback.pay({ account, amount });
  }

  /** reference : identifiant de commande d'une machine du réseau (rdcpay), transmis tel quel à Airtel. */
  async pay({ account, amount, description, creditAccountId, reference }) {
    const r = await this.debit(account, amount, reference ?? description);
    if (!r.ok) return r;
    if (creditAccountId) {
      const seller = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(creditAccountId);
      if (seller) {
        const p = await this.payout({ account: seller, amount, description: 'KinPay ' + (description ?? '') });
        if (!p.ok) console.error('Versement au vendeur ' + creditAccountId + ' échoué (' + p.reason + ') : à régulariser.');
      }
    }
    return { ok: true, balance: await this.getBalance(account) };
  }

  async transfer({ account, toPhone, amount }) {
    const r = await this.debit(account, amount, 'Transfert KinPay');
    if (!r.ok) return r;
    const to = findRecipient(this.db, toPhone, account.currency, { excludeId: account.id, operator: account.operator });
    let credited;
    if (to) credited = await this.payout({ account: to, amount, description: 'Transfert KinPay' });
    else if (this.isAirtel(account)) credited = await this.disburse(toPhone, account.currency, amount, 'Transfert KinPay'); // numéro Airtel hors KinPay
    else credited = { ok: true }; // faux opérateur : simple débit, comme avant
    if (!credited.ok) {
      // Bénéficiaire impossible à créditer : l'expéditeur est remboursé.
      if (r.airtelId) await this.refund(r.airtelId, account.currency);
      else await this.fallback.payout({ account, amount });
      return { ok: false, reason: 'UNKNOWN_ACCOUNT' };
    }
    return { ok: true, balance: await this.getBalance(account) };
  }
}
