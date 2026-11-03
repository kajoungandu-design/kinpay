// Enregistre une machine et affiche sa clé secrète (une seule fois) et le texte de son QR fixe.
// Usage : npm run machine -- DIST-0042 "Distributeur aéroport N'Djili" [--type vending|laundry|fuel|atm] [--devise CDF|USD] [--proprietaire 089...]
// (Plus simple : créer la machine depuis le portail http://localhost:3000/portail)
import { openDb, createMachine, MACHINE_KINDS } from '../lib/db.mjs';
import { normalizePhone } from '../lib/phone.mjs';
import { hmac } from '../lib/crypto.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [id, name] = positional;
const kind = opt('type') ?? 'vending';
const currency = opt('devise') ?? 'CDF';
if (!id || !name || !MACHINE_KINDS.includes(kind) || !['CDF', 'USD'].includes(currency)) {
  console.error('Usage : npm run machine -- <id> "<nom>" [--type ' + MACHINE_KINDS.join('|') + '] [--devise CDF|USD] [--proprietaire <numéro>]');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
  console.error("L'identifiant ne doit contenir que des lettres, chiffres, - et _ (32 max).");
  process.exit(1);
}
const db = openDb(process.env.DB_PATH ?? './data/kinpay.db');
let ownerUserId = null;
if (opt('proprietaire')) {
  const owner = db.prepare('SELECT id FROM users WHERE phone = ?').get(normalizePhone(opt('proprietaire')));
  if (!owner) {
    console.error('Propriétaire inconnu : inscrivez-le d\'abord dans l\'application.');
    process.exit(1);
  }
  ownerUserId = owner.id;
}
const key = createMachine(db, { id, name, kind, currency, ownerUserId });
console.log('Machine ' + id + ' (' + kind + ', ' + currency + ') enregistrée.');
console.log('Clé secrète (à stocker dans la machine, non récupérable ensuite) :');
console.log(key);
if (process.env.QR_SECRET) {
  console.log('QR fixe à imprimer et coller sur la machine :');
  console.log('kinpay://m?id=' + id + '&s=' + hmac(process.env.QR_SECRET, 'machine|' + id).slice(0, 16));
}
