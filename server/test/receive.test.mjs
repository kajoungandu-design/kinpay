// Encaisser par QR : taxi (montant rapide), client, commerçant (catalogue).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../app.mjs';
import { openDb } from '../lib/db.mjs';
import { ConsoleSms } from '../lib/sms.mjs';
import { MockProvider } from '../providers/mock.mjs';

async function world() {
  const clock = { t: Date.parse('2026-11-03T10:00:00Z') };
  const db = openDb(':memory:');
  const sms = new ConsoleSms({ quiet: true });
  const app = createApp({ db, provider: new MockProvider(db), sms, config: { qrSecret: 'q'.repeat(40), now: () => clock.t } });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  const base = 'http://127.0.0.1:' + server.address().port;

  async function api(method, path, body, token) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }
  async function user(phone) {
    await api('POST', '/auth/otp', { phone });
    const code = /(\d{6})/.exec(sms.sent.at(-1).text)[1];
    const token = (await api('POST', '/auth/register', { phone, code, pin: '1234' })).json.token;
    const link = async (operator, currency) => (await api('POST', '/accounts/link', { operator, phone, currency }, token)).json;
    const balance = async (id) => (await api('GET', '/accounts', undefined, token)).json.find((a) => a.id === id).balance;
    return { token, link, balance };
  }
  return { api, clock, user, close: () => server.close() };
}

test('taxi : montant rapide, le client scanne et paie, le chauffeur est crédité', async () => {
  const w = await world();
  const taxi = await w.user('0890000021');
  const client = await w.user('0990000022');
  const taxiCdf = await taxi.link('orange', 'CDF');
  const clientCdf = await client.link('airtel', 'CDF');

  const q = await w.api('POST', '/requests', { accountId: taxiCdf.id, amount: 2000, item: 'Course Gombe' }, taxi.token);
  assert.equal(q.status, 201);
  assert.match(q.json.qr, /^kinpay:\/\/pay\?m=U-[0-9A-F]{8}&a=2000&i=Course%20Gombe&n=[a-f0-9]{16}&e=\d+&c=CDF&s=[a-f0-9]{64}$/);

  // le client voit à qui il paie avant de saisir son PIN
  const check = await w.api('POST', '/payments/qr/check', { qr: q.json.qr }, client.token);
  assert.equal(check.json.amount, 2000);
  assert.equal(check.json.payee, '+243 89 ••• ••21');

  assert.equal((await w.api('GET', '/requests/' + q.json.nonce, undefined, taxi.token)).json.status, 'pending');
  const paid = await w.api('POST', '/payments/qr', { qr: q.json.qr, accountId: clientCdf.id }, client.token);
  assert.equal(paid.status, 200);
  assert.equal(paid.json.balance, 98000);
  assert.equal(paid.json.tx.kind, 'payment');
  assert.equal(await taxi.balance(taxiCdf.id), 102000);

  const status = (await w.api('GET', '/requests/' + q.json.nonce, undefined, taxi.token)).json;
  assert.equal(status.status, 'paid');
  assert.equal(status.payer, '+243 99 ••• ••22');
  const hist = (await w.api('GET', '/history', undefined, taxi.token)).json;
  assert.equal(hist[0].kind, 'received');
  assert.equal(hist[0].amount, 2000);

  // usage unique, et le statut n'est visible que par le vendeur
  assert.equal((await w.api('POST', '/payments/qr', { qr: q.json.qr, accountId: clientCdf.id }, client.token)).status, 409);
  assert.equal((await w.api('GET', '/requests/' + q.json.nonce, undefined, client.token)).status, 404);
  w.close();
});

