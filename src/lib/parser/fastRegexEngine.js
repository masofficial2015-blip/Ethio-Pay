/**
 * Stage 1: Fast Regex Engine (<10ms, $0 cost).
 *
 * Runs deterministic regular expression extractors against known Ethiopian financial providers:
 * - CBE (Commercial Bank of Ethiopia)
 * - Telebirr & 127
 * - Safaricom M-PESA
 * - Bank of Abyssinia (BOA)
 * - Awash Bank
 * - Dashen Bank & Amole
 * - Nib International Bank
 * - Berhan Bank
 * - Hibret Bank
 *
 * Evaluation Criteria:
 * High Confidence:
 *   - amount > 0
 *   - reference is non-empty string (length >= 5)
 *   - provider is recognized
 * If High Confidence, immediately returns structured transaction data without calling LLM.
 */

// Helper to sanitize numeric ETB amounts (e.g. "1,500.50" -> 1500.5)
function parseCleanAmount(rawAmount) {
  if (!rawAmount) return null;
  const clean = String(rawAmount).replace(/,/g, '').trim();
  const num = parseFloat(clean);
  return !isNaN(num) && num > 0 ? num : null;
}

// 1. CBE (Commercial Bank of Ethiopia)
function parseCbe(sender, body) {
  const upperSender = sender.toUpperCase();
  if (!upperSender.includes('CBE') && upperSender !== '127') {
    return null;
  }

  let amount = null;
  let reference = null;
  let payerName = null;
  let receiverAccount = null;

  // Receipt URL pattern: mreciept or BranchReceipt
  const receiptMatch = body.match(/(?:mreciept\.cbe\.com\.et\/|BranchReceipt\/)([a-zA-Z0-9_&=-]+)/i);
  if (receiptMatch) {
    reference = receiptMatch[1].trim();
  }

  // Format 1: Direct deposit / Branch credit (Dear Mr Mesud your Account 1****1328 has been credited with ETB 20...)
  const creditedMatch = body.match(/your Account\s*([^\s]+)\s*has been credited with ETB\s*([0-9,]+(?:\.[0-9]{1,2})?)/i);
  if (creditedMatch) {
    receiverAccount = creditedMatch[1].trim();
    amount = parseCleanAmount(creditedMatch[2]);
  } else {
    // Format 2: Account transfer (You have received ETB 4,000.00 from account 1****4343 (Ebrahim Deresa) to your account 1****0675...)
    const transferMatch = body.match(/You have received ETB\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*from account\s*([^\s(]+)(?:\s*\(([^)]+)\))?\s*to your account\s*([^\s.]+)\./i);
    if (transferMatch) {
      amount = parseCleanAmount(transferMatch[1]);
      payerName = transferMatch[3] ? transferMatch[3].trim() : transferMatch[2].trim();
      receiverAccount = transferMatch[4].trim();
    }
  }

  // Fallback FT reference if receipt URL was truncated
  if (!reference) {
    const ftMatch = body.match(/\b(FT[0-9A-Z]{8,})\b/);
    if (ftMatch) {
      reference = ftMatch[1].trim();
    }
  }

  if (amount && reference) {
    return {
      provider: 'CBE',
      amount,
      currency: 'ETB',
      reference,
      payerName,
      receiverAccount,
    };
  }

  return null;
}

// 2. Telebirr
function parseTelebirr(sender, body) {
  const upperSender = sender.toUpperCase();
  if (!upperSender.includes('TELEBIRR') && upperSender !== '127') {
    return null;
  }

  let amount = null;
  let reference = null;
  let payerName = null;
  let receiverAccount = null;

  // Format 1: Interbank CBE-to-Telebirr deposit (You have received  ETB 100.00 by transaction number DJU2HK13XI on 2026-10-30... from Commercial Bank of Ethiopia to your telebirr Account...)
  const interbankMatch = body.match(/You have received\s+ETB\s*([0-9,]+(?:\.[0-9]{1,2})?)\s+by transaction number\s+([a-zA-Z0-9]+)\s+on\s+([0-9/:\s-]+)\s+from\s+(.*?)\s+to your telebirr Account\s+([0-9]+(?:\s*-\s*[^\.]+)?)\./i);
  if (interbankMatch) {
    amount = parseCleanAmount(interbankMatch[1]);
    reference = interbankMatch[2].trim();
    payerName = interbankMatch[4].trim();
    receiverAccount = interbankMatch[5].trim();
  } else {
    // Format 2: Standard P2P (You have received ETB 500.00 from Fekadu aseba(2519****9447) on ... Your transaction number is DI68I7HM40.)
    const standardMatch = body.match(/You have received ETB\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*from\s*([^(]+?)(?:\(([^\s)]+)\))?\s*on\s*([0-9/:\s-]+)\.\s*Your transaction number is\s*([a-zA-Z0-9]+)\./i);
    if (standardMatch) {
      amount = parseCleanAmount(standardMatch[1]);
      payerName = standardMatch[2].trim();
      reference = standardMatch[5].trim();
    }
  }

  if (amount && reference) {
    return {
      provider: 'TELEBIRR',
      amount,
      currency: 'ETB',
      reference,
      payerName,
      receiverAccount,
    };
  }

  return null;
}

