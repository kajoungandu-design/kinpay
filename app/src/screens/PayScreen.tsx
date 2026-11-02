import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useWallet } from '../store/WalletContext';
import { parseMachineQr, DEMO_QR } from '../core/qr';
import { generateOtp, formatOtp, OTP_TTL_SECONDS } from '../core/otp';
import { formatCDF } from '../core/format';
import { Button, Card, ErrorText, Label, Muted, Pill, Title, failureMessage } from '../ui';
import { colors } from '../theme';
import type { MachineQr } from '../core/types';
import type { ResultInfo } from '../../App';

export function PayScreen({ onDone }: { onDone: (r: ResultInfo) => void }) {
  const { accounts, primary, setPrimary, payMachine, requestPaymentCode } = useWallet();
  const [mode, setMode] = useState<'scan' | 'otp'>('scan');
  const [machine, setMachine] = useState<MachineQr | null>(null);
  const [scanError, setScanError] = useState('');
  const [loading, setLoading] = useState(false);
  const [payError, setPayError] = useState('');
  const [pasted, setPasted] = useState('');
  const [permission, requestPermission] = useCameraPermissions();

  const handleScanned = useCallback((text: string) => {
    const parsed = parseMachineQr(text);
    if (!parsed) {
      setScanError("Ce code QR n'est pas un code de paiement reconnu.");
      return;
    }
    setScanError('');
    setMachine(parsed);
  }, []);

  async function pay() {
    if (!machine || !primary || loading) return;
    setLoading(true);
    setPayError('');
    const r = await payMachine({
      fromAccountId: primary.id,
      machineId: machine.machineId,
      item: machine.item,
      amount: machine.amount,
      qr: machine.qr,
    });
    setLoading(false);
    if (!r.ok) {
      setPayError(failureMessage(r.reason));
      return;
    }
    setMachine(null);
    onDone({
      title: 'Paiement réussi',
      detail: machine.item + ' : ' + formatCDF(machine.amount) + ' CDF, depuis ' + primary.label + '.',
      accountLabel: primary.label,
      balance: r.balance,
    });
  }

  const notEnough = !!machine && !!primary && primary.balance < machine.amount;

  return (
    <ScrollView contentContainerStyle={s.content}>
      <View>
        <Title>Payer</Title>
        <Muted>Par code QR ou code OTP</Muted>
      </View>

      <View style={s.tabs}>
        <Pill label="Scanner un QR" on={mode === 'scan'} onPress={() => setMode('scan')} />
        <Pill label="Mon code OTP" on={mode === 'otp'} onPress={() => setMode('otp')} />
      </View>

      <Label>Compte principal pour le paiement rapide</Label>
      <View style={s.tabs}>
        {accounts.map((a) => (
          <Pill key={a.id} label={a.label} on={primary?.id === a.id} onPress={() => setPrimary(a.id)} />
        ))}
      </View>

      {mode === 'scan' ? (
        machine ? (
          <>
            <Card style={{ gap: 6 }}>
              <Muted>Machine détectée : {machine.machineId}</Muted>
              <Text style={s.item}>{machine.item}</Text>
              <View style={s.row}>
                <Muted>À payer</Muted>
                <Text style={s.bold}>{formatCDF(machine.amount)} CDF</Text>
              </View>
            </Card>
            <Muted>
              Payer depuis : <Text style={s.bold}>{primary?.label}</Text> ({formatCDF(primary?.balance ?? 0)} CDF)
            </Muted>
            <ErrorText>{notEnough ? 'Solde insuffisant sur ' + primary?.label : payError}</ErrorText>
            <Button label={'Payer ' + formatCDF(machine.amount) + ' CDF'} onPress={pay} disabled={notEnough} loading={loading} />
            <Button label="Annuler" variant="outline" onPress={() => setMachine(null)} />
          </>
        ) : (
          <>
            {permission?.granted ? (
              <View style={s.camera}>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={({ data }) => handleScanned(data)}
                />
                <View pointerEvents="none" style={s.frame} />
              </View>
            ) : (
              <Card style={{ gap: 10 }}>
                <Text style={s.item}>Autoriser la caméra</Text>
                <Muted>La caméra sert uniquement à lire le code QR affiché par la machine.</Muted>
                <Button label="Autoriser la caméra" onPress={() => requestPermission()} />
              </Card>
            )}
            <Muted style={{ textAlign: 'center' }}>Placez le code QR de la machine dans le cadre</Muted>
            <ErrorText>{scanError}</ErrorText>
            {__DEV__ && (
              <Card style={{ gap: 10 }}>
                <Muted>Test (développement seulement)</Muted>
                {!requestPaymentCode && <Button label="Simuler un QR (mode hors-ligne)" variant="outline" onPress={() => handleScanned(DEMO_QR)} />}
                <TextInput
                  accessibilityLabel="Coller le contenu d'un QR"
                  style={s.devInput}
                  value={pasted}
                  onChangeText={setPasted}
                  placeholder="kinpay://pay?m=..."
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Button label="Utiliser ce QR" variant="outline" onPress={() => handleScanned(pasted)} disabled={!pasted.trim()} />
              </Card>
            )}
          </>
        )
      ) : (
        // key : un nouveau code est demandé quand on change de compte principal
        <OtpPanel key={primary?.id ?? 'none'} accountLabel={primary?.label ?? ''} accountId={primary?.id ?? ''} request={requestPaymentCode} />
      )}
    </ScrollView>
  );
}

