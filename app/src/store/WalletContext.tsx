import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createProvider } from '../config';
import { ApiError } from '../core/api';
import { useAuth } from './AuthContext';
import type {
  Account,
  BillRequest,
  MachineRequest,
  Currency,
  MobileMoneyProvider,
  OperatorId,
  PaymentResult,
  Transaction,
  TransferRequest,
} from '../core/types';

const STORAGE_KEY = 'kinpay.v1';
const MAX_HISTORY = 30;

type Saved = {
  primaryId?: string;
  history?: Transaction[];
  balances?: Record<string, number>;
};

type WalletValue = {
  ready: boolean;
  /** Message si les comptes n'ont pas pu être chargés (serveur injoignable) */
  error: string;
  accounts: Account[];
  primary: Account | null;
  /** Solde total par devise (pas de conversion entre CDF et USD) */
  totals: Record<Currency, number>;
  /** Compte à utiliser pour payer dans une devise : le principal s'il convient, sinon le premier de cette devise */
  accountFor: (currency: Currency) => Account | null;
  history: Transaction[];
  setPrimary: (id: string) => void;
  /** Relit les comptes et l'historique (ex. argent reçu d'un autre utilisateur) */
  refresh: () => Promise<void>;
  send: (req: TransferRequest) => Promise<PaymentResult>;
  payBill: (req: BillRequest) => Promise<PaymentResult>;
  payMachine: (req: MachineRequest) => Promise<PaymentResult>;
  /** null en mode démonstration hors-ligne */
  linkAccount: ((operator: OperatorId, phone: string, currency: Currency) => Promise<string | null>) | null;
  /** null en mode démonstration hors-ligne : le code est alors généré sur le téléphone */
  requestPaymentCode: ((accountId: string) => Promise<{ code: string; expiresInSeconds: number } | null>) | null;
  /** Confirme le PIN : null si correct, sinon le message à afficher. null en mode démonstration hors-ligne (pas de PIN). */
  verifyPin: ((pin: string) => Promise<string | null>) | null;
  /** null en mode démonstration hors-ligne */
  logout: (() => void) | null;
};

const WalletContext = createContext<WalletValue | null>(null);

