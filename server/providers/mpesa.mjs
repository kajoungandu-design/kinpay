/**
 * Vodacom M-Pesa RDC (OpenAPI IPG v2), testé avec le simulateur « RDC Mobile Money Sandbox ».
 * Ce fichier ne parle qu'à M-Pesa ; l'aiguillage entre opérateurs est dans providers/operators.mjs.
 *
 * server/.env :
 *   MPESA_BASE_URL=http://localhost:4010/mpesa/openapi/ipg/v2/vodacomDRC
 *   MPESA_API_KEY=kinpay-mpesa-api-key
 *   MPESA_SERVICE_PROVIDER_CODE=171717
 *   MPESA_COUNTRY=DRC
 *
 * Session : GET /getSession/ (Bearer = clé API) → SessionID, valable 1 heure, puis Bearer = SessionID.
 * Débit = C2B singleStage (USSD push, statut suivi par queryTransactionStatus : Completed / Failed / Expired).
 * Crédit = B2C. Remboursement = reversal. Montants en texte à 2 décimales (« 2500.00 », « 2.50 »).
 * En production, Vodacom demande la clé API chiffrée avec sa clé publique RSA : à ajouter dans sessionKey().
 */
import { randomUUID } from 'node:crypto';
import { sleep, toUnits } from './operators.mjs';

const conversationId = () => 'kp' + randomUUID().replace(/-/g, '').slice(0, 24);
// input_TransactionReference : 20 caractères au maximum, sans espace.
const cleanRef = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'KINPAY';

export class MpesaApi {
  constructor(env) {
    this.base = String(env.MPESA_BASE_URL ?? '').replace(/\/+$/, '');
    this.apiKey = env.MPESA_API_KEY;
    this.spCode = env.MPESA_SERVICE_PROVIDER_CODE;
    if (!this.base || !this.apiKey || !this.spCode) throw new Error('MPESA_BASE_URL, MPESA_API_KEY et MPESA_SERVICE_PROVIDER_CODE sont obligatoires (server/.env)');
    this.country = env.MPESA_COUNTRY ?? 'DRC';
    this.confirmTimeoutMs = Number(env.MPESA_CONFIRM_TIMEOUT_MS ?? env.CONFIRM_TIMEOUT_MS ?? 50_000);
    this.pollMs = Number(env.MPESA_POLL_MS ?? env.POLL_MS ?? 1000);
    this.httpTimeoutMs = Number(env.HTTP_TIMEOUT_MS ?? 15_000);
    this.session = null;
  }

  msisdn = (phone) => String(phone).replace(/^\+/, ''); // 243XXXXXXXXX
  amountText = (amount, currency) => toUnits(amount, currency).toFixed(2);

  sessionKey() {
    return this.apiKey; // bac à sable : clé en clair
  }

  async sessionId(force = false) {
    if (!force && this.session && this.session.expiresAt > Date.now() + 60_000) return this.session.value;
    const r = await fetch(this.base + '/getSession/', {
      headers: { authorization: 'Bearer ' + this.sessionKey(), origin: '*' },
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    const j = await r.json().catch(() => null);
    if (!j?.output_SessionID) throw new Error('M-Pesa : session refusée (' + r.status + ' ' + (j?.output_ResponseCode ?? '') + ')');
    this.session = { value: j.output_SessionID, expiresAt: Date.now() + 3600_000 };
    return this.session.value;
  }

  /** Erreur réseau ou 5xx : exception (résultat inconnu). */
  async call(method, path, body, retried = false) {
    const url = this.base + path + (method === 'GET' && body ? '?' + new URLSearchParams(body) : '');
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (await this.sessionId()), origin: '*' },
      body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (res.status === 401 && !retried) {
      this.session = null;
      return this.call(method, path, body, true);
    }
    const json = await res.json().catch(() => null);
    if (res.status >= 500 || !json) throw new Error('M-Pesa : HTTP ' + res.status);
    return json;
  }

  reasonOf(code) {
    if (code === 'INS-2006') return 'INSUFFICIENT_FUNDS';
    if (code === 'INS-996' || code === 'INS-2051' || code === 'INS-2001') return 'UNKNOWN_ACCOUNT';
    return 'PAYMENT_DECLINED'; // INS-5 refus, INS-6 PIN faux, INS-9 délai, INS-1 erreur
  }

  async ready() {
    await this.sessionId();
  }

  /** C2B : { ok: true, ref } | { ok: false, reason } ; ref = TransactionID (pour le reversal). */
  async debit(phone, currency, amount, reference) {
    const start = await this.call('POST', '/c2bPayment/singleStage/', {
      input_Amount: this.amountText(amount, currency),
      input_Country: this.country,
      input_Currency: currency,
      input_CustomerMSISDN: this.msisdn(phone),
      input_ServiceProviderCode: this.spCode,
      input_ThirdPartyConversationID: conversationId(),
      input_TransactionReference: cleanRef(reference),
      input_PurchasedItemsDesc: String(reference ?? 'KinPay').slice(0, 60),
    });
    const id = start.output_TransactionID;
    if (start.output_ResponseCode !== 'INS-0' || !id) return { ok: false, reason: this.reasonOf(start.output_ResponseCode) };
    const deadline = Date.now() + this.confirmTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.pollMs);
      let st;
      try {
        st = await this.status(id);
      } catch {
        continue;
      }
      if (st.output_ResponseTransactionStatus === 'Completed') return { ok: true, ref: id };
      if (['Failed', 'Expired', 'Reversed'].includes(st.output_ResponseTransactionStatus)) return { ok: false, reason: this.reasonOf(st.output_ResultCode) };
    }
    this.refundIfLate(id);
    return { ok: false, reason: 'NOT_CONFIRMED' };
  }

  status(id) {
    return this.call('GET', '/queryTransactionStatus/', {
      input_QueryReference: id,
      input_ServiceProviderCode: this.spCode,
      input_ThirdPartyConversationID: conversationId(),
      input_Country: this.country,
    });
  }

  async refundIfLate(id) {
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until) {
      await sleep(5000);
      try {
        const s = (await this.status(id)).output_ResponseTransactionStatus;
        if (s === 'Failed' || s === 'Expired' || s === 'Reversed') return;
        if (s === 'Completed') {
          await this.refund(id);
          console.log('M-Pesa : encaissement ' + id + ' confirmé trop tard, remboursé.');
          return;
        }
      } catch {
        // on réessaie
      }
    }
  }

  async refund(ref) {
    await this.call('PUT', '/reversal/', {
      input_TransactionID: ref,
      input_Country: this.country,
      input_ServiceProviderCode: this.spCode,
      input_ThirdPartyConversationID: conversationId(),
    }).catch(() => {});
  }

  /** B2C : { ok: true } | { ok: false, reason }. */
  async credit(phone, currency, amount, description) {
    const r = await this.call('POST', '/b2cPayment/', {
      input_Amount: this.amountText(amount, currency),
      input_Country: this.country,
      input_Currency: currency,
      input_CustomerMSISDN: this.msisdn(phone),
      input_ServiceProviderCode: this.spCode,
      input_ThirdPartyConversationID: conversationId(),
      input_TransactionReference: cleanRef(description),
      input_PaymentItemsDesc: String(description ?? 'KinPay').slice(0, 60),
    });
    return r.output_ResponseCode === 'INS-0' ? { ok: true } : { ok: false, reason: this.reasonOf(r.output_ResponseCode) };
  }
}
