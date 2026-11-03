# KinPay — portefeuille Mobile Money unifié pour la RDC

Un seul portefeuille pour Orange Money, Airtel Money, M-Pesa et Africell Money, avec un compte CDF et un compte USD par opérateur. Il permet :
- d'envoyer de l'argent ;
- de payer et d'encaisser par QR (taxi, commerçant, catalogue) ;
- de payer ses factures ;
- de retirer des espèces chez un agent agréé ou à un distributeur de billets ;
- de payer des **machines connectées** (distributeurs, laveries, pompes), avec remboursement automatique si la machine ne sert pas.

**État actuel : tout fonctionne avec un FAUX opérateur. Aucun argent réel ne circule.**

## 1. Les pièces

```
 App client (app/)  ──┐
 App agent (agent/) ──┼──►  Serveur KinPay (server/)  ──►  Réseau Mobile Money (faux opérateur, simulateur, opérateur réel)
 Portail web        ──┘      comptes, PIN, QR signés, séquestre,
 (/portail)                  retraits, temps réel, base SQLite
                                     ▲
 Machines / simulateur ──────────────┘  clé secrète par machine (SSE, interrogation ou webhook)
```

| Dossier | Contenu |
|---|---|
| `server/` | le serveur, en Node.js **sans aucune dépendance** ; 39 tests |
| `app/` | l'application client, en Expo SDK 58 : accueil, Envoyer, Payer, Encaisser, Factures, Retirer, achat sur machine |
| `agent/` | l'application **KinPay Agent**, pour servir les retraits d'espèces ; elle partage `app/src/core` |
| `server/public/portail.html` | le portail des propriétaires de machines : ventes, stock, QR fixe, clés, webhook |
| `docs/INTEGRATION.md` | **comment brancher un simulateur de machines ou de réseau** |

## 2. Lancer en développement (PC + téléphone Android avec Expo Go)

Prérequis : Node.js 22.18 ou plus. Depuis la racine du projet :

```bash
npm run dev      # terminal 1 : serveur sur le port 3000 (server/.env, voir server/.env.example)
npm run app      # terminal 2 : application client (scanner le QR avec Expo Go)
npm run agent    # terminal 3, si besoin : application agent (port 8082)
npm test         # tests du serveur et de l'application
```

Les fichiers `app/.env` et `agent/.env` contiennent `EXPO_PUBLIC_API_URL=auto` : le téléphone trouve seul l'adresse du PC.

| Je veux tester… | Comment |
|---|---|
| un agent agréé | s'inscrire dans l'app avec un numéro, puis `npm --prefix server run agent -- <numéro>` et se connecter dans KinPay Agent |
| un retrait | dans l'app : **Retirer**, puis montant, PIN, code à 8 chiffres ; dans l'app agent : saisir le code, puis **Confirmer** |
| une machine | ouvrir le **portail** `http://localhost:3000/portail`, puis *Ajouter une machine* ; lancer `node server/scripts/machine-sim.mjs http://localhost:3000 <clé> --catalogue` ; dans l'app : **Payer**, puis coller le QR fixe |
| un DAB | dans le portail, créer une machine « Distributeur de billets » ; dans l'app, **Retirer** pour obtenir un code ; puis `node server/scripts/machine-sim.mjs http://localhost:3000 <clé> --retrait <code>` |

## 3. Ce qui est protégé côté serveur (et testé)

- **Connexion** : PIN haché, blocage après 5 erreurs ; codes SMS limités et expirants.
- **QR signés** : usage unique et expiration ; le montant vient du serveur, jamais du téléphone.
- **Opérations** :
  - pas de double débit (idempotence) ;
  - même devise uniquement ;
  - un compte d'un autre utilisateur est inaccessible.
- **Retraits** :
  - code à 8 chiffres, valable 15 min, usage unique, un seul retrait en attente par client ;
  - 10 codes faux par minute au maximum, par agent ou par DAB.
- **Machines** :
  - **séquestre** : le propriétaire n'est crédité qu'après la distribution confirmée ;
  - remboursement si la machine échoue ou se tait plus de 30 s ;
  - achat refusé **avant débit** si la machine est hors ligne, occupée ou en rupture de stock ;
  - webhook signé (HMAC).

## 4. Mettre le serveur en ligne

```bash
cp server/.env.example server/.env     # QR_SECRET obligatoire ; DEV_ECHO_OTP vide ; ALLOW_MOCK_IN_PRODUCTION=1 pour une démonstration
echo "DOMAIN=api.votre-domaine.com" > .env
docker compose --profile prod up -d --build
```

HTTPS se fait automatiquement avec Caddy. **Sauvegardez le volume `kinpay-data` chaque jour.** En production, le serveur refuse de démarrer avec le faux opérateur, sauf si `ALLOW_MOCK_IN_PRODUCTION=1`.

## 5. Pour passer au réel

1. **Cadre légal** : autorisation ou partenariat avec un établissement agréé par la Banque centrale du Congo ; réglementation des agents.
2. **Opérateurs ou agrégateur** : contrat et API (débit, versement « disbursement », solde, webhook). On les branche avec `PROVIDER_MODULE`, voir `docs/INTEGRATION.md`.
3. **SMS réels** : remplacer `ConsoleSms` (`server/lib/sms.mjs`).
4. **Boîtiers machines** : MDB ou relais, avec un électronicien. Le protocole est dans `docs/INTEGRATION.md`.
5. **Rapprochement** des opérations restées « en attente » et des ventes machine en état `error`.
6. **Lutte contre la fraude** : plafonds journaliers, KYC, journal d'audit, PIN vérifié aussi par le serveur sur chaque paiement.
7. **Production** : PostgreSQL si plusieurs serveurs ; audit de sécurité ; publication sur Google Play et l'App Store.
