import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useWallet } from '../store/WalletContext';
import { DEMO_BILLS } from '../config';
import { formatCDF } from '../core/format';
import { Button, Card, ErrorText, Muted, Title, failureMessage } from '../ui';
import { colors } from '../theme';
import type { ResultInfo } from '../../App';

export function BillsScreen({ onDone }: { onDone: (r: ResultInfo) => void }) {
  const { primary, payBill } = useWallet();
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');

  async function pay(b: (typeof DEMO_BILLS)[number]) {
    if (!primary || busyId) return;
    setBusyId(b.id);
    setError('');
    const r = await payBill({ fromAccountId: primary.id, biller: b.biller, reference: b.reference, amount: b.amount });
    setBusyId('');
    if (!r.ok) {
      setError(failureMessage(r.reason));
      return;
    }
    onDone({
      title: 'Facture payée',
      detail: b.biller + ' : ' + formatCDF(b.amount) + ' CDF, depuis ' + primary.label + '.',
      accountLabel: primary.label,
      balance: r.balance,
    });
  }

  return (
    <ScrollView contentContainerStyle={s.content}>
      <View>
        <Title>Factures</Title>
        <Muted>Eau, électricité, abonnements</Muted>
      </View>
      <Muted>
        Payer depuis : <Text style={s.bold}>{primary?.label}</Text> ({formatCDF(primary?.balance ?? 0)} CDF)
      </Muted>
      <ErrorText>{error}</ErrorText>
      {DEMO_BILLS.map((b) => {
        const notEnough = !!primary && primary.balance < b.amount;
        return (
          <Card key={b.id} style={s.row}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={s.name}>{b.biller}</Text>
              <Muted>Réf. {b.reference}</Muted>
              <Text style={s.bold}>{formatCDF(b.amount)} CDF</Text>
              {notEnough && <ErrorText>{'Solde insuffisant sur ' + primary?.label}</ErrorText>}
            </View>
            <View style={{ width: 110 }}>
              <Button label="Payer" onPress={() => pay(b)} disabled={notEnough || (!!busyId && busyId !== b.id)} loading={busyId === b.id} />
            </View>
          </Card>
        );
      })}
      <Muted style={{ textAlign: 'center' }}>Montants et références de démonstration</Muted>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  bold: { fontSize: 14, fontWeight: '800', color: colors.ink },
});
