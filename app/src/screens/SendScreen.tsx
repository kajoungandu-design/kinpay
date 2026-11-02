import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useWallet } from '../store/WalletContext';
import { detectOperator, normalizePhone, operatorName } from '../core/phone';
import { formatCDF } from '../core/format';
import { Button, Card, ErrorText, Label, Muted, OperatorChip, Pill, Title, failureMessage } from '../ui';
import { colors } from '../theme';
import type { ResultInfo } from '../../App';

const QUICK_AMOUNTS = [5000, 10000, 25000, 50000];

export function SendScreen({ onDone }: { onDone: (r: ResultInfo) => void }) {
  const { accounts, primary, send } = useWallet();
  const [fromId, setFromId] = useState(primary?.id ?? '');
  const [phone, setPhone] = useState('');
  const [amountText, setAmountText] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState('');

  useEffect(() => {
    if (!fromId && primary) setFromId(primary.id);
  }, [fromId, primary]);

  const from = accounts.find((a) => a.id === fromId);
  const normalized = normalizePhone(phone);
  const operator = detectOperator(phone);
  const amount = amountText === '' ? 0 : parseInt(amountText, 10);

  let hint = '';
  if (!normalized) hint = phone.trim() === '' ? 'Saisissez le numéro du bénéficiaire.' : 'Numéro invalide : 9 chiffres après +243.';
  else if (amount <= 0) hint = 'Saisissez un montant.';
  else if (from && amount > from.balance) hint = 'Solde insuffisant sur ' + from.label + ' (' + formatCDF(from.balance) + ' CDF).';
  const canSend = hint === '' && !!from && !loading;

  async function submit() {
    if (!canSend || !from || !normalized) return;
    setLoading(true);
    setServerError('');
    const r = await send({ fromAccountId: from.id, toPhone: normalized, amount });
    setLoading(false);
    if (!r.ok) {
      setServerError(failureMessage(r.reason));
      return;
    }
    setPhone('');
    setAmountText('');
    onDone({
      title: 'Transfert envoyé',
      detail: formatCDF(amount) + ' CDF de ' + from.label + ' vers ' + normalized + '.',
      accountLabel: from.label,
      balance: r.balance,
    });
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <View>
          <Title>Envoyer de l'argent</Title>
          <Muted>Entre vos comptes ou vers un autre opérateur</Muted>
        </View>

        <Label>Depuis quel compte ?</Label>
        {accounts.map((a) => (
          <Pressable
            key={a.id}
            accessibilityRole="button"
            accessibilityState={{ selected: a.id === fromId }}
            onPress={() => setFromId(a.id)}
            style={[s.acc, a.id === fromId ? s.accOn : s.accOff]}
          >
            <OperatorChip operator={a.operator} />
            <View style={{ flex: 1 }}>
              <Text style={s.accName}>{a.label}</Text>
              <Muted>{formatCDF(a.balance)} CDF disponibles</Muted>
            </View>
          </Pressable>
        ))}

        <Label>Numéro du bénéficiaire</Label>
        <TextInput
          accessibilityLabel="Numéro du bénéficiaire"
          style={s.input}
          value={phone}
          onChangeText={(t) => setPhone(t.replace(/[^0-9+ ]/g, ''))}
          keyboardType="phone-pad"
          placeholder="+243 8_ ___ ____"
          placeholderTextColor={colors.muted}
          autoComplete="tel"
        />
        {normalized && (
          <Muted>
            {operator ? 'Opérateur détecté : ' + operatorName(operator) : 'Opérateur non reconnu : vérifiez le numéro.'}
          </Muted>
        )}

        <Label>Montant (CDF)</Label>
        <TextInput
          accessibilityLabel="Montant en francs congolais"
          style={s.input}
          value={amountText}
          onChangeText={(t) => setAmountText(t.replace(/\D/g, '').slice(0, 9))}
          keyboardType="number-pad"
          placeholder="Saisissez un montant"
          placeholderTextColor={colors.muted}
        />
        <View style={s.quickRow}>
          {QUICK_AMOUNTS.map((n) => (
            <Pill key={n} label={formatCDF(n)} on={amount === n} onPress={() => setAmountText(String(n))} />
          ))}
        </View>

        <Card style={{ gap: 6 }}>
          <View style={s.row}>
            <Muted>Montant</Muted>
            <Text style={s.bold}>{formatCDF(amount)} CDF</Text>
          </View>
          <View style={s.row}>
            <Muted>Frais</Muted>
            <Text style={s.bold}>[À confirmer avec l'opérateur]</Text>
          </View>
        </Card>

        <ErrorText>{serverError || hint}</ErrorText>
        <Button label={'Envoyer ' + formatCDF(amount) + ' CDF'} onPress={submit} disabled={!canSend} loading={loading} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  acc: { minHeight: 64, backgroundColor: colors.white, borderRadius: 16, padding: 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  accOn: { borderColor: colors.green, borderWidth: 2 },
  accOff: { borderColor: colors.line, borderWidth: 1 },
  accName: { fontSize: 14, fontWeight: '600', color: colors.ink },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 16,
    backgroundColor: colors.white,
    color: colors.ink,
  },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  bold: { fontSize: 13, fontWeight: '600', color: colors.ink, textAlign: 'right', flexShrink: 1 },
});
