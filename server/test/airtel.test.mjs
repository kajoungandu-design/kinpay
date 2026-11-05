// providers/airtel.mjs contre un faux Airtel (même format que l'Airtel Africa Open API et le simulateur RDC).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../app.mjs';
import { openDb } from '../lib/db.mjs';
import { ConsoleSms } from '../lib/sms.mjs';
import AirtelProvider from '../providers/airtel.mjs';

// Numéros : ...2 = solde insuffisant, ...5 = refus du client, ...9 = inconnu. Montants USD en unités (2.5).
async function fakeAirtel() {
  const wallets = new Map([
    ['970000001', { CDF: 100000, USD: 50 }],
    ['970000002', { CDF: 0, USD: 0 }],
    ['970000005', { CDF: 100000, USD: 50 }],
    ['971234567', { CDF: 1000, USD: 1 }],
  ]);
  const payments = new Map();
  const orders = new Map([['ord_1', { id: 'ord_1', machine_id: 'boissons', product: 'Cola', amount: 1500, currency: 'CDF', status: 'PENDING' }]]);
  const cycle = (id) => [id, { id, machine_id: 'L2', program_name: 'Coton 40°', minutes: 45, amount: 3000, currency: 'CDF', status: 'PENDING', refunded_amount: 0 }];
  const cycles = new Map(['lav_1', 'lav_2', 'lav_3', 'lav_4', 'lav_5'].map(cycle));
  orders.set('ord_2', { id: 'ord_2', machine_id: 'boissons', product: 'Cola + Eau', amount: 3, currency: 'USD', status: 'PENDING', refunded_amount: 0 });
  const seen = { tokens: 0, refs: [], payouts: 0, payoutMode: 'ok' };
  const ok = (data) => ({ data, status: { code: '200', message: 'SUCCESS', success: true } });
  const fail = (message) => ({ status: { code: '400', message, success: false } });
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const b = raw ? JSON.parse(raw) : {};
    const send = (status, j) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(j));
    };
    const url = req.url;
    if (url === '/airtel/auth/oauth2/token') {
      if (b.client_secret !== 'secret') return send(401, fail('bad client'));
      seen.tokens++;
      return send(200, { access_token: 'tok', expires_in: '3600', token_type: 'bearer' });
    }
    if (url.startsWith('/airtel/') && req.headers.authorization !== 'Bearer tok') return send(401, fail('Unauthorized'));
    const cur = req.headers['x-currency'];
    if (url === '/airtel/merchant/v1/payments/') {
      const m = b.subscriber.msisdn;
      seen.refs.push(b.reference);
      const w = wallets.get(m);
      let st = 'TS', message = 'Transaction is successful.';
      if (m.endsWith('5')) [st, message] = ['TF', 'The transaction was refused.'];
      else if (w[cur] < b.transaction.amount) [st, message] = ['TF', 'Not enough balance.'];
      else w[cur] -= b.transaction.amount;
      payments.set(b.transaction.id, { id: b.transaction.id, status: st, message, airtel_money_id: 'MP' + payments.size, m, amount: b.transaction.amount, cur });
      const order = [...orders.values()].find((o) => o.id === b.reference);
      if (order && st === 'TS') order.status = 'DISPENSED';
      const cycle = cycles.get(b.reference);
      if (cycle && st === 'TS') cycle.status = 'RUNNING';
      return send(200, ok({ transaction: { id: b.transaction.id, status: 'Success.' } }));
    }
    if (url.startsWith('/airtel/standard/v1/payments/') && req.method === 'GET') {
      const p = payments.get(decodeURIComponent(url.split('/').pop()));
      return p ? send(200, ok({ transaction: p })) : send(404, fail('Transaction not found.'));
    }
    if (url === '/airtel/standard/v1/payments/refund') {
      const p = [...payments.values()].find((x) => x.airtel_money_id === b.transaction.airtel_money_id);
      wallets.get(p.m)[p.cur] += p.amount;
      return send(200, ok({ transaction: { status: 'SUCCESS' } }));
    }
    if (url === '/airtel/standard/v1/disbursements/') {
      const w = wallets.get(b.payee.msisdn);
      if (!w) return send(400, fail('Invalid msisdn'));
      if (seen.payoutMode === 'refuse') return send(400, fail('Merchant account refused'));
      if (seen.payoutMode === 'crash') return send(500, fail('Panne'));
      seen.payouts++;
      w[cur] += b.transaction.amount;
      return send(200, ok({ transaction: { id: b.transaction.id, status: 'TS', message: 'Transaction is successful.' } }));
    }
    const ph = /^\/sandbox\/phone\/(\d+)$/.exec(url);
    if (ph) return wallets.has(ph[1]) ? send(200, { status: 'ACTIVE', balances: wallets.get(ph[1]) }) : send(404, { error: 'inconnu' });
    if (url === '/machines/qr/verify') {
      const ref = /o=([^&]+)/.exec(b.payload)?.[1];
      const c = cycles.get(ref);
      if (c) {
        if (c.status !== 'PENDING') return send(200, { valid: false, kind: 'laundry', reason: 'CYCLE_' + c.status });
        return send(200, { valid: true, kind: 'laundry', data: { machineId: 'matonge', orderId: c.id, amount: c.amount, currency: c.currency }, cycle: c });
      }
      const o = orders.get(ref);
      if (!o) return send(200, { valid: false, reason: 'UNKNOWN_ORDER' });
      if (o.status !== 'PENDING') return send(200, { valid: false, reason: 'ORDER_' + o.status });
      return send(200, { valid: true, data: { machineId: o.machine_id, orderId: o.id, amount: o.amount, currency: o.currency }, order: o });
    }
    if (url === '/machines/boissons') return send(200, { id: 'boissons', name: 'Boissons Gombe' });
    if (url === '/machines/boissons/orders/ord_1') return send(200, orders.get('ord_1'));
    if (url === '/machines/boissons/orders/ord_2') return send(200, orders.get('ord_2'));
    if (url === '/laundries/matonge') return send(200, { id: 'matonge', name: 'Laverie Matonge', machines: [{ id: 'L2', label: 'Lave-linge 2' }] });
    const cy = /^\/laundries\/matonge\/cycles\/(lav_\d)$/.exec(url);
    if (cy) return send(200, cycles.get(cy[1]));
    send(404, { error: 'NOT_FOUND' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  return { url: 'http://127.0.0.1:' + server.address().port, wallets, orders, cycles, seen, close: () => server.close() };
}

async function world() {
  const net = await fakeAirtel();
  const db = openDb(':memory:');
  const sms = new ConsoleSms({ quiet: true });
  const env = { AIRTEL_BASE_URL: net.url + '/airtel', AIRTEL_CLIENT_ID: 'kinpay', AIRTEL_CLIENT_SECRET: 'secret', AIRTEL_POLL_MS: '10', AIRTEL_CONFIRM_TIMEOUT_MS: '2000' };
  const provider = await new AirtelProvider({ db, env }).init();
  const app = createApp({ db, provider, sms, config: { qrSecret: 'a'.repeat(40), machineNetworkUrl: provider.sandbox } });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = async (method, path, body, token) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  async function user(phone) {
    await api('POST', '/auth/otp', { phone });
    const code = /(\d{6})/.exec(sms.sent.at(-1).text)[1];
    return (await api('POST', '/auth/register', { phone, code, pin: '1234' })).json.token;
  }
  const link = async (token, phone, operator = 'airtel', currency = 'CDF') => (await api('POST', '/accounts/link', { operator, phone, currency }, token)).json;
  return { net, api, user, link, sync: app.syncNetworkOrders, close: () => (net.close(), server.close()) };
}

test('Airtel : liaison, transfert (collection puis versement), refus, devise USD en unités', async () => {
  const w = await world();
  const t = await w.user('0890000601');
  const ok = await w.link(t, '0970000001');
  assert.equal(ok.balance, 100000, 'solde lu chez Airtel');
  assert.equal((await w.link(t, '0970000009')).error, 'OPERATOR_REFUSED');
  const usd = await w.link(t, '0970000001', 'airtel', 'USD');
  assert.equal(usd.balance, 5000, '50 USD = 5 000 cents');

  const r = await w.api('POST', '/transfers', { fromAccountId: ok.id, toPhone: '0971234567', amount: 2500 }, t);
  assert.equal(r.json.balance, 97500);
  assert.equal(w.net.wallets.get('971234567').CDF, 3500, 'numéro Airtel hors KinPay crédité par disbursement');

  const tu = await w.api('POST', '/transfers', { fromAccountId: usd.id, toPhone: '0971234567', amount: 250 }, t);
  assert.equal(tu.json.balance, 4750);
  assert.equal(w.net.wallets.get('971234567').USD, 3.5);

  const poor = await w.link(t, '0970000002');
  assert.deepEqual((await w.api('POST', '/bills', { fromAccountId: poor.id, biller: 'SNEL', reference: 'X', amount: 100 }, t)).json, { ok: false, reason: 'INSUFFICIENT_FUNDS' });
  const refuser = await w.link(t, '0970000005');
  assert.deepEqual((await w.api('POST', '/bills', { fromAccountId: refuser.id, biller: 'SNEL', reference: 'X', amount: 100 }, t)).json, { ok: false, reason: 'PAYMENT_DECLINED' });
  // un seul jeton OAuth réutilisé
  assert.equal(w.net.seen.tokens, 1);
  w.close();
});

test('Airtel : paiement QR vendeur crédité par versement ; compte Orange géré par le faux opérateur', async () => {
  const w = await world();
  const seller = await w.user('0890000602');
  const buyer = await w.user('0890000603');
  const s = await w.link(seller, '0971234567');
  const b = await w.link(buyer, '0970000001');
  const q = (await w.api('POST', '/requests', { accountId: s.id, amount: 2000, item: 'Course' }, seller)).json;
  assert.equal((await w.api('POST', '/payments/qr', { qr: q.qr, accountId: b.id }, buyer)).json.balance, 98000);
  assert.equal(w.net.wallets.get('971234567').CDF, 3000);

  const orange = await w.link(buyer, '0890000603', 'orange');
  assert.equal(orange.balance, 100000);
  const r = await w.api('POST', '/transfers', { fromAccountId: orange.id, toPhone: '0971234567', amount: 1000 }, buyer);
  assert.equal(r.json.balance, 99000);
  assert.equal(w.net.wallets.get('971234567').CDF, 4000, 'Orange (faux) vers un compte KinPay Airtel : versé par Airtel');
  w.close();
});

test('machine du réseau (rdcpay) : vérification, paiement avec la commande en référence, suivi, usage unique', async () => {
  const w = await world();
  const t = await w.user('0890000604');
  const a = await w.link(t, '0970000001');
  const orange = await w.link(t, '0890000604', 'orange');
  const qr = 'rdcpay://pay?m=boissons&o=ord_1&a=1500&c=CDF&exp=9999999999&sig=x';
  const check = (await w.api('POST', '/payments/network/check', { qr }, t)).json;
  assert.deepEqual([check.payee, check.item, check.amount], ['Boissons Gombe', 'Cola', 1500]);
  assert.equal((await w.api('POST', '/payments/network', { qr, accountId: orange.id }, t)).json.reason, 'OPERATOR_NOT_SUPPORTED');
  const paid = (await w.api('POST', '/payments/network', { qr, accountId: a.id }, t)).json;
  assert.equal(paid.balance, 98500);
  assert.equal(w.net.seen.refs.at(-1), 'ord_1', 'numéro de commande transmis comme référence Airtel');
  assert.equal(paid.vend.id, 'ext:boissons:ord_1');
  assert.equal(paid.vend.status, 'dispensed');
  assert.equal((await w.api('POST', '/payments/network', { qr, accountId: a.id }, t)).status, 409);

  // le réseau rembourse (machine bloquée) : inscrit une seule fois dans l'historique
  w.net.orders.get('ord_1').status = 'REFUNDED';
  assert.equal((await w.api('GET', '/external-orders/boissons/ord_1', undefined, t)).json.status, 'refunded');
  await w.api('GET', '/external-orders/boissons/ord_1', undefined, t);
  const refunds = (await w.api('GET', '/history', undefined, t)).json.filter((x) => x.kind === 'refund');
  assert.equal(refunds.length, 1);
  w.close();
});

test("laverie du réseau : paiement validé au démarrage, fin de cycle, panne remboursée au prorata sans l'app", async () => {
  const w = await world();
  const t = await w.user('0890000605');
  const a = await w.link(t, '0970000001');
  const qr = 'rdcpay://pay?m=matonge&o=lav_1&a=3000&c=CDF&exp=9999999999&sig=x';

  const check = (await w.api('POST', '/payments/network/check', { qr }, t)).json;
  assert.deepEqual([check.payee, check.item, check.amount], ['Laverie Matonge', 'Coton 40°', 3000]);

  const paid = (await w.api('POST', '/payments/network', { qr, accountId: a.id }, t)).json;
  assert.equal(paid.balance, 97000);
  assert.equal(w.net.seen.refs.at(-1), 'lav_1', 'cycle transmis comme référence');
  assert.equal(paid.vend.status, 'running', 'message de validation dès le démarrage');
  assert.deepEqual([paid.vend.kind, paid.vend.detail, paid.vend.minutes, paid.vend.machine], ['laundry', 'Lave-linge 2', 45, 'Laverie Matonge']);
  assert.equal((await w.api('POST', '/payments/network/check', { qr }, t)).status, 409, 'cycle déjà payé');

  const follow = async () => (await w.api('GET', '/external-orders/matonge/lav_1', undefined, t)).json;
  w.net.cycles.get('lav_1').status = 'COMPLETED';
  const done = await follow();
  assert.deepEqual([done.status, done.finalAmount], ['dispensed', 3000]);
  assert.equal((await w.api('GET', '/history', undefined, t)).json.filter((x) => x.kind === 'refund').length, 0);

  // panne : le réseau rend 1 000 CDF ; l'historique est à jour sans que l'app regarde le suivi
  const cycle = w.net.cycles.get('lav_1');
  cycle.status = 'RUNNING';
  await follow();
  Object.assign(cycle, { status: 'PARTIAL_REFUND', refunded_amount: 1000 });
  await w.sync();
  await w.sync();
  const refunds = (await w.api('GET', '/history', undefined, t)).json.filter((x) => x.kind === 'refund');
  assert.deepEqual(refunds.map((x) => [x.amount, x.label]), [[1000, 'Reste rendu : Coton 40° (Laverie Matonge)']]);
  assert.equal((await follow()).finalAmount, 2000);
  w.close();
});

test('panier du distributeur : remboursement partiel en USD, unités converties en cents', async () => {
  const w = await world();
  const t = await w.user('0890000606');
  const a = await w.link(t, '0970000001', 'airtel', 'USD');
  const qr = 'rdcpay://pay?m=boissons&o=ord_2&a=3&c=USD&exp=9999999999&sig=x';
  const paid = (await w.api('POST', '/payments/network', { qr, accountId: a.id }, t)).json;
  assert.equal(paid.vend.amount, 300);
  Object.assign(w.net.orders.get('ord_2'), { status: 'PARTIAL_REFUND', refunded_amount: 1.5 });
  const v = (await w.api('GET', '/external-orders/boissons/ord_2', undefined, t)).json;
  assert.deepEqual([v.status, v.finalAmount], ['dispensed', 150]);
  assert.equal((await w.api('GET', '/history', undefined, t)).json[0].amount, 150);
  w.close();
});

// Cycle payé puis interrompu : le réseau rend 2 000 CDF sur 3 000, la raison décide du reste.
async function interruptedCycle(w, t, account, id, reason) {
  const qr = 'rdcpay://pay?m=matonge&o=' + id + '&a=3000&c=CDF&exp=9999999999&sig=x';
  await w.api('POST', '/payments/network', { qr, accountId: account.id }, t);
  w.net.wallets.get('970000001').CDF += 2000; // le réseau rend le temps non consommé
  Object.assign(w.net.cycles.get(id), { status: 'PARTIAL_REFUND', refunded_amount: 2000, reason });
  return async () => (await w.api('GET', '/external-orders/matonge/' + id, undefined, t)).json;
}

test('coupure de courant : remboursement total, complément versé une seule fois ; autre panne au prorata', async () => {
  const w = await world();
  const t = await w.user('0890000607');
  const a = await w.link(t, '0970000001');
  const follow = await interruptedCycle(w, t, a, 'lav_2', 'POWER_CUT');
  const v = await follow();
  assert.deepEqual([v.status, v.refundedAmount, v.reason], ['refunded', 3000, 'POWER_CUT']);
  await follow();
  await w.sync();
  assert.equal(w.net.seen.payouts, 1, 'complément versé une seule fois');
  assert.equal(w.net.wallets.get('970000001').CDF, 100000, 'client remboursé en entier');
  const refunds = (await w.api('GET', '/history', undefined, t)).json.filter((x) => x.kind === 'refund');
  assert.deepEqual(refunds.map((x) => x.amount).sort(), [1000, 2000]);

  const other = await interruptedCycle(w, t, a, 'lav_3', 'MOTOR_FAULT');
  const p = await other();
  assert.deepEqual([p.status, p.finalAmount, p.refundedAmount], ['dispensed', 1000, 2000]);
  assert.equal(w.net.seen.payouts, 1, 'pas de complément pour une autre panne');
  w.close();
});

test('complément refusé : réessayé par le serveur ; résultat inconnu : jamais rejoué', async () => {
  const w = await world();
  const t = await w.user('0890000608');
  const a = await w.link(t, '0970000001');
  w.net.seen.payoutMode = 'refuse';
  const follow = await interruptedCycle(w, t, a, 'lav_4', 'POWER_CUT');
  const v = await follow();
  assert.deepEqual([v.status, v.finalAmount, v.refundedAmount], ['dispensed', 1000, 2000], 'on ne dit pas « remboursé » avant le versement');
  w.net.seen.payoutMode = 'ok';
  await w.sync();
  assert.equal(w.net.seen.payouts, 1);
  assert.equal((await follow()).status, 'refunded');

  w.net.seen.payoutMode = 'crash';
  const unknown = await interruptedCycle(w, t, a, 'lav_5', 'POWER_CUT');
  assert.equal((await unknown()).status, 'dispensed');
  w.net.seen.payoutMode = 'ok';
  await w.sync();
  await unknown();
  assert.equal(w.net.seen.payouts, 1, 'résultat inconnu : pas de second versement');
  w.close();
});
