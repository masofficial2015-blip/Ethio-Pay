import { evaluatePreFilterGate } from './preFilterGate.js';
import { runFastRegexEngine } from './fastRegexEngine.js';
import { runLlmFallbackEngine } from './llmFallbackEngine.js';

/**
 * Hybrid Tiered Payment SMS Parser.
 *
 * Architecture:
 * 1. Pre-Filter Gate:
 *    - Rejects standard personal mobile numbers (+2519..., 09..., 07...).
 *    - Validates sender is an Alphanumeric Title or official bank shortcode.
 *    - Drops outbound debits, payments made, or deductions (English & Amharic).
 *    - Enforces presence of credit indicators.
 *    - Dropped messages are NEVER sent to LLM.
 *
 * 2. Stage 1: Fast Regex Engine (<10ms, $0 cost):
 *    - Extracts payments from known templates (CBE, Telebirr, Mpesa, BoA, Awash, Dashen, Nib, etc.).
 *    - If high confidence, returns structured data immediately. DO NOT call LLM.
 *
 * 3. Stage 2: LLM Fallback Engine (Gemini 3.1 Flash Lite / Gemini Flash):
 *    - Triggered ONLY when Stage 1 fails or returns low confidence.
 *    - Strict JSON structured output with domain rules for Ethiopian banking.
 *
 * @param {object} params
 * @param {string} params.sender
 * @param {string} params.messageBody
 * @returns {Promise<{
 *   success: boolean,
 *   stage: 'pre_filter' | 'regex' | 'llm_fallback' | 'unparsed',
 *   method?: string,
 *   dropped?: boolean,
 *   reason?: string,
 *   durationMs?: number,
 *   data?: {
 *     amount: number,
 *     currency: string,
 *     reference: string,
 *     payerName: string | null,
 *     provider: string,
 *     receiverAccount?: string | null
 *   }
 * }>}
 */
export async function parseHybridPaymentSms({ sender, messageBody }) {
  const totalStartTime = Date.now();

  // 1. Pre-Filter Gate
  const gateResult = evaluatePreFilterGate({ sender, messageBody });
  if (!gateResult.allowed) {
    return {
      success: false,
      stage: 'pre_filter',
      dropped: true,
      reason: gateResult.reason,
      detail: gateResult.detail,
      totalDurationMs: Date.now() - totalStartTime,
    };
  }

  // 2. Stage 1: Fast Regex Engine (<10ms, $0 cost)
  const regexResult = runFastRegexEngine({ sender, messageBody });
  if (regexResult.success && regexResult.confidence === 'high') {
    return {
      success: true,
      stage: 'regex',
      method: 'regex',
      data: regexResult.data,
      regexDurationMs: regexResult.durationMs,
      totalDurationMs: Date.now() - totalStartTime,
    };
  }

  // 3. Stage 2: LLM Fallback Engine (Gemini Flash)
  const llmResult = await runLlmFallbackEngine({ sender, messageBody });
  if (llmResult.success && llmResult.data) {
    return {
      success: true,
      stage: 'llm_fallback',
      method: llmResult.method,
      data: llmResult.data,
      llmDurationMs: llmResult.durationMs,
      totalDurationMs: Date.now() - totalStartTime,
    };
  }

  return {
    success: false,
    stage: 'unparsed',
    reason: llmResult.reason || 'unrecognized_sms_format',
    totalDurationMs: Date.now() - totalStartTime,
  };
}

