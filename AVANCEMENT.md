# Avancement KinPay

Objectif : application testable sur Android avec Expo Go, connectée au serveur qui tourne sur le PC.

| Étape | État |
|---|---|
| 0. Dépôt Git + GitHub privé | Fait : https://github.com/kajoungandu-design/kinpay |
| 1. Serveur sur le PC | Fait (`server/.env` reste local, à recréer depuis `.env.example`) |
| 2. App compilable | Fait : Expo SDK 58, `tsc` sans erreur, expo-doctor 20/20 (`app/.env` reste local) |
| 3. PIN avant paiement, historique, déconnexion | Fait |
| 4. Test sur le téléphone Android (Expo Go) | Fait |
| A. Multi-devises (CDF + USD par opérateur) | Fait |
| B. Encaisser par QR (taxi, client, commerçant avec catalogue) | Fait |
| C. Retraits (agent agréé + distributeur de billets) | Fait : écran « Retirer » (code 8 chiffres + QR, statut en direct), **app agent séparée** `agent/`, `npm run agent -- <tél>`, DAB `POST /machine/withdraw` |
| D1. Machines connectées (serveur) | Fait : QR fixe, catalogue et stock, séquestre, remboursement automatique (échec / 30 s), SSE + interrogation + webhook signé, pompe (pré-autorisation), laverie |
| D2. Simulateur de boîtier | Fait : `server/scripts/machine-sim.mjs` (`--catalogue`, `--echec`, `--muet`, `--servi`, `--qr`) ; protocole dans `docs/INTEGRATION.md` |
| D3. App client : achat sur machine | Fait : « Payer » lit le QR fixe, montre le menu, PIN, puis « Distribution en cours » → « Servi » ou « Remboursé » |
| D4. Portail web propriétaire | Fait : `http://<PC>:3000/portail` (machines en ligne/hors ligne, ventes du jour et du mois, stock, QR fixe à imprimer, clé, webhook) |
| E. Airtel Money (simulateur RDC Mobile Money Sandbox, localhost:4010) | Fait : `providers/airtel.mjs` (OAuth2, collection USSD + suivi du statut, disbursement, remboursement tardif, CDF/USD). Les distributeurs `rdcpay://` du simulateur sont payables depuis « Payer ». Testé en direct sur le simulateur. |
| F. M-Pesa (même simulateur) | Fait : `providers/mpesa.mjs` (session, C2B + statut, B2C, reversal) ; aiguilleur `providers/operators.mjs` ; transferts Airtel ↔ M-Pesa ; machines rdcpay payables en M-Pesa. Testé en direct. |

Tests : 43 serveur, 14 app ; paquets Android client et agent construits ; essai de bout en bout serveur + simulateur (vente servie en 0,6 s).

## Reprendre le travail

```bash
git clone https://github.com/kajoungandu-design/kinpay.git
cd kinpay
cp server/.env.example server/.env          # puis remplir QR_SECRET
cd app && npm install && echo "EXPO_PUBLIC_API_URL=auto" > .env && cd ..
cd agent && npm install && cp .env.example .env && cd ..
```

Lancer depuis la racine : `npm run dev` (serveur), `npm run app` (client), `npm run agent` (agent, port 8082).
