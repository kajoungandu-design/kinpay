import type { Currency } from './types';

const groupThousands = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function formatCDF(n: number): string {
  return groupThousands(String(Math.round(n)));
}

/** Montant sans devise, à la française : 1 500 (CDF) ou 1 250,50 (USD, n en cents). */
export function formatAmount(n: number, currency: Currency): string {
  if (currency === 'CDF') return formatCDF(n);
  const cents = Math.abs(Math.round(n));
  const text = groupThousands(String(Math.floor(cents / 100))) + ',' + String(cents % 100).padStart(2, '0');
  return n < 0 ? '-' + text : text;
}

/** Montant avec devise : « 1 500 CDF », « 250,00 USD ». */
export function formatMoney(n: number, currency: Currency): string {
  return formatAmount(n, currency) + ' ' + currency;
}

/**
 * Lit un montant saisi. CDF : entier. USD : virgule ou point, 2 décimales au maximum (« 2,50 » → 250 cents).
 * Retourne null si la saisie est vide, invalide ou nulle.
 */
export function parseAmount(text: string, currency: Currency): number | null {
  const t = text.replace(/\s/g, '');
  const m = currency === 'CDF' ? /^(\d{1,9})$/.exec(t) : /^(\d{1,7})(?:[.,](\d{0,2}))?$/.exec(t);
  if (!m) return null;
  const value = currency === 'CDF' ? parseInt(m[1], 10) : parseInt(m[1], 10) * 100 + parseInt((m[2] ?? '').padEnd(2, '0'), 10);
  return value > 0 ? value : null;
}

/** Filtre la frappe dans un champ montant : chiffres, et pour USD une virgule suivie de 2 chiffres au plus. */
export function cleanAmountInput(text: string, currency: Currency): string {
  if (currency === 'CDF') return text.replace(/\D/g, '').slice(0, 9);
  const m = /^(\d{0,7})(?:[.,](\d{0,2}))?/.exec(text.replace(/[^\d.,]/g, ''));
  if (!m) return '';
  return /[.,]/.test(text) ? m[1] + ',' + (m[2] ?? '') : m[1];
}

/** Affiche une date ISO de façon lisible : "À l'instant", "Il y a 5 min", "Hier"... */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "À l'instant";
  if (min < 60) return 'Il y a ' + min + ' min';
  const hours = Math.floor(min / 60);
  if (hours < 24) return 'Il y a ' + hours + ' h';
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Hier';
  if (days < 7) return 'Il y a ' + days + ' jours';
  return then.toLocaleDateString('fr-FR');
}
