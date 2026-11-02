// Enregistre une machine et affiche sa clé secrète (une seule fois).
// Usage : node scripts/create-machine.mjs DIST-0042 "Distributeur aéroport N'Djili"
import { openDb, createMachine } from '../lib/db.mjs';

const [id, name] = process.argv.slice(2);
if (!id || !name) {
  console.error('Usage : node scripts/create-machine.mjs <id> "<nom>"');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
  console.error("L'identifiant ne doit contenir que des lettres, chiffres, - et _ (32 max).");
  process.exit(1);
}
const db = openDb(process.env.DB_PATH ?? './data/kinpay.db');
const key = createMachine(db, { id, name });
console.log('Machine ' + id + ' enregistrée.');
console.log('Clé secrète (à stocker dans la machine, non récupérable ensuite) :');
console.log(key);
