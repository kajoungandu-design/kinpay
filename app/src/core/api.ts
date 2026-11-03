import type {
  Account,
  BillRequest,
  FailureReason,
  MachineMenu,
  MachineRequest,
  MobileMoneyProvider,
  OperatorId,
  Currency,
  PaymentResult,
  Product,
  Transaction,
  TransferRequest,
  Vend,
  Withdrawal,
} from './types';

export type Session = { token: string; user: { id: string; phone: string; isAgent?: boolean } };

/** Code de retrait à 8 chiffres, valable 15 minutes. */
export type NewWithdrawal = { id: string; code: string; amount: number; currency: Currency; expiresAt: number };
/** Ce que voit l'agent avant de remettre le cash. */
export type WithdrawalLookup = { amount: number; currency: Currency; client: string; expiresAt: number };
export type ServedWithdrawal = { id: string; amount: number; currency: Currency; client: string; at: string };

/** QR d'encaissement créé par le serveur (valable 10 minutes, usage unique). */
export type PaymentRequest = { qr: string; nonce: string; expiresAt: number; amount: number; currency: Currency; item: string };
export type RequestStatus = { status: 'pending' | 'claimed' | 'paid' | 'expired'; amount: number; currency: Currency; item: string; payer: string | null };

export class ApiError extends Error {
  status: number;
  code: string;
  attemptsLeft?: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const KNOWN_REASONS: FailureReason[] = [
  'INSUFFICIENT_FUNDS',
  'INVALID_AMOUNT',
  'UNKNOWN_ACCOUNT',
  'INVALID_QR',
  'EXPIRED_QR',
  'QR_ALREADY_USED',
  'CURRENCY_MISMATCH',
  'SELF_PAYMENT',
  'MACHINE_OFFLINE',
  'MACHINE_BUSY',
  'OUT_OF_STOCK',
  'INVALID_CODE',
  'NETWORK',
];

const reasonOf = (json: any): FailureReason => {
  const reason = json?.reason as FailureReason | undefined;
  return reason && KNOWN_REASONS.includes(reason) ? reason : 'NETWORK';
};

/** Résultat d'un appel qui peut échouer pour une raison connue (solde, code invalide...) sans lever d'exception. */
export type Outcome<T> = ({ ok: true } & T) | { ok: false; reason: FailureReason; error?: string };

/** Appels HTTP vers le serveur KinPay. Pas de dépendance : utilise fetch. */
export class ApiClient {
  baseUrl: string;
  getToken: () => string | null;

  constructor(baseUrl: string, getToken: () => string | null = () => null) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.getToken = getToken;
  }

