import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import type { Account, Currency, FailureReason } from './core/types';
import { colors, operatorColors, radius } from './theme';
import { OPERATORS } from './core/phone';

export function Title({ children }: { children: React.ReactNode }) {
  return <Text style={s.title}>{children}</Text>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={s.label}>{children}</Text>;
}

export function Muted({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[s.muted, style]}>{children}</Text>;
}

export function ErrorText({ children }: { children?: string }) {
  if (!children) return null;
  return (
    <Text accessibilityLiveRegion="polite" style={s.error}>
      {children}
    </Text>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Button({
  label,
  onPress,
  disabled,
  loading,
  variant = 'solid',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'solid' | 'outline';
}) {
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off }}
      onPress={off ? undefined : onPress}
      style={[s.btn, variant === 'outline' ? s.btnOutline : s.btnSolid, off && { opacity: 0.4 }]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'outline' ? colors.green : colors.white} />
      ) : (
        <Text style={[s.btnText, { color: variant === 'outline' ? colors.green : colors.white }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Pill({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={[s.pill, on ? s.pillOn : s.pillOff]}
    >
      <Text style={[s.pillText, { color: on ? colors.white : colors.ink }]}>{label}</Text>
    </Pressable>
  );
}

export function OperatorChip({ operator }: { operator: Account['operator'] }) {
  const c = operatorColors[operator] ?? { bg: colors.track, fg: colors.ink };
  const short = OPERATORS.find((o) => o.id === operator)?.short ?? '?';
  return (
    <View style={[s.chip, { backgroundColor: c.bg }]}>
      <Text style={[s.chipText, { color: c.fg }]}>{short}</Text>
    </View>
  );
}

export function CurrencyBadge({ currency }: { currency: Currency }) {
  const usd = currency === 'USD';
  return (
    <View style={[s.badge, { backgroundColor: usd ? colors.ink : colors.greenSoft }]}>
      <Text style={[s.badgeText, { color: usd ? colors.white : colors.green }]}>{currency}</Text>
    </View>
  );
}

export function failureMessage(reason: FailureReason): string {
  switch (reason) {
    case 'INSUFFICIENT_FUNDS':
      return 'Solde insuffisant sur ce compte.';
    case 'INVALID_AMOUNT':
      return 'Montant invalide.';
    case 'UNKNOWN_ACCOUNT':
      return 'Compte introuvable.';
    case 'INVALID_QR':
      return "Ce code QR n'est pas valide.";
    case 'EXPIRED_QR':
      return 'Ce code QR a expiré : demandez-en un nouveau à la machine.';
    case 'QR_ALREADY_USED':
      return 'Ce code QR a déjà été utilisé.';
    case 'CURRENCY_MISMATCH':
      return 'Devise différente : payez depuis un compte dans la même devise (CDF ou USD).';
    case 'SELF_PAYMENT':
      return 'Ce QR est le vôtre : faites-le scanner par la personne qui paie.';
    case 'MACHINE_OFFLINE':
      return "La machine n'est pas connectée en ce moment. Vous n'avez pas été débité.";
    case 'MACHINE_BUSY':
      return 'La machine sert un autre client. Réessayez dans quelques secondes.';
    case 'OUT_OF_STOCK':
      return 'Ce produit est épuisé. Choisissez-en un autre.';
    case 'INVALID_CODE':
      return 'Code invalide, expiré ou déjà utilisé.';
    default:
      return "Connexion impossible. Réessayez dans un instant.";
  }
}

const s = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '800', color: colors.ink },
  label: { fontSize: 14, fontWeight: '800', color: colors.ink },
  muted: { fontSize: 13, color: colors.muted },
  error: { fontSize: 13, fontWeight: '600', color: colors.danger },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.card,
    padding: 14,
  },
  btn: { minHeight: 52, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnSolid: { backgroundColor: colors.green },
  btnOutline: { backgroundColor: colors.white, borderColor: colors.green, borderWidth: 2 },
  btnText: { fontSize: 16, fontWeight: '800' },
  pill: { minHeight: 44, borderRadius: radius.pill, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  pillOn: { backgroundColor: colors.green, borderColor: colors.green, borderWidth: 2 },
  pillOff: { backgroundColor: colors.white, borderColor: colors.lineStrong, borderWidth: 1 },
  pillText: { fontSize: 14, fontWeight: '600' },
  chip: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  chipText: { fontSize: 14, fontWeight: '800' },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, alignSelf: 'flex-start' },
  badgeText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
});
