import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../app.mjs';
import { openDb, createMachine } from '../lib/db.mjs';
import { ConsoleSms } from '../lib/sms.mjs';
import { MockProvider } from '../providers/mock.mjs';

const SECRET = 'test-secret-test-secret-test-secret-123';

async function world() {
  const clock = { t: Date.parse('2026-10-29T10:00:00Z') };
  const db = openDb(':memory:');
  const sms = new ConsoleSms({ quiet: true });
  const app = createApp({ db, provider: new MockProvider(db), sms, config: { qrSecret: SECRET, now: () => clock.t } });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref(); // un test qui échoue ne doit pas empêcher le programme de se terminer
  const base = 'http://127.0.0.1:' + server.address().port;

  async function api(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }
  const bearer = (token) => ({ authorization: 'Bearer ' + token });

  async function register(phone, pin = '1234') {
    await api('POST', '/auth/otp', { phone });
    const code = /(\d{6})/.exec(sms.sent.at(-1).text)[1];
    const r = await api('POST', '/auth/register', { phone, code, pin });
    assert.equal(r.status, 201);
    return r.json.token;
  }
  async function link(token, operator, phone) {
    const r = await api('POST', '/accounts/link', { operator, phone }, bearer(token));
    assert.equal(r.status, 201);
    return r.json;
  }
  async function balanceOf(token, accountId) {
    const r = await api('GET', '/accounts', undefined, bearer(token));
    return r.json.find((a) => a.id === accountId).balance;
  }

  const aliceToken = await register('0890000011');
  const bobToken = await register('0990000012');
  const alice = await link(aliceToken, 'orange', '0890000011');
  const bob = await link(bobToken, 'airtel', '0990000012');
  const machineKey = createMachine(db, { id: 'DIST-0042', name: 'Distributeur test' });
  const mh = { 'x-machine-key': machineKey };

  return { base, api, bearer, clock, sms, db, aliceToken, bobToken, alice, bob, machineKey, mh, balanceOf, close: () => server.close() };
}

test('santé, accès sans connexion refusé', async () => {
  const w = await world();
  assert.equal((await w.api('GET', '/health')).status, 200);
  assert.equal((await w.api('GET', '/accounts')).status, 401);
  assert.equal((await w.api('GET', '/accounts', undefined, { authorization: 'Bearer ' + 'a'.repeat(64) })).status, 401);
  assert.equal((await w.api('GET', '/inconnu')).status, 404);
  w.close();
});

test('inscription : code SMS, PIN, doublon, mauvais code', async () => {
  const w = await world();
  const phone = '0810000099';
  assert.equal((await w.api('POST', '/auth/otp', { phone: '123' })).status, 400);
  await w.api('POST', '/auth/otp', { phone });
  const code = /(\d{6})/.exec(w.sms.sent.at(-1).text)[1];
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await w.api('POST', '/auth/register', { phone, code: wrong, pin: '1234' })).status, 401);
  assert.equal((await w.api('POST', '/auth/register', { phone, code, pin: 'abcd' })).status, 400);
  assert.equal((await w.api('POST', '/auth/register', { phone, code, pin: '4321' })).status, 201);
  // déjà inscrit
  await w.api('POST', '/auth/otp', { phone });
  const code2 = /(\d{6})/.exec(w.sms.sent.at(-1).text)[1];
  assert.equal((await w.api('POST', '/auth/register', { phone, code: code2, pin: '4321' })).status, 409);
  w.close();
});

test('codes SMS : limite de demandes et expiration', async () => {
  const w = await world();
  const phone = '0810000098';
  for (let i = 0; i < 3; i++) assert.equal((await w.api('POST', '/auth/otp', { phone })).status, 200);
  assert.equal((await w.api('POST', '/auth/otp', { phone })).status, 429);
  const code = /(\d{6})/.exec(w.sms.sent.at(-1).text)[1];
  w.clock.t += 11 * 60_000;
  assert.equal((await w.api('POST', '/auth/register', { phone, code, pin: '1234' })).status, 401);
  w.close();
});

test('connexion PIN : blocage après 5 erreurs, puis déblocage', async () => {
  const w = await world();
  for (let i = 0; i < 5; i++) assert.equal((await w.api('POST', '/auth/login', { phone: '0890000011', pin: '9999' })).status, 401);
  assert.equal((await w.api('POST', '/auth/login', { phone: '0890000011', pin: '1234' })).status, 423);
  w.clock.t += 16 * 60_000;
  assert.equal((await w.api('POST', '/auth/login', { phone: '0890000011', pin: '1234' })).status, 200);
  assert.equal((await w.api('POST', '/auth/login', { phone: '0700000000', pin: '1234' })).status, 401);
  w.close();
});

