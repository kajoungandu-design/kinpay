// Lancer : node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, detectOperator } from '../src/core/phone.ts';
import { cleanAmountInput, formatCDF, formatMoney, parseAmount, relativeTime } from '../src/core/format.ts';
import { parseMachineQr, DEMO_QR } from '../src/core/qr.ts';
import { generateOtp, formatOtp } from '../src/core/otp.ts';
import { MockProvider, SEED_ACCOUNTS } from '../src/core/mockProvider.ts';

test('normalizePhone accepte les formats courants', () => {
  assert.equal(normalizePhone('+243 89 000 00 01'), '+243890000001');
  assert.equal(normalizePhone('0890000001'), '+243890000001');
  assert.equal(normalizePhone('890000001'), '+243890000001');
  assert.equal(normalizePhone('243890000001'), '+243890000001');
});

test('normalizePhone refuse les numéros invalides', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('+243 08 000 00 01'), null);
  assert.equal(normalizePhone('+33 6 12 34 56 78'), null);
});

test('detectOperator', () => {
  assert.equal(detectOperator('0890000001'), 'orange');
  assert.equal(detectOperator('0990000002'), 'airtel');
  assert.equal(detectOperator('0810000003'), 'mpesa');
  assert.equal(detectOperator('0700000000'), null);
  assert.equal(detectOperator('abc'), null);
});

test('formatCDF', () => {
  assert.equal(formatCDF(0), '0');
  assert.equal(formatCDF(1500), '1 500');
  assert.equal(formatCDF(1234567), '1 234 567');
});

test('formatMoney : à la française, cents pour USD', () => {
  assert.equal(formatMoney(1500, 'CDF'), '1 500 CDF');
  assert.equal(formatMoney(25000, 'USD'), '250,00 USD');
  assert.equal(formatMoney(125050, 'USD'), '1 250,50 USD');
  assert.equal(formatMoney(5, 'USD'), '0,05 USD');
  assert.equal(formatMoney(0, 'USD'), '0,00 USD');
});

test('parseAmount : virgule ou point, 2 décimales au maximum en USD', () => {
  assert.equal(parseAmount('250,00', 'USD'), 25000);
  assert.equal(parseAmount('2,5', 'USD'), 250);
  assert.equal(parseAmount('2.50', 'USD'), 250);
  assert.equal(parseAmount('12', 'USD'), 1200);
  assert.equal(parseAmount('1 250,50', 'USD'), 125050);
  assert.equal(parseAmount('2,555', 'USD'), null);
  assert.equal(parseAmount('abc', 'USD'), null);
  assert.equal(parseAmount('0,00', 'USD'), null);
  assert.equal(parseAmount('1500', 'CDF'), 1500);
  assert.equal(parseAmount('15,5', 'CDF'), null, 'pas de décimales en CDF');
  assert.equal(parseAmount('', 'CDF'), null);
});

test('cleanAmountInput filtre la frappe', () => {
  assert.equal(cleanAmountInput('12.345', 'USD'), '12,34');
  assert.equal(cleanAmountInput('1a2', 'USD'), '12');
  assert.equal(cleanAmountInput('7,', 'USD'), '7,');
  assert.equal(cleanAmountInput('1 5,00', 'CDF'), '1500');
});

test('relativeTime', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  assert.equal(relativeTime('2026-10-27T11:59:30Z', now), "À l'instant");
  assert.equal(relativeTime('2026-10-27T11:55:00Z', now), 'Il y a 5 min');
  assert.equal(relativeTime('2026-10-27T09:00:00Z', now), 'Il y a 3 h');
  assert.equal(relativeTime('2026-10-26T11:00:00Z', now), 'Hier');
});

test('parseMachineQr', () => {
  assert.deepEqual(parseMachineQr(DEMO_QR), {
    machineId: 'DIST-0042',
    item: "Bouteille d'eau 50 cl",
    amount: 1500,
    qr: DEMO_QR,
  });
  assert.equal(parseMachineQr('https://exemple.com'), null);
  assert.equal(parseMachineQr('kinpay://pay?m=X&a=0&i=Eau'), null);
  assert.equal(parseMachineQr('kinpay://pay?m=X&a=12.5&i=Eau'), null);
  assert.equal(parseMachineQr('kinpay://pay?m=X&a=1500'), null);
  assert.equal(parseMachineQr('kinpay://pay?m=bad id&a=1500&i=Eau'), null);
  assert.equal(parseMachineQr('kinpay://pay?m=X&a=1500&i=%E0%A4%A'), null);
});

test('generateOtp donne 6 chiffres', () => {
  for (let i = 0; i < 200; i++) assert.match(generateOtp(), /^\d{6}$/);
  assert.equal(formatOtp('482915'), '482 915');
});

test('MockProvider : transfert et solde', async () => {
  const p = new MockProvider(SEED_ACCOUNTS, 0);
  const r = await p.transfer({ fromAccountId: 'orange-1', toPhone: '+243990000099', amount: 25000 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.balance, 220000);
  const accounts = await p.getAccounts();
  assert.equal(accounts.find((a) => a.id === 'orange-1')!.balance, 220000);
});

test('MockProvider : transfert entre mes comptes crédite la destination', async () => {
  const p = new MockProvider(SEED_ACCOUNTS, 0);
  await p.transfer({ fromAccountId: 'orange-1', toPhone: '+243990000002', amount: 10000 });
  const accounts = await p.getAccounts();
  assert.equal(accounts.find((a) => a.id === 'orange-1')!.balance, 235000);
  assert.equal(accounts.find((a) => a.id === 'airtel-1')!.balance, 130500);
});

test('MockProvider : refus et cas limites', async () => {
  const p = new MockProvider(SEED_ACCOUNTS, 0);
  const tooMuch = await p.payBill({ fromAccountId: 'mpesa-1', biller: 'Eau', reference: 'X', amount: 999999 });
  assert.deepEqual(tooMuch, { ok: false, reason: 'INSUFFICIENT_FUNDS' });
  const zero = await p.payMachine({ fromAccountId: 'mpesa-1', machineId: 'M', item: 'Eau', amount: 0 });
  assert.deepEqual(zero, { ok: false, reason: 'INVALID_AMOUNT' });
  const frac = await p.payMachine({ fromAccountId: 'mpesa-1', machineId: 'M', item: 'Eau', amount: 10.5 });
  assert.deepEqual(frac, { ok: false, reason: 'INVALID_AMOUNT' });
  const unknown = await p.payMachine({ fromAccountId: 'nope', machineId: 'M', item: 'Eau', amount: 100 });
  assert.deepEqual(unknown, { ok: false, reason: 'UNKNOWN_ACCOUNT' });
  const accounts = await p.getAccounts();
  assert.equal(accounts.find((a) => a.id === 'mpesa-1')!.balance, 78000);
});
