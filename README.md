# KinPay — portefeuille Mobile Money unifié

Application mobile (Android et iPhone) + serveur, pour regrouper plusieurs Mobile Money (Orange Money, Airtel Money, M-Pesa, Africell Money) dans un seul portefeuille : envoi entre comptes et entre opérateurs, paiement par QR ou code OTP sur des machines, paiement de factures.

**État actuel : tout fonctionne avec un FAUX opérateur. Aucun argent réel ne circule.** Les sections 4 à 6 expliquent ce qu'il faut pour passer au réel.

## 1. Comment les pièces s'assemblent

```
 Téléphone (app/)  ──HTTPS──►  Serveur KinPay (server/)  ──►  Opérateurs Mobile Money
 Expo / React Native           comptes, PIN, SMS, QR signés,     (Orange, Airtel, M-Pesa…)
                               historique, base de données       aujourd'hui : faux opérateur
                                       ▲
 Machine / distributeur ───HTTPS───────┘   (clé secrète par machine)
```

- **`app/`** : l'application. Elle ne parle jamais aux opérateurs directement : seulement à votre serveur.
- **`server/`** : le cerveau. Il garde les comptes, vérifie le PIN, émet les codes OTP et les QR signés, et appelle les opérateurs. Les clés secrètes des opérateurs ne quittent jamais le serveur.
- **Machines** : elles demandent au serveur un QR signé (`POST /machine/qr`) ou valident un code OTP (`POST /machine/redeem`), avec leur clé secrète.

Ce qui est déjà protégé côté serveur (et vérifié par des tests) : PIN haché et blocage après 5 erreurs, code SMS limité et expirant, QR signé à usage unique et expirant (le montant vient du serveur, pas du téléphone), code OTP de paiement à usage unique (60 s), une opération rejouée ne débite pas deux fois, un utilisateur ne peut pas toucher le compte d'un autre.

## 2. Lancer tout l'environnement sur votre ordinateur (développement)

Prérequis : [Node.js](https://nodejs.org) **22.18 ou plus** (sans autre installation pour le serveur).

```bash
# --- Serveur ---
cd server
cp .env.example .env            # puis remplir QR_SECRET (voir la commande indiquée dans le fichier)
npm run dev                     # démarre sur http://localhost:3000
npm test                        # 20 tests : sécurité, soldes, QR, OTP, application ↔ serveur
```

En développement (`DEV_ECHO_OTP=1`), le code SMS est affiché dans le terminal du serveur au lieu d'être envoyé.

```bash
# --- Enregistrer une machine, puis simuler son QR ---
npm run machine -- DIST-0042 "Distributeur de test"        # affiche la clé secrète de la machine
node scripts/demo-machine.mjs http://localhost:3000 <clé> 1500 "Bouteille d'eau 50 cl"
```

```bash
# --- Application (voir app/README.md pour la création du projet Expo) ---
cd app
cp .env.example .env
#   EXPO_PUBLIC_API_URL=http://<adresse IP de votre ordinateur>:3000   (téléphone et ordinateur sur le même Wi-Fi)
npx expo start
```

Dans l'application : **Inscription** → code SMS (lu dans le terminal du serveur) → PIN → **Ajouter un compte** → tester Envoyer, Factures, et Payer (coller dans le champ de test le QR affiché par `demo-machine.mjs`, ou afficher un code OTP).

Sans `EXPO_PUBLIC_API_URL`, l'application fonctionne seule en démonstration hors-ligne.

## 3. Mettre le serveur en ligne (démonstration publique)

Il faut un petit serveur (VPS) avec Docker, et un nom de domaine qui pointe vers lui.

```bash
cp server/.env.example server/.env     # QR_SECRET obligatoire; DEV_ECHO_OTP vide; ALLOW_MOCK_IN_PRODUCTION=1 (faux opérateur)
echo "DOMAIN=api.votre-domaine.com" > .env
docker compose --profile prod up -d --build
```

HTTPS est obtenu automatiquement (Caddy). Les données sont dans le volume `kinpay-data` : **sauvegardez-le chaque jour**. Le serveur refuse de démarrer en production avec le faux opérateur, sauf `ALLOW_MOCK_IN_PRODUCTION=1`, pour éviter de le laisser tourner par erreur avec de vrais clients.

> Ces fichiers Docker n'ont pas pu être exécutés là où ils ont été écrits (Docker indisponible). Le serveur lui-même a été démarré et testé directement avec Node.

## 4. Pour passer au réel : ce qu'il faut obtenir

Ce sont des démarches, pas du code. Elles prennent le plus de temps, il faut les lancer en premier.

1. **Cadre légal.** Manipuler de l'argent de clients exige une autorisation ou un partenariat avec un établissement agréé par la **Banque centrale du Congo**. Consultez un juriste local avant toute ouverture au public.
2. **Contrats opérateurs.** Un contrat et des accès API avec chaque opérateur, ou avec un **agrégateur de paiement** déjà connecté à plusieurs opérateurs en RDC (souvent plus rapide).
3. **Fournisseur de SMS** (par exemple Africa's Talking ou Twilio), pour les codes de connexion.
4. **Hébergement et sauvegardes** sérieux, surveillance des erreurs, plan en cas de panne.
5. **Audit de sécurité** par un expert indépendant avant le lancement.
6. **Comptes de publication :** Google Play (Android) et Apple Developer (iPhone), avec politique de confidentialité.
7. **Fabricants / exploitants des machines :** convenir du format du QR et de la clé secrète de chaque machine.

## 5. Pour passer au réel : ce qu'il faut programmer

1. **Brancher un opérateur** : copier `server/providers/real.example.mjs`, l'implémenter avec la documentation API reçue, puis le choisir dans `server/server.mjs`. Le reste ne change pas.
2. **Envoyer de vrais SMS** : écrire une classe avec la méthode `send(phone, texte)` à la place de `ConsoleSms` (`server/lib/sms.mjs`).
3. **Réconciliation** : une opération dont l'opérateur n'a pas répondu reste « pending » ; il faut une tâche qui l'interroge et la clôture, et des webhooks pour les crédits reçus.
4. **Règlement des commerçants / machines** : aujourd'hui le serveur débite le client mais ne reverse l'argent à personne.
5. **Base de données de production** : SQLite convient pour démarrer (un seul serveur). Avec de la charge ou plusieurs serveurs, passer à PostgreSQL.
6. **Limites et lutte contre la fraude** : plafonds par jour, alertes, vérification d'identité (KYC), journal d'audit.
7. **Application** : écran de vérification du PIN avant chaque paiement, verrouillage biométrique, notifications, publication sur les magasins.

## 6. Limites connues de cette version

- Les écrans de l'application (`app/src/screens`, `App.tsx`, `src/store`) **n'ont pas pu être compilés ni lancés** où ils ont été écrits (accès aux bibliothèques bloqué). La logique de `app/src/core` et le serveur sont, eux, testés. Au premier lancement, de petites corrections de typage ou de version sont possibles.
- Les soldes sont des données de démonstration (100 000 CDF par compte ajouté).
- Un code OTP est de 6 chiffres : acceptable avec la limite d'essais par machine, à renforcer (lié à la machine, plus long) en production.
- Les préfixes d'opérateurs (`app/src/core/phone.ts`) sont à vérifier.
