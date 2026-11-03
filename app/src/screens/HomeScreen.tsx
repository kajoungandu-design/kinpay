import React, { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useWallet } from '../store/WalletContext';
import { formatMoney, relativeTime } from '../core/format';
import { normalizePhone, OPERATORS } from '../core/phone';
import { Button, Card, CurrencyBadge, ErrorText, Label, Muted, OperatorChip, Pill, Title } from '../ui';
import { colors } from '../theme';
import { isCredit, type Currency, type OperatorId } from '../core/types';

export type Tab = 'home' | 'send' | 'pay' | 'receive' | 'bills' | 'withdraw';

export function HomeScreen({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  const { accounts, primary, totals, history, setPrimary, error, linkAccount, logout, refresh } = useWallet();
  const [refreshing, setRefreshing] = useState(false);

  async function onRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  return (
    <ScrollView
      contentContainerStyle={s.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.green]} tintColor={colors.green} />}
    >
      <View>
        <Muted>Bonjour</Muted>
        <Title>Mon portefeuille</Title>
      </View>
      <ErrorText>{error}</ErrorText>

      <View style={s.hero}>
        <Text style={s.heroSmall}>Solde total, tous comptes</Text>
        <Text style={s.heroAmount}>{formatMoney(totals.CDF, 'CDF')}</Text>
        <Text style={s.heroUsd}>{formatMoney(totals.USD, 'USD')}</Text>
        <Text style={s.heroSmall}>{accounts.length} comptes Mobile Money liés</Text>
      </View>

      {primary && (
        <Pressable accessibilityRole="button" onPress={() => onNavigate('pay')} style={s.quick}>
          <Text style={s.quickText}>
            Paiement rapide avec <Text style={s.quickStrong}>{primary.label}</Text>
          </Text>
          <Ionicons name="arrow-forward" size={22} color={colors.green} />
        </Pressable>
      )}

      <View style={s.actions}>
        <Action icon="arrow-forward" label="Envoyer" onPress={() => onNavigate('send')} />
        <Action icon="scan" label="Payer" onPress={() => onNavigate('pay')} />
        <Action icon="qr-code-outline" label="Encaisser" onPress={() => onNavigate('receive')} />
        <Action icon="receipt-outline" label="Factures" onPress={() => onNavigate('bills')} />
        <Action icon="cash-outline" label="Retirer" onPress={() => onNavigate('withdraw')} />
      </View>

      <View style={{ gap: 4 }}>
        <Label>Mes comptes</Label>
        <Muted>Le compte principal sert au paiement rapide : QR, code OTP et factures.</Muted>
      </View>
      {accounts.map((a) => {
        const isPrimary = primary?.id === a.id;
        return (
          <Card key={a.id} style={s.accountRow}>
            <OperatorChip operator={a.operator} />
            <View style={{ flex: 1 }}>
              <View style={s.nameRow}>
                <Text style={s.accountName}>{a.label}</Text>
                <CurrencyBadge currency={a.currency} />
              </View>
              <Muted>{a.phone}</Muted>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 6 }}>
              <Text style={s.accountBalance}>{formatMoney(a.balance, a.currency)}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isPrimary ? a.label + ' ' + a.currency + ' est le compte principal' : 'Définir ' + a.label + ' ' + a.currency + ' comme compte principal'}
                onPress={() => setPrimary(a.id)}
                style={[s.primaryBtn, isPrimary ? s.primaryOn : s.primaryOff]}
              >
                <Text style={[s.primaryText, { color: isPrimary ? colors.white : colors.green }]}>
                  {isPrimary ? 'Principal' : 'Choisir'}
                </Text>
              </Pressable>
            </View>
          </Card>
        );
      })}

      {accounts.length === 0 && !error && <Muted>Ajoutez votre premier compte Mobile Money pour commencer.</Muted>}
      {linkAccount && <AddAccount onLink={linkAccount} />}

      <Label>Activité récente</Label>
      <Card style={{ padding: 0 }}>
        {history.length === 0 ? (
          <View style={{ padding: 14 }}>
            <Muted>Aucune opération pour le moment.</Muted>
          </View>
        ) : (
          history.slice(0, 6).map((t, i) => (
            <View key={t.id} style={[s.txRow, i > 0 && s.txBorder]}>
              <View style={{ flex: 1 }}>
                <Text style={s.txLabel}>{t.label}</Text>
                <Muted>{relativeTime(t.at)}</Muted>
              </View>
              <Text style={[s.txAmount, isCredit(t.kind) && { color: colors.green }]}>
                {isCredit(t.kind) ? '+ ' : '- '}
                {formatMoney(t.amount, t.currency ?? 'CDF')}
              </Text>
            </View>
          ))
        )}
      </Card>
      <Muted style={{ textAlign: 'center' }}>Version de démonstration : aucun argent réel</Muted>
      {logout && <Button label="Se déconnecter" variant="outline" onPress={logout} />}
    </ScrollView>
  );
}