function linkMessage(code: string): string {
  switch (code) {
    case 'ALREADY_LINKED':
      return 'Ce compte (même opérateur, même numéro, même devise) est déjà ajouté.';
    case 'TOO_MANY_ACCOUNTS':
      return 'Nombre maximum de comptes atteint.';
    case 'INVALID_INPUT':
      return 'Opérateur ou numéro invalide.';
    case 'OPERATOR_REFUSED':
      return "L'opérateur ne reconnaît pas ce numéro, ou le compte est bloqué.";
    case 'OPERATOR_UNAVAILABLE':
      return "L'opérateur ne répond pas. Réessayez dans un instant.";
    default:
      return 'Impossible d\'ajouter ce compte. Réessayez.';
  }
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const { api, logout } = useAuth();
  const providerRef = useRef<MobileMoneyProvider | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [primaryId, setPrimaryId] = useState<string>('');
  const [history, setHistory] = useState<Transaction[]>([]);

  const persist = useCallback(
    (next: { primaryId: string; history: Transaction[]; accounts: Account[] }) => {
      // Avec un serveur, la vérité (soldes, historique) est sur le serveur : on ne garde que le compte principal.
      const data: Saved = { primaryId: next.primaryId };
      if (!api) {
        const balances: Record<string, number> = {};
        next.accounts.forEach((a) => {
          balances[a.id] = a.balance;
        });
        data.history = next.history;
        data.balances = balances;
      }
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data)).catch(() => {});
    },
    [api],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let saved: Saved = {};
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) saved = JSON.parse(raw) as Saved;
      } catch {
        saved = {};
      }
      const provider = createProvider({ savedBalances: saved.balances, api });
      providerRef.current = provider;
      let list: Account[] = [];
      let hist: Transaction[] = Array.isArray(saved.history) ? saved.history : [];
      let loadError = '';
      try {
        list = await provider.getAccounts();
        if (provider.getHistory) hist = await provider.getHistory();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          logout(); // session expirée : retour à l'écran de connexion
          return;
        }
        loadError = 'Impossible de joindre le serveur. Vérifiez votre connexion.';
      }
      if (cancelled) return;
      const validPrimary = list.some((a) => a.id === saved.primaryId) ? (saved.primaryId as string) : list[0]?.id ?? '';
      setAccounts(list);
      setPrimaryId(validPrimary);
      setHistory(hist);
      setError(loadError);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, logout]);

  const setPrimary = useCallback(
    (id: string) => {
      setPrimaryId(id);
      persist({ primaryId: id, history, accounts });
    },
    [accounts, history, persist],
  );

  // Exécute une opération, puis relit les comptes (source de vérité = le fournisseur).
  const run = useCallback(
    async (op: (p: MobileMoneyProvider) => Promise<PaymentResult>): Promise<PaymentResult> => {
      const provider = providerRef.current;
      if (!provider) return { ok: false, reason: 'NETWORK' };
      try {
        const result = await op(provider);
        if (!result.ok) return result;
        let list: Account[];
        let nextHistory: Transaction[];
        try {
          list = await provider.getAccounts();
          nextHistory = provider.getHistory ? await provider.getHistory() : [result.tx, ...history].slice(0, MAX_HISTORY);
        } catch {
          // Le paiement a réussi mais la relecture a échoué : on met à jour localement.
          list = accounts.map((a) => (a.id === result.tx.accountId ? { ...a, balance: result.balance } : a));
          nextHistory = [result.tx, ...history].slice(0, MAX_HISTORY);
        }
        setAccounts(list);
        setHistory(nextHistory);
        persist({ primaryId, history: nextHistory, accounts: list });
        return result;
      } catch {
        return { ok: false, reason: 'NETWORK' };
      }
    },
    [accounts, history, persist, primaryId],
  );

  const linkAccount = useCallback(
    async (operator: OperatorId, phone: string, currency: Currency): Promise<string | null> => {
      const provider = providerRef.current;
      if (!provider || !provider.linkAccount) return 'Fonction indisponible.';
      try {
        await provider.linkAccount(operator, phone, currency);
        const list = await provider.getAccounts();
        setAccounts(list);
        if (!primaryId && list[0]) {
          setPrimaryId(list[0].id);
          persist({ primaryId: list[0].id, history, accounts: list });
        }
        return null;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          logout();
          return 'Session expirée.';
        }
        return e instanceof ApiError ? linkMessage(e.code) : 'Connexion impossible. Réessayez.';
      }
    },
    [history, logout, persist, primaryId],
  );

  const requestPaymentCode = useCallback(async (accountId: string) => {
    const provider = providerRef.current;
    if (!provider || !provider.getPaymentCode) return null;
    try {
      return await provider.getPaymentCode(accountId);
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider) return;
    try {
      const list = await provider.getAccounts();
      setAccounts(list);
      if (provider.getHistory) setHistory(await provider.getHistory());
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        logout();
        return;
      }
      setError('Impossible de joindre le serveur. Vérifiez votre connexion.');
    }
  }, [logout]);

  const verifyPin = useCallback(
    async (pin: string): Promise<string | null> => {
      if (!api) return null;
      try {
        await api.verifyPin(pin);
        return null;
      } catch (e) {
        if (!(e instanceof ApiError)) return 'Connexion impossible. Vérifiez votre connexion et réessayez.';
        if (e.status === 401 && e.code === 'UNAUTHORIZED') {
          logout();
          return 'Session expirée.';
        }
        if (e.code === 'LOCKED') return "Trop d'essais. Réessayez dans 15 minutes.";
        if (e.code === 'INVALID_PIN') {
          const left = e.attemptsLeft;
          return 'Code PIN incorrect.' + (left ? ' ' + left + (left > 1 ? ' essais restants.' : ' essai restant.') : '');
        }
        return 'Connexion impossible. Vérifiez votre connexion et réessayez.';
      }
    },
    [api, logout],
  );

  const value = useMemo<WalletValue>(() => {
    const primary = accounts.find((a) => a.id === primaryId) ?? null;
    return {
      ready,
      error,
      accounts,
      primary,
      totals: {
        CDF: accounts.filter((a) => a.currency === 'CDF').reduce((sum, a) => sum + a.balance, 0),
        USD: accounts.filter((a) => a.currency === 'USD').reduce((sum, a) => sum + a.balance, 0),
      },
      accountFor: (currency) => (primary?.currency === currency ? primary : accounts.find((a) => a.currency === currency) ?? null),
      history,
      setPrimary,
      refresh,
      send: (req) => run((p) => p.transfer(req)),
      payBill: (req) => run((p) => p.payBill(req)),
      payMachine: (req) => run((p) => p.payMachine(req)),
      linkAccount: api ? linkAccount : null,
      requestPaymentCode: api ? requestPaymentCode : null,
      verifyPin: api ? verifyPin : null,
      logout: api ? logout : null,
    };
  },
    [ready, error, accounts, primaryId, history, setPrimary, refresh, run, api, linkAccount, requestPaymentCode, verifyPin, logout],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet doit être utilisé dans <WalletProvider>');
  return ctx;
}
