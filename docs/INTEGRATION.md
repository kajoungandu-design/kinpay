# Brancher un simulateur (machines, réseau Mobile Money) sur KinPay

KinPay a deux points de branchement. Les deux sont testés automatiquement : `server/test/machines.test.mjs` et `server/test/network.test.mjs`.

```
                    ┌──────────────────── Serveur KinPay (server/) ────────────────────┐
 App client  ─────► │ comptes, PIN, QR, séquestre, remboursements, retraits, portail   │ ─── B ──► Réseau Mobile Money
 App agent   ─────► │                                                                  │           (votre simulateur de réseau,
 Portail web ─────► │                                                                  │            un agrégateur, un opérateur)
                    └──────────────────────────────────────────────────────────────────┘
                                         ▲   │
                                       A │   │ ordre « vend » (SSE, interrogation ou webhook)
                                         │   ▼
                         Machines : votre simulateur de machines, un boîtier IoT MDB, une laverie à relais
```

- **A. Machines → KinPay.** Votre simulateur de machines (ou un boîtier réel) **appelle l'API machine** de KinPay avec sa clé secrète. KinPay peut aussi **appeler votre simulateur** par webhook.
- **B. KinPay → réseau.** KinPay **appelle l'API** de votre simulateur de réseau pour débiter, créditer et lire les soldes.

Tous les montants sont des **entiers** : des francs pour CDF, des **cents** pour USD (`250` = 2,50 USD).

---

## A. Machines (distributeurs, laverie, pompe, DAB)

### 1. Créer la machine

