import Constants from 'expo-constants';
import { MockProvider, SEED_ACCOUNTS } from './core/mockProvider';
import { ApiClient, HttpProvider } from './core/api';
import type { Account, MobileMoneyProvider } from './core/types';

/**
 * Adresse du serveur KinPay. Définie dans le fichier .env de l'application :
 *   EXPO_PUBLIC_API_URL=https://api.votre-domaine.com
 *   EXPO_PUBLIC_API_URL=auto   (développement : même ordinateur que celui qui sert l'app à Expo Go, port 3000)
 * Vide = mode démonstration hors-ligne (faux opérateur sur le téléphone, aucun serveur).
 */
function resolveApiUrl(raw: string): string {
  if (raw !== 'auto') return raw;
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return host ? `http://${host}:3000` : '';
}

export const API_URL: string = resolveApiUrl(process.env.EXPO_PUBLIC_API_URL ?? '');

/**
 * Point unique où l'on choisit la connexion aux opérateurs.
 * Avec un serveur : HttpProvider (le serveur parle aux opérateurs).
 * Sans serveur : faux opérateur local (aucun argent réel).
 */
export function createProvider(opts: { savedBalances?: Record<string, number>; api?: ApiClient | null }): MobileMoneyProvider {
  if (opts.api) return new HttpProvider(opts.api);
  const saved = opts.savedBalances;
  const seed: Account[] = SEED_ACCOUNTS.map((a) => ({
    ...a,
    balance: saved && typeof saved[a.id] === 'number' ? saved[a.id] : a.balance,
  }));
  return new MockProvider(seed);
}

export const DEMO_BILLS = [
  { id: 'elec', biller: 'Électricité', reference: '[N° de compteur]', amount: 32000 },
  { id: 'eau', biller: 'Eau', reference: "[N° d'abonné]", amount: 11500 },
  { id: 'internet', biller: 'Internet à domicile', reference: '[N° de client]', amount: 45000 },
  { id: 'tv', biller: 'Télévision par abonnement', reference: '[N° de carte]', amount: 18000 },
];
