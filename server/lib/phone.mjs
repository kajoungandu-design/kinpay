export const OPERATORS = {
  orange: 'Orange Money',
  airtel: 'Airtel Money',
  mpesa: 'M-Pesa',
  africell: 'Africell Money',
};

/** Retourne +243XXXXXXXXX ou null. Même règle que l'application (src/core/phone.ts). */
export function normalizePhone(input) {
  const d = String(input ?? '').replace(/\D/g, '');
  let local;
  if (d.length === 9) local = d;
  else if (d.length === 10 && d[0] === '0') local = d.slice(1);
  else if (d.length === 12 && d.startsWith('243')) local = d.slice(3);
  else return null;
  if (local[0] === '0') return null;
  return '+243' + local;
}
