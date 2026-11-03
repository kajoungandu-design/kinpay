// Phase C : retraits d'espèces chez un agent agréé et au distributeur de billets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './helpers.mjs';

test('retrait chez un agent : code à 8 chiffres, client débité, agent crédité, usage unique', async () => {
  const w = await world();
  const client = await w.user('0990000061');
  const agent = await w.user('0890000062');
  const c = await client.link('CDF', 'airtel');
  const a = await agent.link('CDF');
  const aUsd = await agent.link('USD');

  const wd = await client.call('POST', '/withdrawals', { accountId: c.id, amount: 20000 });
  assert.equal(wd.status, 201);
  assert.match(wd.json.code, /^\d{8}$/);
  assert.equal((await client.call('GET', '/withdrawals/current')).json.withdrawal.status, 'pending');

  // pas encore agent : refus
  assert.equal((await agent.call('POST', '/agent/withdrawals/lookup', { code: wd.json.code })).status, 403);
  w.makeAgent(agent);
  const look = await agent.call('POST', '/agent/withdrawals/lookup', { code: wd.json.code });
  assert.deepEqual([look.json.amount, look.json.currency, look.json.client], [20000, 'CDF', '+243 99 ••• ••61']);

  // compte de l'agent dans une autre devise : refusé sans consommer le code
  assert.equal((await agent.call('POST', '/agent/withdrawals/confirm', { code: wd.json.code, accountId: aUsd.id })).json.reason, 'CURRENCY_MISMATCH');
  const ok = await agent.call('POST', '/agent/withdrawals/confirm', { code: wd.json.code, accountId: a.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.balance, 120000);
  assert.equal(await client.balance(c.id), 80000);
  assert.equal((await client.history())[0].kind, 'withdrawal');
  assert.equal((await agent.history())[0].kind, 'received');
  const cur = (await client.call('GET', '/withdrawals/current')).json.withdrawal;
  assert.equal(cur.status, 'done');
  assert.equal(cur.servedBy, 'Agent +243 89 ••• ••62');

  // rejeu
  assert.equal((await agent.call('POST', '/agent/withdrawals/confirm', { code: wd.json.code, accountId: a.id })).status, 404);
  assert.equal((await agent.call('GET', '/agent/withdrawals')).json.length, 1);
  w.close();
});

test('retrait : solde, expiration, remplacement, annulation, devinette bloquée, soi-même', async () => {
  const w = await world();
  const client = await w.user('0990000071');
  const agent = await w.user('0890000072');
  w.makeAgent(agent);
  const c = await client.link();
  const a = await agent.link();

  assert.equal((await client.call('POST', '/withdrawals', { accountId: c.id, amount: 100001 })).json.reason, 'INSUFFICIENT_FUNDS');
  assert.equal((await client.call('POST', '/withdrawals', { accountId: a.id, amount: 100 })).status, 404, "compte d'un autre");
  assert.equal((await client.call('POST', '/withdrawals', { accountId: c.id, amount: 0 })).status, 422);

  const first = (await client.call('POST', '/withdrawals', { accountId: c.id, amount: 5000 })).json;
  const second = (await client.call('POST', '/withdrawals', { accountId: c.id, amount: 6000 })).json;
  assert.equal((await agent.call('POST', '/agent/withdrawals/lookup', { code: first.code })).status, 404, 'remplacé');
  assert.equal((await agent.call('POST', '/agent/withdrawals/lookup', { code: second.code })).json.amount, 6000);

  w.clock.t += 16 * 60_000;
  assert.equal((await client.call('GET', '/withdrawals/current')).json.withdrawal.status, 'expired');
  assert.equal((await agent.call('POST', '/agent/withdrawals/confirm', { code: second.code, accountId: a.id })).status, 404, 'expiré');

  const third = (await client.call('POST', '/withdrawals', { accountId: c.id, amount: 1000 })).json;
  await client.call('POST', '/withdrawals/cancel');
  assert.equal((await client.call('GET', '/withdrawals/current')).json.withdrawal.status, 'cancelled');
  assert.equal((await agent.call('POST', '/agent/withdrawals/lookup', { code: third.code })).status, 404);

  // l'agent ne sert pas son propre retrait
  const own = (await agent.call('POST', '/withdrawals', { accountId: a.id, amount: 1000 })).json;
  assert.equal((await agent.call('POST', '/agent/withdrawals/confirm', { code: own.code, accountId: a.id })).json.reason, 'SELF_PAYMENT');

  // devinette : 10 essais ratés par minute, puis blocage
  for (let i = 0; i < 9; i++) await agent.call('POST', '/agent/withdrawals/lookup', { code: '00000000' });
  assert.equal((await agent.call('POST', '/agent/withdrawals/lookup', { code: own.code })).status, 429);
  assert.equal(await client.balance(c.id), 100000);
  w.close();
});

test('retrait au distributeur de billets : débit, puis billets sortis ou remboursement', async () => {
  const w = await world();
  const client = await w.user('0990000081');
  const owner = await w.user('0890000082');
  const c = await client.link();
  const o = await owner.link();
  const atm = w.machine({ id: 'DAB-01', name: 'DAB Gombe', kind: 'atm', ownerUserId: owner.id });
  const vending = w.machine({ id: 'DIST-01', name: 'Snacks' });

  const wd = (await client.call('POST', '/withdrawals', { accountId: c.id, amount: 10000 })).json;
  assert.equal((await vending.call('POST', '/machine/withdraw', { code: wd.code })).status, 403, "pas un DAB");
  const r = await atm.call('POST', '/machine/withdraw', { code: wd.code });
  assert.equal(r.status, 200);
  assert.equal(r.json.amount, 10000);
  assert.equal(await client.balance(c.id), 90000);
  assert.equal((await atm.call('POST', '/machine/withdraw', { code: wd.code })).status, 404, 'usage unique');
  // billets sortis : le propriétaire du DAB récupère la monnaie électronique
  assert.equal((await atm.call('POST', '/machine/vends/' + r.json.vendId + '/result', { ok: true })).json.status, 'dispensed');
  assert.equal(await owner.balance(o.id), 110000);

  // billets bloqués : client remboursé
  const wd2 = (await client.call('POST', '/withdrawals', { accountId: c.id, amount: 5000 })).json;
  const r2 = await atm.call('POST', '/machine/withdraw', { code: wd2.code });
  assert.equal((await atm.call('POST', '/machine/vends/' + r2.json.vendId + '/result', { ok: false, reason: 'CASSETTE_VIDE' })).json.status, 'refunded');
  assert.equal(await client.balance(c.id), 90000);
  assert.equal((await client.history())[0].kind, 'refund');
  w.close();
});
