// Phase D : machines connectées (QR fixe, séquestre, remboursement automatique, temps réel, webhook, portail).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, createHash } from 'node:crypto';
import { world } from './helpers.mjs';

const SLOTS = [
  { slot: 1, name: 'Eau 50 cl', price: 1000, stock: 2 },
  { slot: 2, name: 'Coca 33 cl', price: 2000, stock: 0 },
];

async function setup() {
  const w = await world();
  const owner = await w.user('0890000091');
  const client = await w.user('0990000092');
  const o = await owner.link();
  const c = await client.link('CDF', 'airtel');
  const created = await owner.call('POST', '/owner/machines', { name: 'Boissons Gombe', kind: 'vending', currency: 'CDF' });
  assert.equal(created.status, 201);
  const m = created.json;
  const mh = { 'x-machine-key': m.key };
  const machine = (method, path, body) => w.api(method, path, body, mh);
  const s = new URL(m.fixedQr.replace('kinpay://', 'http://x/')).searchParams.get('s');
  return { w, owner, client, o, c, m, s, machine };
}

test('QR fixe : menu, machine hors ligne refusée sans débit, achat, distribution, propriétaire crédité', async () => {
  const { w, owner, client, o, c, m, s, machine } = await setup();
  assert.match(m.fixedQr, /^kinpay:\/\/m\?id=DIST-[0-9A-F]{6}&s=[a-f0-9]{16}$/);
  assert.equal((await owner.call('POST', '/owner/machines/' + m.id + '/slots', { slots: SLOTS })).status, 200);

  const menu = await client.call('GET', '/machines/' + m.id + '?s=' + s);
  assert.equal(menu.json.name, 'Boissons Gombe');
  assert.equal(menu.json.slots.length, 2);
  assert.equal(menu.json.online, false);
  assert.equal((await client.call('GET', '/machines/' + m.id + '?s=' + '0'.repeat(16))).status, 404, 'signature fausse');

  const buy = (slot, extra = {}) => client.call('POST', '/machines/' + m.id + '/buy', { s, slot, accountId: c.id, ...extra });
  assert.equal((await buy(1)).json.reason, 'MACHINE_OFFLINE');
  assert.equal(await client.balance(c.id), 100000, 'aucun débit');

  // la machine donne signe de vie (interrogation simple)
  assert.deepEqual((await machine('POST', '/machine/heartbeat')).json.vends, []);
  assert.equal((await buy(2)).json.reason, 'OUT_OF_STOCK');
  const bought = await buy(1);
  assert.equal(bought.status, 200);
  assert.equal(bought.json.balance, 99000);
  assert.equal(bought.json.vend.status, 'held');
  assert.equal(await owner.balance(o.id), 100000, 'propriétaire pas encore crédité');
  assert.equal((await buy(1)).json.reason, 'MACHINE_BUSY', 'une vente à la fois');

  const pending = (await machine('POST', '/machine/heartbeat')).json.vends;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].slot, 1);
  const res = await machine('POST', '/machine/vends/' + pending[0].id + '/result', { ok: true });
  assert.equal(res.json.status, 'dispensed');
  assert.equal(await owner.balance(o.id), 101000);
  assert.equal((await owner.history())[0].kind, 'received');
  assert.equal((await client.call('GET', '/vends/' + pending[0].id)).json.status, 'dispensed');
  assert.equal((await owner.call('GET', '/owner/machines')).json[0].slots[0].stock, 1, 'stock diminué');

  // un second résultat ne change rien
  assert.equal((await machine('POST', '/machine/vends/' + pending[0].id + '/result', { ok: false })).json.status, 'dispensed');
  assert.equal(await client.balance(c.id), 99000);
  // une autre machine ou un autre client ne voient pas cette vente
  assert.equal((await owner.call('GET', '/vends/' + pending[0].id)).status, 404);
  w.close();
});

