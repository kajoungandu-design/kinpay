import type {
  Account,
  BillRequest,
  FailureReason,
  MachineRequest,
  MobileMoneyProvider,
  OperatorId,
  PaymentResult,
  Transaction,
  TransferRequest,
} from './types';

export type Session = { token: string; user: { id: string; phone: string } };

export class ApiError extends Error {
  status: number;
  code: string;
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
  'NETWORK',
];

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

  private toResult(r: { status: number; json: any }): PaymentResult {
    if (r.status === 200 && r.json?.ok) return { ok: true, tx: r.json.tx, balance: r.json.balance };
    const reason = r.json?.reason as FailureReason | undefined;
    if (reason && KNOWN_REASONS.includes(reason)) return { ok: false, reason };
    return { ok: false, reason: 'NETWORK' };
  }

  private async send(path: string, body: unknown): Promise<PaymentResult> {
    try {
      return this.toResult(await this.api.request('POST', path, body));
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

  async linkAccount(operator: OperatorId, phone: string): Promise<Account> {
    const r = await this.api.request('POST', '/accounts/link', { operator, phone });
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
