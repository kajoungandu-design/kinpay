import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as SecureStore from 'expo-secure-store';
// Code partagé avec l'application client (voir metro.config.js).
import { ApiClient, ApiError, type Session, type ServedWithdrawal, type WithdrawalLookup } from '../app/src/core/api';
import { formatMoney } from '../app/src/core/format';
import { normalizePhone } from '../app/src/core/phone';
import { parseWithdrawalQr } from '../app/src/core/qr';
import type { Account } from '../app/src/core/types';
import { API_URL } from './src/config';
import { Button, Card, ErrorText, Label, Muted, Pill, Title, colors } from './src/ui';

const SESSION_KEY = 'kinpay.agent.session';

export default function App() {
  const tokenRef = useRef<string | null>(null);
  const api = useMemo(() => (API_URL ? new ApiClient(API_URL, () => tokenRef.current) : null), []);
  const [session, setSessionState] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync(SESSION_KEY);
        const s = raw ? (JSON.parse(raw) as Session) : null;
        if (s?.token && s.user?.isAgent) {
          tokenRef.current = s.token;
          setSessionState(s);
        }
      } catch {
        // pas de session sauvegardée
      }
      setLoading(false);
    })();
  }, []);

  const setSession = useCallback((s: Session | null) => {
    tokenRef.current = s?.token ?? null;
    setSessionState(s);
    if (s) SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(s)).catch(() => {});
    else SecureStore.deleteItemAsync(SESSION_KEY).catch(() => {});
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }} edges={['top', 'bottom']}>
        <View style={s.header}>
          <Ionicons name="storefront-outline" size={22} color={colors.white} />
          <Text style={s.headerText}>KinPay Agent</Text>
          {session && <Text style={s.headerPhone}>{session.user.phone}</Text>}
        </View>
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          {!api ? (
            <View style={s.content}>
              <ErrorText>Adresse du serveur inconnue : créez le fichier agent/.env avec EXPO_PUBLIC_API_URL=auto.</ErrorText>
            </View>
          ) : loading ? (
            <View style={s.center}>
              <ActivityIndicator size="large" color={colors.green} />
            </View>
          ) : session ? (
            <Main api={api} onLogout={() => setSession(null)} />
          ) : (
            <Login api={api} onSession={setSession} />
          )}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Login({ api, onSession }: { api: ApiClient; onSession: (s: Session) => void }) {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const sess = await api.login(phone, pin);
      if (!sess.user.isAgent) {
        setError("Ce compte KinPay n'est pas un agent agréé. L'activation se fait sur le serveur : npm run agent -- " + (normalizePhone(phone) ?? phone));
        return;
      }
      onSession(sess);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setError(code === 'INVALID_CREDENTIALS' ? 'Numéro ou code PIN incorrect.' : code === 'LOCKED' ? "Trop d'essais. Réessayez dans 15 minutes." : 'Connexion impossible. Le serveur est-il lancé ?');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <Title>Connexion agent</Title>
      <Muted>Utilisez le même numéro et le même code PIN que dans l'application KinPay. Votre compte doit être activé comme agent agréé.</Muted>
      <TextInput accessibilityLabel="Numéro" style={s.input} value={phone} onChangeText={(t) => setPhone(t.replace(/[^0-9+ ]/g, ''))} keyboardType="phone-pad" placeholder="+243 8_ ___ ____" placeholderTextColor={colors.muted} />
      <TextInput accessibilityLabel="Code PIN" style={s.input} value={pin} onChangeText={(t) => setPin(t.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" secureTextEntry placeholder="Code PIN" placeholderTextColor={colors.muted} />
      <ErrorText>{error}</ErrorText>
      <Button label="Se connecter" onPress={submit} disabled={!normalizePhone(phone) || pin.length < 4} loading={busy} />
    </ScrollView>
  );
}

function Main({ api, onLogout }: { api: ApiClient; onLogout: () => void }) {
  const [tab, setTab] = useState<'withdraw' | 'history'>('withdraw');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [served, setServed] = useState<ServedWithdrawal[]>([]);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const r = await api.request('GET', '/accounts');
      if (r.status === 401) return onLogout();
      setAccounts(r.json as Account[]);
      setServed(await api.agentHistory());
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setError("Ce compte n'est plus agent agréé.");
        return;
      }
      setError('Connexion impossible. Vérifiez la connexion.');
    }
  }, [api, onLogout]);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>{tab === 'withdraw' ? <WithdrawDesk api={api} accounts={accounts} onDone={reload} /> : <History accounts={accounts} served={served} error={error} onRefresh={reload} onLogout={onLogout} />}</View>
      <View style={s.bar}>
        {(
          [
            ['withdraw', 'Retrait client', 'cash-outline'],
            ['history', 'Soldes et historique', 'list-outline'],
          ] as const
        ).map(([id, label, icon]) => (
          <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: tab === id }} onPress={() => setTab(id)} style={s.tab}>
            <Ionicons name={icon} size={24} color={tab === id ? colors.green : colors.muted} />
            <Text style={[s.tabText, { color: tab === id ? colors.green : colors.muted }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function lookupMessage(reason: string, error?: string): string {
  if (error === 'NOT_AGENT') return "Ce compte n'est pas agent agréé.";
  if (error === 'TOO_MANY_ATTEMPTS') return 'Trop de codes faux : attendez une minute.';
  if (reason === 'INVALID_CODE') return 'Code invalide, expiré ou déjà utilisé.';
  if (reason === 'CURRENCY_MISMATCH') return 'Choisissez votre compte dans la devise du retrait.';
  if (reason === 'INSUFFICIENT_FUNDS') return 'Le client n\'a plus assez d\'argent sur son compte. Ne remettez rien.';
  if (reason === 'SELF_PAYMENT') return 'Vous ne pouvez pas servir votre propre retrait.';
  if (reason === 'UNKNOWN_ACCOUNT') return 'Compte agent introuvable.';
  return 'Connexion impossible. Réessayez.';
}

function WithdrawDesk({ api, accounts, onDone }: { api: ApiClient; accounts: Account[]; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [scan, setScan] = useState(false);
  const [found, setFound] = useState<WithdrawalLookup | null>(null);
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [paid, setPaid] = useState<(WithdrawalLookup & { balance: number }) | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const scanning = useRef(false);

  async function lookup(c: string) {
    if (busy || c.length !== 8) return;
    setBusy(true);
    setError('');
    const r = await api.agentLookup(c);
    setBusy(false);
    if (!r.ok) {
      setError(lookupMessage(r.reason, r.error));
      return;
    }
    setCode(c);
    setFound(r);
    setAccountId('');
  }

  function onScanned(text: string) {
    if (scanning.current) return;
    const c = parseWithdrawalQr(text);
    if (!c) {
      setError("Ce QR n'est pas un code de retrait KinPay.");
      return;
    }
    scanning.current = true;
    setScan(false);
    lookup(c).finally(() => {
      scanning.current = false;
    });
  }

  function reset() {
    setCode('');
    setFound(null);
    setPaid(null);
    setError('');
    setAccountId('');
  }

  if (paid) {
    return (
      <ScrollView contentContainerStyle={s.content}>
        <Card style={s.centerCard}>
          <Ionicons name="checkmark-circle" size={64} color={colors.green} />
          <Text style={s.big}>Remettez au client</Text>
          <Text style={s.amount}>{formatMoney(paid.amount, paid.currency)}</Text>
          <Muted>{'Client ' + paid.client}</Muted>
          <Muted>{'Votre compte ' + paid.currency + ' a été crédité. Nouveau solde : ' + formatMoney(paid.balance, paid.currency)}</Muted>
        </Card>
        <Button label="Retrait suivant" onPress={reset} />
      </ScrollView>
    );
  }

  if (found) {
    const options = accounts.filter((a) => a.currency === found.currency);
    const account = options.find((a) => a.id === accountId) ?? options[0] ?? null;
    const left = Math.max(0, Math.round((found.expiresAt - Date.now()) / 60000));
    const confirm = async () => {
      if (!account || busy) return;
      setBusy(true);
      setError('');
      const r = await api.agentConfirm(code, account.id);
      setBusy(false);
      if (!r.ok) {
        setError(lookupMessage(r.reason, r.error));
        return;
      }
      setPaid(r);
      onDone();
    };
    return (
      <ScrollView contentContainerStyle={s.content}>
        <Title>Retrait à servir</Title>
        <Card style={s.centerCard}>
          <Muted>Montant à remettre</Muted>
          <Text style={s.amount}>{formatMoney(found.amount, found.currency)}</Text>
          <Muted>{'Client ' + found.client + ' · code valable encore ' + left + ' min'}</Muted>
        </Card>
        <Muted>Vérifiez l'identité du client si le montant est important. Le client est débité et votre compte crédité au moment où vous confirmez.</Muted>
        <Label>Compte agent crédité</Label>
        {options.length === 0 ? (
          <ErrorText>{'Ajoutez un compte ' + found.currency + " dans l'application KinPay pour servir ce retrait."}</ErrorText>
        ) : (
          <View style={s.row}>
            {options.map((a) => (
              <Pill key={a.id} label={a.label + ' ' + a.currency} on={account?.id === a.id} onPress={() => setAccountId(a.id)} />
            ))}
          </View>
        )}
        <ErrorText>{error}</ErrorText>
        <Button label={'Confirmer et remettre ' + formatMoney(found.amount, found.currency)} onPress={confirm} disabled={!account} loading={busy} />
        <Button label="Annuler" variant="outline" onPress={reset} />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <Title>Retrait client</Title>
      <Muted>Saisissez le code à 8 chiffres affiché sur le téléphone du client, ou scannez son QR.</Muted>
      <TextInput
        accessibilityLabel="Code de retrait à 8 chiffres"
        style={[s.input, s.codeInput]}
        value={code}
        onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 8))}
        keyboardType="number-pad"
        placeholder="0000 0000"
        placeholderTextColor={colors.muted}
        maxLength={8}
      />
      <ErrorText>{error}</ErrorText>
      <Button label="Vérifier le code" onPress={() => lookup(code)} disabled={code.length !== 8} loading={busy} />
      {scan ? (
        permission?.granted ? (
          <View style={s.camera}>
            <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => onScanned(data)} />
            <View pointerEvents="none" style={s.frame} />
          </View>
        ) : (
          <Button label="Autoriser la caméra" onPress={() => requestPermission()} />
        )
      ) : null}
      <Button label={scan ? 'Fermer la caméra' : 'Scanner le QR du client'} variant="outline" onPress={() => setScan(!scan)} />
    </ScrollView>
  );
}

function History({ accounts, served, error, onRefresh, onLogout }: { accounts: Account[]; served: ServedWithdrawal[]; error: string; onRefresh: () => Promise<void>; onLogout: () => void }) {
  const [refreshing, setRefreshing] = useState(false);
  const totals = (cur: 'CDF' | 'USD') => served.filter((w) => w.currency === cur).reduce((n, w) => n + w.amount, 0);
  return (
    <ScrollView
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await onRefresh();
            setRefreshing(false);
          }}
          colors={[colors.green]}
        />
      }
    >
      <Title>Soldes</Title>
      <ErrorText>{error}</ErrorText>
      <Muted>Monnaie électronique reçue en échange du cash remis. Rechargez-la chez votre super-agent quand elle est trop haute.</Muted>
      {accounts.map((a) => (
        <Card key={a.id} style={s.rowBetween}>
          <View>
            <Text style={s.strong}>{a.label + ' ' + a.currency}</Text>
            <Muted>{a.phone}</Muted>
          </View>
          <Text style={s.strong}>{formatMoney(a.balance, a.currency)}</Text>
        </Card>
      ))}
      <Title>Retraits servis</Title>
      <Muted>{served.length + ' retraits · ' + formatMoney(totals('CDF'), 'CDF') + ' · ' + formatMoney(totals('USD'), 'USD')}</Muted>
      <Card style={{ padding: 0 }}>
        {served.length === 0 ? (
          <View style={{ padding: 14 }}>
            <Muted>Aucun retrait servi pour le moment.</Muted>
          </View>
        ) : (
          served.map((w, i) => (
            <View key={w.id} style={[s.txRow, i > 0 && s.txBorder]}>
              <View style={{ flex: 1 }}>
                <Text style={s.strong}>{'Client ' + w.client}</Text>
                <Muted>{new Date(w.at).toLocaleString('fr-FR')}</Muted>
              </View>
              <Text style={s.strong}>{formatMoney(w.amount, w.currency)}</Text>
            </View>
          ))
        )}
      </Card>
      <Button label="Se déconnecter" variant="outline" onPress={onLogout} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 12, backgroundColor: colors.ink },
  headerText: { color: colors.white, fontSize: 17, fontWeight: '800', flex: 1 },
  headerPhone: { color: colors.white, opacity: 0.8, fontSize: 13 },
  content: { padding: 20, gap: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  centerCard: { alignItems: 'center', gap: 8, paddingVertical: 24 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  input: { minHeight: 52, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 12, paddingHorizontal: 14, fontSize: 18, backgroundColor: colors.white, color: colors.ink },
  codeInput: { fontSize: 30, fontWeight: '800', letterSpacing: 6, textAlign: 'center' },
  camera: { height: 280, borderRadius: 20, overflow: 'hidden', backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  frame: { width: 170, height: 170, borderWidth: 3, borderColor: colors.white, borderRadius: 16 },
  big: { fontSize: 22, fontWeight: '800', color: colors.ink },
  amount: { fontSize: 36, fontWeight: '800', color: colors.green },
  strong: { fontSize: 15, fontWeight: '700', color: colors.ink },
  txRow: { padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  txBorder: { borderTopWidth: 1, borderTopColor: '#EEEBE3' },
  bar: { flexDirection: 'row', backgroundColor: colors.white, borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: 6 },
  tab: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 3 },
  tabText: { fontSize: 12, fontWeight: '600' },
});
