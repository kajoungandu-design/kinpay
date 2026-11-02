import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '../store/AuthContext';
import { ApiError } from '../core/api';
import { normalizePhone } from '../core/phone';
import { Button, ErrorText, Label, Muted, Pill, Title } from '../ui';
import { colors } from '../theme';

function authMessage(e: unknown): string {
  const code = e instanceof ApiError ? e.code : '';
  switch (code) {
    case 'INVALID_PHONE':
      return 'Numéro invalide : 9 chiffres après +243.';
    case 'INVALID_CODE':
      return 'Code incorrect ou expiré.';
    case 'INVALID_PIN':
      return 'Le code PIN doit contenir 4 à 6 chiffres.';
    case 'ALREADY_REGISTERED':
      return 'Ce numéro a déjà un compte : utilisez « Connexion ».';
    case 'INVALID_CREDENTIALS':
      return 'Numéro ou code PIN incorrect.';
    case 'LOCKED':
      return 'Trop d\'essais. Réessayez dans 15 minutes.';
    case 'TOO_MANY_REQUESTS':
      return 'Trop de demandes. Patientez quelques minutes.';
    default:
      return 'Connexion impossible. Vérifiez votre connexion et réessayez.';
  }
}

export function LoginScreen() {
  const { api, setSession } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const normalized = normalizePhone(phone);
  const pinOk = /^\d{4,6}$/.test(pin);

  async function guard(fn: () => Promise<void>) {
    if (!api || loading) return;
    setLoading(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(authMessage(e));
    } finally {
      setLoading(false);
    }
  }

  const sendCode = () =>
    guard(async () => {
      await api!.requestCode(phone);
      setCodeSent(true);
    });
  const register = () =>
    guard(async () => {
      setSession(await api!.register(phone, code.trim(), pin));
    });
  const login = () =>
    guard(async () => {
      setSession(await api!.login(phone, pin));
    });

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <View>
          <Title>KinPay</Title>
          <Muted>Tous vos Mobile Money dans un seul portefeuille</Muted>
        </View>

        <View style={s.row}>
          <Pill label="Connexion" on={mode === 'login'} onPress={() => { setMode('login'); setError(''); }} />
          <Pill label="Inscription" on={mode === 'register'} onPress={() => { setMode('register'); setError(''); }} />
        </View>

        <Label>Votre numéro de téléphone</Label>
        <TextInput
          accessibilityLabel="Numéro de téléphone"
          style={s.input}
          value={phone}
          onChangeText={(t) => setPhone(t.replace(/[^0-9+ ]/g, ''))}
          keyboardType="phone-pad"
          placeholder="+243 8_ ___ ____"
          placeholderTextColor={colors.muted}
          autoComplete="tel"
        />

        {mode === 'register' && codeSent && (
          <>
            <Label>Code reçu par SMS</Label>
            <TextInput
              accessibilityLabel="Code reçu par SMS"
              style={s.input}
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              placeholder="6 chiffres"
              placeholderTextColor={colors.muted}
              autoComplete="sms-otp"
            />
          </>
        )}

        {(mode === 'login' || codeSent) && (
          <>
            <Label>{mode === 'login' ? 'Code PIN' : 'Choisissez un code PIN (4 à 6 chiffres)'}</Label>
            <TextInput
              accessibilityLabel="Code PIN"
              style={s.input}
              value={pin}
              onChangeText={(t) => setPin(t.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              secureTextEntry
              placeholder="••••"
              placeholderTextColor={colors.muted}
            />
          </>
        )}

        <ErrorText>{error}</ErrorText>

        {mode === 'login' ? (
          <Button label="Se connecter" onPress={login} disabled={!normalized || !pinOk} loading={loading} />
        ) : codeSent ? (
          <>
            <Button label="Créer mon compte" onPress={register} disabled={!normalized || !pinOk || code.length !== 6} loading={loading} />
            <Button label="Renvoyer le code" variant="outline" onPress={sendCode} disabled={!normalized} />
          </>
        ) : (
          <Button label="Recevoir le code par SMS" onPress={sendCode} disabled={!normalized} loading={loading} />
        )}

        <Text style={s.legal}>Ne communiquez jamais votre code PIN ni vos codes SMS, même à une personne qui se présente comme KinPay.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  row: { flexDirection: 'row', gap: 8 },
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
  legal: { fontSize: 12, color: colors.muted, textAlign: 'center', marginTop: 8 },
});
