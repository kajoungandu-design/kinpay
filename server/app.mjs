import { hashPin, hmac, newCode, newId, newToken, safeEqualHex, sha256, verifyPin } from './lib/crypto.mjs';
import { normalizePhone, OPERATORS } from './lib/phone.mjs';

const DAY = 24 * 3600 * 1000;
// Montants en unités entières : francs pour CDF, cents pour USD. Plafond par opération (à fixer avec la réglementation).
const MAX_AMOUNT = { CDF: 5_000_000, USD: 500_000 };
const CURRENCIES = Object.keys(MAX_AMOUNT);

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

  const toTx = (r) => ({ id: r.id, kind: r.kind, label: r.label, amount: r.amount, currency: r.currency ?? 'CDF', accountId: r.account_id, at: new Date(r.created_at).toISOString() });

  // ---------- cœur : une opération d'argent ----------
  // 1) on note l'opération « pending », 2) on appelle l'opérateur, 3) on note le résultat.
  async function execute(user, { accountId, kind, label, amount, idemKey }, call) {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(accountId, user.id);
    if (!account) return { status: 404, body: { ok: false, reason: 'UNKNOWN_ACCOUNT' } };
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT[account.currency]) return { status: 422, body: { ok: false, reason: 'INVALID_AMOUNT' } };

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
      'INSERT INTO transactions (id, user_id, account_id, kind, label, amount, currency, status, idem_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, user.id, accountId, kind, label, amount, account.currency, 'pending', idemKey ?? null, at);

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
    return { status: 200, body: { ok: true, tx: toTx({ id, kind, label, amount, currency: account.currency, account_id: accountId, created_at: at }), balance: r.balance } };
  }

  function recordReceived(fromUser, fromAccountId, toPhone, amount) {
    // Valable pour le faux opérateur. Avec un vrai opérateur, la réception est confirmée par webhook.
    const { currency } = db.prepare('SELECT currency FROM accounts WHERE id = ?').get(fromAccountId);
    const rows = db.prepare('SELECT id, user_id FROM accounts WHERE phone = ? AND currency = ? AND id <> ?').all(toPhone, currency, fromAccountId);
    for (const a of rows) {
      db.prepare(
        "INSERT INTO transactions (id, user_id, account_id, kind, label, amount, currency, status, created_at) VALUES (?, ?, ?, 'received', ?, ?, ?, 'success', ?)",
      ).run(newId('tx'), a.user_id, a.id, 'Reçu de ' + fromUser.phone, amount, currency, now());
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
  // m = machine (DIST-0042) ou vendeur (U-XXXXXXXX), a = montant, i = article, n = usage unique, e = expiration, c = devise.
  const qrMessage = (m, a, i, n, e, c) => [m, a, i, n, e, c].join('|');
  const payeeCode = (userId) => 'U-' + sha256(userId).slice(0, 8).toUpperCase();
  // « +243 89 ••• ••11 » : assez pour reconnaître la personne, sans afficher tout le numéro.
  const maskPhone = (phone) => phone.slice(0, 4) + ' ' + phone.slice(4, 6) + ' ••• ••' + phone.slice(-2);

  function issueQr({ m, amount, currency, item, ttlSeconds, machineId = null, payeeUserId = null, payeeAccountId = null }) {
    const n = newToken().slice(0, 16);
    const e = Math.floor(now() / 1000) + ttlSeconds;
    const s = hmac(config.qrSecret, qrMessage(m, amount, item, n, e, currency));
    db.prepare(
      'INSERT INTO qr_requests (nonce, machine_id, payee_user_id, payee_account_id, amount, currency, item, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(n, machineId, payeeUserId, payeeAccountId, amount, currency, item, e * 1000);
    const qr = 'kinpay://pay?m=' + m + '&a=' + amount + '&i=' + encodeURIComponent(item) + '&n=' + n + '&e=' + e + '&c=' + currency + '&s=' + s;
    return { ok: true, qr, nonce: n, expiresAt: e * 1000, amount, currency, item };
  }

  // Vérifie un QR scanné : signature, expiration, correspondance avec la demande enregistrée.
  function readQr(text) {
    const p = parseSignedQr(text);
    if (!p) return { error: { status: 400, body: { ok: false, reason: 'INVALID_QR' } } };
    const c = p.c ?? 'CDF';
    if (!safeEqualHex(hmac(config.qrSecret, qrMessage(p.m, p.a, p.i, p.n, p.e, c)), p.s)) return { error: { status: 400, body: { ok: false, reason: 'INVALID_QR' } } };
    if (Number(p.e) * 1000 < now()) return { error: { status: 410, body: { ok: false, reason: 'EXPIRED_QR' } } };
    const req = db.prepare('SELECT * FROM qr_requests WHERE nonce = ?').get(p.n);
    const owner = req && (req.machine_id ?? payeeCode(req.payee_user_id));
    if (!req || owner !== p.m || String(req.amount) !== p.a || req.item !== p.i || req.currency !== c) {
      return { error: { status: 400, body: { ok: false, reason: 'INVALID_QR' } } };
    }
    return { p, req };
  }

  function payeeLabel(req) {
    if (req.machine_id) return db.prepare('SELECT name FROM machines WHERE id = ?').get(req.machine_id)?.name ?? req.machine_id;
    return maskPhone(db.prepare('SELECT phone FROM users WHERE id = ?').get(req.payee_user_id).phone);
  }

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

    // Confirmation du PIN avant une opération d'argent (même blocage que la connexion).
    'POST /me/verify-pin': async ({ user, body }) => {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      if (u.locked_until > now()) return { status: 423, body: { error: 'LOCKED' } };
      if (!verifyPin(String(body.pin ?? ''), u.pin_salt, u.pin_hash)) {
        const failed = u.failed_logins + 1;
        if (failed >= 5) {
          db.prepare('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?').run(now() + 15 * 60_000, u.id);
          return { status: 423, body: { error: 'LOCKED' } };
        }
        db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(failed, u.id);
        return { status: 401, body: { error: 'INVALID_PIN', attemptsLeft: 5 - failed } };
      }
      db.prepare('UPDATE users SET failed_logins = 0 WHERE id = ?').run(u.id);
      return { status: 200, body: { ok: true } };
    },

    'GET /accounts': async ({ user }) => {
      const rows = db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY rowid').all(user.id);
      const out = [];
      for (const a of rows) out.push({ id: a.id, operator: a.operator, label: a.label, phone: a.phone, currency: a.currency, balance: await provider.getBalance(a) });
      return { status: 200, body: out };
    },

    'POST /accounts/link': async ({ user, body }) => {
      const operator = String(body.operator ?? '');
      const phone = normalizePhone(body.phone);
      const currency = body.currency === undefined ? 'CDF' : String(body.currency);
      if (!OPERATORS[operator] || !phone || !CURRENCIES.includes(currency)) return { status: 400, body: { error: 'INVALID_INPUT' } };
      if (db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?').get(user.id).n >= 12) return { status: 409, body: { error: 'TOO_MANY_ACCOUNTS' } };
      if (db.prepare('SELECT 1 FROM accounts WHERE user_id = ? AND operator = ? AND phone = ? AND currency = ?').get(user.id, operator, phone, currency)) {
        return { status: 409, body: { error: 'ALREADY_LINKED' } };
      }
      const { balance } = await provider.link({ operator, phone, currency });
      const id = newId('acc');
      db.prepare('INSERT INTO accounts (id, user_id, operator, label, phone, currency, balance) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, user.id, operator, OPERATORS[operator], phone, currency, balance);
      return { status: 201, body: { id, operator, label: OPERATORS[operator], phone, currency, balance } };
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
      const { p, req, error } = readQr(body.qr);
      if (error) return error;
      if (req.payee_user_id === user.id) return { status: 422, body: { ok: false, reason: 'SELF_PAYMENT' } };
      // Pas de conversion : le compte du payeur doit être dans la devise du QR.
      const payer = db.prepare('SELECT currency FROM accounts WHERE id = ? AND user_id = ?').get(String(body.accountId ?? ''), user.id);
      if (payer && payer.currency !== req.currency) return { status: 422, body: { ok: false, reason: 'CURRENCY_MISMATCH' } };
      const claim = db.prepare("UPDATE qr_requests SET status = 'claimed' WHERE nonce = ? AND status = 'pending'").run(p.n);
      if (Number(claim.changes) !== 1) return { status: 409, body: { ok: false, reason: 'QR_ALREADY_USED' } };
      const toUser = !req.machine_id;
      const label = toUser ? 'Payé à ' + payeeLabel(req) + ' : ' + req.item : req.item + ' (' + req.machine_id + ')';
      const r = await execute(user, { accountId: body.accountId, kind: toUser ? 'payment' : 'machine', label, amount: req.amount, idemKey: body.idempotencyKey }, (account) =>
        provider.pay({ account, amount: req.amount, description: req.item, creditAccountId: req.payee_account_id ?? undefined }),
      );
      db.prepare('UPDATE qr_requests SET status = ?, payer_user_id = ? WHERE nonce = ?').run(r.body.ok ? 'paid' : r.status === 502 ? 'claimed' : 'pending', r.body.ok ? user.id : null, p.n);
      if (r.body.ok && toUser) {
        db.prepare(
          "INSERT INTO transactions (id, user_id, account_id, kind, label, amount, currency, status, created_at) VALUES (?, ?, ?, 'received', ?, ?, ?, 'success', ?)",
        ).run(newId('tx'), req.payee_user_id, req.payee_account_id, 'Reçu de ' + maskPhone(user.phone) + ' : ' + req.item, req.amount, req.currency, now());
      }
      return r;
    },

    // Avant de demander le PIN : l'application montre à qui l'on paie, et le QR est vérifié.
    'POST /payments/qr/check': async ({ user, body }) => {
      const { req, error } = readQr(body.qr);
      if (error) return error;
      if (req.status !== 'pending') return { status: 409, body: { ok: false, reason: 'QR_ALREADY_USED' } };
      if (req.payee_user_id === user.id) return { status: 422, body: { ok: false, reason: 'SELF_PAYMENT' } };
      return { status: 200, body: { ok: true, amount: req.amount, currency: req.currency, item: req.item, payee: payeeLabel(req), expiresAt: req.expires_at } };
    },

    // Encaisser : un taxi, un client ou un commerçant affiche un QR, la personne en face le scanne et paie.
    'POST /requests': async ({ user, body }) => {
      const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(String(body.accountId ?? ''), user.id);
      if (!account) return { status: 404, body: { error: 'UNKNOWN_ACCOUNT' } };
      let amount;
      let item;
      if (Array.isArray(body.items)) {
        // Catalogue : le serveur calcule le total à partir de SES prix, jamais d'un montant envoyé par l'application.
        if (body.items.length < 1 || body.items.length > 20) return { status: 400, body: { error: 'INVALID_INPUT' } };
        amount = 0;
        const parts = [];
        for (const line of body.items) {
          const qty = line?.qty;
          const product = db.prepare('SELECT * FROM products WHERE id = ? AND user_id = ?').get(String(line?.productId ?? ''), user.id);
          if (!product || !Number.isInteger(qty) || qty < 1 || qty > 99) return { status: 400, body: { error: 'INVALID_INPUT' } };
          if (product.currency !== account.currency) return { status: 422, body: { error: 'CURRENCY_MISMATCH' } };
          amount += product.price * qty;
          parts.push(qty + ' × ' + product.name);
        }
        item = parts.join(', ');
        if (item.length > 60) item = item.slice(0, 59) + '…';
      } else {
        amount = body.amount;
        item = String(body.item ?? '').trim().slice(0, 60) || 'Paiement';
      }
      if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT[account.currency]) return { status: 422, body: { error: 'INVALID_AMOUNT' } };
      const out = issueQr({ m: payeeCode(user.id), amount, currency: account.currency, item, ttlSeconds: 600, payeeUserId: user.id, payeeAccountId: account.id });
      return { status: 201, body: out };
    },

    'GET /products': async ({ user }) => {
      const rows = db.prepare('SELECT id, name, price, currency FROM products WHERE user_id = ? ORDER BY name').all(user.id);
      return { status: 200, body: rows.map((r) => ({ ...r })) };
    },

    'POST /products': async ({ user, body }) => {
      const name = String(body.name ?? '').trim();
      const currency = String(body.currency ?? '');
      const price = body.price;
      if (!name || name.length > 40 || !CURRENCIES.includes(currency) || !Number.isInteger(price) || price < 1 || price > MAX_AMOUNT[currency]) {
        return { status: 400, body: { error: 'INVALID_INPUT' } };
      }
      if (db.prepare('SELECT COUNT(*) AS n FROM products WHERE user_id = ?').get(user.id).n >= 60) return { status: 409, body: { error: 'TOO_MANY_PRODUCTS' } };
      const id = newId('prd');
      db.prepare('INSERT INTO products (id, user_id, name, price, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, user.id, name, price, currency, now());
      return { status: 201, body: { id, name, price, currency } };
    },

    'POST /machine/qr': async ({ machine, body }) => {
      const amount = body.amount;
      const item = String(body.item ?? '');
      const currency = body.currency === undefined ? 'CDF' : String(body.currency);
      if (!CURRENCIES.includes(currency) || !Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT[currency] || !item || item.length > 60) {
        return { status: 400, body: { error: 'INVALID_INPUT' } };
      }
      return { status: 201, body: issueQr({ m: machine.id, amount, currency, item, ttlSeconds: 120, machineId: machine.id }) };
    },

    'POST /machine/redeem': async ({ machine, body }) => {
      if (machineBlocked(machine.id)) return { status: 429, body: { ok: false, reason: 'NETWORK', error: 'TOO_MANY_ATTEMPTS' } };
      const amount = body.amount;
      const item = String(body.item ?? '');
      const currency = body.currency === undefined ? 'CDF' : String(body.currency);
      if (!CURRENCIES.includes(currency) || !Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT[currency] || !item || item.length > 60) {
        return { status: 400, body: { error: 'INVALID_INPUT' } };
      }
      const hash = sha256('pc:' + String(body.code ?? ''));
      // Devise différente : refus sans consommer le code (le client peut changer de compte et réessayer).
      const target = db.prepare('SELECT a.currency FROM payment_codes p JOIN accounts a ON a.id = p.account_id WHERE p.code_hash = ? AND p.used = 0 AND p.expires_at >= ?').get(hash, now());
      if (target && target.currency !== currency) return { status: 422, body: { ok: false, reason: 'CURRENCY_MISMATCH' } };
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

  // Routes avec un paramètre dans l'adresse : [méthode, motif, gestionnaire(ctx, valeur)].
  const paramRoutes = [
    [
      'GET',
      /^\/machine\/qr\/([a-f0-9]{16})$/,
      async ({ machine }, nonce) => {
        const r = db.prepare('SELECT status, machine_id FROM qr_requests WHERE nonce = ?').get(nonce);
        if (!r || r.machine_id !== machine.id) return { status: 404, body: { error: 'NOT_FOUND' } };
        return { status: 200, body: { status: r.status } };
      },
    ],
    [
      // L'écran « Encaisser » interroge ce statut jusqu'à « paid ».
      'GET',
      /^\/requests\/([a-f0-9]{16})$/,
      async ({ user }, nonce) => {
        const r = db.prepare('SELECT * FROM qr_requests WHERE nonce = ?').get(nonce);
        if (!r || r.payee_user_id !== user.id) return { status: 404, body: { error: 'NOT_FOUND' } };
        const status = r.status === 'pending' && r.expires_at < now() ? 'expired' : r.status;
        const payer = r.payer_user_id ? maskPhone(db.prepare('SELECT phone FROM users WHERE id = ?').get(r.payer_user_id).phone) : null;
        return { status: 200, body: { status, amount: r.amount, currency: r.currency, item: r.item, payer } };
      },
    ],
    [
      'DELETE',
      /^\/products\/(prd_[a-f0-9]{18})$/,
      async ({ user }, id) => {
        const r = db.prepare('DELETE FROM products WHERE id = ? AND user_id = ?').run(id, user.id);
        return Number(r.changes) === 1 ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'NOT_FOUND' } };
      },
    ],
  ];

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const key = req.method + ' ' + url.pathname;
      const isMachine = url.pathname.startsWith('/machine/');
      let route = routes[key];
      if (!route) {
        for (const [method, pattern, fn] of paramRoutes) {
          const m = req.method === method && pattern.exec(url.pathname);
          if (m) {
            route = (ctx) => fn(ctx, m[1]);
            break;
          }
        }
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