// 3. Safaricom M-PESA
function parseMpesa(sender, body) {
  const upperSender = sender.toUpperCase();
  if (!upperSender.includes('MPESA') && !upperSender.includes('SAFARICOM')) {
    return null;
  }

  const mpesaMatch = body.match(/You have received\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*from\s*(.*?)(?:\s+Account Number\s+([0-9]+))?\s*on\s*([0-9-]+)\s*at\s*([0-9:APMapm\s]+)\s*to your Account\s*([0-9]+)\.\s*Transaction number is\s*([a-zA-Z0-9]+)\./i);
  if (mpesaMatch) {
    const amount = parseCleanAmount(mpesaMatch[1]);
    const payerName = mpesaMatch[2].trim();
    const receiverAccount = mpesaMatch[6].trim();
    const reference = mpesaMatch[7].trim();

    if (amount && reference) {
      return {
        provider: 'MPESA',
        amount,
        currency: 'ETB',
        reference,
        payerName,
        receiverAccount,
      };
    }
  }

  return null;
}

// 4. Bank of Abyssinia (BOA)
function parseBoa(sender, body) {
  const upperSender = sender.toUpperCase();
  if (!upperSender.includes('BOA') && !upperSender.includes('ABYSSINIA')) {
    return null;
  }

  const boaMatch = body.match(/your account\s*([^\s]+)\s*was credited with ETB\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*by\s*(.*?)\s*\.\s*Available Balance/i);
  if (boaMatch) {
    const receiverAccount = boaMatch[1].trim();
    const amount = parseCleanAmount(boaMatch[2]);
    const payerName = boaMatch[3].trim();

    let reference = null;
    const trxMatch = body.match(/trx=([a-zA-Z0-9]+)/i);
    if (trxMatch) {
      reference = trxMatch[1].trim();
    } else {
      const ftMatch = body.match(/\b(FT[0-9A-Z]{8,})\b/);
      if (ftMatch) reference = ftMatch[1].trim();
    }

    if (amount && reference) {
      return {
        provider: 'BOA',
        amount,
        currency: 'ETB',
        reference,
        payerName,
        receiverAccount,
      };
    }
  }

  return null;
}

// 5. Awash Bank
function parseAwash(sender, body) {
  const upperSender = sender.toUpperCase();
  if (!upperSender.includes('AWASH') && !upperSender.includes('CBEBIRR')) {
    return null;
  }

  const awashMatch = body.match(/(?:credited with|received|deposit of)\s*(?:ETB\s*)?([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:ETB)?\s*(?:from|by)?\s*(.*?)(?:\s+Ref:?\s*([a-zA-Z0-9]+))?/i);
  if (awashMatch) {
    const amount = parseCleanAmount(awashMatch[1]);
    const payerName = awashMatch[2] ? awashMatch[2].trim() : null;
    const reference = awashMatch[3] ? awashMatch[3].trim() : null;

    if (amount && reference) {
      return {
        provider: 'AWASH',
        amount,
        currency: 'ETB',
        reference,
        payerName: payerName || null,
        receiverAccount: null,
      };
    }
  }

  return null;
}

// 6. Dashen Bank (and Amole)
function parseDashen(sender, body) {
  const upperSender = sender.toUpperCase();
  if (!upperSender.includes('DASHEN') && !upperSender.includes('AMOLE')) {
    return null;
  }

  let amount = null;
  let reference = null;
  let payerName = null;
  let receiverAccount = null;

  const m1 = body.match(/(?:Account\s*([^\s]+)\s*has been credited with|credited with)\s*ETB\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:from\s*(.*?))?\s*(?:on\s*([0-9a-zA-Z\s-]+?))?(?:\.|\s+Ref|\s+Balance)/i);
  if (m1) {
    receiverAccount = m1[1] ? m1[1].trim() : null;
    amount = parseCleanAmount(m1[2]);
    payerName = m1[3] ? m1[3].trim() : null;
  }

  const refMatch = body.match(/(?:Ref(?:erence)?(?:\s*is|:)?|FT)\s*([a-zA-Z0-9]+)/i);
  if (refMatch) {
    reference = refMatch[1].trim();
  }

  if (amount && reference) {
    return {
      provider: 'DASHEN',
      amount,
      currency: 'ETB',
      reference,
      payerName,
      receiverAccount,
    };
  }

  return null;
}