function AddAccount({ onLink }: { onLink: (operator: OperatorId, phone: string, currency: Currency) => Promise<string | null> }) {
  const [operator, setOperator] = useState<OperatorId>('orange');
  const [currency, setCurrency] = useState<Currency>('CDF');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const normalized = normalizePhone(phone);

  async function submit() {
    if (!normalized || loading) return;
    setLoading(true);
    setError('');
    const err = await onLink(operator, phone, currency);
    setLoading(false);
    if (err) setError(err);
    else setPhone('');
  }

  return (
    <Card style={{ gap: 12 }}>
      <Label>Ajouter un compte Mobile Money</Label>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {OPERATORS.map((o) => (
          <Pill key={o.id} label={o.name} on={operator === o.id} onPress={() => setOperator(o.id)} />
        ))}
      </View>
      <Muted>Chaque opérateur peut avoir un compte en francs (CDF) et un compte en dollars (USD).</Muted>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pill label="Francs (CDF)" on={currency === 'CDF'} onPress={() => setCurrency('CDF')} />
        <Pill label="Dollars (USD)" on={currency === 'USD'} onPress={() => setCurrency('USD')} />
      </View>
      <TextInput
        accessibilityLabel="Numéro du compte Mobile Money"
        style={s.input}
        value={phone}
        onChangeText={(t) => setPhone(t.replace(/[^0-9+ ]/g, ''))}
        keyboardType="phone-pad"
        placeholder="+243 8_ ___ ____"
        placeholderTextColor={colors.muted}
      />
      <ErrorText>{error}</ErrorText>
      <Button label={'Ajouter le compte ' + currency} onPress={submit} disabled={!normalized} loading={loading} />
    </Card>
  );
}

function Action({ icon, label, onPress }: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={s.action}>
      <Ionicons name={icon} size={24} color={colors.green} />
      <Text style={s.actionText}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  content: { padding: 20, gap: 16 },
  hero: { backgroundColor: colors.green, borderRadius: 20, padding: 20, gap: 6 },
  heroSmall: { color: colors.white, fontSize: 13, opacity: 0.9 },
  heroAmount: { color: colors.white, fontSize: 32, fontWeight: '800' },
  heroUsd: { color: colors.white, fontSize: 22, fontWeight: '800' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  quick: {
    minHeight: 56,
    backgroundColor: colors.white,
    borderColor: colors.green,
    borderWidth: 2,
    borderRadius: 16,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  quickText: { fontSize: 14, fontWeight: '600', color: colors.ink },
  quickStrong: { fontWeight: '800', color: colors.green },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  action: {
    flexGrow: 1,
    flexBasis: '30%',
    minHeight: 76,
    backgroundColor: colors.white,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  actionText: { fontSize: 13, fontWeight: '600', color: colors.ink },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  accountName: { fontSize: 15, fontWeight: '600', color: colors.ink },
  accountBalance: { fontSize: 15, fontWeight: '800', color: colors.ink },
  primaryBtn: { minHeight: 44, paddingHorizontal: 14, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  primaryOn: { backgroundColor: colors.green, borderColor: colors.green, borderWidth: 2 },
  primaryOff: { backgroundColor: colors.white, borderColor: colors.green, borderWidth: 1 },
  primaryText: { fontSize: 12, fontWeight: '800' },
  txRow: { padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  txBorder: { borderTopWidth: 1, borderTopColor: '#EEEBE3' },
  txLabel: { fontSize: 14, fontWeight: '600', color: colors.ink },
  txAmount: { fontSize: 14, fontWeight: '800', color: colors.ink },
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
});
