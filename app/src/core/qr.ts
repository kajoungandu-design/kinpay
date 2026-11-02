import type { MachineQr } from './types';

/**
 * Format du QR affiché par une machine (à définir avec les fabricants) :
 *   kinpay://pay?m=<id machine>&a=<montant CDF>&i=<article>
 * Exemple : kinpay://pay?m=DIST-0042&a=1500&i=Eau%2050cl
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
  if (!machineId || !/^[A-Za-z0-9_-]{1,32}$/.test(machineId)) return null;
  if (!item || item.length > 60) return null;
  if (!Number.isInteger(amount) || amount < 1 || amount > 1000000) return null;
  return { machineId, item, amount, qr: text.trim() };
}

export const DEMO_QR = 'kinpay://pay?m=DIST-0042&a=1500&i=Bouteille%20d%27eau%2050%20cl';
