import type {
  Account,
  BillRequest,
  MachineRequest,
  MobileMoneyProvider,
  PaymentResult,
  Transaction,
  TransactionKind,
  TransferRequest,
} from './types';

export const SEED_ACCOUNTS: Account[] = [
  { id: 'orange-1', operator: 'orange', label: 'Orange Money', phone: '+243890000001', balance: 245000 },
  { id: 'airtel-1', operator: 'airtel', label: 'Airtel Money', phone: '+243990000002', balance: 120500 },
  { id: 'mpesa-1', operator: 'mpesa', label: 'M-Pesa', phone: '+243810000003', balance: 78000 },
];

/**
 * Faux opérateur pour développer et démontrer l'application.
 * Aucun argent réel. Remplacé plus tard par une vraie implémentation de MobileMoneyProvider.
 */
export class MockProvider implements MobileMoneyProvider {
  private accounts: Account[];
  private seq = 0;
  private latencyMs: number;

  constructor(seed: Account[] = SEED_ACCOUNTS, latencyMs = 500) {
    this.accounts = seed.map((a) => ({ ...a }));
    this.latencyMs = latencyMs;
  }

  private wait(): Promise<void> {
    if (this.latencyMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }

  async getAccounts(): Promise<Account[]> {
    await this.wait();
    return this.accounts.map((a) => ({ ...a }));
  }

  private async debit(
    accountId: string,
    amount: number,
    kind: TransactionKind,
    label: string,
    creditPhone?: string,
  ): Promise<PaymentResult> {
    await this.wait();
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: 'INVALID_AMOUNT' };
    const acc = this.accounts.find((a) => a.id === accountId);
    if (!acc) return { ok: false, reason: 'UNKNOWN_ACCOUNT' };
    if (acc.balance < amount) return { ok: false, reason: 'INSUFFICIENT_FUNDS' };
    acc.balance -= amount;
    // Transfert vers un autre de mes propres comptes : on crédite aussi la destination.
    if (creditPhone) {
      const dest = this.accounts.find((a) => a.phone === creditPhone && a.id !== accountId);
      if (dest) dest.balance += amount;
    }
    this.seq += 1;
    const tx: Transaction = {
      id: 'tx-' + Date.now() + '-' + this.seq,
      kind,
      label,
      amount,
      accountId,
      at: new Date().toISOString(),
    };
    return { ok: true, tx, balance: acc.balance };
  }

  transfer(req: TransferRequest): Promise<PaymentResult> {
    return this.debit(req.fromAccountId, req.amount, 'transfer', 'Envoyé à ' + req.toPhone, req.toPhone);
  }

  payBill(req: BillRequest): Promise<PaymentResult> {
    return this.debit(req.fromAccountId, req.amount, 'bill', 'Facture : ' + req.biller);
  }

  payMachine(req: MachineRequest): Promise<PaymentResult> {
    return this.debit(req.fromAccountId, req.amount, 'machine', req.item + ' (' + req.machineId + ')');
  }
}