type CodeRequest = ((accountId: string) => Promise<{ code: string; expiresInSeconds: number } | null>) | null;

function OtpPanel({ accountLabel, accountId, request }: { accountLabel: string; accountId: string; request: CodeRequest }) {
  // Avec un serveur : le code est émis par le serveur (usage unique, lié au compte).
  // Sans serveur (démonstration) : code généré sur le téléphone, non vérifiable.
  const [code, setCode] = useState(request ? '' : generateOtp());
  const [expiresAt, setExpiresAt] = useState(() => (request ? 0 : Date.now() + OTP_TTL_SECONDS * 1000));
  const [now, setNow] = useState(Date.now());
  const [err, setErr] = useState('');

  const renew = useCallback(async () => {
    if (!request) {
      setCode(generateOtp());
      setExpiresAt(Date.now() + OTP_TTL_SECONDS * 1000);
      setNow(Date.now());
      return;
    }
    const r = accountId ? await request(accountId) : null;
    if (!r) {
      setErr("Impossible d'obtenir un code. Vérifiez la connexion puis réessayez.");
      setCode('');
      return;
    }
    setErr('');
    setCode(r.code);
    setExpiresAt(Date.now() + r.expiresInSeconds * 1000);
    setNow(Date.now());
  }, [request, accountId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  useEffect(() => {
    if (left === 0 && !err) renew();
  }, [left, err, renew]);

  return (
    <>
      <Card style={s.otpCard}>
        <Muted>Votre code de paiement</Muted>
        <Text accessibilityLabel={code ? 'Code ' + code.split('').join(' ') : 'Code en cours de chargement'} style={s.otp}>
          {code ? formatOtp(code) : '------'}
        </Text>
        <View style={s.track}>
          <View style={[s.bar, { width: `${Math.round((left / OTP_TTL_SECONDS) * 100)}%` }]} />
        </View>
        <Muted>{code ? 'Expire dans ' + left + ' s, usage unique' : 'Chargement du code...'}</Muted>
      </Card>
      <ErrorText>{err}</ErrorText>
      <Text style={s.body}>
        Saisissez ce code sur la machine ou donnez-le au commerçant. Le paiement sera prélevé sur{' '}
        <Text style={s.bold}>{accountLabel}</Text>.
      </Text>
      <Button label="Générer un nouveau code" variant="outline" onPress={() => renew()} />
    </>
  );
}

const s = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  camera: { height: 280, borderRadius: 20, overflow: 'hidden', backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  frame: { width: 170, height: 170, borderWidth: 3, borderColor: colors.white, borderRadius: 16 },
  devInput: { minHeight: 48, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 12, paddingHorizontal: 14, fontSize: 14, backgroundColor: colors.white, color: colors.ink },
  item: { fontSize: 16, fontWeight: '800', color: colors.ink },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  bold: { fontSize: 14, fontWeight: '800', color: colors.ink },
  body: { fontSize: 14, lineHeight: 21, color: colors.ink },
  otpCard: { alignItems: 'center', gap: 10, paddingVertical: 24 },
  otp: { fontSize: 44, fontWeight: '800', letterSpacing: 6, color: colors.green },
  track: { width: '100%', height: 6, borderRadius: 3, backgroundColor: colors.track, overflow: 'hidden' },
  bar: { height: '100%', backgroundColor: colors.green },
});
