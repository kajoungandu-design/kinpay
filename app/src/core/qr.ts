import type { Currency, MachineQr } from './types';

// Plafonds identiques à ceux du serveur, en unités entières (francs CDF, cents USD).
const MAX_AMOUNT: Record<Currency, number> = { CDF: 5000000, USD: 500000 };

/**
 * Format du QR de paiement (machine ou utilisateur qui encaisse) :
 *   kinpay://pay?m=<id machine ou U-XXXXXXXX>&a=<montant>&i=<article>&c=<CDF|USD>&n=..&e=..&s=<signature>
 * Exemple : kinpay://pay?m=DIST-0042&a=1500&i=Eau%2050cl&c=CDF
 * Sans « c », le QR est en CDF. La signature est vérifiée par le serveur, pas ici.
 * Retourne null si le contenu n'est pas un QR de paiement valide.
 */
export function parseMachineQr(text: string): MachineQr | null {
  const m = /^kinpay:\/\/pay\?(.+)$/.exec(text.trim());
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const part of m[1].split('&')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    try {
      params[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
    } catch {
      return null;
    }
  }
  const machineId = params.m;
  const item = params.i;
  const amount = Number(params.a);
  const currency = (params.c ?? 'CDF') as Currency;
  if (!machineId || !/^[A-Za-z0-9_-]{1,32}$/.test(machineId)) return null;
  if (!item || item.length > 60) return null;
  if (currency !== 'CDF' && currency !== 'USD') return null;
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT[currency]) return null;
  return { machineId, item, amount, currency, qr: text.trim() };
}

export const DEMO_QR = 'kinpay://pay?m=DIST-0042&a=1500&i=Bouteille%20d%27eau%2050%20cl';