test('confirmation du PIN avant paiement : bon PIN, mauvais PIN, blocage', async () => {
  const w = await world();
  const h = w.bearer(w.aliceToken);
  assert.equal((await w.api('POST', '/me/verify-pin', { pin: '1234' })).status, 401); // sans session
  assert.equal((await w.api('POST', '/me/verify-pin', { pin: '1234' }, h)).status, 200);
  for (let i = 0; i < 4; i++) {
    const r = await w.api('POST', '/me/verify-pin', { pin: '9999' }, h);
    assert.equal(r.status, 401);
    assert.equal(r.json.attemptsLeft, 4 - i);
  }
  assert.equal((await w.api('POST', '/me/verify-pin', { pin: '9999' }, h)).status, 423);
  assert.equal((await w.api('POST', '/me/verify-pin', { pin: '1234' }, h)).status, 423);
  w.clock.t += 16 * 60_000;
  assert.equal((await w.api('POST', '/me/verify-pin', { pin: '1234' }, h)).status, 200);
  w.close();
});

test('la session expire', async () => {
  const w = await world();
  assert.equal((await w.api('GET', '/accounts', undefined, w.bearer(w.aliceToken))).status, 200);
  w.clock.t += 8 * 24 * 3600_000;
  assert.equal((await w.api('GET', '/accounts', undefined, w.bearer(w.aliceToken))).status, 401);
  w.close();
});

test('comptes : liaison, doublon, opérateur invalide', async () => {
  const w = await world();
  const h = w.bearer(w.aliceToken);
  assert.equal((await w.api('POST', '/accounts/link', { operator: 'orange', phone: '0890000011' }, h)).status, 409);
  assert.equal((await w.api('POST', '/accounts/link', { operator: 'banque', phone: '0890000011' }, h)).status, 400);
  assert.equal((await w.api('POST', '/accounts/link', { operator: 'mpesa', phone: 'abc' }, h)).status, 400);
  const list = await w.api('GET', '/accounts', undefined, h);
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].balance, 100000);
  w.close();
});

test('transfert entre deux utilisateurs : soldes, historique, reçu', async () => {
  const w = await world();
  const r = await w.api('POST', '/transfers', { fromAccountId: w.alice.id, toPhone: '0990000012', amount: 25000 }, w.bearer(w.aliceToken));
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.balance, 75000);
  assert.equal(await w.balanceOf(w.bobToken, w.bob.id), 125000);
  const hist = await w.api('GET', '/history', undefined, w.bearer(w.bobToken));
  assert.equal(hist.json[0].kind, 'received');
  assert.equal(hist.json[0].amount, 25000);
  const histA = await w.api('GET', '/history', undefined, w.bearer(w.aliceToken));
  assert.equal(histA.json[0].kind, 'transfer');
  w.close();
});

test('transfert : refus (solde, montant, compte d\'un autre, numéro)', async () => {
  const w = await world();
  const h = w.bearer(w.aliceToken);
  const t = (body, hh = h) => w.api('POST', '/transfers', { toPhone: '0990000012', ...body }, hh);
  assert.deepEqual((await t({ fromAccountId: w.alice.id, amount: 100001 })).json, { ok: false, reason: 'INSUFFICIENT_FUNDS' });
  for (const amount of [0, -5, 1.5, '100', null, 99999999]) {
    const r = await t({ fromAccountId: w.alice.id, amount });
    assert.equal(r.status, 422, 'montant ' + amount);
  }
  // Bob essaie de dépenser le compte d'Alice
  assert.equal((await t({ fromAccountId: w.alice.id, amount: 1000 }, w.bearer(w.bobToken))).status, 404);
  assert.equal((await w.api('POST', '/transfers', { fromAccountId: w.alice.id, toPhone: '12', amount: 1000 }, h)).status, 400);
  assert.equal(await w.balanceOf(w.aliceToken, w.alice.id), 100000);
  assert.equal(await w.balanceOf(w.bobToken, w.bob.id), 100000);
  w.close();
});

test('idempotence : un rejeu ne débite ni ne crédite deux fois', async () => {
  const w = await world();
  const body = { fromAccountId: w.alice.id, toPhone: '0990000012', amount: 10000, idempotencyKey: 'abc-123' };
  const a = await w.api('POST', '/transfers', body, w.bearer(w.aliceToken));
  const b = await w.api('POST', '/transfers', body, w.bearer(w.aliceToken));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.json.tx.id, b.json.tx.id);
  assert.equal(await w.balanceOf(w.aliceToken, w.alice.id), 90000);
  assert.equal(await w.balanceOf(w.bobToken, w.bob.id), 110000);
  const hist = await w.api('GET', '/history', undefined, w.bearer(w.bobToken));
  assert.equal(hist.json.filter((x) => x.kind === 'received').length, 1);
  w.close();
});

test('factures', async () => {
  const w = await world();
  const h = w.bearer(w.aliceToken);
  const r = await w.api('POST', '/bills', { fromAccountId: w.alice.id, biller: 'Eau', reference: 'AB123', amount: 11500 }, h);
  assert.equal(r.json.balance, 88500);
  assert.equal((await w.api('POST', '/bills', { fromAccountId: w.alice.id, biller: 'Eau', amount: 100 }, h)).status, 400);
  w.close();
});

