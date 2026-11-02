import React, { useCallback, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { useWallet } from './store/WalletContext';
import { Button, ErrorText, Muted } from './ui';
import { colors, radius } from './theme';

/**
 * Demande le code PIN avant une opération d'argent.
 *   const { confirm, pinModal } = usePinConfirm();
 *   if (!(await confirm('Envoyer 5 000 CDF'))) return;
 *   ...  et rendre {pinModal} dans l'écran.
 * En mode démonstration hors-ligne (pas de serveur, pas de PIN), confirm() répond oui tout de suite.
 */
export function usePinConfirm() {
  const { verifyPin } = useWallet();
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  const confirm = useCallback(
    (why: string) => {
      if (!verifyPin) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setReason(why);
      });
    },
    [verifyPin],
  );

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setReason(null);
  };

  const pinModal =
    reason !== null && verifyPin ? <PinModal reason={reason} verify={verifyPin} onDone={finish} /> : null;
  return { confirm, pinModal };
}

function PinModal({ reason, verify, onDone }: { reason: string; verify: (pin: string) => Promise<string | null>; onDone: (ok: boolean) => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const pinOk = /^\d{4,6}$/.test(pin);

  async function submit() {
    if (!pinOk || loading) return;
    setLoading(true);
    setError('');
    const err = await verify(pin);
    setLoading(false);
    if (err) {
      setError(err);
      setPin('');
      return;
    }
    onDone(true);
  }

  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => onDone(false)}>
      <KeyboardAvoidingView style={s.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={s.sheet}>
          <Text style={s.title}>Confirmez avec votre code PIN</Text>
          <Muted>{reason}</Muted>
          <TextInput
            accessibilityLabel="Code PIN"
            style={s.input}
            value={pin}
            onChangeText={(t) => setPin(t.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            secureTextEntry
            autoFocus
            placeholder="••••"
            placeholderTextColor={colors.muted}
            onSubmitEditing={submit}
          />
          <ErrorText>{error}</ErrorText>
          <Button label="Confirmer" onPress={submit} disabled={!pinOk} loading={loading} />
          <Button label="Annuler" variant="outline" onPress={() => onDone(false)} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.bg, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card, padding: 20, gap: 12 },
  title: { fontSize: 18, fontWeight: '800', color: colors.ink },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 22,
    letterSpacing: 8,
    textAlign: 'center',
    backgroundColor: colors.white,
    color: colors.ink,
  },
});