test('remboursement automatique : produit coincé, puis machine muette (délai dépassé)', async () => {
  const { w, owner, client, o, c, m, s, machine } = await setup();
  await owner.call('POST', '/owner/machines/' + m.id + '/slots', { slots: SLOTS });
  await machine('POST', '/machine/heartbeat');
  const buy = () => client.call('POST', '/machines/' + m.id + '/buy', { s, slot: 1, accountId: c.id });

  const a = (await buy()).json.vend;
  assert.equal((await machine('POST', '/machine/vends/' + a.id + '/result', { ok: false, reason: 'JAMMED' })).json.status, 'refunded');
  assert.equal(await client.balance(c.id), 100000);
  const h = await client.history();
  assert.equal(h[0].kind, 'refund');
  assert.equal(h[1].kind, 'machine');

  const b = (await buy()).json.vend;
  w.clock.t += 31_000;
  await w.sweep();
  const after = (await client.call('GET', '/vends/' + b.id)).json;
  assert.equal(after.status, 'refunded');
  assert.equal(after.reason, 'TIMEOUT');
  assert.equal(await client.balance(c.id), 100000);
  assert.equal(await owner.balance(o.id), 100000);
  // trop tard : la machine ne peut plus confirmer
  assert.equal((await machine('POST', '/machine/vends/' + b.id + '/result', { ok: true })).json.status, 'refunded');
  assert.equal(await owner.balance(o.id), 100000);
  // machine hors ligne 60 s après son dernier signe de vie
  w.clock.t += 61_000;
  assert.equal((await buy()).json.reason, 'MACHINE_OFFLINE');
  w.close();
});

