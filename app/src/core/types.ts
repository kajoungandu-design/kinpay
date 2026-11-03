// Types partagés. Aucun import ici : ce fichier ne contient que des types.

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

export type TransactionKind = 'transfer' | 'bill' | 'machine' | 'received';

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
  | 'NETWORK';

export type PaymentResult =
  | { ok: true; tx: Transaction; balance: number }
  | { ok: false; reason: FailureReason };

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

export type MachineQr = {
  machineId: string;
  item: string;
  amount: number;
  /** Contenu brut du QR, à transmettre au serveur. */
  qr: string;
};
