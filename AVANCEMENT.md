# Avancement KinPay

Objectif : application testable sur Android avec Expo Go, connectée au serveur qui tourne sur le PC (même Wi-Fi).

| Étape | État |
|---|---|
| 0. Dépôt Git + GitHub privé | Fait : https://github.com/kajoungandu-design/kinpay |
| 1. Serveur sur le PC (`server/.env`, tests, machine de test) | Fait : 20 tests OK, démarre sur le port 3000 (`server/.env` reste local, à recréer depuis `.env.example`) |
| 2. App compilable (`package.json`, `app.json`, `tsconfig.json`, corrections TypeScript) | Fait : Expo SDK 58, `tsc` sans erreur, 10 tests OK, expo-doctor 20/20, bundle Android OK (`app/.env` reste local) |
| 3. Fonctions manquantes (PIN avant paiement, historique, déconnexion, erreurs) | Fait : inscription sans SMS en développement, PIN demandé avant envoi / facture / paiement QR / affichage du code OTP (route `POST /me/verify-pin`, blocage après 5 erreurs), actualisation de l'accueil en tirant vers le bas. Historique et déconnexion existaient déjà. |
| 4. Test sur le téléphone Android (Expo Go) | Fait : inscription et accueil OK sur le téléphone |
| A. Multi-devises : un compte CDF et un compte USD par opérateur | Fait : montants en unités entières (cents pour USD), affichage « 250,00 USD », pas de conversion, migration automatique de l'ancienne base |
| B. Encaisser par QR (taxi, client, commerçant avec catalogue) | Fait : onglet « Encaisser » (montant rapide ou produits), QR signé valable 10 min, total calculé par le serveur, vendeur crédité, statut « Payé » en direct ; « Payer » choisit un compte de la devise du QR et montre le bénéficiaire avant le PIN |
| C. Retraits (agent agréé avec application agent séparée, distributeur) | À faire |

## Reprendre le travail

```bash
git clone https://github.com/kajoungandu-design/kinpay.git
cd kinpay
cp server/.env.example server/.env   # puis remplir QR_SECRET
cd app && npm install
echo "EXPO_PUBLIC_API_URL=auto" > .env
```

Lancer : `npm run dev` dans `server/`, `npx expo start -c` dans `app/`, scanner le QR avec Expo Go.
Puis reprendre à la première étape non terminée ci-dessus.
