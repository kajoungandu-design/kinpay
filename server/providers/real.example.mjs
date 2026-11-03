/**
 * MODÈLE pour brancher un vrai opérateur (ou un agrégateur de paiement présent en RDC).
 * À copier, renommer (par ex. orange.mjs) et compléter avec la documentation API fournie
 * par l'opérateur après signature du contrat. Les clés viennent de variables d'environnement,
 * jamais du code.
 *
 * Règles importantes :
 *  - Chaque appel doit être idempotent : réutiliser une référence unique (account.id + date + montant)
 *    pour qu'un nouvel essai ne débite pas deux fois.
 *  - Un appel qui expire (timeout) n'est pas un échec : la transaction reste « pending » jusqu'à
 *    confirmation par l'opérateur (webhook ou consultation de statut).
 *  - Un transfert vers un autre opérateur peut passer par un agrégateur ou un accord d'interopérabilité.
 */
export class RealProviderExample {
  constructor({ baseUrl, clientId, clientSecret }) {
    if (!baseUrl || !clientId || !clientSecret) throw new Error('Identifiants opérateur manquants');
    this.baseUrl = baseUrl;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  async link({ operator, phone, currency }) {
    // Faire vérifier le numéro par l'opérateur (code envoyé par l'opérateur), puis lire le solde.
    throw new Error('À implémenter : ' + operator + ' ' + phone);
  }

  async getBalance(account) {
    throw new Error('À implémenter : ' + account.id);
  }

  async transfer({ account, toPhone, amount }) {
    throw new Error('À implémenter : ' + account.id + ' -> ' + toPhone + ' ' + amount);
  }

  async pay({ account, amount }) {
    throw new Error('À implémenter : ' + account.id + ' ' + amount);
  }
}
