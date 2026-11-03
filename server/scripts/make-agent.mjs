// Donne (ou retire) le statut d'agent agréé à un utilisateur déjà inscrit.
// Usage : npm run agent -- 0890000011          (donner)
//         npm run agent -- 0890000011 --retirer (retirer)
import { openDb } from '../lib/db.mjs';
import { normalizePhone } from '../lib/phone.mjs';

const args = process.argv.slice(2);
const phone = normalizePhone(args.find((a) => !a.startsWith('--')));
const remove = args.includes('--retirer');
if (!phone) {
  console.error('Usage : npm run agent -- <numéro> [--retirer]');
  process.exit(1);
}
const db = openDb(process.env.DB_PATH ?? './data/kinpay.db');
const r = db.prepare('UPDATE users SET is_agent = ? WHERE phone = ?').run(remove ? 0 : 1, phone);
if (Number(r.changes) !== 1) {
  console.error("Aucun utilisateur avec ce numéro. Inscrivez-le d'abord dans l'application KinPay.");
  process.exit(1);
}
console.log(phone + (remove ? " n'est plus agent." : ' est maintenant agent agréé. Il peut se connecter dans KinPay Agent.'));