  async request(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const token = this.getToken();
      if (token) headers.authorization = 'Bearer ' + token;
      const res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      let json: any = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Renvoie le code quand le serveur est en développement (DEV_ECHO_OTP=1), sinon null : le code part par SMS. */
  async requestCode(phone: string): Promise<string | null> {
    const r = await this.request('POST', '/auth/otp', { phone });
    if (r.status !== 200) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
    return typeof r.json?.devCode === 'string' ? r.json.devCode : null;
  }

  async register(phone: string, code: string, pin: string): Promise<Session> {
    const r = await this.request('POST', '/auth/register', { phone, code, pin });
    if (r.status !== 201) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
    return { token: r.json.token, user: r.json.user };
  }

  async login(phone: string, pin: string): Promise<Session> {
    const r = await this.request('POST', '/auth/login', { phone, pin });
    if (r.status !== 200) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
    return { token: r.json.token, user: r.json.user };
  }

  /** Confirme le PIN de l'utilisateur connecté. ApiError INVALID_PIN (avec essais restants) ou LOCKED sinon. */
  async verifyPin(pin: string): Promise<void> {
    const r = await this.request('POST', '/me/verify-pin', { pin });
    if (r.status === 200) return;
    const err = new ApiError(r.status, r.json?.error ?? 'NETWORK');
    if (typeof r.json?.attemptsLeft === 'number') err.attemptsLeft = r.json.attemptsLeft;
    throw err;
  }

  // ---------- Encaisser par QR ----------

  /** Crée un QR à faire scanner : montant libre (taxi, client) ou articles du catalogue (total calculé par le serveur). */
  async createRequest(req: { accountId: string; amount?: number; item?: string; items?: { productId: string; qty: number }[] }): Promise<PaymentRequest> {
    const r = await this.request('POST', '/requests', req);
    if (r.status !== 201) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
    return r.json as PaymentRequest;
  }

  async getRequestStatus(nonce: string): Promise<RequestStatus> {
    const r = await this.request('GET', '/requests/' + nonce);
    if (r.status !== 200) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
    return r.json as RequestStatus;
  }

  /** Vérifie un QR scanné et dit à qui l'on paie, avant de demander le PIN. */
  async checkQr(qr: string): Promise<{ ok: true; payee: string; amount: number; currency: Currency; item: string } | { ok: false; reason: FailureReason }> {
    try {
      const r = await this.request('POST', '/payments/qr/check', { qr });
      if (r.status === 200 && r.json?.ok) return r.json;
      const reason = r.json?.reason as FailureReason | undefined;
      return { ok: false, reason: reason && KNOWN_REASONS.includes(reason) ? reason : 'NETWORK' };
    } catch {
      return { ok: false, reason: 'NETWORK' };
    }
  }

  async listProducts(): Promise<Product[]> {
    const r = await this.request('GET', '/products');
    if (r.status !== 200) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
    return r.json as Product[];
  }

  async addProduct(p: { name: string; price: number; currency: Currency }): Promise<Product> {
    const r = await this.request('POST', '/products', p);
    if (r.status !== 201) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
    return r.json as Product;
  }

  async deleteProduct(id: string): Promise<void> {
    const r = await this.request('DELETE', '/products/' + id);
    if (r.status !== 200) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
  }

  /** Appel POST/GET qui renvoie { ok: false, reason } au lieu de lever une exception. */
  private async outcome<T>(method: string, path: string, body: unknown, okStatus: number): Promise<Outcome<T>> {
    try {
      const r = await this.request(method, path, body);
      if (r.status === okStatus && r.json && r.json.ok !== false) return { ok: true, ...(r.json as T) };
      return { ok: false, reason: reasonOf(r.json), error: r.json?.error };
    } catch {
      return { ok: false, reason: 'NETWORK' };
    }
  }

  // ---------- Retraits d'espèces (client) ----------

  createWithdrawal(accountId: string, amount: number): Promise<Outcome<NewWithdrawal>> {
    return this.outcome('POST', '/withdrawals', { accountId, amount }, 201);
  }

  async currentWithdrawal(): Promise<Withdrawal | null> {
    const r = await this.request('GET', '/withdrawals/current');
    if (r.status !== 200) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
    return (r.json?.withdrawal ?? null) as Withdrawal | null;
  }

  async cancelWithdrawal(): Promise<void> {
    await this.request('POST', '/withdrawals/cancel', {});
  }

  // ---------- Machines connectées (QR fixe) ----------

  machineMenu(id: string, s: string): Promise<Outcome<MachineMenu>> {
    return this.outcome('GET', '/machines/' + encodeURIComponent(id) + '?s=' + s, undefined, 200);
  }

  /** Achat sur une machine : slot (distributeur, laverie) ou amount = plafond (pompe à essence). */
  buyFromMachine(req: { id: string; s: string; accountId: string; slot?: number; amount?: number; idempotencyKey?: string }): Promise<PaymentResult> {
    const { id, ...body } = req;
    return this.request('POST', '/machines/' + encodeURIComponent(id) + '/buy', { ...body, idempotencyKey: body.idempotencyKey ?? newKey() })
      .then(toPaymentResult)
      .catch(() => ({ ok: false, reason: 'NETWORK' }) as PaymentResult);
  }

  async getVend(id: string): Promise<Vend> {
    const r = await this.request('GET', '/vends/' + id);
    if (r.status !== 200) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
    return r.json as Vend;
  }

  // ---------- Agent agréé (application agent) ----------

  agentLookup(code: string): Promise<Outcome<WithdrawalLookup>> {
    return this.outcome('POST', '/agent/withdrawals/lookup', { code }, 200);
  }

  agentConfirm(code: string, accountId: string): Promise<Outcome<WithdrawalLookup & { balance: number }>> {
    return this.outcome('POST', '/agent/withdrawals/confirm', { code, accountId }, 200);
  }

  async agentHistory(): Promise<ServedWithdrawal[]> {
    const r = await this.request('GET', '/agent/withdrawals');
    if (r.status !== 200) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
    return r.json as ServedWithdrawal[];
  }
}

function toPaymentResult(r: { status: number; json: any }): PaymentResult {
  if (r.status === 200 && r.json?.ok) return { ok: true, tx: r.json.tx, balance: r.json.balance, ...(r.json.vend ? { vend: r.json.vend as Vend } : {}) };
  return { ok: false, reason: reasonOf(r.json) };
}

function newKey(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

/** Connexion au vrai serveur : même contrat que le faux opérateur local. */
export class HttpProvider implements MobileMoneyProvider {
  api: ApiClient;

  constructor(api: ApiClient) {
    this.api = api;
  }

  private async send(path: string, body: unknown): Promise<PaymentResult> {
    try {
      return toPaymentResult(await this.api.request('POST', path, body));
    } catch {
      return { ok: false, reason: 'NETWORK' };
    }
  }

  async getAccounts(): Promise<Account[]> {
    const r = await this.api.request('GET', '/accounts');
    if (r.status !== 200) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
    return r.json as Account[];
  }

  async getHistory(): Promise<Transaction[]> {
    const r = await this.api.request('GET', '/history');
    if (r.status !== 200) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
    return r.json as Transaction[];
  }

  async linkAccount(operator: OperatorId, phone: string, currency: Currency): Promise<Account> {
    const r = await this.api.request('POST', '/accounts/link', { operator, phone, currency });
    if (r.status !== 201) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
    return r.json as Account;
  }

  async getPaymentCode(accountId: string): Promise<{ code: string; expiresInSeconds: number }> {
    const r = await this.api.request('POST', '/payments/code', { accountId });
    if (r.status !== 201) throw new ApiError(r.status, r.json?.error ?? 'NETWORK');
    return { code: r.json.code, expiresInSeconds: r.json.expiresInSeconds };
  }

  transfer(req: TransferRequest): Promise<PaymentResult> {
    return this.send('/transfers', {
      fromAccountId: req.fromAccountId,
      toPhone: req.toPhone,
      amount: req.amount,
      idempotencyKey: req.idempotencyKey ?? newKey(),
    });
  }

  payBill(req: BillRequest): Promise<PaymentResult> {
    return this.send('/bills', {
      fromAccountId: req.fromAccountId,
      biller: req.biller,
      reference: req.reference,
      amount: req.amount,
      idempotencyKey: req.idempotencyKey ?? newKey(),
    });
  }

  async payMachine(req: MachineRequest): Promise<PaymentResult> {
    if (!req.qr) return { ok: false, reason: 'INVALID_QR' };
    // Le montant et l'article viennent du serveur (QR signé), jamais de l'application.
    return this.send('/payments/qr', { qr: req.qr, accountId: req.fromAccountId, idempotencyKey: req.idempotencyKey ?? newKey() });
  }
}
