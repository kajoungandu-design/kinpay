export const OTP_TTL_SECONDS = 60;

/**
 * Code à 6 chiffres pour la démonstration.
 * En production, le code doit être émis et vérifié par le SERVEUR (usage unique,
 * lié à la transaction), jamais généré seulement sur le téléphone.
 */
export function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function formatOtp(code: string): string {
  return code.slice(0, 3) + ' ' + code.slice(3);
}