test('QR signé : paiement, rejeu, falsification, expiration', async () => {
  const w = await world();
  const h = w.bearer(w.aliceToken);
  const mk = (amount, item = "Bouteille d'eau") => w.api('POST', '/machine/qr', { amount, item }, w.mh);

  const q = await mk(1500);
  assert.equal(q.status, 201);
  assert.match(q.json.qr, /^kinpay:\/\/pay\?m=DIST-0042&a=1500&i=/);

  // falsification du montant
  const forged = q.json.qr.replace('a=1500', 'a=1');
  assert.equal((await w.api('POST', '/payments/qr', { qr: forged, accountId: w.alice.id }, h)).status, 400);
  // bonne donnée, mauvaise signature
  assert.equal((await w.api('POST', '/payments/qr', { qr: q.json.qr.replace(/s=[a-f0-9]+$/, 's=' + '0'.repeat(64)), accountId: w.alice.id }, h)).status, 400);
  // signature absente
  assert.equal((await w.api('POST', '/payments/qr', { qr: q.json.qr.replace(/&s=.*/, ''), accountId: w.alice.id }, h)).status, 400);
  // paiement valide : le montant vient du serveur
  const ok = await w.api('POST', '/payments/qr', { qr: q.json.qr, accountId: w.alice.id, amount: 1 }, h);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.balance, 98500);
  // rejeu du même QR
  assert.equal((await w.api('POST', '/payments/qr', { qr: q.json.qr, accountId: w.alice.id }, w.bearer(w.bobToken))).status, 409);
  assert.equal((await w.api('GET', '/machine/qr/' + q.json.nonce, undefined, w.mh)).json.status, 'paid');

  // solde insuffisant : le QR reste utilisable
  const big = await mk(150000);
  const refused = await w.api('POST', '/payments/qr', { qr: big.json.qr, accountId: w.alice.id }, h);
  assert.deepEqual(refused.json, { ok: false, reason: 'INSUFFICIENT_FUNDS' });
  assert.equal((await w.api('GET', '/machine/qr/' + big.json.nonce, undefined, w.mh)).json.status, 'pending');

  // expiration
  const old = await mk(500);
  w.clock.t += 121_000;
  assert.equal((await w.api('POST', '/payments/qr', { qr: old.json.qr, accountId: w.alice.id }, h)).status, 410);
  w.close();
});

test('machines : clé obligatoire, un utilisateur ne peut pas se faire passer pour une machine', async () => {
  const w = await world();
  assert.equal((await w.api('POST', '/machine/qr', { amount: 100, item: 'x' })).status, 401);
  assert.equal((await w.api('POST', '/machine/qr', { amount: 100, item: 'x' }, { 'x-machine-key': 'mk_faux' })).status, 401);
  assert.equal((await w.api('POST', '/machine/qr', { amount: 100, item: 'x' }, w.bearer(w.aliceToken))).status, 401);
  assert.equal((await w.api('POST', '/machine/qr', { amount: 0, item: 'x' }, w.mh)).status, 400);
  w.close();
});

test('code de paiement OTP : usage unique, expiration, remplacement, limite d\'essais', async () => {
  const w = await world();
  const h = w.bearer(w.aliceToken);
  const redeem = (code, amount = 1500) => w.api('POST', '/machine/redeem', { code, amount, item: 'Eau' }, w.mh);

  const c1 = await w.api('POST', '/payments/code', { accountId: w.alice.id }, h);
  assert.match(c1.json.code, /^\d{6}$/);
  const paid = await redeem(c1.json.code);
  assert.equal(paid.status, 200);
  assert.equal(paid.json.balance, 98500);
  assert.equal((await redeem(c1.json.code)).status, 401, 'usage unique');

  const c2 = await w.api('POST', '/payments/code', { accountId: w.alice.id }, h);
  const c3 = await w.api('POST', '/payments/code', { accountId: w.alice.id }, h);
  assert.equal((await redeem(c2.json.code)).status, 401, 'remplacé par le suivant');
  w.clock.t += 61_000;
  assert.equal((await redeem(c3.json.code)).status, 401, 'expiré');

  // compte d'un autre utilisateur interdit
  assert.equal((await w.api('POST', '/payments/code', { accountId: w.bob.id }, h)).status, 404);

  // devinette : blocage après 10 essais ratés
  for (let i = 0; i < 10; i++) await redeem('000000');
  assert.equal((await redeem('000000')).status, 429);
  w.close();
});

test('code de paiement : solde insuffisant refusé', async () => {
  const w = await world();
  const c = await w.api('POST', '/payments/code', { accountId: w.alice.id }, w.bearer(w.aliceToken));
  const r = await w.api('POST', '/machine/redeem', { code: c.json.code, amount: 200000, item: 'Eau' }, w.mh);
  assert.deepEqual(r.json, { ok: false, reason: 'INSUFFICIENT_FUNDS' });
  assert.equal(await w.balanceOf(w.aliceToken, w.alice.id), 100000);
  w.close();
});

test('corps de requête invalide ou trop gros', async () => {
  const w = await world();
  const bad = await fetch(w.base + '/auth/otp', { method: 'POST', body: '{pas du json' });
  assert.equal(bad.status, 400);
  const huge = await fetch(w.base + '/auth/otp', { method: 'POST', body: JSON.stringify({ phone: 'x'.repeat(20000) }) });
  assert.equal(huge.status, 413);
  w.close();
});
