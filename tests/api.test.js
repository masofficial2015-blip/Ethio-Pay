import test from 'node:test';
import assert from 'node:assert';
import {
  hashDeviceToken,
  generateDeviceToken,
  generatePairingCode,
  generateTelegramLinkCode,
} from '../src/lib/auth.js';
import { formatCashierAlert } from '../src/lib/telegram.js';

test('Security: hashDeviceToken creates 64-char SHA-256 hash', () => {
  const token = 'ethiopay_live_demo_device_token_secret_123';
  const hash = hashDeviceToken(token);
  assert.strictEqual(hash.length, 64);
  assert.strictEqual(hash, '3023425e1af4778f0dae3927bb27f8e5ebba6917d0dd14e6d39a1f6bafa69b5e');
});

test('Security: generateDeviceToken creates unique high-entropy tokens', () => {
  const token1 = generateDeviceToken();
  const token2 = generateDeviceToken();

  assert.ok(token1.rawToken.startsWith('ethiopay_live_'));
  assert.strictEqual(token1.tokenHash.length, 64);
  assert.notStrictEqual(token1.rawToken, token2.rawToken);
  assert.notStrictEqual(token1.tokenHash, token2.tokenHash);
});

test('Pairing: generatePairingCode creates 6-digit expiring code', () => {
  const { code, expiresAt } = generatePairingCode();
  assert.strictEqual(code.length, 6);
  assert.match(code, /^[0-9]{6}$/);
  assert.ok(expiresAt > new Date());
});

test('Telegram: generateTelegramLinkCode creates EP-xxxx format code', () => {
  const { code, expiresAt } = generateTelegramLinkCode();
  assert.match(code, /^EP-[0-9]{4}$/);
  assert.ok(expiresAt > new Date());
});

test('Telegram Formatter: excludes balance and formats Ethiopian payment correctly', () => {
  const tx = {
    provider: 'CBE',
    reference_number: 'FT26223Y3VJ7',
    amount: 4000.0,
    currency: 'ETB',
    payer_name: 'Ebrahim Deresa Asihab',
    payer_account_or_phone: '1********4343',
    transaction_time: '2026-10-29T11:14:17Z',
  };

  const message = formatCashierAlert(tx);

  assert.ok(message.includes('Commercial Bank of Ethiopia (CBE)'));
  assert.ok(message.includes('4,000.00'));
  assert.ok(message.includes('FT26223Y3VJ7'));
  assert.ok(message.includes('Ebrahim Deresa Asihab'));
  assert.ok(message.includes('1********4343'));

  // Critical privacy verification: message must NOT contain balance words
  assert.ok(!message.toLowerCase().includes('balance'));
});
