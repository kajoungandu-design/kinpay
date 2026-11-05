import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.mjs';
import { openDb } from './lib/db.mjs';
import { ConsoleSms } from './lib/sms.mjs';
import { MockProvider } from './providers/mock.mjs';

const env = process.env;
const production = env.NODE_ENV === 'production';
const port = Number(env.PORT ?? 3000);
const dbPath = env.DB_PATH ?? './data/kinpay.db';

const qrSecret = env.QR_SECRET ?? '';
if (qrSecret.length < 32) {
  console.error('QR_SECRET manquant ou trop court (32 caractères minimum). Voir .env.example.');
  process.exit(1);
}
if (production && env.PROVIDER !== 'real' && !env.PROVIDER_MODULE && env.ALLOW_MOCK_IN_PRODUCTION !== '1') {
  console.error("Refus de démarrer en production avec le faux opérateur. Branchez un vrai opérateur ou définissez ALLOW_MOCK_IN_PRODUCTION=1 pour une démonstration.");
  process.exit(1);
}

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

let provider;
if (env.PROVIDER_MODULE) {
  // Opérateur ou simulateur de réseau branché sans toucher au reste du code (voir docs/INTEGRATION.md) :
  //   PROVIDER_MODULE=./providers/simulateur.mjs   (export default class, constructeur ({ db, env }))
  const mod = await import(pathToFileURL(resolve(env.PROVIDER_MODULE)).href);
  provider = new mod.default({ db, env });
  if (typeof provider.init === 'function') await provider.init();
  for (const fn of ['link', 'getBalance', 'transfer', 'pay', 'payout']) {
    if (typeof provider[fn] !== 'function') {
      console.error(env.PROVIDER_MODULE + ' : méthode « ' + fn + ' » manquante (voir le contrat dans providers/mock.mjs).');
      process.exit(1);
    }
  }
  console.log('Opérateur : ' + env.PROVIDER_MODULE);
} else if (env.PROVIDER === 'real') {
  console.error("PROVIDER=real : implémentez providers/real.example.mjs puis branchez-le ici (server.mjs).");
  process.exit(1);
} else {
  provider = new MockProvider(db);
}

const app = createApp({
  db,
  provider,
  sms: new ConsoleSms(),
  config: {
    qrSecret,
    echoOtp: env.DEV_ECHO_OTP === '1',
    production,
    // Réseau de machines externe (QR rdcpay://). Par défaut, le simulateur qui sert l'API Airtel.
    machineNetworkUrl: env.MACHINE_NETWORK_URL || (provider.sandbox ?? null),
    // Opérateurs branchés sur une vraie API : eux seuls peuvent payer une machine du réseau.
    machineNetworkOperators: provider.operators ?? [],
  },
});

// Remboursement automatique des ventes machine non confirmées, même sans trafic.
setInterval(() => app.sweep().catch((e) => console.error(e)), 5000).unref();
// Cycles de laverie et commandes du réseau externe : suivis même si le client a fermé l'application.
setInterval(() => app.syncNetworkOrders().catch((e) => console.error(e)), 5000).unref();

createServer(app).listen(port, () => {
  console.log('KinPay serveur prêt sur le port ' + port + (provider instanceof MockProvider ? ' (FAUX OPÉRATEUR, aucun argent réel)' : ''));
  console.log('Portail des propriétaires de machines : http://localhost:' + port + '/portail');
  if (provider.operators?.length) console.log('Opérateurs branchés : ' + provider.operators.join(', ') + ' (les autres : faux opérateur)');
  if (provider.sandbox) console.log('Machines du réseau : ' + provider.sandbox + '/machines');
});
