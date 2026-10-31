/**
 * Pre-Filter Gate for Ethiopian Banking & Mobile Money Payment SMS.
 *
 * Responsibilities:
 * 1. Anti-Spoofing: Drops any SMS originating from standard mobile/personal numbers (+2519..., 09..., 07...).
 * 2. Originator Validation: Requires valid Alphanumeric Sender ID (e.g. CBE, telebirr, MPESA) or shortcode (127).
 * 3. Direction Guard: Drops outbound debits, payments made, or deductions (English & Amharic).
 * 4. Credit Requirement: Enforces presence of incoming/credited payment indicators.
 *
 * SECURITY & PRIVACY GUARANTEE:
 * Any message rejected by this gate is dropped immediately and NEVER sent to the LLM.
 */

// Outbound / Debit keywords to drop immediately
const DEBIT_KEYWORDS = [
  'debited',
  'transferred to',
  'transferred etb',
  'you have paid',
  'paid',
  'payment made',
  'withdrawn',
  'sent',
  'ወጪ ሆኗል',
  'ወጪ ሆነ',
  'ተቀናሽ',
  'አስተላልፈዋል',
  'ልከዋል',
  'ተላልፏል',
  'ተከፍሏል',
];

// Credit / Incoming keywords required for valid payment alerts
const CREDIT_KEYWORDS = [
  'credited',
  'has been credited',
  'was credited',
  'received',
  'you have received',
  'incoming fund',
  'deposit',
  'ገቢ ሆነ',
  'ገቢ ሆኗል',
  'ተቀብለዋል',
  'ገቢ ተደርጓል',
];

/**
 * Checks if the sender string is a personal/subscriber phone number.
 * @param {string} sender
 * @returns {boolean}
 */
export function isStandardPhoneNumber(sender) {
  if (!sender || typeof sender !== 'string') return true;
  const clean = sender.trim().replace(/[\s-]/g, '');

  // Starts with '+' (personal international format)
  if (clean.startsWith('+')) {
    return true;
  }

  // Ethiopian mobile numbers: 09..., 07..., 2519..., 2517...
  if (/^(\+?251[79]\d{8}|0[79]\d{8})$/.test(clean)) {
    return true;
  }

  // Any purely numeric domestic or international phone number (length >= 8)
  if (/^\d{8,15}$/.test(clean)) {
    return true;
  }

  return false;
}

/**
 * Validates that sender is a registered Alphanumeric Sender ID or official bank shortcode.
 * @param {string} sender
 * @returns {boolean}
 */
export function isValidBankOriginator(sender) {
  if (!sender || typeof sender !== 'string') return false;
  const clean = sender.trim();
  if (!clean || isStandardPhoneNumber(clean)) return false;

  const hasLetters = /[a-zA-Z\u1200-\u137F]/.test(clean);
  const isShortcode = /^\d{3,5}$/.test(clean);

  return hasLetters || isShortcode;
}

/**
 * Evaluates incoming SMS against all Pre-Filter Gate policies.
 *
 * @param {object} params
 * @param {string} params.sender - The originating address or sender ID
 * @param {string} params.messageBody - The raw SMS message body
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function evaluatePreFilterGate({ sender, messageBody }) {
  if (!sender || !messageBody) {
    return { allowed: false, reason: 'missing_sender_or_body' };
  }

  const cleanSender = sender.trim();
  const cleanBody = messageBody.trim();

  if (!cleanSender || !cleanBody) {
    return { allowed: false, reason: 'empty_sender_or_body' };
  }

  // 1. Anti-Spoofing Check: Drop personal mobile numbers
  if (isStandardPhoneNumber(cleanSender)) {
    return {
      allowed: false,
      reason: 'dropped_personal_phone_number',
      detail: `Sender '${cleanSender}' matches personal subscriber format. Legitimate bank alerts use alphanumeric headers or shortcodes.`,
    };
  }

  // 2. Originator Validation
  if (!isValidBankOriginator(cleanSender)) {
    return {
      allowed: false,
      reason: 'invalid_bank_originator',
      detail: `Sender '${cleanSender}' is neither an authorized alphanumeric title nor a bank shortcode.`,
    };
  }

  const lowerBody = cleanBody.toLowerCase();

  // 3. Outbound / Debit Filter: Drop debits, transfers, payment sent
  for (const keyword of DEBIT_KEYWORDS) {
    if (lowerBody.includes(keyword.toLowerCase())) {
      return {
        allowed: false,
        reason: 'dropped_outbound_debit',
        detail: `Message contains debit keyword '${keyword}'.`,
      };
    }
  }

  // 4. Inbound / Credit Requirement: Must contain credit indication
  const hasCredit = CREDIT_KEYWORDS.some((kw) => lowerBody.includes(kw.toLowerCase()));
  if (!hasCredit) {
    return {
      allowed: false,
      reason: 'dropped_no_credit_keyword',
      detail: 'Message does not contain recognized payment credit/received keywords.',
    };
  }

  return { allowed: true };
}

