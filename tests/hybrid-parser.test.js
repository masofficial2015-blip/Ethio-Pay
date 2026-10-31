import test from 'node:test';
import assert from 'node:assert';
import {
  evaluatePreFilterGate,
  isStandardPhoneNumber,
  isValidBankOriginator,
} from '../src/lib/parser/preFilterGate.js';
import { runFastRegexEngine } from '../src/lib/parser/fastRegexEngine.js';
import { runLlmFallbackEngine } from '../src/lib/parser/llmFallbackEngine.js';
import { parseHybridPaymentSms } from '../src/lib/parser/hybridParser.js';

// ============================================================================
// 1. PRE-FILTER GATE TESTS
// ============================================================================

test('Pre-Filter Gate: isStandardPhoneNumber correctly identifies personal mobile numbers', () => {
  const personalNumbers = [
    '+251911223344',
    '+251711223344',
    '0911223344',
    '0711223344',
    '251911223344',
    '251711223344',
    '+14155552671',
    '0912345678',
  ];

  for (const num of personalNumbers) {
    assert.strictEqual(
      isStandardPhoneNumber(num),
      true,
      `Should recognize '${num}' as standard personal phone number`
    );
  }
});

test('Pre-Filter Gate: isValidBankOriginator allows legitimate alphanumeric IDs and shortcodes', () => {
  const validBankSenders = [
    'CBE',
    'telebirr',
    'MPESA',
    'BOA',
    'AWASH',
    'DASHEN',
    'WEGAGEN',
    'SINQEE',
    '127',
    '727',
  ];

  for (const sender of validBankSenders) {
    assert.strictEqual(
      isValidBankOriginator(sender),
      true,
      `Should allow bank sender '${sender}'`
    );
  }

  // Reject personal numbers
  assert.strictEqual(isValidBankOriginator('+251911223344'), false);
  assert.strictEqual(isValidBankOriginator('0911223344'), false);
});

test('Pre-Filter Gate: Drops spoofed messages from personal numbers even if body imitates CBE', () => {
  const fakeSms = 'Dear Mr Mesud your Account 1****1328 has been credited with ETB 20. Your Current Balance is ETB 14225.98. Thank you for Banking with CBE! for Reciept https://apps.cbe.com.et:100/BranchReceipt/FT26303FYJ9N';

  const result = evaluatePreFilterGate({
    sender: '+251911223344',
    messageBody: fakeSms,
  });

  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'dropped_personal_phone_number');
});

test('Pre-Filter Gate: Drops outbound and debit messages in English & Amharic', () => {
  const debitEnglish = 'Dear Customer, you have transferred ETB 3,000.00 to account 1000000001. Your current balance is ETB 10,000.00.';
  const debitAmharic1 = 'ክቡር ደንበኛ፣ ከሂሳብዎ ላይ ETB 500.00 ወጪ ሆኗል:: ቀሪ ሒሳብዎ ETB 1,200.00::';
  const debitAmharic2 = 'ክቡር ደንበኛ፣ ETB 250.00 ወደ 10000989 አስተላልፈዋል::';
  const deductionAmharic = 'ክቡር ደንበኛ፣ የካርድ ክፍያ ETB 150.00 ተቀናሽ ተደርጓል::';

  assert.strictEqual(evaluatePreFilterGate({ sender: 'CBE', messageBody: debitEnglish }).allowed, false);
  assert.strictEqual(evaluatePreFilterGate({ sender: 'CBE', messageBody: debitAmharic1 }).allowed, false);
  assert.strictEqual(evaluatePreFilterGate({ sender: 'CBE', messageBody: debitAmharic2 }).allowed, false);
  assert.strictEqual(evaluatePreFilterGate({ sender: 'CBE', messageBody: deductionAmharic }).allowed, false);
});

test('Pre-Filter Gate: Drops messages missing credit keywords', () => {
  const promoSms = 'Dear customer, visit our nearest branch to upgrade your debit card today!';
  const result = evaluatePreFilterGate({ sender: 'CBE', messageBody: promoSms });
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'dropped_no_credit_keyword');
});