test('temps réel : la machine reçoit la commande sur son flux SSE', async () => {
  const { w, owner, client, c, m, s } = await setup();
  await owner.call('POST', '/owner/machines/' + m.id + '/slots', { slots: SLOTS });
  const ctrl = new AbortController();
  const res = await fetch(w.base + '/machine/events', { headers: { 'x-machine-key': m.key }, signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const readUntil = async (needle) => {
    while (!text.includes(needle)) text += decoder.decode((await reader.read()).value);
  };
  await readUntil('event: hello');
  assert.equal((await client.call('GET', '/machines/' + m.id + '?s=' + s)).json.online, true, 'connectée = en ligne');
  const bought = await client.call('POST', '/machines/' + m.id + '/buy', { s, slot: 1, accountId: c.id });
  await readUntil('event: vend');
  assert.ok(text.includes('"id":"' + bought.json.vend.id + '"'));
  assert.ok(text.includes('"item":"Eau 50 cl"'));
  ctrl.abort();
  w.close();
});

test('webhook : un simulateur répond tout de suite « distribué », signature vérifiable', async () => {
  const { w, owner, client, o, c, m, s } = await setup();
  await owner.call('POST', '/owner/machines/' + m.id + '/slots', { slots: SLOTS });
  const received = [];
  let answer = { dispensed: true };
  const sim = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ body, sig: req.headers['x-kinpay-signature'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  await new Promise((r) => sim.listen(0, '127.0.0.1', r));
  sim.unref();
  const hook = 'http://127.0.0.1:' + sim.address().port + '/kinpay';
  assert.equal((await owner.call('POST', '/owner/machines/' + m.id + '/settings', { webhookUrl: 'ftp://x' })).status, 400);
  assert.equal((await owner.call('POST', '/owner/machines/' + m.id + '/settings', { webhookUrl: hook })).json.webhookUrl, hook);

  const bought = await client.call('POST', '/machines/' + m.id + '/buy', { s, slot: 1, accountId: c.id });
  assert.equal(bought.json.vend.status, 'dispensed', 'résultat immédiat du webhook');
  assert.equal(await owner.balance(o.id), 101000);
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.type, 'vend');
  assert.equal(payload.vend.slot, 1);
  const keyHash = createHash('sha256').update(m.key).digest('hex');
  assert.equal(received[0].sig, createHmac('sha256', keyHash).update(received[0].body).digest('hex'));

  answer = { dispensed: false, reason: 'EMPTY' };
  const again = await client.call('POST', '/machines/' + m.id + '/buy', { s, slot: 1, accountId: c.id });
  assert.equal(again.json.vend.status, 'refunded');
  assert.equal(await client.balance(c.id), 99000);

  // webhook injoignable : remboursement immédiat
  sim.close();
  await owner.call('POST', '/owner/machines/' + m.id + '/settings', { webhookUrl: 'http://127.0.0.1:1/x' });
  const down = await client.call('POST', '/machines/' + m.id + '/buy', { s, slot: 1, accountId: c.id });
  assert.equal(down.json.vend.status, 'refunded');
  assert.equal(down.json.vend.reason, 'MACHINE_UNREACHABLE');
  assert.equal(await client.balance(c.id), 99000);
  w.close();
});

test("pompe à essence : plafond bloqué, montant servi payé, reste rendu ; laverie et devise", async () => {
  const w = await world();
  const owner = await w.user('0890000093');
  const client = await w.user('0990000094');
  const o = await owner.link();
  const c = await client.link('CDF', 'airtel');
  const cUsd = await client.link('USD', 'airtel');
  const pump = (await owner.call('POST', '/owner/machines', { name: 'Pompe 3', kind: 'fuel' })).json;
  const ph = { 'x-machine-key': pump.key };
  const s = new URL(pump.fixedQr.replace('kinpay://', 'http://x/')).searchParams.get('s');
  await w.api('POST', '/machine/heartbeat', undefined, ph);

  assert.equal((await client.call('POST', '/machines/' + pump.id + '/buy', { s, amount: 50000, accountId: cUsd.id })).json.reason, 'CURRENCY_MISMATCH');
  const r = await client.call('POST', '/machines/' + pump.id + '/buy', { s, amount: 50000, accountId: c.id });
  assert.equal(r.json.balance, 50000);
  const done = await w.api('POST', '/machine/vends/' + r.json.vend.id + '/result', { ok: true, finalAmount: 32000 }, ph);
  assert.equal(done.json.finalAmount, 32000);
  assert.equal(await client.balance(c.id), 68000);
  assert.equal(await owner.balance(o.id), 132000);
  assert.equal((await client.history())[0].label, 'Reste rendu : Carburant (Pompe 3)');

  const sum = (await owner.call('GET', '/owner/summary')).json;
  assert.deepEqual(sum.today, [{ currency: 'CDF', n: 1, total: 32000 }]);
  const vends = (await owner.call('GET', '/owner/vends')).json;
  assert.equal(vends[0].client, '+243 99 ••• ••94');
  // un autre utilisateur ne gère pas cette machine
  assert.equal((await client.call('POST', '/owner/machines/' + pump.id + '/slots', { slots: [] })).status, 404);
  assert.deepEqual((await client.call('GET', '/owner/machines')).json, []);
  // nouvelle clé : l'ancienne ne marche plus
  const rot = await owner.call('POST', '/owner/machines/' + pump.id + '/key');
  assert.equal((await w.api('POST', '/machine/heartbeat', undefined, ph)).status, 401);
  assert.equal((await w.api('POST', '/machine/heartbeat', undefined, { 'x-machine-key': rot.json.key })).status, 200);
  w.close();
});

test('machine à écran (QR dynamique) et code OTP : aussi sous séquestre', async () => {
  const w = await world();
  const owner = await w.user('0890000095');
  const client = await w.user('0990000096');
  const o = await owner.link();
  const c = await client.link('CDF', 'airtel');
  const m = w.machine({ id: 'DIST-0099', name: 'Snacks aéroport', ownerUserId: owner.id });

  // la machine publie elle-même son catalogue
  assert.equal((await m.call('POST', '/machine/slots', { slots: [{ slot: 1, name: 'Chips', price: 1500, stock: 3 }] })).status, 200);
  assert.equal((await m.call('POST', '/machine/slots', { slots: [{ slot: 1, name: '', price: 1 }] })).status, 400);
  assert.equal((await m.call('GET', '/machine/me')).json.slots[0].name, 'Chips');

  const q = (await m.call('POST', '/machine/qr', { amount: 1500, item: 'Chips' })).json;
  const paid = await client.call('POST', '/payments/qr', { qr: q.qr, accountId: c.id });
  assert.equal(paid.json.vend.status, 'held');
  const st = (await m.call('GET', '/machine/qr/' + q.nonce)).json;
  assert.equal(st.status, 'paid');
  await m.call('POST', '/machine/vends/' + st.vendId + '/result', { ok: true });
  assert.equal(await owner.balance(o.id), 101500);

  const code = (await client.call('POST', '/payments/code', { accountId: c.id })).json.code;
  const red = await m.call('POST', '/machine/redeem', { code, amount: 1500, item: 'Chips' });
  assert.ok(red.json.vendId);
  await m.call('POST', '/machine/vends/' + red.json.vendId + '/result', { ok: false });
  assert.equal(await client.balance(c.id), 98500, 'second achat remboursé');
  w.close();
});
