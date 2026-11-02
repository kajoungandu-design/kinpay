import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button, Muted } from '../ui';
import { formatCDF } from '../core/format';
import { colors } from '../theme';
import type { ResultInfo } from '../../App';

export function ResultScreen({ result, onClose }: { result: ResultInfo; onClose: () => void }) {
  return (
    <View style={s.wrap}>
      <View style={s.center}>
        <View style={s.badge}>
          <Ionicons name="checkmark" size={48} color={colors.white} />
        </View>
        <Text style={s.title}>{result.title}</Text>
        <Text style={s.detail}>{result.detail}</Text>
        <Muted>
          Nouveau solde {result.accountLabel} : {formatCDF(result.balance)} CDF
        </Muted>
        <Muted>Simulation : aucun argent réel n'a bougé</Muted>
      </View>
      <Button label="Retour à l'accueil" onPress={onClose} />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, padding: 20, gap: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  badge: { width: 88, height: 88, borderRadius: 44, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '800', color: colors.ink, textAlign: 'center' },
  detail: { fontSize: 15, lineHeight: 22, color: colors.ink, textAlign: 'center' },
});
