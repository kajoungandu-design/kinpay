/**
 * Airtel Money (Airtel Africa Open API), testé avec le simulateur « RDC Mobile Money Sandbox ».
 * Ce fichier ne parle qu'à Airtel ; l'aiguillage entre opérateurs est dans providers/operators.mjs.
 *
 * server/.env :
 *   AIRTEL_BASE_URL=http://localhost:4010/airtel
 *   AIRTEL_CLIENT_ID=kinpay-airtel
 *   AIRTEL_CLIENT_SECRET=kinpay-airtel-secret
 *   AIRTEL_COUNTRY=CD
 *   AIRTEL_CURRENCY=CDF
 *
 * Débit = « collection » (USSD push : le client confirme avec son PIN), suivie par le statut (TS réussi, TF échec).
 * Crédit = « disbursement » B2C depuis le compte marchand KinPay. Montants Airtel en unités (2.5 USD).
 */
import { randomUUID } from 'node:crypto';
import { sleep, toUnits } from './operators.mjs';

export class AirtelApi {
  constructor(env) {
    this.base = String(env.AIRTEL_BASE_URL ?? '').replace(/\/+$/, '');
    this.clientId = env.AIRTEL_CLIENT_ID;
    this.clientSecret = env.AIRTEL_CLIENT_SECRET;
    if (!this.base || !this.clientId || !this.clientSecret) throw new Error('AIRTEL_BASE_URL, AIRTEL_CLIENT_ID et AIRTEL_CLIENT_SECRET sont obligatoires (server/.env)');
    this.country = env.AIRTEL_COUNTRY ?? 'CD';
    this.defaultCurrency = env.AIRTEL_CURRENCY ?? 'CDF';
    this.confirmTimeoutMs = Number(env.AIRTEL_CONFIRM_TIMEOUT_MS ?? env.CONFIRM_TIMEOUT_MS ?? 50_000);
    this.pollMs = Number(env.AIRTEL_POLL_MS ?? env.POLL_MS ?? 1000);
    this.httpTimeoutMs = Number(env.HTTP_TIMEOUT_MS ?? 15_000);
    this.token = null;
  }

  msisdn = (phone) => String(phone).replace(/^\+243/, '');

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

  /** Erreur réseau ou 5xx : exception (résultat inconnu). */
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

  /** Vérifie que les identifiants marchand sont acceptés. */
  async ready() {
    await this.accessToken();
  }

  /** Collection : { ok: true, ref } | { ok: false, reason } ; ref sert au remboursement. */
  async debit(phone, currency, amount, reference) {
    const id = 'kp-' + randomUUID();
    const start = await this.call('POST', '/merchant/v1/payments/', {
      currency,
      body: {
        reference: String(reference ?? 'KinPay').slice(0, 64),
        subscriber: { country: this.country, currency, msisdn: this.msisdn(phone) },
        transaction: { amount: toUnits(amount, currency), country: this.country, currency, id },
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
      if (tx?.status === 'TS') return { ok: true, ref: tx.airtel_money_id };
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
        const tx = (await this.call('GET', '/standard/v1/payments/' + encodeURIComponent(id), { currency })).json?.data?.transaction;
        if (tx?.status === 'TF') return;
        if (tx?.status === 'TS') {
          await this.refund(tx.airtel_money_id, currency);
          console.log('Airtel : collection ' + id + ' confirmée trop tard, remboursée.');
          return;
        }
      } catch {
        // on réessaie
      }
    }
  }

  async refund(ref, currency) {
    await this.call('POST', '/standard/v1/payments/refund', { currency, body: { transaction: { airtel_money_id: ref } } }).catch(() => {});
  }

  /** Disbursement B2C : { ok: true } | { ok: false, reason }. */
  async credit(phone, currency, amount, description) {
    const id = 'kp-po-' + randomUUID();
    const r = await this.call('POST', '/standard/v1/disbursements/', {
      currency,
      body: {
        payee: { msisdn: this.msisdn(phone), wallet_type: 'NORMAL' },
        reference: String(description ?? 'KinPay').slice(0, 64),
        pin: '',
        transaction: { amount: toUnits(amount, currency), id, type: 'B2C' },
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
}

// Compatibilité : PROVIDER_MODULE=./providers/airtel.mjs fonctionne toujours (aiguilleur complet).
export { default } from './operators.mjs';
