import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useWallet } from '../store/WalletContext';
import { detectOperator, normalizePhone, operatorName } from '../core/phone';
import { cleanAmountInput, formatAmount, formatMoney, parseAmount } from '../core/format';
import { Button, Card, CurrencyBadge, ErrorText, Label, Muted, OperatorChip, Pill, Title, failureMessage } from '../ui';
import { colors } from '../theme';
import { usePinConfirm } from '../pin';
import type { ResultInfo } from '../../App';

// Montants rapides en unités entières : francs pour CDF, cents pour USD (5,00 / 10,00 / 20,00 / 50,00).
const QUICK_AMOUNTS = { CDF: [5000, 10000, 25000, 50000], USD: [500, 1000, 2000, 5000] };

export function SendScreen({ onDone }: { onDone: (r: ResultInfo) => void }) {
  const { accounts, primary, send } = useWallet();
  const [fromId, setFromId] = useState(primary?.id ?? '');
  const [phone, setPhone] = useState('');
  const [amountText, setAmountText] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState('');
  const { confirm, pinModal } = usePinConfirm();

  useEffect(() => {
    if (!fromId && primary) setFromId(primary.id);
  }, [fromId, primary]);

  const from = accounts.find((a) => a.id === fromId);
  const currency = from?.currency ?? 'CDF';
  const normalized = normalizePhone(phone);
  const operator = detectOperator(phone);
  const amount = parseAmount(amountText, currency) ?? 0;

  let hint = '';
  if (!normalized) hint = phone.trim() === '' ? 'Saisissez le numéro du bénéficiaire.' : 'Numéro invalide : 9 chiffres après +243.';
  else if (amount <= 0) hint = 'Saisissez un montant.';
  else if (from && amount > from.balance) hint = 'Solde insuffisant sur ' + from.label + ' (' + formatMoney(from.balance, from.currency) + ').';
  const canSend = hint === '' && !!from && !loading;

  async function submit() {
    if (!canSend || !from || !normalized) return;
    if (!(await confirm('Envoyer ' + formatMoney(amount, currency) + ' à ' + normalized + ' depuis ' + from.label + ' ' + currency + '.'))) return;
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
      detail: formatMoney(amount, currency) + ' de ' + from.label + ' vers ' + normalized + '.',
      accountLabel: from.label + ' ' + currency,
      balance: r.balance,
      currency,
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
            onPress={() => {
              if (a.currency !== currency) setAmountText('');
              setFromId(a.id);
            }}
            style={[s.acc, a.id === fromId ? s.accOn : s.accOff]}
          >
            <OperatorChip operator={a.operator} />
            <View style={{ flex: 1 }}>
              <View style={s.nameRow}>
                <Text style={s.accName}>{a.label}</Text>
                <CurrencyBadge currency={a.currency} />
              </View>
              <Muted>{formatMoney(a.balance, a.currency)} disponibles</Muted>
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

        <Label>{'Montant (' + currency + ')'}</Label>
        <Muted>{'Le bénéficiaire reçoit sur son compte ' + currency + ' : pas de conversion entre CDF et USD.'}</Muted>
        <TextInput
          accessibilityLabel={currency === 'USD' ? 'Montant en dollars' : 'Montant en francs congolais'}
          style={s.input}
          value={amountText}
          onChangeText={(t) => setAmountText(cleanAmountInput(t, currency))}
          keyboardType={currency === 'USD' ? 'decimal-pad' : 'number-pad'}
          placeholder={currency === 'USD' ? 'Ex. 12,50' : 'Saisissez un montant'}
          placeholderTextColor={colors.muted}
        />
        <View style={s.quickRow}>
          {QUICK_AMOUNTS[currency].map((n) => (
            <Pill key={n} label={formatAmount(n, currency)} on={amount === n} onPress={() => setAmountText(formatAmount(n, currency).replace(/\s/g, ''))} />
          ))}
        </View>

        <Card style={{ gap: 6 }}>
          <View style={s.row}>
            <Muted>Montant</Muted>
            <Text style={s.bold}>{formatMoney(amount, currency)}</Text>
          </View>
          <View style={s.row}>
            <Muted>Frais</Muted>
            <Text style={s.bold}>[À confirmer avec l'opérateur]</Text>
          </View>
        </Card>

        <ErrorText>{serverError || hint}</ErrorText>
        <Button label={'Envoyer ' + formatMoney(amount, currency)} onPress={submit} disabled={!canSend} loading={loading} />
      </ScrollView>
      {pinModal}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  acc: { minHeight: 64, backgroundColor: colors.white, borderRadius: 16, padding: 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  accOn: { borderColor: colors.green, borderWidth: 2 },
  accOff: { borderColor: colors.line, borderWidth: 1 },
  accName: { fontSize: 14, fontWeight: '600', color: colors.ink },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
