// Simulateur de boîtier machine (distributeur, laverie, pompe, DAB) : aucun matériel nécessaire.
// Il ouvre le flux temps réel du serveur, reçoit les ordres de distribution et répond comme une vraie machine.
//
// Usage : node scripts/machine-sim.mjs <url-serveur> <clé-machine> [options]
//   --catalogue      publie un catalogue de démonstration (selon le type de machine)
//   --echec          la distribution échoue (produit coincé) : le client doit être remboursé
//   --muet           ne répond jamais (panne réseau) : remboursement automatique après 30 s
//   --delai <ms>     temps de distribution simulé (défaut 1500)
//   --servi <0-100>  pompe à essence : pourcentage du plafond réellement servi (défaut 70)
//   --qr <montant> "<article>"   affiche un QR dynamique (machine à écran) au démarrage
//   --retrait <code> distributeur de billets : saisit le code de retrait à 8 chiffres du client
const args = process.argv.slice(2);
const [url, key] = args;
const has = (f) => args.includes(f);
const opt = (f, d) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : d);
if (!url || !key) {
  console.error('Usage : node scripts/machine-sim.mjs <url-serveur> <clé-machine> [--catalogue] [--echec] [--muet] [--delai ms] [--servi %]');
  process.exit(1);
}
const base = url.replace(/\/+$/, '');
const headers = { 'content-type': 'application/json', 'x-machine-key': key };
const delay = Number(opt('--delai', 1500));
const served = Math.min(100, Math.max(0, Number(opt('--servi', 70))));
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const fmt = (n, c) => (c === 'USD' ? (n / 100).toFixed(2).replace('.', ',') : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')) + ' ' + c;

const me = await call('GET', '/machine/me');
if (me.status !== 200) {
  console.error('Clé refusée par le serveur (' + me.status + ').');
  process.exit(1);
}
const machine = me.json;
console.log('Machine ' + machine.id + ' « ' + machine.name + ' » (' + machine.kind + ', ' + machine.currency + ')');
console.log('QR fixe (étiquette) : ' + machine.fixedQr);

if (has('--catalogue')) {
  const usd = machine.currency === 'USD';
  const demo = {
    vending: [
      { slot: 1, name: 'Eau 50 cl', price: usd ? 50 : 1000, stock: 12 },
      { slot: 2, name: 'Coca-Cola 33 cl', price: usd ? 100 : 2000, stock: 8 },
      { slot: 3, name: 'Biscuits', price: usd ? 75 : 1500, stock: 5 },
      { slot: 4, name: 'Jus de gingembre', price: usd ? 120 : 2500, stock: 1 },
    ],
    laundry: [
      { slot: 1, name: 'Lavage 30° (35 min)', price: usd ? 200 : 4000, stock: null },
      { slot: 2, name: 'Lavage 60° (50 min)', price: usd ? 300 : 6000, stock: null },
      { slot: 3, name: 'Séchage (30 min)', price: usd ? 150 : 3000, stock: null },
    ],
  }[machine.kind];
  if (demo) {
    const r = await call('POST', '/machine/slots', { slots: demo });
    console.log(r.status === 200 ? 'Catalogue publié : ' + demo.map((s) => s.slot + '. ' + s.name + ' ' + fmt(s.price, machine.currency)).join(' | ') : 'Catalogue refusé : ' + JSON.stringify(r.json));
  }
}

if (has('--qr')) {
  const i = args.indexOf('--qr');
  const r = await call('POST', '/machine/qr', { amount: Number(args[i + 1]), item: args[i + 2] ?? 'Article', currency: machine.currency });
  console.log(r.status === 201 ? 'QR dynamique (2 min) : ' + r.json.qr : 'QR refusé : ' + JSON.stringify(r.json));
}

if (has('--retrait')) {
  const r = await call('POST', '/machine/withdraw', { code: opt('--retrait') });
  console.log(r.status === 200 ? 'Code accepté : ' + fmt(r.json.amount, r.json.currency) + ' à sortir (commande ' + r.json.vendId + ')' : 'Code refusé (' + r.status + ') : ' + JSON.stringify(r.json));
}

const seen = new Set();
async function handleVend(v) {
  if (seen.has(v.id)) return;
  seen.add(v.id);
  const what = machine.kind === 'atm' ? 'Billets : ' + fmt(v.amount, v.currency) : machine.kind === 'laundry' ? 'Relais ON → ' + v.item : 'Distribution : ' + v.item;
  console.log('\n▶ Commande ' + v.id + ' — ' + what + ' (payé ' + fmt(v.amount, v.currency) + ')');
  if (has('--muet')) {
    console.log('  (mode muet : aucune réponse, le serveur remboursera le client)');
    return;
  }
  await new Promise((r) => setTimeout(r, delay));
  const ok = !has('--echec');
  const body = { ok, ...(ok ? {} : { reason: 'JAMMED' }) };
  if (ok && v.source === 'fuel') body.finalAmount = Math.round((v.amount * served) / 100);
  const r = await call('POST', '/machine/vends/' + v.id + '/result', body);
  const st = r.json?.status;
  console.log('  ' + (ok ? '✓ Servi' : '✗ Produit coincé') + ' → serveur : ' + (st === 'dispensed' ? 'propriétaire crédité' + (body.finalAmount !== undefined ? ' (' + fmt(body.finalAmount, v.currency) + ', reste rendu)' : '') : st === 'refunded' ? 'client remboursé' : JSON.stringify(r.json)));
}

// Flux SSE (reconnexion automatique). Lecture du texte « event: ... / data: ... ».
async function listen() {
  for (;;) {
    try {
      const res = await fetch(base + '/machine/events', { headers });
      if (res.status !== 200) throw new Error('HTTP ' + res.status);
      console.log('Connecté au serveur en temps réel. En attente de commandes… (Ctrl+C pour arrêter)');
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event === 'vend' && data) handleVend(JSON.parse(data)).catch((e) => console.error(e));
        }
      }
      console.log('Flux fermé, reconnexion…');
    } catch (e) {
      console.log('Serveur injoignable (' + e.message + '), nouvel essai dans 3 s…');
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
listen();
