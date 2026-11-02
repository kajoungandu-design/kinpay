export function formatCDF(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Affiche une date ISO de façon lisible : "À l'instant", "Il y a 5 min", "Hier"... */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "À l'instant";
  if (min < 60) return 'Il y a ' + min + ' min';
  const hours = Math.floor(min / 60);
  if (hours < 24) return 'Il y a ' + hours + ' h';
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Hier';
  if (days < 7) return 'Il y a ' + days + ' jours';
  return then.toLocaleDateString('fr-FR');
}
