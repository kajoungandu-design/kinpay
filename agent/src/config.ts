import Constants from 'expo-constants';

/**
 * Adresse du serveur KinPay (fichier .env) :
 *   EXPO_PUBLIC_API_URL=auto   (développement : même ordinateur que celui qui sert l'app à Expo Go, port 3000)
 *   EXPO_PUBLIC_API_URL=https://api.votre-domaine.com
 */
function resolveApiUrl(raw: string): string {
  if (raw !== 'auto') return raw;
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return host ? `http://${host}:3000` : '';
}

export const API_URL: string = resolveApiUrl(process.env.EXPO_PUBLIC_API_URL ?? 'auto');