test('QR utilisateur : devise, se payer soi-même, falsification, expiration, compte d\'un autre', async () => {
  const w = await world();
  const a = await w.user('0890000031');
  const b = await w.user('0990000032');
  const aUsd = await a.link('orange', 'USD');
  const bCdf = await b.link('airtel', 'CDF');
  const bUsd = await b.link('airtel', 'USD');

  const q = await w.api('POST', '/requests', { accountId: aUsd.id, amount: 250 }, a.token); // 2,50 USD
  assert.equal(q.json.currency, 'USD');
  assert.equal(q.json.item, 'Paiement');
  assert.deepEqual((await w.api('POST', '/payments/qr', { qr: q.json.qr, accountId: bCdf.id }, b.token)).json, { ok: false, reason: 'CURRENCY_MISMATCH' });
  assert.deepEqual((await w.api('POST', '/payments/qr', { qr: q.json.qr, accountId: aUsd.id }, a.token)).json, { ok: false, reason: 'SELF_PAYMENT' });
  assert.equal((await w.api('POST', '/payments/qr', { qr: q.json.qr.replace('c=USD', 'c=CDF'), accountId: bCdf.id }, b.token)).status, 400, 'devise falsifiée');
  assert.equal((await w.api('POST', '/payments/qr', { qr: q.json.qr.replace('a=250', 'a=25'), accountId: bUsd.id }, b.token)).status, 400, 'montant falsifié');
  assert.equal((await w.api('POST', '/payments/qr', { qr: q.json.qr, accountId: bUsd.id }, b.token)).json.balance, 4750);
  assert.equal(await a.balance(aUsd.id), 5250);

  // un compte qui ne m'appartient pas ne peut pas encaisser pour moi
  assert.equal((await w.api('POST', '/requests', { accountId: bCdf.id, amount: 100 }, a.token)).status, 404);
  assert.equal((await w.api('POST', '/requests', { accountId: aUsd.id, amount: 0 }, a.token)).status, 422);
  assert.equal((await w.api('POST', '/requests', { accountId: aUsd.id, amount: 500_001 }, a.token)).status, 422);

  // solde insuffisant : le QR reste payable ; expiration après 10 minutes
  const big = await w.api('POST', '/requests', { accountId: aUsd.id, amount: 400_000 }, a.token);
  assert.deepEqual((await w.api('POST', '/payments/qr', { qr: big.json.qr, accountId: bUsd.id }, b.token)).json, { ok: false, reason: 'INSUFFICIENT_FUNDS' });
  assert.equal((await w.api('GET', '/requests/' + big.json.nonce, undefined, a.token)).json.status, 'pending');
  w.clock.t += 601_000;
  assert.equal((await w.api('GET', '/requests/' + big.json.nonce, undefined, a.token)).json.status, 'expired');
  assert.equal((await w.api('POST', '/payments/qr', { qr: big.json.qr, accountId: bUsd.id }, b.token)).status, 410);
  w.close();
});

test('commerçant : catalogue, le total est calculé par le serveur', async () => {
  const w = await world();
  const resto = await w.user('0890000041');
  const client = await w.user('0990000042');
  const restoCdf = await resto.link('orange', 'CDF');
  const clientCdf = await client.link('airtel', 'CDF');

  const add = (body, token = resto.token) => w.api('POST', '/products', body, token);
  const combo = (await add({ name: 'Plat combo', price: 8000, currency: 'CDF' })).json;
  const jus = (await add({ name: 'Jus de gingembre', price: 1500, currency: 'CDF' })).json;
  const soda = (await add({ name: 'Soda importé', price: 150, currency: 'USD' })).json;
  assert.equal((await add({ name: '', price: 100, currency: 'CDF' })).status, 400);
  assert.equal((await add({ name: 'x'.repeat(41), price: 100, currency: 'CDF' })).status, 400);
  assert.equal((await add({ name: 'Eau', price: 0, currency: 'CDF' })).status, 400);
  assert.deepEqual((await w.api('GET', '/products', undefined, resto.token)).json.map((p) => p.name), ['Jus de gingembre', 'Plat combo', 'Soda importé']);
  assert.deepEqual((await w.api('GET', '/products', undefined, client.token)).json, [], 'chacun son catalogue');

  // un prix envoyé par l'application est ignoré
  const items = [{ productId: combo.id, qty: 2, price: 1 }, { productId: jus.id, qty: 1 }];
  const q = await w.api('POST', '/requests', { accountId: restoCdf.id, items, amount: 1 }, resto.token);
  assert.equal(q.status, 201);
  assert.equal(q.json.amount, 17500);
  assert.equal(q.json.item, '2 × Plat combo, 1 × Jus de gingembre');
  assert.equal((await w.api('POST', '/payments/qr', { qr: q.json.qr, accountId: clientCdf.id }, client.token)).json.balance, 82500);
  assert.equal(await resto.balance(restoCdf.id), 117500);

  // devises mélangées, quantité invalide, produit d'un autre commerçant
  assert.equal((await w.api('POST', '/requests', { accountId: restoCdf.id, items: [{ productId: soda.id, qty: 1 }] }, resto.token)).status, 422);
  assert.equal((await w.api('POST', '/requests', { accountId: restoCdf.id, items: [{ productId: combo.id, qty: 0 }] }, resto.token)).status, 400);
  assert.equal((await w.api('POST', '/requests', { accountId: clientCdf.id, items: [{ productId: combo.id, qty: 1 }] }, client.token)).status, 400);
  assert.equal((await w.api('POST', '/requests', { accountId: restoCdf.id, items: [] }, resto.token)).status, 400);

  // suppression : seulement par son propriétaire
  assert.equal((await w.api('DELETE', '/products/' + jus.id, undefined, client.token)).status, 404);
  assert.equal((await w.api('DELETE', '/products/' + jus.id, undefined, resto.token)).status, 200);
  assert.equal((await w.api('GET', '/products', undefined, resto.token)).json.length, 2);
  w.close();
});
