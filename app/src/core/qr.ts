import type { Currency, FixedMachineQr, MachineQr } from './types';

/**
 * QR fixe (étiquette collée sur un distributeur, une laverie, une pompe) : kinpay://m?id=DIST-0042&s=<16 hex>
 * La signature est vérifiée par le serveur.
 */
export function parseFixedQr(text: string): FixedMachineQr | null {
  const m = /^kinpay:\/\/m\?id=([A-Za-z0-9_-]{1,32})&s=([a-f0-9]{16})$/.exec(text.trim());
  return m ? { id: m[1], s: m[2] } : null;
}

/** QR du code de retrait affiché par le client, lu par l'application agent : kinpay://withdraw?c=12345678 */
export const withdrawalQr = (code: string) => 'kinpay://withdraw?c=' + code;
export function parseWithdrawalQr(text: string): string | null {
  const t = text.trim();
  if (/^\d{8}$/.test(t)) return t;
  return /^kinpay:\/\/withdraw\?c=(\d{8})$/.exec(t)?.[1] ?? null;
}

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