Créez la machine dans le **portail** (`http://<PC>:3000/portail`, avec le même numéro et le même PIN que dans l'app) : *Ajouter une machine*. Le portail affiche :
- la **clé secrète** `mk_…`, une seule fois : elle va dans le simulateur ;
- le **QR fixe** `kinpay://m?id=DIST-XXXXXX&s=<16 hex>`, à imprimer sur la machine.

Autre possibilité : `cd server && npm run machine -- DIST-0042 "Nom" --type vending --devise CDF --proprietaire 0890000000`.

Types de machine : `vending` (snacks, boissons), `laundry` (laverie, relais), `fuel` (pompe à essence), `atm` (distributeur de billets).

### 2. API machine

Chaque appel porte l'en-tête `x-machine-key: mk_…`. Chaque appel compte aussi comme un signe de vie : une machine silencieuse depuis **60 s** est « hors ligne », et l'app refuse alors l'achat **avant** de débiter le client.

| Appel | Rôle |
|---|---|
| `GET /machine/me` | identité, devise, QR fixe, catalogue |
| `POST /machine/slots` `{ slots: [{ slot, name, price, stock }] }` | publier ou remplacer le catalogue (`stock: null` = illimité) |
| `GET /machine/events` | **flux temps réel SSE**. Événements : `hello`, `vend`, `ping` (toutes les 15 s). Les ventes en attente sont renvoyées à chaque reconnexion. |
| `POST /machine/heartbeat` | autre mode, sans connexion ouverte : à appeler toutes les 1 à 3 s. Renvoie `{ vends: [...] }`, les ventes à servir. |
| `POST /machine/vends/:id/result` `{ ok, finalAmount?, reason? }` | **résultat de la distribution**, obligatoire |
| `POST /machine/qr` `{ amount, item, currency }` | QR dynamique, pour une machine avec écran |
| `GET /machine/qr/:nonce` | état de ce QR : `{ status, vendId, vendStatus }` |
| `POST /machine/redeem` `{ code, amount, item, currency }` | paiement par code OTP à 6 chiffres (téléphone sans réseau) |
| `POST /machine/withdraw` `{ code }` | **DAB uniquement** : code de retrait à 8 chiffres |

Ordre `vend` reçu par la machine :

```json
{ "id": "vnd_…", "slot": 2, "item": "Coca-Cola 33 cl", "amount": 2000, "currency": "CDF", "source": "fixed", "deadline": 1793700000000 }
```

`source` vaut `fixed` (QR fixe), `qr` (QR dynamique), `code` (OTP), `fuel` (pompe) ou `atm` (retrait).

### 3. La règle du séquestre (remboursement automatique)

1. Le client paie : son compte est débité et l'argent est **bloqué** (`held`).
2. La machine distribue, puis appelle `POST /machine/vends/:id/result` :
   - `{ "ok": true }` : le **propriétaire est crédité** et le stock diminue ;
   - `{ "ok": false, "reason": "JAMMED" }` : le **client est remboursé** tout de suite.
3. Sans résultat dans les **30 s**, le client est remboursé automatiquement. Un résultat qui arrive trop tard ne change plus rien.
4. **Pompe à essence** : `{ "ok": true, "finalAmount": 32000 }`. Le propriétaire reçoit 32 000, le reste du plafond est rendu au client.

Un même résultat envoyé deux fois est sans effet : la réponse donne l'état final.

### 4. Webhook (si votre simulateur expose une API)

Dans le portail, ouvrez *Connexion* et saisissez l'adresse de votre simulateur, par exemple `http://192.168.1.50:5000/kinpay`. À chaque vente, KinPay envoie :

```http
POST /kinpay
content-type: application/json
x-kinpay-signature: <HMAC-SHA256 hex du corps, avec pour clé sha256(clé machine) en hex>

{ "type": "vend", "machineId": "DIST-XXXXXX", "vend": { …même objet que ci-dessus… } }
```

Votre simulateur répond de l'une de deux façons :
- **tout de suite** `{ "dispensed": true }` (ou `{ "dispensed": false, "reason": "EMPTY" }`) : la vente est réglée sur-le-champ ;
- ou par `200 {}`, puis plus tard `POST /machine/vends/:id/result`.

Si l'adresse est injoignable, le client est remboursé tout de suite. Si elle ne répond pas avant 4 s, KinPay attend le résultat jusqu'au délai de 30 s. Une machine avec webhook est considérée « en ligne ». En production, `https://` est obligatoire.

Vérifier la signature, en Node :

```js
const secret = crypto.createHash('sha256').update(MACHINE_KEY).digest('hex');
const ok = crypto.createHmac('sha256', secret).update(rawBody).digest('hex') === req.headers['x-kinpay-signature'];
```

### 5. Tester sans matériel

```bash
cd server
node scripts/machine-sim.mjs http://localhost:3000 mk_… --catalogue      # distribue normalement
node scripts/machine-sim.mjs http://localhost:3000 mk_… --echec          # produit coincé → remboursement
node scripts/machine-sim.mjs http://localhost:3000 mk_… --muet           # aucune réponse → remboursement après 30 s
node scripts/machine-sim.mjs http://localhost:3000 mk_… --servi 60       # pompe : 60 % du plafond servi
node scripts/machine-sim.mjs http://localhost:3000 mk_… --qr 1500 "Eau"  # machine à écran : affiche un QR dynamique
node scripts/machine-sim.mjs http://localhost:3000 mk_… --retrait 12345678  # DAB : saisit le code de retrait du client
```

Sur le téléphone : **Payer**, puis collez le QR fixe (`kinpay://m?id=…`) dans le champ de test, ou scannez-le sur l'écran du PC dans le portail (*QR fixe*).

### 6. Vers le vrai matériel

- **Distributeur MDB** : un boîtier « cashless » (ESP32 ou Raspberry Pi, avec une carte MDB et une connexion 4G ou Wi-Fi) parle MDB à la machine, et l'API ci-dessus à KinPay. À la commande `vend`, il autorise la vente MDB ; selon que le produit sort ou non, il envoie `result ok` ou `result ok:false`.
- **Laverie** : un relais suffit. Une impulsion par `vend`, puis `result ok`.
- Un pont **MQTT** pourra s'ajouter plus tard sans changer cette logique.

---

## B. Réseau Mobile Money (votre simulateur de réseau)

KinPay ne connaît les opérateurs qu'à travers 5 fonctions : le **contrat du fournisseur**, décrit en tête de `server/providers/mock.mjs`.

| Fonction | Rôle |
|---|---|
| `link({ operator, phone, currency })` → `{ balance }` | lier un compte |
| `getBalance(account)` → `number` | solde |
| `transfer({ account, toPhone, amount })` → `{ ok, balance }` | envoi vers un numéro |
| `pay({ account, amount, description, creditAccountId? })` → `{ ok, balance }` | débit (facture, QR, machine, retrait agent) |
| `payout({ account, amount, description })` → `{ ok, balance }` | versement depuis le compte marchand KinPay (vente machine confirmée, remboursement) |

### Option 1 : votre simulateur adopte ce contrat HTTP (rien à programmer)

`server/providers/http-network.mjs` appelle :

```
POST /accounts/verify   { operator, phone, currency }                                 -> { balance }
POST /accounts/balance  { operator, phone, currency }                                 -> { balance }
POST /transfers         { reference, operator, phone, currency, amount, toPhone }     -> { ok: true, balance } | { ok: false, reason }
POST /payments          { reference, operator, phone, currency, amount, description } -> { ok: true, balance } | { ok: false, reason }
POST /payouts           { reference, operator, phone, currency, amount, description } -> { ok: true, balance } | { ok: false, reason }
```

`reason` vaut `INSUFFICIENT_FUNDS`, `INVALID_AMOUNT` ou `UNKNOWN_ACCOUNT`. `reference` est unique : un rejeu ne doit pas débiter deux fois. Une erreur 5xx ou un délai dépassé laisse l'opération « en attente », sans rejeu à l'aveugle.

Ajoutez dans `server/.env` :

```
PROVIDER_MODULE=./providers/http-network.mjs
NETWORK_API_URL=http://localhost:4000
NETWORK_API_KEY=votre-cle
```

### Option 2 : votre simulateur a déjà sa propre API

Copiez `server/providers/http-network.mjs` sous un autre nom, par exemple `simulateur.mjs`, et adaptez seulement la fonction `call` et les 5 méthodes aux adresses et formats de votre API. Puis indiquez `PROVIDER_MODULE=./providers/simulateur.mjs`. Au démarrage, le serveur vérifie que les 5 méthodes existent.

**Pour que j'écrive cet adaptateur, il me faut** la documentation de votre API :
- adresse de base ;
- authentification (clé, jeton) ;
- pour chacune des 5 opérations : adresse, corps envoyé, réponse, codes d'erreur ;
- comment le réseau signale un crédit reçu (webhook ou consultation).

---

## C. Airtel Money, M-Pesa et distributeurs du simulateur « RDC Mobile Money Sandbox » (branchés)

Les deux opérateurs sont branchés sur leur vraie API, avec le simulateur sur `localhost:4010` :
- `server/providers/operators.mjs` aiguille chaque compte vers l'API de son opérateur ;
- `airtel.mjs` et `mpesa.mjs` parlent chacun à leur opérateur ;
- Orange et Africell restent sur le faux opérateur intégré.

Tests automatiques : `server/test/airtel.test.mjs` et `mpesa.test.mjs`. Les deux opérateurs ont aussi été testés en direct sur le simulateur.

```
PROVIDER_MODULE=./providers/operators.mjs
AIRTEL_BASE_URL=http://localhost:4010/airtel
AIRTEL_CLIENT_ID=kinpay-airtel
AIRTEL_CLIENT_SECRET=kinpay-airtel-secret
AIRTEL_COUNTRY=CD
AIRTEL_CURRENCY=CDF
MPESA_BASE_URL=http://localhost:4010/mpesa/openapi/ipg/v2/vodacomDRC
MPESA_API_KEY=kinpay-mpesa-api-key
MPESA_SERVICE_PROVIDER_CODE=171717
MPESA_COUNTRY=DRC
```

Sans les variables `AIRTEL_*` ou `MPESA_*`, l'opérateur concerné repasse sur le faux opérateur.

| Opération KinPay | Airtel | M-Pesa |
|---|---|---|
| connexion | OAuth2 `/auth/oauth2/token` | `/getSession/` (Bearer = clé API) |
| lier un compte, lire le solde | `/sandbox/phone/{numéro}`, propre au bac à sable ; un numéro d'un autre opérateur est refusé | idem |
| débit : payer, envoyer, retrait agent, machine | collection `/merchant/v1/payments/`, puis statut `TS` / `TF` | C2B `/c2bPayment/singleStage/`, puis `/queryTransactionStatus/` (`Completed` / `Failed` / `Expired`) |
| crédit : vendeur, agent, destinataire, propriétaire, remboursement | disbursement `/standard/v1/disbursements/` | B2C `/b2cPayment/` |
| confirmation trop tardive | `/standard/v1/payments/refund` automatique | `/reversal/` automatique |

- **Transfert d'un opérateur à un autre** (exemple : Airtel vers M-Pesa) : le compte de l'expéditeur est débité chez son opérateur. Le destinataire est crédité chez le sien, depuis le compte marchand KinPay de cet opérateur. Si le crédit échoue, l'expéditeur est remboursé.
- **Montants** : KinPay compte en cents pour l'USD, les opérateurs en unités (M-Pesa : texte à 2 décimales, `"2.50"`). La référence M-Pesa fait au plus 20 caractères, sans espace.
- **Délai** : le client a 50 s pour taper son PIN (`CONFIRM_TIMEOUT_MS`), et l'app attend jusqu'à 90 s.
- **Production M-Pesa** : Vodacom demande la clé API chiffrée avec sa clé publique RSA. Le chiffrement est à ajouter dans `MpesaApi.sessionKey()`.

**Numéros pour tester** (Airtel : 097, 098, 099 ; M-Pesa : 081, 082, 083) :

| Numéro | Comportement |
|---|---|
| `0970000001` / `0810000001` | accepte tout seul |
| `…0000002` | solde insuffisant |
| `…0000003` | pas de réponse |
| `…0000005` | le client refuse |
| `0971234567` (Grace), `0811234567` | vous tapez le PIN vous-même sur le téléphone virtuel `http://localhost:4010/phone.html` |

**Distributeurs du simulateur (QR `rdcpay://pay?m=…&o=…`)**
1. Dans KinPay, « Payer » vérifie le QR (`POST /payments/network/check`).
2. L'app paie avec un compte **Airtel ou M-Pesa** de la même devise. Le numéro de commande sert de référence chez l'opérateur.
3. Le simulateur garde l'argent en séquestre jusqu'à la distribution.
4. L'app suit la commande (`GET /external-orders/:machine/:commande`) jusqu'à « Servi » ou « Remboursé ». Un remboursement est inscrit une seule fois dans l'historique.

**Laveries du simulateur (même QR `rdcpay://`, cycle `lav_…`)**

KinPay reconnaît une laverie au champ `kind: "laundry"` renvoyé par la vérification du QR, puis lit `GET /laundries/{id}/cycles/{cycle}`.

| État du simulateur | État KinPay | Écran de l'app |
|---|---|---|
| `PENDING`, `PAID` | `held` | Démarrage de la machine |
| `RUNNING` | `running` | **Paiement validé**, cycle en cours ; le client peut fermer l'écran |
| `COMPLETED` | `dispensed` | Cycle terminé, retirer le linge |
| `PARTIAL_REFUND` | `dispensed` | Montant payé et reste rendu (aussi pour un panier de distributeur) |
| `REFUNDED` | `refunded` | Remboursé |

Le serveur relit toutes les 5 s les commandes et cycles non terminés des dernières 24 heures (`syncNetworkOrders`). Un remboursement survenu après la fermeture de l'app est donc bien inscrit dans l'historique.