// ============================================================================
// 2. STAGE 1: FAST REGEX ENGINE TESTS (<10ms, $0)
// ============================================================================

test('Fast Regex: Correctly parses real CBE Branch Credit SMS in <10ms', () => {
  const sms = 'Dear Mr Mesud your Account 1****1328 has been credited with ETB 20. Your Current Balance is ETB 14225.98. Thank you for Banking with CBE! for Reciept https://apps.cbe.com.et:100/BranchReceipt/FT26303FYJ9N&46891328';

  const startTime = Date.now();
  const result = runFastRegexEngine({ sender: 'CBE', messageBody: sms });
  const duration = Date.now() - startTime;

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.confidence, 'high');
  assert.strictEqual(result.method, 'regex');
  assert.strictEqual(result.data.provider, 'CBE');
  assert.strictEqual(result.data.amount, 20.0);
  assert.strictEqual(result.data.reference, 'FT26303FYJ9N&46891328');
  assert.ok(duration < 20, `Execution time was ${duration}ms, should be fast`);
});

test('Fast Regex: Correctly parses real CBE Transfer SMS', () => {
  const sms = 'Dear Seada Ahmed Seid You have received ETB 4,000.00 from account 1********4343 (Ebrahim Deresa Asihab) to your account 1********0675. Your current balance is ETB40,178.85. Thanks for Banking with CBE. https://mreciept.cbe.com.et/v2-hfHCxNIyTvxhHmwkPnLd';

  const result = runFastRegexEngine({ sender: 'CBE', messageBody: sms });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.provider, 'CBE');
  assert.strictEqual(result.data.amount, 4000.0);
  assert.strictEqual(result.data.payerName, 'Ebrahim Deresa Asihab');
  assert.strictEqual(result.data.reference, 'v2-hfHCxNIyTvxhHmwkPnLd');
});

test('Fast Regex: Correctly parses real Telebirr Interbank CBE Deposit', () => {
  const sms = 'Dear musued,\nYou have received  ETB 100.00 by transaction number DJU2HK13XI on 2026-10-30 16:55:46 from Commercial Bank of Ethiopia to your telebirr Account 251941084897 - musued ahmed seid. Your current balance is ETB 403.24.\nThank you for using telebirr\nEthio telecom';

  const result = runFastRegexEngine({ sender: 'telebirr', messageBody: sms });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.provider, 'TELEBIRR');
  assert.strictEqual(result.data.amount, 100.0);
  assert.strictEqual(result.data.reference, 'DJU2HK13XI');
  assert.strictEqual(result.data.payerName, 'Commercial Bank of Ethiopia');
});

test('Fast Regex: Correctly parses Telebirr Standard P2P Credit', () => {
  const sms = 'Dear musued\nYou have received ETB 500.00 from Fekadu aseba(2519****9447)  on 06/09/2026 20:59:54. Your transaction number is DI68I7HM40. Your current E-Money Account balance is ETB 612.13.\nThank you for using telebirr\nEthio telecom';

  const result = runFastRegexEngine({ sender: '127', messageBody: sms });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.provider, 'TELEBIRR');
  assert.strictEqual(result.data.amount, 500.0);
  assert.strictEqual(result.data.reference, 'DI68I7HM40');
  assert.strictEqual(result.data.payerName, 'Fekadu aseba');
});

test('Fast Regex: Correctly parses Safaricom M-PESA SMS', () => {
  const sms = 'Dear Merchant, You have received 5830.00 from Commercial Bank of Ethiopia Account Number 1000055706631 on 2026-10-26 at 11:14:17 AM to your Account 7030189. Transaction number is UJQ4UUH03O.Your Current working balance is 22676.16.';

  const result = runFastRegexEngine({ sender: 'MPESA', messageBody: sms });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.provider, 'MPESA');
  assert.strictEqual(result.data.amount, 5830.0);
  assert.strictEqual(result.data.reference, 'UJQ4UUH03O');
  assert.strictEqual(result.data.payerName, 'Commercial Bank of Ethiopia');
});

