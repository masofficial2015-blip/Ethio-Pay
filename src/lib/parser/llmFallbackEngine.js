import { GoogleGenAI, Type } from '@google/genai';

/**
 * Stage 2: LLM Fallback Engine (Gemini Flash).
 *
 * Triggered ONLY when Stage 1 (Fast Regex) fails or returns Low Confidence.
 * Used for unfamiliar bank formats, emerging banks (Wegagen, Sinqee, Oromia, Amhara, etc.),
 * complex intermediary descriptions, or non-standard notification layouts.
 *
 * Structured Output Schema guarantees exact JSON layout with zero hallucinated formats.
 */

const SYSTEM_INSTRUCTIONS = `You are a high-precision payment parsing engine for Ethiopian financial institutions and mobile wallets.
Your task is to extract payment transaction details from Ethiopian bank/mobile wallet SMS (in Amharic or English).

Strict Operational Rules:
1. CRITICAL: Do NOT confuse the current balance ("ቀሪ ሒሳብ", "Available Balance", "Current Balance") with the received transfer amount.
2. Direction Guard: Set isPaymentReceived = false if the message is a debit, outgoing transfer, bank fee/charge, or promotional notification.
3. Complex Intermediaries: Cleanly extract the actual individual or business payer name (e.g., "ከ Commercial Bank Of Ethiopia-B2C ፟- ከ Mesud Ahmed" -> Payer is "Mesud Ahmed").
4. Noise Rejection: Ignore marketing links, Fayda links, receipt URLs, toll-free customer support numbers, and footnote text.
5. Inferred Provider: Output the standard canonical bank or wallet name (e.g., CBE, TELEBIRR, MPESA, WEGAGEN, SINQEE, OROMIA, AMHARA, BOA, DASHEN, AWASH, NIB, BERHAN, HIBRET).`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    isPaymentReceived: {
      type: Type.BOOLEAN,
      description: 'false if spam, promo, fee deduction, debit, or outbound transfer. true ONLY if this is a verified incoming credit/payment.',
    },
    amount: {
      type: Type.NUMBER,
      description: 'Clean float of the received payment amount in ETB, or 0 if not found.',
    },
    currency: {
      type: Type.STRING,
      enum: ['ETB'],
    },
    reference: {
      type: Type.STRING,
      description: 'Transaction or reference ID (e.g. FT code, transaction number, receipt id). Null if not present.',
      nullable: true,
    },
    payerName: {
      type: Type.STRING,
      description: 'Extracted sender or payer name. Null if not present.',
      nullable: true,
    },
    provider: {
      type: Type.STRING,
      description: 'Inferred Ethiopian bank or mobile wallet name (e.g. CBE, TELEBIRR, WEGAGEN, SINQEE, etc.).',
    },
  },
  required: ['isPaymentReceived', 'amount', 'currency', 'reference', 'payerName', 'provider'],
};

/**
 * Runs the Gemini LLM Fallback Engine on ambiguous or unmapped SMS.
 *
 * @param {object} params
 * @param {string} params.sender
 * @param {string} params.messageBody
 * @returns {Promise<{ success: boolean, method: 'llm', data?: object, reason?: string, durationMs: number }>}
 */
export async function runLlmFallbackEngine({ sender, messageBody }) {
  const startTime = Date.now();
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

  if (!apiKey) {
    console.warn('[LLM Fallback] GEMINI_API_KEY is not set. Executing resilient heuristic fallback.');
    return runHeuristicFallback({ sender, messageBody, startTime });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const prompt = `Sender ID: "${sender}"\nMessage Body:\n"""\n${messageBody}\n"""`;

    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTIONS,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.1, // High determinism for financial parsing
      },
    });

    const durationMs = Date.now() - startTime;
    const rawText = response.text;

    if (!rawText) {
      return {
        success: false,
        method: 'llm',
        reason: 'empty_model_response',
        durationMs,
      };
    }

    const parsed = JSON.parse(rawText);

    // Validate structured output logic
    if (!parsed.isPaymentReceived) {
      return {
        success: false,
        method: 'llm',
        reason: 'not_payment_received',
        durationMs,
      };
    }

    const cleanAmount = typeof parsed.amount === 'number' && parsed.amount > 0 ? parsed.amount : null;
    const cleanRef = typeof parsed.reference === 'string' && parsed.reference.trim().length >= 4 ? parsed.reference.trim() : null;

    if (!cleanAmount || !cleanRef) {
      return {
        success: false,
        method: 'llm',
        reason: 'missing_critical_fields_in_llm_output',
        durationMs,
      };
    }

    return {
      success: true,
      method: 'llm',
      durationMs,
      data: {
        amount: cleanAmount,
        currency: 'ETB',
        reference: cleanRef,
        payerName: parsed.payerName ? String(parsed.payerName).trim() : null,
        provider: parsed.provider ? String(parsed.provider).toUpperCase().trim() : sender.toUpperCase().trim(),
      },
    };
  } catch (error) {
    console.error('[LLM Fallback Engine Error]', error.message);
    // Graceful degradation: run heuristic fallback if LLM request fails
    return runHeuristicFallback({ sender, messageBody, startTime });
  }
}

/**
 * Resilient deterministic fallback parser when LLM is offline or unconfigured.
 */
function runHeuristicFallback({ sender, messageBody, startTime }) {
  // Amount regex
  let amount = null;
  const amountMatch = messageBody.match(/(?:ETB|Birr|ብር|Br\.?)\s*([0-9,]+(?:\.[0-9]{1,2})?)|([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:ETB|Birr|ብር|Br\.?)/i);
  if (amountMatch) {
    const raw = (amountMatch[1] || amountMatch[2]).replace(/,/g, '');
    const candidate = parseFloat(raw);
    if (!isNaN(candidate) && candidate > 0) amount = candidate;
  }

  // Reference regex
  let reference = null;
  const refMatch = messageBody.match(/(?:Ref(?:erence)?|Trx(?:Id)?|Txn(?:Id)?|Transaction\s*(?:ID|Number)|ማመሳከሪያ)\s*[:=\s]\s*([a-zA-Z0-9_&=-]{5,})|\b(FT[0-9A-Z]{6,})\b/i);
  if (refMatch) {
    reference = (refMatch[1] || refMatch[2]).trim();
  }

  // Payer regex
  let payerName = null;
  const payerMatch = messageBody.match(/(?:from|by|ከ|በ)\s+([A-Za-z\u1200-\u137F]{2,}(?:\s+[A-Za-z\u1200-\u137F]{2,})*?)(?=[.,;:]|\s+(?:to|on|with|ref|account|ለ|ማመሳከሪያ)|$)/i);
  if (payerMatch) {
    payerName = payerMatch[1].trim();
  }

  const durationMs = Date.now() - startTime;

  if (amount && reference) {
    return {
      success: true,
      method: 'heuristic_fallback',
      durationMs,
      data: {
        amount,
        currency: 'ETB',
        reference,
        payerName,
        provider: sender.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12) || 'BANK',
      },
    };
  }

  return {
    success: false,
    method: 'heuristic_fallback',
    reason: 'unable_to_extract_amount_or_reference',
    durationMs,
  };
}

