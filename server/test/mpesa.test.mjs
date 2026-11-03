// providers/mpesa.mjs (via l'aiguilleur operators.mjs) contre un faux M-Pesa au format OpenAPI IPG v2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../app.mjs';
import { openDb } from '../lib/db.mjs';
import { ConsoleSms } from '../lib/sms.mjs';
import OperatorsProvider from '../providers/operators.mjs';

async function fakeMpesa() {
  const wallets = new Map([
    ['243810000001', { CDF: 100000, USD: 50 }],
    ['243810000002', { CDF: 0, USD: 0 }],
    ['243811234567', { CDF: 1000, USD: 0 }],
  ]);
  const txs = new Map();
  const seen = { sessions: 0, refs: [] };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = new URL(req.url, 'http://x');
    const b = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams);
    const send = (status, j) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(j));
    };
    const p = url.pathname.replace('/mpesa/openapi/ipg/v2/vodacomDRC', '');
    if (p === '/getSession/') {
      if (req.headers.authorization !== 'Bearer cle') return send(401, { output_ResponseCode: 'INS-2' });
      seen.sessions++;
      return send(201, { output_ResponseCode: 'INS-0', output_SessionID: 'sess' });
    }
    if (p.startsWith('/') && !url.pathname.startsWith('/sandbox') && req.headers.authorization !== 'Bearer sess') return send(401, { output_ResponseCode: 'INS-2' });
    if (p === '/c2bPayment/singleStage/') {
      const w = wallets.get(b.input_CustomerMSISDN);
      if (!w) return send(400, { output_ResponseCode: 'INS-2051' });
      seen.refs.push(b.input_TransactionReference);
      const id = 'T' + txs.size;
      const amount = Number(b.input_Amount);
      const okPay = w[b.input_Currency] >= amount;
      if (okPay) w[b.input_Currency] -= amount;
      txs.set(id, { status: okPay ? 'Completed' : 'Failed', code: okPay ? 'INS-0' : 'INS-2006', m: b.input_CustomerMSISDN, amount, cur: b.input_Currency });
      return send(201, { output_ResponseCode: 'INS-0', output_TransactionID: id, output_TransactionStatus: 'Pending' });
    }
    if (p === '/queryTransactionStatus/') {
      const t = txs.get(b.input_QueryReference);
      return send(200, { output_ResponseCode: 'INS-0', output_ResponseTransactionStatus: t.status, output_ResultCode: t.code });
    }
    if (p === '/b2cPayment/') {
      const w = wallets.get(b.input_CustomerMSISDN);
      if (!w) return send(400, { output_ResponseCode: 'INS-2051' });
      w[b.input_Currency] += Number(b.input_Amount);
      return send(201, { output_ResponseCode: 'INS-0' });
    }
    if (p === '/reversal/') {
      const t = txs.get(b.input_TransactionID);
      wallets.get(t.m)[t.cur] += t.amount;
      t.status = 'Reversed';
      return send(201, { output_ResponseCode: 'INS-0' });
    }
    const ph = /^\/sandbox\/phone\/(\d+)$/.exec(url.pathname);
    if (ph) {
      const w = wallets.get('243' + ph[1]);
      return w ? send(200, { operator: 'mpesa', status: 'ACTIVE', balances: w }) : send(404, {});
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  return { url: 'http://127.0.0.1:' + server.address().port, wallets, seen, close: () => server.close() };
}

test('M-Pesa : session, C2B suivi par statut, B2C, montants USD à 2 décimales, refus, opérateur simulé à côté', async () => {
  const net = await fakeMpesa();
  const db = openDb(':memory:');
  const sms = new ConsoleSms({ quiet: true });
  const env = { MPESA_BASE_URL: net.url + '/mpesa/openapi/ipg/v2/vodacomDRC', MPESA_API_KEY: 'cle', MPESA_SERVICE_PROVIDER_CODE: '171717', POLL_MS: '10' };
  const provider = await new OperatorsProvider({ db, env }).init();
  assert.deepEqual(provider.operators, ['mpesa']);
  const app = createApp({ db, provider, sms, config: { qrSecret: 'm'.repeat(40) } });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = async (method, path, body, token) => (await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
  await api('POST', '/auth/otp', { phone: '0890000801' });
  const code = /(\d{6})/.exec(sms.sent.at(-1).text)[1];
  const { token } = await api('POST', '/auth/register', { phone: '0890000801', code, pin: '1234' });
  const link = (phone, operator = 'mpesa', currency = 'CDF') => api('POST', '/accounts/link', { operator, phone, currency }, token);

  const m = await link('0810000001');
  assert.equal(m.balance, 100000);
  assert.equal((await link('0819999999')).error, 'OPERATOR_REFUSED');
  const r = await api('POST', '/transfers', { fromAccountId: m.id, toPhone: '0811234567', amount: 4000 }, token);
  assert.equal(r.balance, 96000);
  assert.equal(net.wallets.get('243811234567').CDF, 5000);

  const usd = await link('0810000001', 'mpesa', 'USD');
  assert.equal((await api('POST', '/transfers', { fromAccountId: usd.id, toPhone: '0811234567', amount: 250 }, token)).balance, 4750);
  assert.equal(net.wallets.get('243811234567').USD, 2.5);

  const poor = await link('0810000002');
  assert.deepEqual(await api('POST', '/bills', { fromAccountId: poor.id, biller: 'REGIDESO', reference: 'E1', amount: 100 }, token), { ok: false, reason: 'INSUFFICIENT_FUNDS' });
  assert.ok(net.seen.refs.every((x) => x.length <= 20 && !/\s/.test(x)), 'référence M-Pesa : 20 caractères, sans espace');

  // compte Orange simulé → destinataire M-Pesa hors KinPay : simple débit côté simulé (aucun versement M-Pesa)
  const orange = await link('0890000801', 'orange');
  assert.equal((await api('POST', '/transfers', { fromAccountId: orange.id, toPhone: '0811234567', amount: 1000 }, token)).balance, 99000);
  assert.equal(net.seen.sessions, 1, 'une seule session réutilisée');
  net.close();
  server.close();
});
