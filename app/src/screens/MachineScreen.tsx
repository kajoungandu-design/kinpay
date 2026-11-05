import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../store/AuthContext';
import { useWallet } from '../store/WalletContext';
import { cleanAmountInput, formatMoney, parseAmount } from '../core/format';
import { Button, Card, CurrencyBadge, ErrorText, Label, Muted, Pill, Title, UssdHint, failureMessage } from '../ui';
import { colors } from '../theme';
import { usePinConfirm } from '../pin';
import type { Account, FixedMachineQr, MachineMenu, MachineSlot, Vend } from '../core/types';
import type { ResultInfo } from '../../App';

const KIND_LABEL: Record<MachineMenu['kind'], string> = {
  vending: 'Distributeur automatique',
  laundry: 'Laverie automatique',
  fuel: "Pompe à essence",
  atm: 'Distributeur de billets',
};
// Pompe : plafonds rapides (francs CDF, cents USD). Le reste non servi est rendu.
const FUEL_MAX = { CDF: [20000, 50000, 100000], USD: [1000, 2000, 5000] };

// Pourquoi un cycle de laverie a été remboursé.
function laundryReason(reason: string | null): string {
  if (reason === 'POWER_CUT') return 'Coupure de courant';
  if (reason === 'DOOR_OPEN') return 'Porte ouverte';
  if (reason === 'START_TIMEOUT') return "La machine n'a pas démarré";
  return 'Panne de la machine';
}

