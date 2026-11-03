// Vérifie que le code de l'APPLICATION (app/src/core/api.ts) parle correctement à ce serveur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../app.mjs';
import { openDb, createMachine } from '../lib/db.mjs';
import { ConsoleSms } from '../lib/sms.mjs';
import { MockProvider } from '../providers/mock.mjs';
import { ApiClient, ApiError, HttpProvider } from '../../app/src/core/api.ts';
import { parseMachineQr } from '../../app/src/core/qr.ts';

async function setup() {
  const db = openDb(':memory:');
  const sms = new ConsoleSms({ quiet: true });
  const app = createApp({ db, provider: new MockProvider(db), sms, config: { qrSecret: 'x'.repeat(40) } });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  const url = 'http://127.0.0.1:' + server.address().port;
  const machineKey = createMachine(db, { id: 'DIST-0042', name: 'Test' });

  async function user(phone) {
    let token = null;
    const api = new ApiClient(url, () => token);
    await api.requestCode(phone);
    const code = /(\d{6})/.exec(sms.sent.at(-1).text)[1];
    const session = await api.register(phone, code, '1234');
    token = session.token;
    return { api, provider: new HttpProvider(api), session };
  }
  return { url, machineKey, user, close: () => server.close() };
}

test("l'application s'inscrit, se connecte et lie un compte", async () => {
  const w = await setup();
  const a = await w.user('0890000011');
  assert.match(a.session.user.phone, /^\+243/);
  const login = await new ApiClient(w.url).login('0890000011', '1234');
  assert.ok(login.token);
  await assert.rejects(new ApiClient(w.url).login('0890000011', '0000'), (e) => e instanceof ApiError && e.status === 401);

  assert.deepEqual(await a.provider.getAccounts(), []);
  const acc = await a.provider.linkAccount('orange', '0890000011', 'CDF');
  assert.equal(acc.balance, 100000);
  assert.equal((await a.provider.getAccounts()).length, 1);
  const usd = await a.provider.linkAccount('orange', '0890000011', 'USD');
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.balance, 5000);
  assert.deepEqual((await a.provider.getAccounts()).map((x) => x.currency), ['CDF', 'USD']);
  w.close();
});

test('sans connexion : ApiError 401', async () => {
  const w = await setup();
  const p = new HttpProvider(new ApiClient(w.url));
  await assert.rejects(p.getAccounts(), (e) => e instanceof ApiError && e.status === 401);
  w.close();
});

test('transfert, refus et historique via HttpProvider', async () => {
  const w = await setup();
  const alice = await w.user('0890000011');
  const bob = await w.user('0990000012');
  const a = await alice.provider.linkAccount('orange', '0890000011');
  const b = await bob.provider.linkAccount('airtel', '0990000012');

  const ok = await alice.provider.transfer({ fromAccountId: a.id, toPhone: '+243990000012', amount: 20000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.balance, 80000);
  assert.equal((await bob.provider.getAccounts())[0].balance, 120000);
  assert.equal((await bob.provider.getHistory())[0].kind, 'received');

  const refused = await alice.provider.transfer({ fromAccountId: a.id, toPhone: '+243990000012', amount: 999999 });
  assert.deepEqual(refused, { ok: false, reason: 'INSUFFICIENT_FUNDS' });

  // même clé = une seule opération
  const key = { fromAccountId: a.id, toPhone: '+243990000012', amount: 1000, idempotencyKey: 'k1' };
  await alice.provider.transfer(key);
  await alice.provider.transfer(key);
  assert.equal((await alice.provider.getAccounts())[0].balance, 79000);

  const bill = await alice.provider.payBill({ fromAccountId: a.id, biller: 'Eau', reference: 'R1', amount: 1500 });
  assert.equal(bill.ok && bill.balance, 77500);
  assert.equal(b.balance, 100000);
  w.close();
});

test('paiement par QR signé et par code serveur via HttpProvider', async () => {
  const w = await setup();
  const alice = await w.user('0890000011');
  const a = await alice.provider.linkAccount('orange', '0890000011');

  const res = await fetch(w.url + '/machine/qr', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-machine-key': w.machineKey },
    body: JSON.stringify({ amount: 1500, item: "Eau d'Evian 50 cl" }),
  });
  const { qr } = await res.json();
  const parsed = parseMachineQr(qr); // le lecteur de QR de l'application accepte ce format
  assert.ok(parsed);
  assert.equal(parsed.amount, 1500);

  const paid = await alice.provider.payMachine({ fromAccountId: a.id, machineId: parsed.machineId, item: parsed.item, amount: 1, qr: parsed.qr });
  assert.equal(paid.ok && paid.balance, 98500, 'le montant vient du QR signé, pas de l\'application');
  const again = await alice.provider.payMachine({ fromAccountId: a.id, machineId: parsed.machineId, item: parsed.item, amount: 1, qr: parsed.qr });
  assert.deepEqual(again, { ok: false, reason: 'QR_ALREADY_USED' });
  assert.deepEqual(await alice.provider.payMachine({ fromAccountId: a.id, machineId: 'X', item: 'x', amount: 1 }), { ok: false, reason: 'INVALID_QR' });

  const pc = await alice.provider.getPaymentCode(a.id);
  assert.match(pc.code, /^\d{6}$/);
  assert.equal(pc.expiresInSeconds, 60);
  const redeem = await fetch(w.url + '/machine/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-machine-key': w.machineKey },
    body: JSON.stringify({ code: pc.code, amount: 1500, item: 'Eau' }),
  });
  assert.equal((await redeem.json()).balance, 97000);
  w.close();
});

test('serveur injoignable : NETWORK, sans planter', async () => {
  const p = new HttpProvider(new ApiClient('http://127.0.0.1:1', () => 'a'.repeat(64)));
  assert.deepEqual(await p.transfer({ fromAccountId: 'x', toPhone: '+243890000001', amount: 100 }), { ok: false, reason: 'NETWORK' });
});
