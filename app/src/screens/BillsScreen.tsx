import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useWallet } from '../store/WalletContext';
import { DEMO_BILLS } from '../config';
import { formatMoney } from '../core/format';
import { Button, Card, ErrorText, Muted, Title, UssdHint, failureMessage } from '../ui';
import { colors } from '../theme';
import { usePinConfirm } from '../pin';
import type { ResultInfo } from '../../App';

export function BillsScreen({ onDone }: { onDone: (r: ResultInfo) => void }) {
  const { accountFor, payBill } = useWallet();
  // Factures de démonstration en CDF : compte principal s'il est en CDF, sinon le premier compte CDF.
  const payer = accountFor('CDF');
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const { confirm, pinModal } = usePinConfirm();

  async function pay(b: (typeof DEMO_BILLS)[number]) {
    if (!payer || busyId) return;
    if (!(await confirm('Payer ' + b.biller + ' : ' + formatMoney(b.amount, 'CDF') + ' depuis ' + payer.label + ' CDF.'))) return;
    setBusyId(b.id);
    setError('');
    const r = await payBill({ fromAccountId: payer.id, biller: b.biller, reference: b.reference, amount: b.amount });
    setBusyId('');
    if (!r.ok) {
      setError(failureMessage(r.reason));
      return;
    }
    onDone({
      title: 'Facture payée',
      detail: b.biller + ' : ' + formatMoney(b.amount, 'CDF') + ', depuis ' + payer.label + '.',
      accountLabel: payer.label + ' CDF',
      balance: r.balance,
      currency: 'CDF',
    });
  }

  return (
    <ScrollView contentContainerStyle={s.content}>
      <View>
        <Title>Factures</Title>
        <Muted>Eau, électricité, abonnements</Muted>
      </View>
      {payer ? (
        <Muted>
          Payer depuis : <Text style={s.bold}>{payer.label} CDF</Text> ({formatMoney(payer.balance, 'CDF')})
        </Muted>
      ) : (
        <ErrorText>Ajoutez un compte en francs (CDF) pour payer ces factures.</ErrorText>
      )}
      <ErrorText>{error}</ErrorText>
      {DEMO_BILLS.map((b) => {
        const notEnough = !!payer && payer.balance < b.amount;
        return (
          <Card key={b.id} style={s.row}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={s.name}>{b.biller}</Text>
              <Muted>Réf. {b.reference}</Muted>
              <Text style={s.bold}>{formatMoney(b.amount, 'CDF')}</Text>
              {notEnough && <ErrorText>{'Solde insuffisant sur ' + payer?.label}</ErrorText>}
            </View>
            <View style={{ width: 110 }}>
              <Button label="Payer" onPress={() => pay(b)} disabled={!payer || notEnough || (!!busyId && busyId !== b.id)} loading={busyId === b.id} />
              <UssdHint show={busyId === b.id} operator={payer?.operator} />
            </View>
          </Card>
        );
      })}
      <Muted style={{ textAlign: 'center' }}>Montants et références de démonstration</Muted>
      {pinModal}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  bold: { fontSize: 14, fontWeight: '800', color: colors.ink },
});
