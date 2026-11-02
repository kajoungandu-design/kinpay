/**
 * Envoi de SMS. En développement : on affiche le message dans la console et on le garde en mémoire.
 * En production : remplacer par une implémentation qui appelle un fournisseur
 * (par exemple Africa's Talking ou Twilio) avec la même méthode send(phone, text).
 */
export class ConsoleSms {
  constructor({ quiet = false } = {}) {
    this.sent = [];
    this.quiet = quiet;
  }
  async send(phone, text) {
    this.sent.push({ phone, text });
    if (!this.quiet) console.log('[SMS simulé] ' + phone + ' : ' + text);
  }
}
