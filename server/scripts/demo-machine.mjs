// Simule une machine : demande au serveur un QR de paiement signé.
// Usage : node scripts/demo-machine.mjs http://localhost:3000 <clé-machine> 1500 "Bouteille d'eau 50 cl"
// Collez ensuite le texte affiché dans le champ de test de l'application (ou dans un générateur de QR).
const [url, key, amount, ...item] = process.argv.slice(2);
if (!url || !key || !amount || item.length === 0) {
  console.error('Usage : node scripts/demo-machine.mjs <url-serveur> <clé-machine> <montant> "<article>"');
  process.exit(1);
}
const res = await fetch(url.replace(/\/+$/, '') + '/machine/qr', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-machine-key': key },
  body: JSON.stringify({ amount: Number(amount), item: item.join(' ') }),
});
const json = await res.json();
if (!res.ok) {
  console.error('Refusé (' + res.status + ') :', json);
  process.exit(1);
}
console.log(json.qr);
console.log('(valable 2 minutes, utilisable une seule fois)');
