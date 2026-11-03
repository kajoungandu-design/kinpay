import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

// Mêmes couleurs que l'application client, avec un en-tête foncé pour distinguer l'application agent.
export const colors = {
  bg: '#F5F3EE',
  card: '#FFFFFF',
  line: '#DAD6CC',
  lineStrong: '#B9B4A8',
  ink: '#15231D',
  muted: '#5B6B63',
  green: '#0F6B4F',
  greenSoft: '#E7F1EC',
  danger: '#A83A2B',
  white: '#FFFFFF',
};

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
export function Button({ label, onPress, disabled, loading, variant = 'solid' }: { label: string; onPress: () => void; disabled?: boolean; loading?: boolean; variant?: 'solid' | 'outline' }) {
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
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress} style={[s.pill, on ? s.pillOn : s.pillOff]}>
      <Text style={[s.pillText, { color: on ? colors.white : colors.ink }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '800', color: colors.ink },
  label: { fontSize: 14, fontWeight: '800', color: colors.ink },
  muted: { fontSize: 13, color: colors.muted },
  error: { fontSize: 13, fontWeight: '600', color: colors.danger },
  card: { backgroundColor: colors.card, borderColor: colors.line, borderWidth: 1, borderRadius: 16, padding: 14 },
  btn: { minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnSolid: { backgroundColor: colors.green },
  btnOutline: { backgroundColor: colors.white, borderColor: colors.green, borderWidth: 2 },
  btnText: { fontSize: 16, fontWeight: '800' },
  pill: { minHeight: 44, borderRadius: 22, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  pillOn: { backgroundColor: colors.green, borderColor: colors.green, borderWidth: 2 },
  pillOff: { backgroundColor: colors.white, borderColor: colors.lineStrong, borderWidth: 1 },
  pillText: { fontSize: 14, fontWeight: '600' },
});
