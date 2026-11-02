import type { OperatorId } from './types';

export const OPERATORS: { id: OperatorId; name: string; short: string }[] = [
  { id: 'orange', name: 'Orange Money', short: 'OM' },
  { id: 'airtel', name: 'Airtel Money', short: 'AM' },
  { id: 'mpesa', name: 'M-Pesa', short: 'MP' },
  { id: 'africell', name: 'Africell Money', short: 'AF' },
];

// Préfixes à VÉRIFIER auprès de l'ARPTC / des opérateurs avant la mise en production.
const PREFIXES: Record<string, OperatorId> = {
  '81': 'mpesa',
  '82': 'mpesa',
  '83': 'mpesa',
  '84': 'orange',
  '85': 'orange',
  '89': 'orange',
  '97': 'airtel',
  '98': 'airtel',
  '99': 'airtel',
  '90': 'africell',
};

/**
 * Accepte 9 chiffres, 0 + 9 chiffres, ou 243 + 9 chiffres (avec espaces ou +).
 * Retourne +243XXXXXXXXX ou null si le numéro est invalide.
 */
export function normalizePhone(input: string): string | null {
  const d = input.replace(/\D/g, '');
  let local: string;
  if (d.length === 9) local = d;
  else if (d.length === 10 && d.charAt(0) === '0') local = d.slice(1);
  else if (d.length === 12 && d.indexOf('243') === 0) local = d.slice(3);
  else return null;
  if (local.charAt(0) === '0') return null;
  return '+243' + local;
}

export function detectOperator(input: string): OperatorId | null {
  const n = normalizePhone(input);
  if (!n) return null;
  return PREFIXES[n.slice(4, 6)] ?? null;
}

export function operatorName(id: OperatorId): string {
  const o = OPERATORS.find((x) => x.id === id);
  return o ? o.name : id;
}