/** Après un paiement machine : suit la distribution ou le cycle de laverie jusqu'au résultat. */
export function VendProgress({ vend: initial, balanceAfterPay, account, onFinish }: { vend: Vend; balanceAfterPay: number; account: Account; onFinish: (r: ResultInfo) => void }) {
  const { api } = useAuth();
  const { refresh } = useWallet();
  const [vend, setVend] = useState(initial);
  const pending = vend.status === 'held' || vend.status === 'finishing';
  const running = vend.status === 'running';
  const follow = pending || running;
  const laundry = vend.kind === 'laundry';

  useEffect(() => {
    if (!follow || !api) {
      refresh();
      return;
    }
    const t = setInterval(async () => {
      try {
        setVend(await api.getVend(initial.id));
      } catch {
        // réseau coupé : on réessaie à la prochaine seconde
      }
    }, 1000);
    return () => clearInterval(t);
  }, [follow, api, initial.id, refresh]);

  const paid = vend.finalAmount ?? (vend.status === 'dispensed' ? vend.amount : 0);
  const back = vend.status === 'refunded' || vend.status === 'dispensed' ? vend.amount - paid : 0;
  // Laverie remboursée, en partie ou en totalité : l'écran donne le montant payé et le reste rendu.
  const interrupted = laundry && back > 0;
  const refundTitle = paid === 0 ? 'Remboursé en totalité' : 'Panne de la machine';
  // « Coton 40° — Lave-linge 2, 45 min » ou « Cola 33 cl — Boissons Gombe »
  const place = (vend.detail ? vend.detail + ' — ' : '') + vend.machine;
  const what = vend.item + ' — ' + place + (vend.minutes ? ', ' + vend.minutes + ' min' : '');
  const rest = back > 0 ? ' (reste rendu : ' + formatMoney(back, vend.currency) + ')' : '';

  function finish() {
    const balance = balanceAfterPay + back;
    const label = account.label + ' ' + account.currency;
    if (interrupted) {
      onFinish({
        title: refundTitle,
        detail: laundryReason(vend.reason) + ' — ' + what + '. Payé : ' + formatMoney(paid, vend.currency) + ', rendu : ' + formatMoney(back, vend.currency) + '.',
        accountLabel: label,
        balance,
        currency: vend.currency,
      });
    } else if (vend.status === 'refunded') {
      onFinish({ title: 'Remboursé', detail: "La machine n'a pas pu servir « " + vend.item + ' ». ' + formatMoney(vend.amount, vend.currency) + ' ont été rendus sur ' + account.label + '.', accountLabel: label, balance, currency: vend.currency });
    } else if (running) {
      onFinish({ title: 'Paiement validé', detail: what + ' : ' + formatMoney(vend.amount, vend.currency) + '. Le cycle est en cours.', accountLabel: label, balance, currency: vend.currency });
    } else {
      onFinish({
        title: laundry ? 'Cycle terminé' : 'Servi',
        detail: what + ' : ' + formatMoney(paid, vend.currency) + rest + '.',
        accountLabel: label,
        balance,
        currency: vend.currency,
      });
    }
  }

  return (
    <Card style={s.progress}>
      {pending ? (
        <>
          <ActivityIndicator size="large" color={colors.green} />
          <Text style={s.big}>{laundry ? 'Démarrage de la machine…' : 'Distribution en cours…'}</Text>
          <Muted style={{ textAlign: 'center' }}>{what}</Muted>
          <Muted style={{ textAlign: 'center' }}>
            {laundry
              ? 'Votre argent est bloqué. Si la machine ne démarre pas, il vous est rendu automatiquement.'
              : 'Votre argent est bloqué. Si la machine ne sert pas dans les 30 secondes, il vous est rendu automatiquement.'}
          </Muted>
        </>
      ) : running ? (
        <>
          <Ionicons name="checkmark-circle" size={64} color={colors.green} />
          <Text style={s.big}>Paiement validé</Text>
          <Text style={s.amountDone}>{formatMoney(vend.amount, vend.currency)}</Text>
          <Muted style={{ textAlign: 'center' }}>{what}</Muted>
          <Muted style={{ textAlign: 'center' }}>Le cycle a démarré. Vous pouvez fermer cet écran : en cas de panne, le temps non utilisé vous sera rendu.</Muted>
          <Button label="Terminé" onPress={finish} />
        </>
      ) : interrupted ? (
        <>
          <Ionicons name="arrow-undo-circle" size={64} color={colors.danger} />
          <Text style={s.big}>{refundTitle}</Text>
          <Muted style={{ textAlign: 'center' }}>{laundryReason(vend.reason) + ' — ' + what}</Muted>
          <View style={s.split}>
            <Muted>Payé</Muted>
            <Text style={s.splitValue}>{formatMoney(paid, vend.currency)}</Text>
          </View>
          <View style={s.split}>
            <Muted>Rendu sur votre compte</Muted>
            <Text style={[s.splitValue, { color: colors.green }]}>{formatMoney(back, vend.currency)}</Text>
          </View>
          <Button label="Terminé" onPress={finish} />
        </>
      ) : vend.status === 'dispensed' ? (
        <>
          <Ionicons name="checkmark-circle" size={64} color={colors.green} />
          <Text style={s.big}>{laundry ? 'Cycle terminé' : 'Servi'}</Text>
          <Muted style={{ textAlign: 'center' }}>{vend.item + ' : ' + formatMoney(paid, vend.currency) + rest}</Muted>
          {laundry && <Muted style={{ textAlign: 'center' }}>{'Vous pouvez retirer votre linge' + (vend.detail ? ' : ' + vend.detail : '') + '.'}</Muted>}
          <Button label="Terminé" onPress={finish} />
        </>
      ) : (
        <>
          <Ionicons name="arrow-undo-circle" size={64} color={colors.danger} />
          <Text style={s.big}>Remboursé</Text>
          <Muted style={{ textAlign: 'center' }}>{"La machine n'a pas pu servir. " + formatMoney(vend.amount, vend.currency) + ' ont été rendus sur votre compte.'}</Muted>
          <Button label="Terminé" onPress={finish} />
        </>
      )}
    </Card>
  );
}

