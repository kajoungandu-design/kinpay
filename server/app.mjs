import { hashPin, hmac, newCode, newId, newToken, safeEqualHex, sha256, verifyPin } from './lib/crypto.mjs';
import { normalizePhone, OPERATORS } from './lib/phone.mjs';
import { createMachine, MACHINE_KINDS, rotateMachineKey } from './lib/db.mjs';
import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';

const PORTAL_HTML = readFileSync(new URL('./public/portail.html', import.meta.url), 'utf8');

const DAY = 24 * 3600 * 1000;
// Heure de Kinshasa (UTC+1) pour « aujourd'hui » et « ce mois » dans le portail.
const KIN_OFFSET = 3600 * 1000;
// Montants en unités entières : francs pour CDF, cents pour USD. Plafond par opération (à fixer avec la réglementation).
const MAX_AMOUNT = { CDF: 5_000_000, USD: 500_000 };
const CURRENCIES = Object.keys(MAX_AMOUNT);

export function createApp({ db, provider, sms, config }) {
  const now = config.now ?? (() => Date.now());
  // Délai laissé à une machine pour confirmer la distribution ; au-delà, le client est remboursé.
  const VEND_TIMEOUT = config.vendTimeoutMs ?? 30_000;
  // Une machine sans signe de vie depuis 60 s est « hors ligne » : l'achat est refusé avant tout débit.
  const ONLINE_WINDOW = 60_000;
  const streams = new Map(); // machineId -> Set de réponses SSE ouvertes (GET /machine/events)

  // Limite d'essais ratés (codes devinés) : 10 par minute et par clé.
  function makeLimiter(max) {
    const map = new Map();
    return {
      note(k) {
        const t = now();
        const cur = map.get(k);
        if (!cur || cur.resetAt < t) map.set(k, { count: 1, resetAt: t + 60_000 });
        else cur.count += 1;
      },
      blocked(k) {
        const cur = map.get(k);
        return !!cur && cur.resetAt >= now() && cur.count >= max;
      },
    };
  }
  const machineLimit = makeLimiter(10);
  const agentLimit = makeLimiter(10);

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
    return db.prepare('SELECT id, phone, is_agent FROM users WHERE id = ?').get(s.user_id) ?? null;
  }

  function machineFrom(req) {
    const key = req.headers['x-machine-key'];
    if (typeof key !== 'string' || key.length > 100) return null;
    const m = db.prepare('SELECT * FROM machines WHERE key_hash = ?').get(sha256(key)) ?? null;
    // Toute requête authentifiée d'une machine est un signe de vie.
    if (m) db.prepare('UPDATE machines SET last_seen_at = ? WHERE id = ?').run(now(), m.id);
    return m;
  }

  const publicUser = (u) => ({ id: u.id, phone: u.phone, isAgent: !!u.is_agent });

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

  function addTx(userId, accountId, kind, label, amount, currency) {
    db.prepare(
      "INSERT INTO transactions (id, user_id, account_id, kind, label, amount, currency, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?)",
    ).run(newId('tx'), userId, accountId, kind, label.slice(0, 80), amount, currency, now());
  }

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

  // ---------- machines connectées (IoT) ----------
  // QR fixe (étiquette collée sur la machine) : identifiant + signature, sans montant.
  const fixedSig = (id) => hmac(config.qrSecret, 'machine|' + id).slice(0, 16);
  const fixedQr = (id) => 'kinpay://m?id=' + id + '&s=' + fixedSig(id);
  const isOnline = (m) => (streams.get(m.id)?.size ?? 0) > 0 || m.last_seen_at > now() - ONLINE_WINDOW || !!m.webhook_url;
  const slotsOf = (machineId) =>
    db.prepare('SELECT slot, name, price, stock FROM machine_slots WHERE machine_id = ? ORDER BY slot').all(machineId).map((r) => ({ ...r }));

  function ownerAccount(machine, currency) {
    if (!machine.owner_user_id) return null;
    return db.prepare('SELECT * FROM accounts WHERE user_id = ? AND currency = ? ORDER BY rowid LIMIT 1').get(machine.owner_user_id, currency) ?? null;
  }

  // Ce que reçoit la machine : quoi distribuer.
  const vendForMachine = (v) => ({ id: v.id, slot: v.slot, item: v.item, amount: v.amount, currency: v.currency, source: v.source, deadline: v.deadline });
  // Ce que voit le client dans l'application.
  function vendForUser(v) {
    const machine = db.prepare('SELECT name FROM machines WHERE id = ?').get(v.machine_id);
    return { id: v.id, status: v.status, item: v.item, amount: v.amount, finalAmount: v.final_amount, currency: v.currency, machine: machine?.name ?? v.machine_id, reason: v.reason };
  }

  function sse(res, event, data) {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  }

  function validWebhook(url) {
    if (typeof url !== 'string' || url.length > 200) return false;
    try {
      const u = new URL(url);
      return u.protocol === 'https:' || (u.protocol === 'http:' && !config.production);
    } catch {
      return false;
    }
  }

  // Envoie l'ordre de distribuer : flux SSE ouvert par la machine et/ou webhook (simulateur, passerelle IoT).
  async function notifyMachine(machine, vend) {
    const ev = vendForMachine(vend);
    for (const res of streams.get(machine.id) ?? []) sse(res, 'vend', ev);
    if (!machine.webhook_url) return;
    const body = JSON.stringify({ type: 'vend', machineId: machine.id, vend: ev });
    try {
      const r = await fetch(machine.webhook_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kinpay-signature': hmac(machine.key_hash, body) },
        body,
        signal: AbortSignal.timeout(4000),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) await finishVend(vend.id, false, null, 'MACHINE_ERROR');
      // Réponse immédiate possible : { dispensed: true | false, finalAmount?, reason? }. Sinon, la machine rappelle /machine/vends/:id/result.
      else if (j && typeof j.dispensed === 'boolean') await finishVend(vend.id, j.dispensed, j.finalAmount, j.reason);
    } catch (e) {
      // Délai dépassé : la machine distribue peut-être encore, on attend son résultat (ou le délai de remboursement).
      if (e?.name !== 'TimeoutError') await finishVend(vend.id, false, null, 'MACHINE_UNREACHABLE');
    }
  }

  async function createVend({ machine, slot = null, ref = null, source, user, accountId, item, amount, currency }) {
    const id = newId('vnd');
    db.prepare(
      'INSERT INTO vends (id, machine_id, slot, ref, source, user_id, account_id, item, amount, currency, created_at, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, machine.id, slot, ref, source, user.id, accountId, item, amount, currency, now(), now() + VEND_TIMEOUT);
    await notifyMachine(machine, db.prepare('SELECT * FROM vends WHERE id = ?').get(id));
    return db.prepare('SELECT * FROM vends WHERE id = ?').get(id);
  }

  /**
   * Fin d'une vente sous séquestre. ok : le propriétaire reçoit le montant final (le reste éventuel est rendu
   * au client, cas de la pompe à essence). Échec ou délai dépassé : le client est remboursé en entier.
   */
  async function finishVend(id, ok, finalAmount, reason) {
    const claim = db.prepare("UPDATE vends SET status = 'finishing' WHERE id = ? AND status = 'held'").run(id);
    const v = db.prepare('SELECT * FROM vends WHERE id = ?').get(id);
    if (Number(claim.changes) !== 1) return v;
    const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(v.machine_id);
    let final = ok ? v.amount : 0;
    if (ok && v.source === 'fuel') final = Number.isInteger(finalAmount) && finalAmount >= 0 && finalAmount <= v.amount ? finalAmount : v.amount;
    try {
      if (final > 0) {
        const owner = ownerAccount(machine, v.currency);
        if (owner) {
          const p = await provider.payout({ account: owner, amount: final, description: v.item });
          if (p.ok) addTx(owner.user_id, owner.id, 'received', 'Vente : ' + v.item + ' (' + machine.name + ')', final, v.currency);
        }
        if (v.slot !== null) db.prepare('UPDATE machine_slots SET stock = stock - 1 WHERE machine_id = ? AND slot = ? AND stock > 0').run(v.machine_id, v.slot);
      }
      const back = v.amount - final;
      if (back > 0) {
        const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(v.account_id);
        await provider.payout({ account, amount: back, description: 'Remboursement ' + v.item });
        addTx(v.user_id, v.account_id, 'refund', (final > 0 ? 'Reste rendu : ' : 'Remboursé : ') + v.item + ' (' + machine.name + ')', back, v.currency);
      }
      const why = final > 0 ? null : String(reason ?? 'FAILED').slice(0, 40);
      db.prepare('UPDATE vends SET status = ?, final_amount = ?, reason = ?, done_at = ? WHERE id = ?').run(final > 0 ? 'dispensed' : 'refunded', final, why, now(), id);
    } catch {
      // Versement interrompu : à rapprocher à la main avec l'opérateur, jamais rejoué automatiquement (risque de double versement).
      db.prepare("UPDATE vends SET status = 'error', done_at = ? WHERE id = ?").run(now(), id);
    }
    return db.prepare('SELECT * FROM vends WHERE id = ?').get(id);
  }

  // Rembourse les ventes dont la machine n'a pas confirmé la distribution à temps.
  async function sweep() {
    const late = db.prepare("SELECT id FROM vends WHERE status = 'held' AND deadline < ?").all(now());
    for (const v of late) await finishVend(v.id, false, null, 'TIMEOUT');
  }

  // Le client paie depuis son compte : l'argent est d'abord débité vers le séquestre KinPay.
  async function chargeForVend(user, { machine, accountId, item, amount, idemKey, kind = 'machine' }) {
    return execute(user, { accountId, kind, label: item + ' (' + machine.name + ')', amount, idemKey }, (account) =>
      provider.pay({ account, amount, description: item }),
    );
  }

  const withdrawalCode = () => String(randomInt(10_000_000, 100_000_000));
  const withdrawalStatus = (w) => (w.status === 'pending' && w.expires_at < now() ? 'expired' : w.status);
  function findWithdrawal(code) {
    if (!/^\d{8}$/.test(String(code ?? ''))) return null;
    const w = db.prepare('SELECT * FROM withdrawals WHERE code_hash = ?').get(sha256('wd:' + code));
    return w && withdrawalStatus(w) === 'pending' ? w : null;
  }

  function kinshasaStarts() {
    const local = new Date(now() + KIN_OFFSET);
    const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - KIN_OFFSET;
    const month = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - KIN_OFFSET;
    return { day, month };
  }

  function ownedMachine(user, id) {
    return db.prepare('SELECT * FROM machines WHERE id = ? AND owner_user_id = ?').get(id, user.id) ?? null;
  }

  function machineSummary(m) {
    const { day } = kinshasaStarts();
    const today = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(final_amount), 0) AS total FROM vends WHERE machine_id = ? AND status = 'dispensed' AND done_at >= ?").get(m.id, day);
    const refunds = db.prepare("SELECT COUNT(*) AS n FROM vends WHERE machine_id = ? AND status = 'refunded' AND done_at >= ?").get(m.id, day);
    return {
      id: m.id,
      name: m.name,
      kind: m.kind,
      currency: m.currency,
      online: isOnline(m),
      connected: (streams.get(m.id)?.size ?? 0) > 0,
      lastSeenAt: m.last_seen_at || null,
      webhookUrl: m.webhook_url,
      fixedQr: fixedQr(m.id),
      slots: slotsOf(m.id),
      today: { sales: today.n, total: today.total, refunds: refunds.n },
    };
  }

  function parseSlots(list, { requireStockField = false } = {}) {
    if (!Array.isArray(list) || list.length > 60) return null;
    const out = [];
    const seen = new Set();
    for (const s of list) {
      const slot = s?.slot;
      const name = String(s?.name ?? '').trim();
      const price = s?.price;
      const stock = s?.stock === undefined || s?.stock === null ? null : s.stock;
      if (!Number.isInteger(slot) || slot < 0 || slot > 999 || seen.has(slot)) return null;
      if (!name || name.length > 40 || !Number.isInteger(price) || price < 1) return null;
      if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 9999)) return null;
      if (requireStockField && stock === undefined) return null;
      seen.add(slot);
      out.push({ slot, name, price, stock });
    }
    return out;
  }

  function replaceSlots(machine, slots) {
    for (const s of slots) if (s.price > MAX_AMOUNT[machine.currency]) return false;
    db.exec('BEGIN');
    db.prepare('DELETE FROM machine_slots WHERE machine_id = ?').run(machine.id);
    for (const s of slots) db.prepare('INSERT INTO machine_slots (machine_id, slot, name, price, stock) VALUES (?, ?, ?, ?, ?)').run(machine.id, s.slot, s.name, s.price, s.stock);
    db.exec('COMMIT');
    return true;
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
      return { status: 201, body: { ok: true, token: startSession(id), user: { id, phone, isAgent: false } } };
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
      return { status: 200, body: { ok: true, token: startSession(u.id), user: publicUser(u) } };
    },

    'GET /me': async ({ user }) => {
      const machines = db.prepare('SELECT COUNT(*) AS n FROM machines WHERE owner_user_id = ?').get(user.id).n;
      return { status: 200, body: { ...publicUser(user), machines } };
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
      if (r.body.ok && !toUser && !r.replayed) {
        // Machine à écran : l'argent reste au séquestre jusqu'à la confirmation de distribution.
        const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(req.machine_id);
        const vend = await createVend({ machine, ref: p.n, source: 'qr', user, accountId: body.accountId, item: req.item, amount: req.amount, currency: req.currency });
        r.body.vend = vendForUser(vend);
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
      if (machineLimit.blocked(machine.id)) return { status: 429, body: { ok: false, reason: 'NETWORK', error: 'TOO_MANY_ATTEMPTS' } };
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
        machineLimit.note(machine.id);
        return { status: 401, body: { ok: false, reason: 'INVALID_CODE' } };
      }
      const pc = db.prepare('SELECT user_id, account_id FROM payment_codes WHERE code_hash = ?').get(hash);
      const user = db.prepare('SELECT id, phone FROM users WHERE id = ?').get(pc.user_id);
      const r = await execute(user, { accountId: pc.account_id, kind: 'machine', label: item + ' (' + machine.id + ')', amount }, (account) =>
        provider.pay({ account, amount, description: item }),
      );
      if (r.body.ok) {
        // La machine doit confirmer la distribution (POST /machine/vends/:id/result), sinon remboursement.
        const vend = await createVend({ machine, source: 'code', user, accountId: pc.account_id, item, amount, currency });
        r.body.vendId = vend.id;
      }
      return r;
    },

    // ---------- machine connectée : flux, signe de vie, catalogue ----------

    // Pour une machine qui ne garde pas de connexion ouverte : interroger toutes les 1 à 3 s.
    'POST /machine/heartbeat': async ({ machine }) => {
      const vends = db.prepare("SELECT * FROM vends WHERE machine_id = ? AND status = 'held' ORDER BY created_at").all(machine.id);
      return { status: 200, body: { ok: true, vends: vends.map(vendForMachine) } };
    },

    'GET /machine/me': async ({ machine }) => ({
      status: 200,
      body: { id: machine.id, name: machine.name, kind: machine.kind, currency: machine.currency, fixedQr: fixedQr(machine.id), slots: slotsOf(machine.id) },
    }),

    // La machine (ou le simulateur) publie son catalogue : remplace tous les emplacements.
    'POST /machine/slots': async ({ machine, body }) => {
      const slots = parseSlots(body.slots);
      if (!slots || !replaceSlots(machine, slots)) return { status: 400, body: { error: 'INVALID_INPUT' } };
      return { status: 200, body: { ok: true, slots: slotsOf(machine.id) } };
    },

    // Distributeur de billets : le client saisit son code de retrait à 8 chiffres.
    'POST /machine/withdraw': async ({ machine, body }) => {
      if (machine.kind !== 'atm') return { status: 403, body: { ok: false, error: 'NOT_ATM' } };
      if (machineLimit.blocked(machine.id)) return { status: 429, body: { ok: false, error: 'TOO_MANY_ATTEMPTS' } };
      const w = findWithdrawal(body.code);
      if (!w) {
        machineLimit.note(machine.id);
        return { status: 404, body: { ok: false, reason: 'INVALID_CODE' } };
      }
      if (w.currency !== machine.currency) return { status: 422, body: { ok: false, reason: 'CURRENCY_MISMATCH' } };
      const claim = db.prepare("UPDATE withdrawals SET status = 'processing' WHERE id = ? AND status = 'pending'").run(w.id);
      if (Number(claim.changes) !== 1) return { status: 404, body: { ok: false, reason: 'INVALID_CODE' } };
      const client = db.prepare('SELECT id, phone FROM users WHERE id = ?').get(w.user_id);
      const r = await chargeForVend(client, { machine, accountId: w.account_id, item: 'Retrait DAB', amount: w.amount, kind: 'withdrawal' });
      if (!r.body.ok) {
        db.prepare("UPDATE withdrawals SET status = 'failed', failure = ? WHERE id = ?").run(r.body.reason, w.id);
        return r;
      }
      // Billets non sortis = client remboursé : même séquestre que les ventes.
      const vend = await createVend({ machine, source: 'atm', user: client, accountId: w.account_id, item: 'Retrait DAB', amount: w.amount, currency: w.currency });
      db.prepare("UPDATE withdrawals SET status = 'done', machine_id = ?, vend_id = ?, done_at = ? WHERE id = ?").run(machine.id, vend.id, now(), w.id);
      return { status: 200, body: { ok: true, amount: w.amount, currency: w.currency, vendId: vend.id } };
    },

    // ---------- retraits d'espèces (client) ----------

    'POST /withdrawals': async ({ user, body }) => {
      const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(String(body.accountId ?? ''), user.id);
      if (!account) return { status: 404, body: { ok: false, reason: 'UNKNOWN_ACCOUNT' } };
      const amount = body.amount;
      if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT[account.currency]) return { status: 422, body: { ok: false, reason: 'INVALID_AMOUNT' } };
      if ((await provider.getBalance(account)) < amount) return { status: 422, body: { ok: false, reason: 'INSUFFICIENT_FUNDS' } };
      // Un seul retrait en attente par client : le précédent est annulé.
      db.prepare("UPDATE withdrawals SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'").run(user.id);
      for (let i = 0; i < 10; i++) {
        const code = withdrawalCode();
        const id = newId('wd');
        try {
          db.prepare('INSERT INTO withdrawals (id, code_hash, user_id, account_id, amount, currency, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
            id,
            sha256('wd:' + code),
            user.id,
            account.id,
            amount,
            account.currency,
            now() + 15 * 60_000,
            now(),
          );
          return { status: 201, body: { ok: true, id, code, amount, currency: account.currency, expiresAt: now() + 15 * 60_000 } };
        } catch {
          /* collision : on retente */
        }
      }
      return { status: 503, body: { error: 'RETRY' } };
    },

    'GET /withdrawals/current': async ({ user }) => {
      const w = db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(user.id);
      if (!w) return { status: 200, body: { withdrawal: null } };
      const agent = w.agent_user_id ? maskPhone(db.prepare('SELECT phone FROM users WHERE id = ?').get(w.agent_user_id).phone) : null;
      const machine = w.machine_id ? db.prepare('SELECT name FROM machines WHERE id = ?').get(w.machine_id)?.name : null;
      return {
        status: 200,
        body: { withdrawal: { id: w.id, status: withdrawalStatus(w), amount: w.amount, currency: w.currency, accountId: w.account_id, expiresAt: w.expires_at, failure: w.failure, servedBy: agent ? 'Agent ' + agent : machine ?? null } },
      };
    },

    'POST /withdrawals/cancel': async ({ user }) => {
      db.prepare("UPDATE withdrawals SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'").run(user.id);
      return { status: 200, body: { ok: true } };
    },

    // ---------- agent agréé (application agent) ----------

    'POST /agent/withdrawals/lookup': async ({ user, body }) => {
      if (!user.is_agent) return { status: 403, body: { ok: false, error: 'NOT_AGENT' } };
      if (agentLimit.blocked(user.id)) return { status: 429, body: { ok: false, error: 'TOO_MANY_ATTEMPTS' } };
      const w = findWithdrawal(body.code);
      if (!w) {
        agentLimit.note(user.id);
        return { status: 404, body: { ok: false, reason: 'INVALID_CODE' } };
      }
      const client = db.prepare('SELECT phone FROM users WHERE id = ?').get(w.user_id);
      return { status: 200, body: { ok: true, amount: w.amount, currency: w.currency, client: maskPhone(client.phone), expiresAt: w.expires_at } };
    },

    'POST /agent/withdrawals/confirm': async ({ user, body }) => {
      if (!user.is_agent) return { status: 403, body: { ok: false, error: 'NOT_AGENT' } };
      if (agentLimit.blocked(user.id)) return { status: 429, body: { ok: false, error: 'TOO_MANY_ATTEMPTS' } };
      const w = findWithdrawal(body.code);
      if (!w) {
        agentLimit.note(user.id);
        return { status: 404, body: { ok: false, reason: 'INVALID_CODE' } };
      }
      if (w.user_id === user.id) return { status: 422, body: { ok: false, reason: 'SELF_PAYMENT' } };
      const agentAccount = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(String(body.accountId ?? ''), user.id);
      if (!agentAccount) return { status: 404, body: { ok: false, reason: 'UNKNOWN_ACCOUNT' } };
      if (agentAccount.currency !== w.currency) return { status: 422, body: { ok: false, reason: 'CURRENCY_MISMATCH' } };
      const claim = db.prepare("UPDATE withdrawals SET status = 'processing' WHERE id = ? AND status = 'pending'").run(w.id);
      if (Number(claim.changes) !== 1) return { status: 404, body: { ok: false, reason: 'INVALID_CODE' } };
      const client = db.prepare('SELECT id, phone FROM users WHERE id = ?').get(w.user_id);
      // Le client est débité et l'agent crédité (monnaie électronique) dans la même opération ; l'agent remet ensuite le cash.
      const r = await execute(client, { accountId: w.account_id, kind: 'withdrawal', label: 'Retrait chez agent ' + maskPhone(user.phone), amount: w.amount }, (account) =>
        provider.pay({ account, amount: w.amount, description: 'Retrait agent', creditAccountId: agentAccount.id }),
      );
      if (!r.body.ok) {
        db.prepare("UPDATE withdrawals SET status = 'failed', failure = ? WHERE id = ?").run(r.body.reason ?? 'NETWORK', w.id);
        return r;
      }
      db.prepare("UPDATE withdrawals SET status = 'done', agent_user_id = ?, done_at = ? WHERE id = ?").run(user.id, now(), w.id);
      addTx(user.id, agentAccount.id, 'received', 'Retrait servi à ' + maskPhone(client.phone), w.amount, w.currency);
      return { status: 200, body: { ok: true, amount: w.amount, currency: w.currency, client: maskPhone(client.phone), balance: await provider.getBalance(agentAccount) } };
    },

    'GET /agent/withdrawals': async ({ user }) => {
      if (!user.is_agent) return { status: 403, body: { ok: false, error: 'NOT_AGENT' } };
      const rows = db
        .prepare("SELECT w.*, u.phone FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.agent_user_id = ? AND w.status = 'done' ORDER BY w.done_at DESC LIMIT 50")
        .all(user.id);
      return { status: 200, body: rows.map((w) => ({ id: w.id, amount: w.amount, currency: w.currency, client: maskPhone(w.phone), at: new Date(w.done_at).toISOString() })) };
    },

    // ---------- propriétaires de machines (portail web) ----------

    'GET /owner/machines': async ({ user }) => {
      const rows = db.prepare('SELECT * FROM machines WHERE owner_user_id = ? ORDER BY created_at, id').all(user.id);
      return { status: 200, body: rows.map(machineSummary) };
    },

    'POST /owner/machines': async ({ user, body }) => {
      const name = String(body.name ?? '').trim();
      const kind = String(body.kind ?? 'vending');
      const currency = String(body.currency ?? 'CDF');
      if (!name || name.length > 40 || !MACHINE_KINDS.includes(kind) || !CURRENCIES.includes(currency)) return { status: 400, body: { error: 'INVALID_INPUT' } };
      if (db.prepare('SELECT COUNT(*) AS n FROM machines WHERE owner_user_id = ?').get(user.id).n >= 50) return { status: 409, body: { error: 'TOO_MANY_MACHINES' } };
      for (let i = 0; i < 10; i++) {
        const id = 'DIST-' + newToken().slice(0, 6).toUpperCase();
        if (db.prepare('SELECT 1 FROM machines WHERE id = ?').get(id)) continue;
        const key = createMachine(db, { id, name, kind, currency, ownerUserId: user.id, now: now() });
        return { status: 201, body: { ...machineSummary(db.prepare('SELECT * FROM machines WHERE id = ?').get(id)), key } };
      }
      return { status: 503, body: { error: 'RETRY' } };
    },

    'GET /owner/vends': async ({ user }) => {
      const rows = db
        .prepare(
          'SELECT v.*, m.name AS machine_name, u.phone FROM vends v JOIN machines m ON m.id = v.machine_id JOIN users u ON u.id = v.user_id WHERE m.owner_user_id = ? ORDER BY v.created_at DESC, v.rowid DESC LIMIT 50',
        )
        .all(user.id);
      return {
        status: 200,
        body: rows.map((v) => ({
          id: v.id,
          machineId: v.machine_id,
          machine: v.machine_name,
          item: v.item,
          amount: v.amount,
          finalAmount: v.final_amount,
          currency: v.currency,
          status: v.status,
          reason: v.reason,
          client: maskPhone(v.phone),
          at: new Date(v.created_at).toISOString(),
        })),
      };
    },

    'GET /owner/summary': async ({ user }) => {
      const { day, month } = kinshasaStarts();
      const sum = (from, status) =>
        db
          .prepare('SELECT v.currency, COUNT(*) AS n, COALESCE(SUM(v.final_amount), 0) AS total FROM vends v JOIN machines m ON m.id = v.machine_id WHERE m.owner_user_id = ? AND v.status = ? AND v.done_at >= ? GROUP BY v.currency')
          .all(user.id, status, from)
          .map((r) => ({ ...r }));
      const balances = db.prepare('SELECT id, label, currency, phone FROM accounts WHERE user_id = ? ORDER BY rowid').all(user.id);
      const accounts = [];
      for (const a of balances) accounts.push({ id: a.id, label: a.label, currency: a.currency, phone: a.phone, balance: await provider.getBalance(a) });
      return { status: 200, body: { today: sum(day, 'dispensed'), month: sum(month, 'dispensed'), refundsToday: sum(day, 'refunded'), accounts } };
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
        const vend = db.prepare('SELECT id, status FROM vends WHERE machine_id = ? AND ref = ?').get(machine.id, nonce);
        return { status: 200, body: { status: r.status, vendId: vend?.id ?? null, vendStatus: vend?.status ?? null } };
      },
    ],
    [
      // La machine confirme : produit tombé (ok: true) ou blocage (ok: false). Pompe : finalAmount = montant servi.
      'POST',
      /^\/machine\/vends\/(vnd_[a-f0-9]{18})\/result$/,
      async ({ machine, body }, id) => {
        const v = db.prepare('SELECT * FROM vends WHERE id = ? AND machine_id = ?').get(id, machine.id);
        if (!v) return { status: 404, body: { error: 'NOT_FOUND' } };
        if (typeof body.ok !== 'boolean') return { status: 400, body: { error: 'INVALID_INPUT' } };
        // Résultat déjà connu (rejeu, ou délai dépassé) : on renvoie l'état final sans rien refaire.
        const done = await finishVend(id, body.ok, body.finalAmount, body.reason);
        return { status: 200, body: { ok: true, status: done.status, finalAmount: done.final_amount } };
      },
    ],
    [
      // QR fixe scanné : menu de la machine, disponibilité et stock.
      'GET',
      /^\/machines\/([A-Za-z0-9_-]{1,32})$/,
      async ({ query }, id) => {
        const m = db.prepare('SELECT * FROM machines WHERE id = ?').get(id);
        if (!m || !safeEqualHex(fixedSig(id), query.get('s') ?? '')) return { status: 404, body: { ok: false, reason: 'INVALID_QR' } };
        const busy = !!db.prepare("SELECT 1 FROM vends WHERE machine_id = ? AND status = 'held'").get(id);
        return { status: 200, body: { ok: true, id: m.id, name: m.name, kind: m.kind, currency: m.currency, online: isOnline(m), busy, slots: m.kind === 'fuel' ? [] : slotsOf(id) } };
      },
    ],
    [
      'POST',
      /^\/machines\/([A-Za-z0-9_-]{1,32})\/buy$/,
      async ({ user, body }, id) => {
        const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(id);
        if (!machine || !safeEqualHex(fixedSig(id), String(body.s ?? ''))) return { status: 404, body: { ok: false, reason: 'INVALID_QR' } };
        if (machine.kind === 'atm') return { status: 400, body: { ok: false, reason: 'INVALID_QR' } };
        const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(String(body.accountId ?? ''), user.id);
        if (!account) return { status: 404, body: { ok: false, reason: 'UNKNOWN_ACCOUNT' } };
        if (account.currency !== machine.currency) return { status: 422, body: { ok: false, reason: 'CURRENCY_MISMATCH' } };
        // Vérifications AVANT tout débit : machine joignable, libre, produit disponible.
        if (!isOnline(machine)) return { status: 503, body: { ok: false, reason: 'MACHINE_OFFLINE' } };
        if (db.prepare("SELECT 1 FROM vends WHERE machine_id = ? AND status = 'held'").get(id)) return { status: 409, body: { ok: false, reason: 'MACHINE_BUSY' } };
        let item;
        let amount;
        let slot = null;
        let source = 'fixed';
        if (machine.kind === 'fuel') {
          // Pré-autorisation : on bloque un plafond, la pompe sert, le reste est rendu.
          amount = body.amount;
          item = 'Carburant';
          source = 'fuel';
          if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT[machine.currency]) return { status: 422, body: { ok: false, reason: 'INVALID_AMOUNT' } };
        } else {
          const s = db.prepare('SELECT * FROM machine_slots WHERE machine_id = ? AND slot = ?').get(id, body.slot);
          if (!s) return { status: 400, body: { ok: false, reason: 'INVALID_AMOUNT', error: 'UNKNOWN_SLOT' } };
          if (s.stock === 0) return { status: 409, body: { ok: false, reason: 'OUT_OF_STOCK' } };
          ({ name: item, price: amount, slot } = s);
        }
        const r = await chargeForVend(user, { machine, accountId: account.id, item, amount, idemKey: body.idempotencyKey });
        if (!r.body.ok) return r;
        if (r.replayed) {
          const prev = db.prepare('SELECT * FROM vends WHERE user_id = ? AND machine_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id, id);
          if (prev) r.body.vend = vendForUser(prev);
          return r;
        }
        const vend = await createVend({ machine, slot, source, user, accountId: account.id, item, amount, currency: machine.currency });
        r.body.vend = vendForUser(vend);
        return r;
      },
    ],
    [
      // L'application suit sa vente : held -> dispensed / refunded.
      'GET',
      /^\/vends\/(vnd_[a-f0-9]{18})$/,
      async ({ user }, id) => {
        const v = db.prepare('SELECT * FROM vends WHERE id = ? AND user_id = ?').get(id, user.id);
        if (!v) return { status: 404, body: { error: 'NOT_FOUND' } };
        return { status: 200, body: vendForUser(v) };
      },
    ],
    [
      'POST',
      /^\/owner\/machines\/([A-Za-z0-9_-]{1,32})\/slots$/,
      async ({ user, body }, id) => {
        const m = ownedMachine(user, id);
        if (!m) return { status: 404, body: { error: 'NOT_FOUND' } };
        const slots = parseSlots(body.slots);
        if (!slots || !replaceSlots(m, slots)) return { status: 400, body: { error: 'INVALID_INPUT' } };
        return { status: 200, body: machineSummary(m) };
      },
    ],
    [
      // Nom de la machine et adresse du webhook (simulateur, passerelle IoT). webhookUrl: null pour l'enlever.
      'POST',
      /^\/owner\/machines\/([A-Za-z0-9_-]{1,32})\/settings$/,
      async ({ user, body }, id) => {
        const m = ownedMachine(user, id);
        if (!m) return { status: 404, body: { error: 'NOT_FOUND' } };
        if (body.name !== undefined) {
          const name = String(body.name).trim();
          if (!name || name.length > 40) return { status: 400, body: { error: 'INVALID_INPUT' } };
          db.prepare('UPDATE machines SET name = ? WHERE id = ?').run(name, id);
        }
        if (body.webhookUrl !== undefined) {
          const url = body.webhookUrl === null || body.webhookUrl === '' ? null : body.webhookUrl;
          if (url !== null && !validWebhook(url)) return { status: 400, body: { error: 'INVALID_WEBHOOK' } };
          db.prepare('UPDATE machines SET webhook_url = ? WHERE id = ?').run(url, id);
        }
        return { status: 200, body: machineSummary(db.prepare('SELECT * FROM machines WHERE id = ?').get(id)) };
      },
    ],
    [
      // Nouvelle clé secrète (clé perdue ou volée). L'ancienne cesse de fonctionner.
      'POST',
      /^\/owner\/machines\/([A-Za-z0-9_-]{1,32})\/key$/,
      async ({ user }, id) => {
        if (!ownedMachine(user, id)) return { status: 404, body: { error: 'NOT_FOUND' } };
        for (const res of streams.get(id) ?? []) res.end();
        return { status: 200, body: { ok: true, key: rotateMachineKey(db, id) } };
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

  // Flux temps réel pour une machine : « vend » (à distribuer) et « ping » toutes les 15 s.
  function openStream(req, res, machine) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    const set = streams.get(machine.id) ?? new Set();
    set.add(res);
    streams.set(machine.id, set);
    sse(res, 'hello', { id: machine.id, name: machine.name, kind: machine.kind, currency: machine.currency });
    // Ventes en attente envoyées à nouveau après une coupure réseau.
    for (const v of db.prepare("SELECT * FROM vends WHERE machine_id = ? AND status = 'held' ORDER BY created_at").all(machine.id)) sse(res, 'vend', vendForMachine(v));
    const ping = setInterval(() => {
      db.prepare('UPDATE machines SET last_seen_at = ? WHERE id = ?').run(now(), machine.id);
      sse(res, 'ping', { at: now() });
    }, 15_000);
    ping.unref?.();
    req.on('close', () => {
      clearInterval(ping);
      set.delete(res);
      // La machine vient de partir : elle reste « en ligne » encore 60 s (reconnexion rapide).
      db.prepare('UPDATE machines SET last_seen_at = ? WHERE id = ?').run(now(), machine.id);
    });
  }

  const handler = async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const key = req.method + ' ' + url.pathname;
      const isMachine = url.pathname.startsWith('/machine/');
      if (key === 'GET /portail' || key === 'GET /portail/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
        });
        return res.end(PORTAL_HTML);
      }
      await sweep();
      if (key === 'GET /machine/events') {
        const machine = machineFrom(req);
        if (!machine) return reply(res, 401, { error: 'UNAUTHORIZED' });
        return openStream(req, res, machine);
      }
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

      const ctx = { body: req.method === 'POST' ? await readJson(req) : {}, query: url.searchParams };
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
  // Appelé aussi par un minuteur (server.mjs) pour rembourser même sans trafic.
  handler.sweep = sweep;
  return handler;
}
