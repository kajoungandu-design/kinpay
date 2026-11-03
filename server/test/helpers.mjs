// Monde de test commun : serveur en mémoire, horloge contrôlée, utilisateurs, machines.
import { createServer } from 'node:http';
import { createApp } from '../app.mjs';
import { openDb, createMachine } from '../lib/db.mjs';
import { ConsoleSms } from '../lib/sms.mjs';
import { MockProvider } from '../providers/mock.mjs';

export async function world() {
  const clock = { t: Date.parse('2026-11-03T10:00:00Z') };
  const db = openDb(':memory:');
  const sms = new ConsoleSms({ quiet: true });
  const app = createApp({ db, provider: new MockProvider(db), sms, config: { qrSecret: 'w'.repeat(40), now: () => clock.t } });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  const base = 'http://127.0.0.1:' + server.address().port;

  async function api(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  async function user(phone) {
    await api('POST', '/auth/otp', { phone });
    const code = /(\d{6})/.exec(sms.sent.at(-1).text)[1];
    const reg = (await api('POST', '/auth/register', { phone, code, pin: '1234' })).json;
    const h = { authorization: 'Bearer ' + reg.token };
    const call = (method, path, body) => api(method, path, body, h);
    const link = async (currency = 'CDF', operator = 'orange') => (await call('POST', '/accounts/link', { operator, phone, currency })).json;
    const balance = async (id) => (await call('GET', '/accounts')).json.find((a) => a.id === id).balance;
    const history = async () => (await call('GET', '/history')).json;
    return { id: reg.user.id, phone, token: reg.token, h, call, link, balance, history };
  }

  function machine(opts) {
    const key = createMachine(db, { now: clock.t, ...opts });
    const h = { 'x-machine-key': key };
    return { id: opts.id, key, h, call: (method, path, body) => api(method, path, body, h) };
  }

  const makeAgent = (u) => db.prepare('UPDATE users SET is_agent = 1 WHERE id = ?').run(u.id);
  return { base, api, clock, db, user, machine, makeAgent, sweep: app.sweep, close: () => server.close() };
}
