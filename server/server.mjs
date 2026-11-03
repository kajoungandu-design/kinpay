import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
if (production && env.PROVIDER !== 'real' && env.ALLOW_MOCK_IN_PRODUCTION !== '1') {
  console.error("Refus de démarrer en production avec le faux opérateur. Branchez un vrai opérateur ou définissez ALLOW_MOCK_IN_PRODUCTION=1 pour une démonstration.");
  process.exit(1);
}

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

let provider;
if (env.PROVIDER === 'real') {
  console.error("PROVIDER=real : implémentez providers/real.example.mjs puis branchez-le ici (server.mjs).");
  process.exit(1);
} else {
  provider = new MockProvider(db);
}

const app = createApp({
  db,
  provider,
  sms: new ConsoleSms(),
  config: { qrSecret, echoOtp: env.DEV_ECHO_OTP === '1', production },
});

// Remboursement automatique des ventes machine non confirmées, même sans trafic.
setInterval(() => app.sweep().catch((e) => console.error(e)), 5000).unref();

createServer(app).listen(port, () => {
  console.log('KinPay serveur prêt sur le port ' + port + (provider instanceof MockProvider ? ' (FAUX OPÉRATEUR, aucun argent réel)' : ''));
  console.log('Portail des propriétaires de machines : http://localhost:' + port + '/portail');
});
