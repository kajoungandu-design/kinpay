import { hashPin, hmac, newCode, newId, newToken, safeEqualHex, sha256, verifyPin } from './lib/crypto.mjs';
import { normalizePhone, OPERATORS } from './lib/phone.mjs';

const DAY = 24 * 3600 * 1000;
const MAX_AMOUNT = 5_000_000; // CDF par opération (à fixer avec la réglementation)

export function createApp({ db, provider, sms, config }) {
  const now = config.now ?? (() => Date.now());
  const machineFailures = new Map(); // machineId -> { count, resetAt }

  // ---------- utilitaires HTTP ----------
  function reply(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(text);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 10_000) throw Object.assign(new Error('too large'), { status: 413 });
      chunks.push(c);
    }
    if (size === 0) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return v && typeof v === 'object' ? v : {};
    } catch {
      throw Object.assign(new Error('bad json'), { status: 400 });
    }
  }

  function userFrom(req) {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer ([a-f0-9]{64})$/.exec(h);
    if (!m) return null;
    const s = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(sha256(m[1]));
    if (!s || s.expires_at < now()) return null;
    return db.prepare('SELECT id, phone FROM users WHERE id = ?').get(s.user_id) ?? null;
  }

  function machineFrom(req) {
    const key = req.headers['x-machine-key'];
    if (typeof key !== 'string' || key.length > 100) return null;
    return db.prepare('SELECT id, name FROM machines WHERE key_hash = ?').get(sha256(key)) ?? null;
  }

  function startSession(userId) {
    const token = newToken();
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, now() + 7 * DAY);
    return token;
  }

  const toTx = (r) => ({ id: r.id, kind: r.kind, label: r.label, amount: r.amount, accountId: r.account_id, at: new Date(r.created_at).toISOString() });

  // ---------- cœur : une opération d'argent ----------
  // 1) on note l'opération « pending », 2) on appelle l'opérateur, 3) on note le résultat.
  async function execute(user, { accountId, kind, label, amount, idemKey }, call) {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(accountId, user.id);
    if (!account) return { status: 404, body: { ok: false, reason: 'UNKNOWN_ACCOUNT' } };
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) return { status: 422, body: { ok: false, reason: 'INVALID_AMOUNT' } };

    if (idemKey) {
      const prev = db.prepare('SELECT * FROM transactions WHERE user_id = ? AND idem_key = ?').get(user.id, idemKey);
      if (prev) {
        if (prev.status === 'success') {
          return { status: 200, replayed: true, body: { ok: true, tx: toTx(prev), balance: await provider.getBalance(account) } };
        }
        if (prev.status === 'pending') return { status: 409, body: { ok: false, reason: 'NETWORK' } };
        return { status: 422, body: { ok: false, reason: prev.failure } };
      }
    }

    const id = newId('tx');
    const at = now();
    db.prepare(
      'INSERT INTO transactions (id, user_id, account_id, kind, label, amount, status, idem_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, user.id, accountId, kind, label, amount, 'pending', idemKey ?? null, at);

    let r;
    try {
      r = await call(account);
    } catch {
      // Résultat inconnu : on laisse « pending » (à rapprocher avec l'opérateur), on ne rejoue pas à l'aveugle.
      return { status: 502, body: { ok: false, reason: 'NETWORK' } };
    }
    if (!r.ok) {
      db.prepare("UPDATE transactions SET status = 'failed', failure = ? WHERE id = ?").run(r.reason, id);
      return { status: 422, body: { ok: false, reason: r.reason } };
    }
    db.prepare("UPDATE transactions SET status = 'success' WHERE id = ?").run(id);
    return { status: 200, body: { ok: true, tx: toTx({ id, kind, label, amount, account_id: accountId, created_at: at }), balance: r.balance } };
  }

  function recordReceived(fromUser, fromAccountId, toPhone, amount) {
    // Valable pour le faux opérateur. Avec un vrai opérateur, la réception est confirmée par webhook.
    const rows = db.prepare('SELECT id, user_id FROM accounts WHERE phone = ? AND id <> ?').all(toPhone, fromAccountId);
    for (const a of rows) {
      db.prepare(
        "INSERT INTO transactions (id, user_id, account_id, kind, label, amount, status, created_at) VALUES (?, ?, ?, 'received', ?, ?, 'success', ?)",
      ).run(newId('tx'), a.user_id, a.id, 'Reçu de ' + fromUser.phone, amount, now());
    }
  }

  function noteMachineFailure(machineId) {
    const t = now();
    const cur = machineFailures.get(machineId);
    if (!cur || cur.resetAt < t) machineFailures.set(machineId, { count: 1, resetAt: t + 60_000 });
    else cur.count += 1;
  }
  const machineBlocked = (machineId) => {
    const cur = machineFailures.get(machineId);
    return !!cur && cur.resetAt >= now() && cur.count >= 10;
  };

  // ---------- QR signé ----------
  const qrMessage = (m, a, i, n, e) => [m, a, i, n, e].join('|');

  function parseSignedQr(text) {
    const m = /^kinpay:\/\/pay\?(.+)$/.exec(String(text ?? '').trim());
    if (!m) return null;
    const p = {};
    for (const part of m[1].split('&')) {
      const eq = part.indexOf('=');
      if (eq < 1) continue;
      try {
        p[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
      } catch {
        return null;
      }
    }
    if (!p.m || !p.a || !p.i || !p.n || !p.e || !p.s) return null;
    return p;
  }

  // ---------- routes ----------
  const routes = {
    'GET /health': async () => ({ status: 200, body: { ok: true } }),

    'POST /auth/otp': async ({ body }) => {
      const phone = normalizePhone(body.phone);
      if (!phone) return { status: 400, body: { error: 'INVALID_PHONE' } };
      const recent = db.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE phone = ? AND created_at > ?').get(phone, now() - 10 * 60_000).n;
      if (recent >= 3) return { status: 429, body: { error: 'TOO_MANY_REQUESTS' } };
      const code = newCode();
      db.prepare('INSERT INTO login_codes (phone, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
        phone,
        sha256(phone + ':' + code),
        now() + 10 * 60_000,
        now(),
      );
      await sms.send(phone, 'KinPay : votre code est ' + code + '. Il expire dans 10 minutes.');
      return { status: 200, body: { ok: true, ...(config.echoOtp ? { devCode: code } : {}) } };
    },

    'POST /auth/register': async ({ body }) => {
      const phone = normalizePhone(body.phone);
      if (!phone) return { status: 400, body: { error: 'INVALID_PHONE' } };
      if (!/^\d{4,6}$/.test(String(body.pin ?? ''))) return { status: 400, body: { error: 'INVALID_PIN' } };
      const row = db.prepare('SELECT * FROM login_codes WHERE phone = ? ORDER BY id DESC LIMIT 1').get(phone);
      if (!row || row.expires_at < now() || row.attempts >= 5) return { status: 401, body: { error: 'INVALID_CODE' } };
      if (!safeEqualHex(sha256(phone + ':' + String(body.code ?? '')), row.code_hash)) {
        db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
        return { status: 401, body: { error: 'INVALID_CODE' } };
      }
      if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) return { status: 409, body: { error: 'ALREADY_REGISTERED' } };
      const { salt, hash } = hashPin(body.pin);
      const id = newId('usr');
      db.prepare('INSERT INTO users (id, phone, pin_salt, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(id, phone, salt, hash, now());
      db.prepare('DELETE FROM login_codes WHERE phone = ?').run(phone);
      return { status: 201, body: { ok: true, token: startSession(id), user: { id, phone } } };
    },

    'POST /auth/login': async ({ body }) => {
      const phone = normalizePhone(body.phone);
      const bad = { status: 401, body: { error: 'INVALID_CREDENTIALS' } };
      if (!phone) return bad;
      const u = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
      if (!u) return bad;
      if (u.locked_until > now()) return { status: 423, body: { error: 'LOCKED' } };
      if (!verifyPin(String(body.pin ?? ''), u.pin_salt, u.pin_hash)) {
        const failed = u.failed_logins + 1;
        if (failed >= 5) db.prepare('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?').run(now() + 15 * 60_000, u.id);
        else db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(failed, u.id);
        return bad;
      }
      db.prepare('UPDATE users SET failed_logins = 0 WHERE id = ?').run(u.id);
      return { status: 200, body: { ok: true, token: startSession(u.id), user: { id: u.id, phone: u.phone } } };
    },

    'GET /accounts': async ({ user }) => {
      const rows = db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY rowid').all(user.id);
      const out = [];
      for (const a of rows) out.push({ id: a.id, operator: a.operator, label: a.label, phone: a.phone, balance: await provider.getBalance(a) });
      return { status: 200, body: out };
    },

    'POST /accounts/link': async ({ user, body }) => {
      const operator = String(body.operator ?? '');
      const phone = normalizePhone(body.phone);
      if (!OPERATORS[operator] || !phone) return { status: 400, body: { error: 'INVALID_INPUT' } };
      if (db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?').get(user.id).n >= 6) return { status: 409, body: { error: 'TOO_MANY_ACCOUNTS' } };
      if (db.prepare('SELECT 1 FROM accounts WHERE user_id = ? AND operator = ? AND phone = ?').get(user.id, operator, phone)) {
        return { status: 409, body: { error: 'ALREADY_LINKED' } };
      }
      const { balance } = await provider.link({ operator, phone });
      const id = newId('acc');
      db.prepare('INSERT INTO accounts (id, user_id, operator, label, phone, balance) VALUES (?, ?, ?, ?, ?, ?)').run(id, user.id, operator, OPERATORS[operator], phone, balance);
      return { status: 201, body: { id, operator, label: OPERATORS[operator], phone, balance } };
    },

    'GET /history': async ({ user }) => {
      const rows = db.prepare("SELECT * FROM transactions WHERE user_id = ? AND status = 'success' ORDER BY created_at DESC, rowid DESC LIMIT 30").all(user.id);
      return { status: 200, body: rows.map(toTx) };
    },

    'POST /transfers': async ({ user, body }) => {
      const toPhone = normalizePhone(body.toPhone);
      if (!toPhone) return { status: 400, body: { ok: false, reason: 'INVALID_AMOUNT', error: 'INVALID_PHONE' } };
      const r = await execute(
        user,
        { accountId: body.fromAccountId, kind: 'transfer', label: 'Envoyé à ' + toPhone, amount: body.amount, idemKey: body.idempotencyKey },
        (account) => provider.transfer({ account, toPhone, amount: body.amount }),
      );
      // Un rejeu (même clé d'idempotence) ne crédite pas une seconde fois le bénéficiaire.
      if (r.status === 200 && !r.replayed) recordReceived(user, body.fromAccountId, toPhone, body.amount);
      return r;
    },

    'POST /bills': async ({ user, body }) => {
      const biller = String(body.biller ?? '').slice(0, 60);
      const reference = String(body.reference ?? '').slice(0, 40);
      if (!biller || !reference) return { status: 400, body: { error: 'INVALID_INPUT' } };
      return execute(user, { accountId: body.fromAccountId, kind: 'bill', label: 'Facture : ' + biller, amount: body.amount, idemKey: body.idempotencyKey }, (account) =>
        provider.pay({ account, amount: body.amount, description: biller + ' ' + reference }),
      );
    },

    'POST /payments/code': async ({ user, body }) => {
      const account = db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?').get(String(body.accountId ?? ''), user.id);
      if (!account) return { status: 404, body: { error: 'UNKNOWN_ACCOUNT' } };
      db.prepare('UPDATE payment_codes SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);
      for (let i = 0; i < 10; i++) {
        const code = newCode();
        try {
          db.prepare('INSERT INTO payment_codes (code_hash, user_id, account_id, expires_at) VALUES (?, ?, ?, ?)').run(sha256('pc:' + code), user.id, account.id, now() + 60_000);
          return { status: 201, body: { ok: true, code, expiresInSeconds: 60 } };
        } catch {
          /* collision : on retente */
        }
      }
      return { status: 503, body: { error: 'RETRY' } };
    },

    'POST /payments/qr': async ({ user, body }) => {
      const p = parseSignedQr(body.qr);
      if (!p) return { status: 400, body: { ok: false, reason: 'INVALID_QR' } };
      const expected = hmac(config.qrSecret, qrMessage(p.m, p.a, p.i, p.n, p.e));
      if (!safeEqualHex(expected, p.s)) return { status: 400, body: { ok: false, reason: 'INVALID_QR' } };
      if (Number(p.e) * 1000 < now()) return { status: 410, body: { ok: false, reason: 'EXPIRED_QR' } };
      const req = db.prepare('SELECT * FROM qr_requests WHERE nonce = ?').get(p.n);
      if (!req || req.machine_id !== p.m || String(req.amount) !== p.a || req.item !== p.i) return { status: 400, body: { ok: false, reason: 'INVALID_QR' } };
      const claim = db.prepare("UPDATE qr_requests SET status = 'claimed' WHERE nonce = ? AND status = 'pending'").run(p.n);
      if (Number(claim.changes) !== 1) return { status: 409, body: { ok: false, reason: 'QR_ALREADY_USED' } };
      const r = await execute(user, { accountId: body.accountId, kind: 'machine', label: req.item + ' (' + req.machine_id + ')', amount: req.amount, idemKey: body.idempotencyKey }, (account) =>
        provider.pay({ account, amount: req.amount, description: req.item }),
      );
      db.prepare('UPDATE qr_requests SET status = ? WHERE nonce = ?').run(r.body.ok ? 'paid' : r.status === 502 ? 'claimed' : 'pending', p.n);
      return r;
    },

    'POST /machine/qr': async ({ machine, body }) => {
      const amount = body.amount;
      const item = String(body.item ?? '');
      if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT || !item || item.length > 60) return { status: 400, body: { error: 'INVALID_INPUT' } };
      const n = newToken().slice(0, 16);
      const e = Math.floor(now() / 1000) + 120;
      const s = hmac(config.qrSecret, qrMessage(machine.id, amount, item, n, e));
      db.prepare('INSERT INTO qr_requests (nonce, machine_id, amount, item, expires_at) VALUES (?, ?, ?, ?, ?)').run(n, machine.id, amount, item, e * 1000);
      const qr = 'kinpay://pay?m=' + machine.id + '&a=' + amount + '&i=' + encodeURIComponent(item) + '&n=' + n + '&e=' + e + '&s=' + s;
      return { status: 201, body: { ok: true, qr, nonce: n, expiresAt: e * 1000 } };
    },

    'POST /machine/redeem': async ({ machine, body }) => {
      if (machineBlocked(machine.id)) return { status: 429, body: { ok: false, reason: 'NETWORK', error: 'TOO_MANY_ATTEMPTS' } };
      const amount = body.amount;
      const item = String(body.item ?? '');
      if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT || !item || item.length > 60) return { status: 400, body: { error: 'INVALID_INPUT' } };
      const hash = sha256('pc:' + String(body.code ?? ''));
      const claim = db.prepare('UPDATE payment_codes SET used = 1 WHERE code_hash = ? AND used = 0 AND expires_at >= ?').run(hash, now());
      if (Number(claim.changes) !== 1) {
        noteMachineFailure(machine.id);
        return { status: 401, body: { ok: false, reason: 'INVALID_CODE' } };
      }
      const pc = db.prepare('SELECT user_id, account_id FROM payment_codes WHERE code_hash = ?').get(hash);
      const user = db.prepare('SELECT id, phone FROM users WHERE id = ?').get(pc.user_id);
      return execute(user, { accountId: pc.account_id, kind: 'machine', label: item + ' (' + machine.id + ')', amount }, (account) => provider.pay({ account, amount, description: item }));
    },
  };

  const machineStatus = /^\/machine\/qr\/([a-f0-9]{16})$/;

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const key = req.method + ' ' + url.pathname;
      const isMachine = url.pathname.startsWith('/machine/');
      let route = routes[key];
      let params = null;
      if (!route && req.method === 'GET' && machineStatus.test(url.pathname)) {
        params = machineStatus.exec(url.pathname);
        route = async ({ machine }) => {
          const r = db.prepare('SELECT status, machine_id FROM qr_requests WHERE nonce = ?').get(params[1]);
          if (!r || r.machine_id !== machine.id) return { status: 404, body: { error: 'NOT_FOUND' } };
          return { status: 200, body: { status: r.status } };
        };
      }
      if (!route) return reply(res, 404, { error: 'NOT_FOUND' });

      const ctx = { body: req.method === 'POST' ? await readJson(req) : {} };
      if (isMachine) {
        ctx.machine = machineFrom(req);
        if (!ctx.machine) return reply(res, 401, { error: 'UNAUTHORIZED' });
      } else if (!key.startsWith('POST /auth/') && key !== 'GET /health') {
        ctx.user = userFrom(req);
        if (!ctx.user) return reply(res, 401, { error: 'UNAUTHORIZED' });
      }
      const out = await route(ctx);
      reply(res, out.status, out.body);
    } catch (e) {
      if (e && e.status) return reply(res, e.status, { error: 'BAD_REQUEST' });
      console.error(e);
      reply(res, 500, { error: 'SERVER_ERROR' });
    }
  };
}
