import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AuthProvider, useAuth } from './src/store/AuthContext';
import { WalletProvider, useWallet } from './src/store/WalletContext';
import { HomeScreen, type Tab } from './src/screens/HomeScreen';
import { SendScreen } from './src/screens/SendScreen';
import { PayScreen } from './src/screens/PayScreen';
import { BillsScreen } from './src/screens/BillsScreen';
import { ReceiveScreen } from './src/screens/ReceiveScreen';
import { ResultScreen } from './src/screens/ResultScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { colors } from './src/theme';
import type { Currency } from './src/core/types';

export type ResultInfo = {
  title: string;
  detail: string;
  accountLabel: string;
  balance: number;
  currency: Currency;
};

const TABS: { id: Tab; label: string; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
  { id: 'home', label: 'Accueil', icon: 'home-outline' },
  { id: 'send', label: 'Envoyer', icon: 'arrow-forward' },
  { id: 'pay', label: 'Payer', icon: 'scan' },
  { id: 'receive', label: 'Encaisser', icon: 'qr-code-outline' },
  { id: 'bills', label: 'Factures', icon: 'receipt-outline' },
];

function Loading() {
  return (
    <View style={s.loading}>
      <ActivityIndicator size="large" color={colors.green} />
    </View>
  );
}

function Shell() {
  const { ready } = useWallet();
  const [tab, setTab] = useState<Tab>('home');
  const [result, setResult] = useState<ResultInfo | null>(null);

  if (!ready) return <Loading />;

  const close = () => {
    setResult(null);
    setTab('home');
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        {result ? (
          <ResultScreen result={result} onClose={close} />
        ) : tab === 'home' ? (
          <HomeScreen onNavigate={setTab} />
        ) : tab === 'send' ? (
          <SendScreen onDone={setResult} />
        ) : tab === 'pay' ? (
          <PayScreen onDone={setResult} />
        ) : tab === 'receive' ? (
          <ReceiveScreen />
        ) : (
          <BillsScreen onDone={setResult} />
        )}
      </View>
      <View style={s.bar}>
        {TABS.map((t) => {
          const on = !result && tab === t.id;
          return (
            <Pressable
              key={t.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={t.label}
              onPress={() => {
                setResult(null);
                setTab(t.id);
              }}
              style={s.tab}
            >
              <Ionicons name={t.icon} size={24} color={on ? colors.green : colors.muted} />
              <Text style={[s.tabText, { color: on ? colors.green : colors.muted }]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// Avec un serveur configuré : écran de connexion tant qu'il n'y a pas de session.
function Gate() {
  const { api, session, loading } = useAuth();
  if (loading) return <Loading />;
  if (api && !session) return <LoginScreen />;
  // key : un autre utilisateur qui se connecte repart d'un portefeuille propre
  return (
    <WalletProvider key={session?.user.id ?? 'demo'}>
      <Shell />
    </WalletProvider>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'bottom']}>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingVertical: 6,
  },
  tab: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 3 },
  tabText: { fontSize: 11, fontWeight: '600' },
});
