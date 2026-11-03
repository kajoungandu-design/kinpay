import React, { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import { useAuth } from '../store/AuthContext';
import { useWallet } from '../store/WalletContext';
import { ApiError, type PaymentRequest, type RequestStatus } from '../core/api';
import { cleanAmountInput, formatAmount, formatMoney, parseAmount } from '../core/format';
import { Button, Card, CurrencyBadge, ErrorText, Label, Muted, Pill, Title } from '../ui';
import { colors } from '../theme';
import type { Currency, Product } from '../core/types';

// Montants rapides pour une course ou un petit achat (francs CDF, cents USD).
const QUICK_AMOUNTS: Record<Currency, number[]> = { CDF: [1500, 2000, 3000, 5000], USD: [100, 200, 500, 1000] };

function requestMessage(e: unknown): string {
  const code = e instanceof ApiError ? e.code : '';
  if (code === 'INVALID_AMOUNT') return 'Montant invalide ou trop élevé.';
  if (code === 'CURRENCY_MISMATCH') return 'Tous les articles doivent être dans la devise du compte qui reçoit.';
  if (code === 'TOO_MANY_PRODUCTS') return 'Catalogue plein (60 articles au maximum).';
  if (code === 'INVALID_INPUT') return 'Vérifiez le nom et le prix.';
  return 'Connexion impossible. Vérifiez votre connexion et réessayez.';
}

export function ReceiveScreen() {
  const { api } = useAuth();
  const { accounts, primary, refresh } = useWallet();
  const [accountId, setAccountId] = useState(primary?.id ?? '');
  const [mode, setMode] = useState<'quick' | 'catalog'>('quick');
  const [request, setRequest] = useState<PaymentRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!accounts.some((a) => a.id === accountId) && accounts[0]) setAccountId(primary?.id ?? accounts[0].id);
  }, [accounts, accountId, primary]);

  const account = accounts.find((a) => a.id === accountId) ?? null;

  if (!api) {
    return (
      <View style={s.content}>
        <Title>Encaisser</Title>
        <Muted>Disponible quand l'application est connectée au serveur KinPay.</Muted>
      </View>
    );
  }

  async function generate(body: { amount?: number; item?: string; items?: { productId: string; qty: number }[] }) {
    if (!api || !account || loading) return;
    setLoading(true);
    setError('');
    try {
      setRequest(await api.createRequest({ accountId: account.id, ...body }));
    } catch (e) {
      setError(requestMessage(e));
    } finally {
      setLoading(false);
    }
  }

  if (request) {
    return (
      <QrPanel
        request={request}
        accountLabel={account ? account.label + ' ' + account.currency : ''}
        onPaid={refresh}
        onNew={() => setRequest(null)}
      />
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <View>
          <Title>Encaisser</Title>
          <Muted>Affichez un QR : la personne en face le scanne avec KinPay et paie.</Muted>
        </View>

        <View style={s.wrap}>
          <Pill label="Montant rapide" on={mode === 'quick'} onPress={() => setMode('quick')} />
          <Pill label="Mes produits" on={mode === 'catalog'} onPress={() => setMode('catalog')} />
        </View>

        <Label>Recevoir sur</Label>
        {accounts.length === 0 ? (
          <ErrorText>Ajoutez d'abord un compte Mobile Money depuis l'accueil.</ErrorText>
        ) : (
          <View style={s.wrap}>
            {accounts.map((a) => (
              <Pill key={a.id} label={a.label + ' ' + a.currency} on={a.id === accountId} onPress={() => setAccountId(a.id)} />
            ))}
          </View>
        )}

        {account &&
          (mode === 'quick' ? (
            <QuickAmount key={account.currency} currency={account.currency} loading={loading} onGenerate={generate} />
          ) : (
            <Catalog key={account.currency} currency={account.currency} loading={loading} onGenerate={generate} />
          ))}
        <ErrorText>{error}</ErrorText>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

type Generate = (body: { amount?: number; item?: string; items?: { productId: string; qty: number }[] }) => void;

// Taxi, client, petit vendeur : on tape le montant, le QR s'affiche.
function QuickAmount({ currency, loading, onGenerate }: { currency: Currency; loading: boolean; onGenerate: Generate }) {
  const [amountText, setAmountText] = useState('');
  const [item, setItem] = useState('');
  const amount = parseAmount(amountText, currency) ?? 0;

  return (
    <>
      <Label>{'Montant (' + currency + ')'}</Label>
      <TextInput
        accessibilityLabel={currency === 'USD' ? 'Montant en dollars' : 'Montant en francs congolais'}
        style={[s.input, s.bigInput]}
        value={amountText}
        onChangeText={(t) => setAmountText(cleanAmountInput(t, currency))}
        keyboardType={currency === 'USD' ? 'decimal-pad' : 'number-pad'}
        placeholder={currency === 'USD' ? '0,00' : '0'}
        placeholderTextColor={colors.muted}
      />
      <View style={s.wrap}>
        {QUICK_AMOUNTS[currency].map((n) => (
          <Pill key={n} label={formatAmount(n, currency)} on={amount === n} onPress={() => setAmountText(formatAmount(n, currency).replace(/\s/g, ''))} />
        ))}
      </View>
      <Label>Motif (facultatif)</Label>
      <TextInput
        accessibilityLabel="Motif du paiement"
        style={s.input}
        value={item}
        onChangeText={(t) => setItem(t.slice(0, 60))}
        placeholder="Ex. Course Gombe – Lingwala"
        placeholderTextColor={colors.muted}
      />
      <Button
        label={amount > 0 ? 'Générer le QR de ' + formatMoney(amount, currency) : 'Générer le QR'}
        onPress={() => onGenerate({ amount, item: item.trim() || undefined })}
        disabled={amount <= 0}
        loading={loading}
      />
    </>
  );
}

// Commerçant, restaurant : on choisit les articles, le serveur calcule le total.
function Catalog({ currency, loading, onGenerate }: { currency: Currency; loading: boolean; onGenerate: Generate }) {
  const { api } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [priceText, setPriceText] = useState('');
  const [adding, setAdding] = useState(false);
  const price = parseAmount(priceText, currency) ?? 0;

  const load = useCallback(async () => {
    if (!api) return;
    try {
      setProducts(await api.listProducts());
      setError('');
    } catch (e) {
      setError(requestMessage(e));
    }
    setLoaded(true);
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const mine = products.filter((p) => p.currency === currency);
  const lines = mine.filter((p) => (cart[p.id] ?? 0) > 0);
  const total = lines.reduce((sum, p) => sum + p.price * cart[p.id], 0);
  const change = (id: string, delta: number) => setCart((c) => ({ ...c, [id]: Math.max(0, Math.min(99, (c[id] ?? 0) + delta)) }));

  async function add() {
    if (!api || !name.trim() || price <= 0 || adding) return;
    setAdding(true);
    try {
      await api.addProduct({ name: name.trim(), price, currency });
      setName('');
      setPriceText('');
      await load();
    } catch (e) {
      setError(requestMessage(e));
    }
    setAdding(false);
  }

  async function remove(p: Product) {
    if (!api) return;
    try {
      await api.deleteProduct(p.id);
      setCart(({ [p.id]: _, ...rest }) => rest);
      await load();
    } catch (e) {
      setError(requestMessage(e));
    }
  }

  return (
    <>
      <Label>{'Mes produits en ' + currency}</Label>
      {loaded && mine.length === 0 && <Muted>Aucun produit. Ajoutez vos plats ou articles ci-dessous.</Muted>}
      {mine.map((p) => {
        const qty = cart[p.id] ?? 0;
        return (
          <Card key={p.id} style={s.productRow}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={s.productName}>{p.name}</Text>
              <Muted>{formatMoney(p.price, p.currency)}</Muted>
              <Pressable accessibilityRole="button" accessibilityLabel={'Supprimer ' + p.name} onPress={() => remove(p)} hitSlop={8}>
                <Text style={s.remove}>Supprimer</Text>
              </Pressable>
            </View>
            <View style={s.qtyRow}>
              <QtyButton icon="remove" label={'Retirer un ' + p.name} onPress={() => change(p.id, -1)} disabled={qty === 0} />
              <Text style={s.qty}>{qty}</Text>
              <QtyButton icon="add" label={'Ajouter un ' + p.name} onPress={() => change(p.id, 1)} />
            </View>
          </Card>
        );
      })}

      <Card style={{ gap: 6 }}>
        <View style={s.between}>
          <Muted>Total</Muted>
          <Text style={s.total}>{formatMoney(total, currency)}</Text>
        </View>
        <Muted>Le total final est recalculé par le serveur avec vos prix enregistrés.</Muted>
      </Card>
      <ErrorText>{error}</ErrorText>
      <Button
        label="Générer le QR"
        onPress={() => onGenerate({ items: lines.map((p) => ({ productId: p.id, qty: cart[p.id] })) })}
        disabled={lines.length === 0}
        loading={loading}
      />

      <Card style={{ gap: 10 }}>
        <Label>Ajouter un produit</Label>
        <TextInput
          accessibilityLabel="Nom du produit"
          style={s.input}
          value={name}
          onChangeText={(t) => setName(t.slice(0, 40))}
          placeholder="Ex. Plat combo"
          placeholderTextColor={colors.muted}
        />
        <TextInput
          accessibilityLabel={'Prix en ' + currency}
          style={s.input}
          value={priceText}
          onChangeText={(t) => setPriceText(cleanAmountInput(t, currency))}
          keyboardType={currency === 'USD' ? 'decimal-pad' : 'number-pad'}
          placeholder={'Prix en ' + currency}
          placeholderTextColor={colors.muted}
        />
        <Button label="Ajouter au catalogue" variant="outline" onPress={add} disabled={!name.trim() || price <= 0} loading={adding} />
      </Card>
    </>
  );
}

function QtyButton({ icon, label, onPress, disabled }: { icon: 'add' | 'remove'; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      onPress={disabled ? undefined : onPress}
      style={[s.qtyBtn, disabled && { opacity: 0.35 }]}
    >
      <Ionicons name={icon} size={22} color={colors.green} />
    </Pressable>
  );
}

// Le QR à montrer, avec compte à rebours ; le serveur est interrogé toutes les 2 s jusqu'au paiement.
function QrPanel({ request, accountLabel, onPaid, onNew }: { request: PaymentRequest; accountLabel: string; onPaid: () => void; onNew: () => void }) {
  const { api } = useAuth();
  const [status, setStatus] = useState<RequestStatus | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const paid = status?.status === 'paid';
  const left = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));
  const expired = !paid && (status?.status === 'expired' || left === 0);

  useEffect(() => {
    if (!api || paid || expired) return;
    const t = setInterval(async () => {
      setNow(Date.now());
      try {
        const st = await api.getRequestStatus(request.nonce);
        setStatus(st);
        if (st.status === 'paid') onPaid();
      } catch {
        // réseau coupé : on réessaie au prochain tour
      }
    }, 2000);
    return () => clearInterval(t);
  }, [api, request.nonce, paid, expired, onPaid]);

  return (
    <ScrollView contentContainerStyle={[s.content, { alignItems: 'center' }]}>
      {paid ? (
        <>
          <View style={s.badge}>
            <Ionicons name="checkmark" size={48} color={colors.white} />
          </View>
          <Text style={s.panelTitle}>Payé</Text>
          <Text style={s.panelAmount}>{formatMoney(request.amount, request.currency)}</Text>
          <Muted>{'Par ' + (status?.payer ?? 'un client') + ', reçu sur ' + accountLabel}</Muted>
        </>
      ) : (
        <>
          <Text style={s.panelTitle}>{expired ? 'QR expiré' : 'Faites scanner ce QR'}</Text>
          <View style={[s.qrBox, expired && { opacity: 0.2 }]}>
            <QRCode value={request.qr} size={240} />
          </View>
          <Text style={s.panelAmount}>{formatMoney(request.amount, request.currency)}</Text>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <CurrencyBadge currency={request.currency} />
            <Muted>{request.item}</Muted>
          </View>
          <Muted>
            {expired
              ? 'Générez un nouveau QR.'
              : status?.status === 'claimed'
                ? 'Paiement en cours…'
                : 'En attente du paiement · expire dans ' + Math.floor(left / 60) + ' min ' + String(left % 60).padStart(2, '0') + ' s'}
          </Muted>
          <Muted>{'Reçu sur ' + accountLabel}</Muted>
          {__DEV__ && !expired && (
            // Test avec un seul téléphone : copier le QR, se connecter avec un autre compte, le coller dans « Payer ».
            <View style={{ alignSelf: 'stretch' }}>
              <Button
                label={copied ? 'QR copié : collez-le dans Payer (autre compte)' : 'Copier le QR (test)'}
                variant="outline"
                onPress={async () => {
                  await Clipboard.setStringAsync(request.qr);
                  setCopied(true);
                }}
              />
            </View>
          )}
        </>
      )}
      <View style={{ alignSelf: 'stretch' }}>
        <Button label={paid ? 'Encaisser à nouveau' : 'Nouveau QR'} variant={paid ? 'solid' : 'outline'} onPress={onNew} />
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
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
  bigInput: { minHeight: 64, fontSize: 32, fontWeight: '800', textAlign: 'center' },
  productRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  productName: { fontSize: 15, fontWeight: '600', color: colors.ink },
  remove: { fontSize: 13, fontWeight: '600', color: colors.danger },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  qtyBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.green, alignItems: 'center', justifyContent: 'center' },
  qty: { minWidth: 24, textAlign: 'center', fontSize: 18, fontWeight: '800', color: colors.ink },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  total: { fontSize: 20, fontWeight: '800', color: colors.ink },
  panelTitle: { fontSize: 20, fontWeight: '800', color: colors.ink, textAlign: 'center' },
  panelAmount: { fontSize: 34, fontWeight: '800', color: colors.green },
  qrBox: { padding: 16, backgroundColor: colors.white, borderRadius: 20, borderWidth: 1, borderColor: colors.line },
  badge: { width: 88, height: 88, borderRadius: 44, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' },
});