test('Fast Regex: Correctly parses Bank of Abyssinia (BOA) SMS', () => {
  const sms = 'Dear Seada, your account 4*****67 was credited with ETB 600.00 by Biniam Worku Getahun . Available Balance: ETB 23,878.45. Receipt: https://cs.bankofabyssinia.com/slip/?trx=FT2629569ZFS35892';

  const result = runFastRegexEngine({ sender: 'BOA', messageBody: sms });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.provider, 'BOA');
  assert.strictEqual(result.data.amount, 600.0);
  assert.strictEqual(result.data.reference, 'FT2629569ZFS35892');
  assert.strictEqual(result.data.payerName, 'Biniam Worku Getahun');
});

test('Fast Regex: Correctly parses Dashen Bank SMS', () => {
  const sms = 'Dear Customer, your Account 123****456 has been credited with ETB 1,500.00 from ABEBE KEBEDE on 30-OCT-2026. Ref: FT26304XYZ. Balance: ETB 15,000.00. Thank you for choosing Dashen Bank.';

  const result = runFastRegexEngine({ sender: 'DASHEN', messageBody: sms });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.provider, 'DASHEN');
  assert.strictEqual(result.data.amount, 1500.0);
  assert.strictEqual(result.data.reference, 'FT26304XYZ');
  assert.strictEqual(result.data.payerName, 'ABEBE KEBEDE');
});

// ============================================================================
// 3. STAGE 2 & HYBRID ORCHESTRATION TESTS
// ============================================================================

test('Hybrid Parser: Fast Regex executes on known provider without calling LLM', async () => {
  const sms = 'Dear Mr Mesud your Account 1****1328 has been credited with ETB 20. Your Current Balance is ETB 14225.98. Thank you for Banking with CBE! for Reciept https://apps.cbe.com.et:100/BranchReceipt/FT26303FYJ9N&46891328';

  const result = await parseHybridPaymentSms({ sender: 'CBE', messageBody: sms });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stage, 'regex');
  assert.strictEqual(result.method, 'regex');
  assert.strictEqual(result.data.amount, 20.0);
  assert.strictEqual(result.data.reference, 'FT26303FYJ9N&46891328');
});

test('Hybrid Parser: Drops personal numbers at Pre-Filter Gate without calling Regex or LLM', async () => {
  const fakeSms = 'Dear Mr Mesud your Account 1****1328 has been credited with ETB 20. for Reciept https://apps.cbe.com.et:100/BranchReceipt/FT26303FYJ9N';

  const result = await parseHybridPaymentSms({ sender: '+251911223344', messageBody: fakeSms });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.stage, 'pre_filter');
  assert.strictEqual(result.dropped, true);
});

test('Hybrid Parser: Falls back to Stage 2 on unmapped bank (e.g. Wegagen Bank)', async () => {
  const wegagenSms = 'Dear customer, your account 0912**** has been credited with ETB 750.00 from KEBEDE ABEBE. Ref: FT99887766. Balance: ETB 12000.00. Thank you for banking with Wegagen Bank.';

  const result = await parseHybridPaymentSms({ sender: 'WegagenBank', messageBody: wegagenSms });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stage, 'llm_fallback');
  assert.strictEqual(result.data.amount, 750.0);
  assert.strictEqual(result.data.reference, 'FT99887766');
  assert.strictEqual(result.data.payerName, 'KEBEDE ABEBE');
});

test('Hybrid Parser: Does NOT confuse current balance with transfer amount', async () => {
  const sinqeeSms = 'ETB 1,200.00 has been credited to your account 4492*** from Tolosa Feyisa. TrxId: SQ88192039. Balance: ETB 84500.00.';

  const result = await parseHybridPaymentSms({ sender: 'Sinqee', messageBody: sinqeeSms });
  assert.strictEqual(result.success, true);
  // Must extract 1,200.00 NOT 84,500.00
  assert.strictEqual(result.data.amount, 1200.0);
  assert.strictEqual(result.data.reference, 'SQ88192039');
});

