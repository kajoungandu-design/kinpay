// L'adaptateur HTTP (providers/http-network.mjs) parle à un faux réseau qui respecte le contrat de docs/INTEGRATION.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../app.mjs';
import { openDb } from '../lib/db.mjs';
import { ConsoleSms } from '../lib/sms.mjs';
import HttpNetworkProvider from '../providers/http-network.mjs';

// Faux réseau : soldes par (opérateur, numéro, devise).
async function fakeNetwork() {
  const wallets = new Map();
  const refs = new Set();
  const key = (b) => b.operator + '|' + b.phone + '|' + b.currency;
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const b = JSON.parse(raw);
    calls.push({ path: req.url, auth: req.headers.authorization, body: b });
    const send = (j) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(j));
    };
    if (!wallets.has(key(b))) wallets.set(key(b), b.currency === 'USD' ? 2000 : 50000);
    if (req.url === '/accounts/verify' || req.url === '/accounts/balance') return send({ balance: wallets.get(key(b)) });
    if (refs.has(b.reference)) return send({ ok: false, reason: 'INVALID_AMOUNT' });
    refs.add(b.reference);
    if (req.url === '/payouts') {
      wallets.set(key(b), wallets.get(key(b)) + b.amount);
      return send({ ok: true, balance: wallets.get(key(b)) });
    }
    if (wallets.get(key(b)) < b.amount) return send({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
    wallets.set(key(b), wallets.get(key(b)) - b.amount);
    if (req.url === '/transfers') {
      const to = [...wallets.keys()].find((k) => k.split('|')[1] === b.toPhone && k.endsWith('|' + b.currency));
      if (to) wallets.set(to, wallets.get(to) + b.amount);
    }
    send({ ok: true, balance: wallets.get(key(b)) });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  return { url: 'http://127.0.0.1:' + server.address().port, wallets, calls, close: () => server.close() };
}

test('réseau externe par HTTP : liaison, transfert, paiement QR vendeur crédité, refus', async () => {
  const net = await fakeNetwork();
  const db = openDb(':memory:');
  const sms = new ConsoleSms({ quiet: true });
  const provider = new HttpNetworkProvider({ db, env: { NETWORK_API_URL: net.url, NETWORK_API_KEY: 'cle-test' } });
  const app = createApp({ db, provider, sms, config: { qrSecret: 'n'.repeat(40) } });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = async (method, path, body, token) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
  async function user(phone) {
    await api('POST', '/auth/otp', { phone });
    const code = /(\d{6})/.exec(sms.sent.at(-1).text)[1];
    const { token } = await api('POST', '/auth/register', { phone, code, pin: '1234' });
    return { token, acc: await api('POST', '/accounts/link', { operator: 'orange', phone, currency: 'CDF' }, token) };
  }
  const a = await user('0890000301');
  const b = await user('0990000302');
  assert.equal(a.acc.balance, 50000, 'solde lu sur le réseau');
  assert.equal(net.calls[0].auth, 'Bearer cle-test');

  const t = await api('POST', '/transfers', { fromAccountId: a.acc.id, toPhone: '0990000302', amount: 7000 }, a.token);
  assert.equal(t.balance, 43000);
  assert.equal((await api('GET', '/accounts', null, b.token))[0].balance, 57000);

  const q = await api('POST', '/requests', { accountId: b.acc.id, amount: 3000, item: 'Course' }, b.token);
  const paid = await api('POST', '/payments/qr', { qr: q.qr, accountId: a.acc.id }, a.token);
  assert.equal(paid.balance, 40000);
  assert.equal((await api('GET', '/accounts', null, b.token))[0].balance, 60000, 'vendeur crédité par /payouts');

  assert.deepEqual(await api('POST', '/transfers', { fromAccountId: a.acc.id, toPhone: '0990000302', amount: 999999 }, a.token), { ok: false, reason: 'INSUFFICIENT_FUNDS' });
  net.close();
  server.close();
});