/** QR fixe scanné : menu de la machine, choix du produit (ou plafond pour une pompe), PIN, distribution. */
export function MachineBuy({ qr, onDone, onCancel }: { qr: FixedMachineQr; onDone: (r: ResultInfo) => void; onCancel: () => void }) {
  const { api } = useAuth();
  const { accounts, accountFor, refresh } = useWallet();
  const [menu, setMenu] = useState<MachineMenu | null>(null);
  const [error, setError] = useState('');
  const [slot, setSlot] = useState<MachineSlot | null>(null);
  const [maxText, setMaxText] = useState('');
  const [payerId, setPayerId] = useState('');
  const [loading, setLoading] = useState(false);
  const [vend, setVend] = useState<{ vend: Vend; balance: number; account: Account } | null>(null);
  const { confirm, pinModal } = usePinConfirm();
  const key = useRef(Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  async function load() {
    if (!api) return;
    const r = await api.machineMenu(qr.id, qr.s);
    if (!r.ok) {
      setError(r.reason === 'NETWORK' ? 'Connexion impossible. Réessayez.' : failureMessage(r.reason));
      return;
    }
    setError('');
    setMenu(r);
  }
  useEffect(() => {
    load();
    // l'état de la machine (en ligne, stock) est relu toutes les 5 s
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qr.id, qr.s]);

  if (vend) return <ScrollView contentContainerStyle={s.content}><VendProgress vend={vend.vend} balanceAfterPay={vend.balance} account={vend.account} onFinish={onDone} /></ScrollView>;

  const currency = menu?.currency ?? 'CDF';
  const options = accounts.filter((a) => a.currency === currency);
  const payer = options.find((a) => a.id === payerId) ?? accountFor(currency);
  const fuel = menu?.kind === 'fuel';
  const amount = fuel ? parseAmount(maxText, currency) : slot?.price ?? null;
  const notEnough = !!payer && amount !== null && payer.balance < amount;

  async function buy() {
    if (!api || !menu || !payer || amount === null || loading) return;
    const what = fuel ? 'Bloquer ' + formatMoney(amount, currency) + ' pour le carburant (le reste vous sera rendu)' : 'Acheter « ' + slot?.name + ' » ' + formatMoney(amount, currency);
    if (!(await confirm(what + ' — ' + menu.name + ', depuis ' + payer.label + ' ' + currency + '.'))) return;
    setLoading(true);
    setError('');
    const r = await api.buyFromMachine({ id: qr.id, s: qr.s, accountId: payer.id, idempotencyKey: key.current, ...(fuel ? { amount } : { slot: slot?.slot }) });
    setLoading(false);
    key.current = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    if (!r.ok) {
      setError(failureMessage(r.reason));
      load();
      return;
    }
    refresh();
    if (r.vend) setVend({ vend: r.vend, balance: r.balance, account: payer });
  }

  return (
    <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <View>
        <Title>{menu?.name ?? 'Machine'}</Title>
        <Muted>{menu ? KIND_LABEL[menu.kind] + ' · ' + qr.id : 'Chargement…'}</Muted>
      </View>
      {menu && (
        <View style={s.status}>
          <View style={[s.dot, { backgroundColor: menu.online ? colors.green : colors.danger }]} />
          <Text style={s.statusText}>{menu.online ? (menu.busy ? 'En ligne · sert un autre client' : 'En ligne') : 'Hors ligne : achat impossible pour le moment'}</Text>
          <CurrencyBadge currency={currency} />
        </View>
      )}
      <ErrorText>{error}</ErrorText>

      {menu && !fuel && (
        <>
          <Label>{menu.kind === 'laundry' ? 'Choisissez un programme' : 'Choisissez un produit'}</Label>
          {menu.slots.length === 0 && <Muted>Aucun produit configuré sur cette machine.</Muted>}
          {menu.slots.map((p) => {
            const out = p.stock === 0;
            const on = slot?.slot === p.slot;
            return (
              <Pressable
                key={p.slot}
                accessibilityRole="button"
                accessibilityState={{ selected: on, disabled: out }}
                onPress={out ? undefined : () => setSlot(p)}
                style={[s.slot, on && s.slotOn, out && { opacity: 0.45 }]}
              >
                <Text style={s.slotNo}>{p.slot}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.slotName}>{p.name}</Text>
                  <Muted>{out ? 'Épuisé' : p.stock === null ? 'Disponible' : p.stock + ' en stock'}</Muted>
                </View>
                <Text style={s.slotPrice}>{formatMoney(p.price, currency)}</Text>
              </Pressable>
            );
          })}
        </>
      )}

      {menu && fuel && (
        <Card style={{ gap: 10 }}>
          <Label>Plafond à bloquer</Label>
          <Muted>La pompe sert jusqu'à ce montant. Vous ne payez que ce qui est servi, le reste vous est rendu tout de suite.</Muted>
          <View style={s.row}>
            {FUEL_MAX[currency].map((v) => (
              <Pill key={v} label={formatMoney(v, currency)} on={amount === v} onPress={() => setMaxText(String(currency === 'USD' ? (v / 100).toFixed(2).replace('.', ',') : v))} />
            ))}
          </View>
          <TextInput
            accessibilityLabel="Plafond"
            style={s.input}
            value={maxText}
            onChangeText={(t) => setMaxText(cleanAmountInput(t, currency))}
            keyboardType={currency === 'USD' ? 'decimal-pad' : 'number-pad'}
            placeholder={currency === 'USD' ? '20,00' : '50000'}
            placeholderTextColor={colors.muted}
          />
        </Card>
      )}

      {menu && (
        <>
          {payer ? (
            <Muted>
              Payer depuis : <Text style={s.bold}>{payer.label} {payer.currency}</Text> ({formatMoney(payer.balance, payer.currency)})
            </Muted>
          ) : (
            <ErrorText>{'Ajoutez un compte ' + currency + ' pour payer cette machine (pas de conversion entre CDF et USD).'}</ErrorText>
          )}
          {options.length > 1 && (
            <View style={s.row}>
              {options.map((a) => (
                <Pill key={a.id} label={a.label + ' ' + a.currency} on={payer?.id === a.id} onPress={() => setPayerId(a.id)} />
              ))}
            </View>
          )}
          {notEnough && <ErrorText>{'Solde insuffisant sur ' + payer?.label}</ErrorText>}
          <Button
            label={amount !== null ? (fuel ? 'Bloquer ' : 'Payer ') + formatMoney(amount, currency) : fuel ? 'Indiquez un plafond' : 'Choisissez un produit'}
            onPress={buy}
            disabled={!payer || amount === null || notEnough || !menu.online || menu.busy}
            loading={loading}
          />
          <UssdHint show={loading} operator={payer?.operator} />
        </>
      )}
      <Button label="Annuler" variant="outline" onPress={onCancel} />
      {pinModal}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.ink },
  slot: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.white, borderColor: colors.line, borderWidth: 1, borderRadius: 16, paddingHorizontal: 14 },
  slotOn: { borderColor: colors.green, borderWidth: 2, backgroundColor: colors.greenSoft },
  slotNo: { width: 28, fontSize: 16, fontWeight: '800', color: colors.muted, textAlign: 'center' },
  slotName: { fontSize: 15, fontWeight: '700', color: colors.ink },
  slotPrice: { fontSize: 15, fontWeight: '800', color: colors.ink },
  bold: { fontSize: 14, fontWeight: '800', color: colors.ink },
  input: { minHeight: 52, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 12, paddingHorizontal: 14, fontSize: 20, fontWeight: '700', backgroundColor: colors.white, color: colors.ink },
  progress: { alignItems: 'center', gap: 12, paddingVertical: 28 },
  big: { fontSize: 22, fontWeight: '800', color: colors.ink },
  split: { alignSelf: 'stretch', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  splitValue: { fontSize: 16, fontWeight: '800', color: colors.ink },
  amountDone: { fontSize: 26, fontWeight: '800', color: colors.green },
});