// 7. Nib International Bank
function parseNib(sender, body) {
  if (!sender.toUpperCase().includes('NIB')) return null;

  const nibMatch = body.match(/your Account\s*([^\s]+)\s*has been Credited with ETB\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*On\s*([0-9]+\s+[a-zA-Z]+\s+[0-9]+)\s*from\s*(.*?)\s*Ref:\s*([a-zA-Z0-9]+)\./i);
  if (nibMatch) {
    const receiverAccount = nibMatch[1].trim();
    const amount = parseCleanAmount(nibMatch[2]);
    const payerName = nibMatch[4].trim();
    const reference = nibMatch[5].trim();

    if (amount && reference) {
      return {
        provider: 'NIB',
        amount,
        currency: 'ETB',
        reference,
        payerName,
        receiverAccount,
      };
    }
  }

  return null;
}

// 8. Berhan Bank
function parseBerhan(sender, body) {
  if (!sender.toUpperCase().includes('BERHAN')) return null;

  const berhanMatch = body.match(/A\/C No\.\s*([^\s]+)\s*has been credited ETB\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*on\s*([0-9a-zA-Z-]+)\.\s*Reference is\s*([a-zA-Z0-9]+)\./i);
  if (berhanMatch) {
    const receiverAccount = berhanMatch[1].trim();
    const amount = parseCleanAmount(berhanMatch[2]);
    const reference = berhanMatch[4].trim();

    if (amount && reference) {
      return {
        provider: 'BERHAN',
        amount,
        currency: 'ETB',
        reference,
        payerName: null,
        receiverAccount,
      };
    }
  }

  return null;
}

// 9. Hibret Bank
function parseHibret(sender, body) {
  if (!sender.toUpperCase().includes('HIBRET')) return null;

  const hibretMatch = body.match(/ETB\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*Incoming Fund Transfer From\s*(.*?)\s*is made to your account\s*([0-9*]+)/i);
  if (hibretMatch) {
    const amount = parseCleanAmount(hibretMatch[1]);
    const payerName = hibretMatch[2].trim();
    const receiverAccount = hibretMatch[3].trim();
    const reference = `HIBRET-${receiverAccount.slice(-4)}-${Date.now() % 1000000}`;

    if (amount && reference) {
      return {
        provider: 'HIBRET',
        amount,
        currency: 'ETB',
        reference,
        payerName,
        receiverAccount,
      };
    }
  }

  return null;
}

const REGEX_PARSERS = [
  parseCbe,
  parseTelebirr,
  parseMpesa,
  parseBoa,
  parseAwash,
  parseDashen,
  parseNib,
  parseBerhan,
  parseHibret,
];

/**
 * Runs the fast regex engine.
 *
 * @param {object} params
 * @param {string} params.sender
 * @param {string} params.messageBody
 * @returns {{ success: boolean, confidence: 'high' | 'low', method: 'regex', data?: object }}
 */
export function runFastRegexEngine({ sender, messageBody }) {
  const startTime = Date.now();

  for (const parser of REGEX_PARSERS) {
    try {
      const result = parser(sender, messageBody);
      if (result) {
        // Evaluate Mandatory Criteria
        const hasValidAmount = typeof result.amount === 'number' && result.amount > 0;
        const hasValidRef = typeof result.reference === 'string' && result.reference.trim().length >= 5;
        const hasProvider = typeof result.provider === 'string' && result.provider.length > 0;

        if (hasValidAmount && hasValidRef && hasProvider) {
          const durationMs = Date.now() - startTime;
          return {
            success: true,
            confidence: 'high',
            method: 'regex',
            durationMs,
            data: {
              amount: result.amount,
              currency: result.currency || 'ETB',
              reference: result.reference.trim(),
              payerName: result.payerName || null,
              receiverAccount: result.receiverAccount || null,
              provider: result.provider.toUpperCase().trim(),
            },
          };
        }
      }
    } catch (e) {
      // Ignore individual regex parser failure and continue
    }
  }

  return {
    success: false,
    confidence: 'low',
    method: 'regex',
    durationMs: Date.now() - startTime,
  };
}

