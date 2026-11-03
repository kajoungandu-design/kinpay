// Types partagés (application client et application agent). Aucun import ici.

export type OperatorId = 'orange' | 'airtel' | 'mpesa' | 'africell';

/** Montants toujours en unités entières : francs pour CDF, cents pour USD. */
export type Currency = 'CDF' | 'USD';

export type Account = {
  id: string;
  operator: OperatorId;
  label: string;
  /** Numéro au format international normalisé, ex. +243890000001 */
  phone: string;
  currency: Currency;
  /** Solde entier dans la devise du compte (francs CDF ou cents USD) */
  balance: number;
};

/** payment = QR d'un autre utilisateur payé (taxi, commerçant) ; refund = remboursement (machine qui n'a pas servi) */
export type TransactionKind = 'transfer' | 'bill' | 'machine' | 'payment' | 'received' | 'withdrawal' | 'refund';

/** Opérations qui ajoutent de l'argent sur le compte (affichées en « + »). */
export const isCredit = (kind: TransactionKind) => kind === 'received' || kind === 'refund';

export type Transaction = {
  id: string;
  kind: TransactionKind;
  label: string;
  /** Montant entier dans la devise de l'opération, toujours positif */
  amount: number;
  currency: Currency;
  accountId: string;
  /** Date ISO 8601 */
  at: string;
};

export type FailureReason =
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_AMOUNT'
  | 'UNKNOWN_ACCOUNT'
  | 'INVALID_QR'
  | 'EXPIRED_QR'
  | 'QR_ALREADY_USED'
  | 'CURRENCY_MISMATCH'
  | 'SELF_PAYMENT'
  | 'MACHINE_OFFLINE'
  | 'MACHINE_BUSY'
  | 'OUT_OF_STOCK'
  | 'INVALID_CODE'
  | 'PAYMENT_DECLINED'
  | 'NOT_CONFIRMED'
  | 'OPERATOR_NOT_SUPPORTED'
  | 'NETWORK';

/**
 * Vente machine sous séquestre : held = argent bloqué, la machine distribue ;
 * dispensed = servi ; refunded = remboursé (machine bloquée ou sans réponse).
 */
export type Vend = {
  id: string;
  status: 'held' | 'finishing' | 'dispensed' | 'refunded' | 'error';
  item: string;
  amount: number;
  /** Montant réellement payé (pompe à essence : peut être inférieur au plafond) */
  finalAmount: number | null;
  currency: Currency;
  machine: string;
  reason: string | null;
};

export type PaymentResult =
  | { ok: true; tx: Transaction; balance: number; vend?: Vend }
  | { ok: false; reason: FailureReason };

/** QR fixe collé sur une machine (sans montant) : kinpay://m?id=DIST-0042&s=<signature> */
export type FixedMachineQr = { id: string; s: string };

export type MachineSlot = { slot: number; name: string; price: number; stock: number | null };
export type MachineMenu = {
  id: string;
  name: string;
  kind: 'vending' | 'laundry' | 'fuel' | 'atm';
  currency: Currency;
  online: boolean;
  busy: boolean;
  slots: MachineSlot[];
};

/** Retrait d'espèces en cours (code montré à l'agent ou saisi au DAB). */
export type Withdrawal = {
  id: string;
  status: 'pending' | 'processing' | 'done' | 'failed' | 'cancelled' | 'expired';
  amount: number;
  currency: Currency;
  accountId: string;
  expiresAt: number;
  failure: string | null;
  servedBy: string | null;
};

export type TransferRequest = {
  fromAccountId: string;
  /** Numéro du bénéficiaire, déjà normalisé (+243...) */
  toPhone: string;
  amount: number;
  /** Clé unique par action de l'utilisateur : un nouvel essai ne débite jamais deux fois. */
  idempotencyKey?: string;
};

export type BillRequest = {
  fromAccountId: string;
  biller: string;
  /** Référence client : numéro de compteur, d'abonné, etc. */
  reference: string;
  amount: number;
  idempotencyKey?: string;
};

export type MachineRequest = {
  fromAccountId: string;
  machineId: string;
  item: string;
  amount: number;
  /** Contenu exact du QR scanné : le serveur le vérifie (signature, expiration, usage unique). */
  qr?: string;
  idempotencyKey?: string;
};

/**
 * Contrat que doit respecter toute connexion à un opérateur (ou à un agrégateur).
 * MockProvider simule tout. Pour brancher un vrai opérateur, écrire une classe
 * qui implémente cette interface (voir le README).
 */
export interface MobileMoneyProvider {
  getAccounts(): Promise<Account[]>;
  transfer(req: TransferRequest): Promise<PaymentResult>;
  payBill(req: BillRequest): Promise<PaymentResult>;
  payMachine(req: MachineRequest): Promise<PaymentResult>;
  // Fonctions disponibles seulement avec le vrai serveur (absentes du faux opérateur local) :
  getHistory?(): Promise<Transaction[]>;
  linkAccount?(operator: OperatorId, phone: string, currency: Currency): Promise<Account>;
  /** Code de paiement à usage unique émis par le serveur. */
  getPaymentCode?(accountId: string): Promise<{ code: string; expiresInSeconds: number }>;
}

/** Article du catalogue d'un commerçant. Le prix est gardé par le serveur. */
export type Product = { id: string; name: string; price: number; currency: Currency };

/** QR de paiement scanné : affiché par une machine (DIST-0042) ou par un utilisateur qui encaisse (U-XXXXXXXX). */
export type MachineQr = {
  machineId: string;
  item: string;
  amount: number;
  currency: Currency;
  /** Contenu brut du QR, à transmettre au serveur. */
  qr: string;
  /** Machine d'un réseau externe (QR rdcpay://), payée par l'API opérateur. */
  external?: boolean;
};
