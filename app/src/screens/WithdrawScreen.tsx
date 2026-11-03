import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import { useAuth } from '../store/AuthContext';
import { useWallet } from '../store/WalletContext';
import { cleanAmountInput, formatMoney, parseAmount } from '../core/format';
import { withdrawalQr } from '../core/qr';
import { Button, Card, ErrorText, Label, Muted, Pill, Title, failureMessage } from '../ui';
import { colors } from '../theme';
import { usePinConfirm } from '../pin';
import type { NewWithdrawal } from '../core/api';
import type { Withdrawal } from '../core/types';

// Montants rapides (francs CDF, cents USD).
const QUICK = { CDF: [10000, 20000, 50000, 100000], USD: [1000, 2000, 5000, 10000] };
// Le serveur ne garde que l'empreinte du code : on le garde en mémoire tant que l'application est ouverte.
// Par utilisateur : un autre compte connecté sur le même téléphone ne voit pas ce code.
const shown = new Map<string, NewWithdrawal>();

const spaced = (code: string) => code.slice(0, 4) + ' ' + code.slice(4);

export function WithdrawScreen({ onBack }: { onBack: () => void }) {
  const { api, session } = useAuth();
  const userId = session?.user.id ?? '';
  const { accounts, primary, refresh } = useWallet();
  const [accountId, setAccountId] = useState(primary?.id ?? accounts[0]?.id ?? '');
  const [text, setText] = useState('');
  const [current, setCurrent] = useState<NewWithdrawal | null>(shown.get(userId) ?? null);
  const [status, setStatus] = useState<Withdrawal | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const { confirm, pinModal } = usePinConfirm();

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const currency = account?.currency ?? 'CDF';
  const amount = parseAmount(text, currency);

  // Statut en direct : en attente → effectué (agent ou DAB).
  useEffect(() => {
    if (!api || !current) return;
    let stop = false;
    const tick = async () => {
      try {
        const w = await api.currentWithdrawal();
        if (stop) return;
        if (w && w.id === current.id) {
          setStatus(w);
          if (w.status === 'done') refresh();
        }
      } catch {
        // réseau coupé : nouvel essai dans 2 s
      }
    };
    tick();
    const t = setInterval(() => {
      setNow(Date.now());
      tick();
    }, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [api, current, refresh]);

  if (!api) {
    return (
      <View style={s.content}>
        <Title>Retirer</Title>
        <Muted>Disponible quand l'application est connectée au serveur KinPay.</Muted>
      </View>
    );
  }

  async function create() {
    if (!api || !account || amount === null || loading) return;
    if (!(await confirm('Retirer ' + formatMoney(amount, currency) + ' en espèces depuis ' + account.label + ' ' + currency + '.'))) return;
    setLoading(true);
    setError('');
    const r = await api.createWithdrawal(account.id, amount);
    setLoading(false);
    if (!r.ok) {
      setError(failureMessage(r.reason));
      return;
    }
    shown.set(userId, r);
    setStatus(null);
    setCurrent(r);
  }

  async function cancel() {
    await api?.cancelWithdrawal();
    shown.delete(userId);
    setCurrent(null);
    setStatus(null);
  }

  function newOne() {
    shown.delete(userId);
    setCurrent(null);
    setStatus(null);
    setText('');
  }

  if (current) {
    const st = status?.status ?? 'pending';
    const left = Math.max(0, Math.ceil((current.expiresAt - now) / 1000));
    if (st === 'done') {
      return (
        <ScrollView contentContainerStyle={s.content}>
          <Card style={s.center}>
            <Ionicons name="checkmark-circle" size={64} color={colors.green} />
            <Text style={s.big}>Retrait effectué</Text>
            <Text style={s.amount}>{formatMoney(current.amount, current.currency)}</Text>
            <Muted style={{ textAlign: 'center' }}>{status?.servedBy ? 'Servi par ' + status.servedBy + '.' : ''} Vérifiez les billets avant de partir.</Muted>
          </Card>
          <Button label="Terminé" onPress={() => { newOne(); onBack(); }} />
        </ScrollView>
      );
    }
    const over = st === 'expired' || st === 'cancelled' || st === 'failed' || left === 0;
    return (
      <ScrollView contentContainerStyle={s.content}>
        <View>
          <Title>Retrait en espèces</Title>
          <Muted>{formatMoney(current.amount, current.currency)}</Muted>
        </View>
        {over ? (
          <Card style={s.center}>
            <Ionicons name="close-circle" size={56} color={colors.danger} />
            <Text style={s.big}>{st === 'failed' ? 'Retrait refusé' : st === 'cancelled' ? 'Retrait annulé' : 'Code expiré'}</Text>
            <Muted style={{ textAlign: 'center' }}>{st === 'failed' && status?.failure === 'INSUFFICIENT_FUNDS' ? 'Solde insuffisant au moment du retrait.' : "Aucun argent n'a été retiré. Créez un nouveau code."}</Muted>
            <Button label="Nouveau retrait" onPress={newOne} />
          </Card>
        ) : (
          <>
            <Card style={s.center}>
              <Muted>Code de retrait</Muted>
              <Text accessibilityLabel={'Code ' + current.code.split('').join(' ')} style={s.code}>
                {spaced(current.code)}
              </Text>
              <View style={s.qr}>
                <QRCode value={withdrawalQr(current.code)} size={180} />
              </View>
              <Muted>{st === 'processing' ? 'Retrait en cours…' : 'Expire dans ' + Math.floor(left / 60) + ' min ' + String(left % 60).padStart(2, '0') + ' s · usage unique'}</Muted>
            </Card>
            <Text style={s.body}>
              Montrez ce code (ou son QR) à un <Text style={s.bold}>agent KinPay agréé</Text>, ou saisissez-le au <Text style={s.bold}>distributeur de billets</Text>. Votre compte
              n'est débité qu'au moment où l'argent vous est remis.
            </Text>
            <Muted>Ne donnez jamais ce code par téléphone ou par SMS.</Muted>
            {__DEV__ && <Button label="Copier le code (test)" variant="outline" onPress={() => Clipboard.setStringAsync(current.code)} />}
            <Button label="Annuler le retrait" variant="outline" onPress={cancel} />
          </>
        )}
        {pinModal}
      </ScrollView>
    );
  }

  const notEnough = !!account && amount !== null && account.balance < amount;
  return (
    <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <View>
        <Title>Retirer des espèces</Title>
        <Muted>Chez un agent agréé ou à un distributeur de billets</Muted>
      </View>
      <Label>Depuis le compte</Label>
      <View style={s.row}>
        {accounts.map((a) => (
          <Pill key={a.id} label={a.label + ' ' + a.currency} on={a.id === accountId} onPress={() => { setAccountId(a.id); setText(''); }} />
        ))}
      </View>
      {account && <Muted>{'Solde : ' + formatMoney(account.balance, currency)}</Muted>}
      <Label>Montant</Label>
      <View style={s.row}>
        {QUICK[currency].map((v) => (
          <Pill key={v} label={formatMoney(v, currency)} on={amount === v} onPress={() => setText(currency === 'USD' ? (v / 100).toFixed(2).replace('.', ',') : String(v))} />
        ))}
      </View>
      <TextInput
        accessibilityLabel="Montant à retirer"
        style={s.input}
        value={text}
        onChangeText={(t) => setText(cleanAmountInput(t, currency))}
        keyboardType={currency === 'USD' ? 'decimal-pad' : 'number-pad'}
        placeholder={currency === 'USD' ? '20,00' : '20000'}
        placeholderTextColor={colors.muted}
      />
      <ErrorText>{notEnough ? 'Solde insuffisant sur ' + account?.label : error}</ErrorText>
      <Button label={amount ? 'Obtenir un code pour ' + formatMoney(amount, currency) : 'Obtenir un code de retrait'} onPress={create} disabled={!account || !amount || notEnough} loading={loading} />
      <Button label="Retour" variant="outline" onPress={onBack} />
      {pinModal}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  center: { alignItems: 'center', gap: 10, paddingVertical: 24 },
  code: { fontSize: 40, fontWeight: '800', letterSpacing: 4, color: colors.green },
  qr: { padding: 12, backgroundColor: colors.white, borderRadius: 12 },
  big: { fontSize: 22, fontWeight: '800', color: colors.ink },
  amount: { fontSize: 30, fontWeight: '800', color: colors.green },
  body: { fontSize: 14, lineHeight: 21, color: colors.ink },
  bold: { fontWeight: '800' },
  input: { minHeight: 52, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 12, paddingHorizontal: 14, fontSize: 20, fontWeight: '700', backgroundColor: colors.white, color: colors.ink },
});
