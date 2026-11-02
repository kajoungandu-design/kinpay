# KinPay — application mobile

> Ce dossier est la partie **application** du projet complet. Le guide général (serveur, environnement, passage au réel) est dans le `README.md` à la racine.
> Avec `EXPO_PUBLIC_API_URL` (voir `.env.example`), l'application se connecte au serveur ; sans, elle fonctionne seule en démonstration hors-ligne.
> Bibliothèque supplémentaire pour la connexion : `npx expo install expo-secure-store`.

# Version de démonstration

Application mobile Android et iPhone (Expo / React Native, TypeScript). Elle regroupe plusieurs comptes Mobile Money dans un seul portefeuille : envoi entre comptes et entre opérateurs, paiement par code QR ou code OTP, paiement de factures, choix du compte principal.

**Aucun argent réel ne circule.** Les opérateurs sont simulés par `MockProvider`.

## 1. Lancer l'application sur votre téléphone

Prérequis : [Node.js](https://nodejs.org) 20 ou plus, et l'application **Expo Go** sur le téléphone.

```bash
# 1. Créer un projet Expo vide (il fixe les bonnes versions des bibliothèques)
npx create-expo-app@latest kinpay --template blank-typescript
cd kinpay

# 2. Installer les bibliothèques utilisées
npx expo install expo-camera expo-secure-store @react-native-async-storage/async-storage react-native-safe-area-context

# 3. Copier dans ce projet les éléments de ce dossier :
#    App.tsx (remplace celui existant), le dossier src/ et le dossier test/

# 4. Lancer
npx expo start
```

Scannez le code QR affiché avec Expo Go (Android) ou l'appareil photo (iPhone).

### Autorisation de la caméra (app.json)

Ajoutez dans `app.json`, sous `expo` :

```json
"plugins": [
  ["expo-camera", { "cameraPermission": "La caméra sert à lire le code QR de paiement affiché par la machine." }]
]
```

## 2. Tester la logique (sans téléphone)

Les règles métier (numéros, QR, OTP, transferts simulés) sont dans `src/core/` et n'ont aucune dépendance :

```bash
node --test test/core.test.ts
```

Node 22.18 ou plus exécute directement les fichiers TypeScript.

## 3. Comment c'est organisé

| Dossier | Rôle |
|---|---|
| `src/core/` | Règles métier pures : numéros congolais, QR machine, OTP, faux opérateur |
| `src/core/types.ts` | Le contrat `MobileMoneyProvider` que chaque opérateur doit respecter |
| `src/config.ts` | **Le seul endroit** où l'on choisit le faux ou le vrai opérateur |
| `src/store/` | État du portefeuille et sauvegarde sur le téléphone |
| `src/screens/` | Accueil, Envoyer, Payer (QR et OTP), Factures, Confirmation |

## 4. Passer au vrai : ce qu'il reste à faire

L'application est écrite pour que le passage au réel ne change que **trois endroits**.

1. **Connexion aux opérateurs.** Écrire une classe qui implémente `MobileMoneyProvider` (Orange Money, Airtel Money, M-Pesa, ou un agrégateur de paiement présent en RDC) et la renvoyer dans `createProvider()` de `src/config.ts`. Il faut pour cela un contrat et des accès API auprès de chaque opérateur.
2. **Serveur (backend).** Les appels aux opérateurs et les clés secrètes ne doivent **jamais** être dans l'application : ils passent par un serveur à vous. Le serveur doit aussi émettre et vérifier les codes OTP (le code actuel est généré sur le téléphone, pour la démonstration seulement), gérer la connexion des utilisateurs (numéro + code PIN + SMS) et garder l'historique.
3. **Format du QR des machines.** Le format `kinpay://pay?m=<machine>&a=<montant>&i=<article>` est une proposition (`src/core/qr.ts`). En production, le QR doit être **signé** par le serveur pour qu'on ne puisse pas falsifier un montant.

À faire aussi avant le lancement :

- Autorisation ou partenariat avec une institution agréée par la Banque centrale du Congo.
- Écran de connexion et code PIN (non inclus dans cette version).
- Frais de transfert réels (affichés en `[À confirmer avec l'opérateur]`).
- Vérifier les préfixes d'opérateurs dans `src/core/phone.ts`.
- Audit de sécurité par un expert, puis comptes Google Play et Apple Developer.

## 5. Limites de cette version

- Le code des écrans n'a pas pu être compilé ni lancé dans l'environnement où il a été écrit (accès aux bibliothèques bloqué). Seule la logique de `src/core/` est testée. Au premier lancement, de petites corrections de typage ou de version peuvent être nécessaires.
- Les factures, les comptes et les soldes sont des données d'exemple.
