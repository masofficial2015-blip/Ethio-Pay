import { authenticateDevice, mockState } from '@/lib/auth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';
import { broadcastToCashiers } from '@/lib/telegram';
import { parseHybridPaymentSms } from '@/lib/parser/hybridParser';

export async function POST(request) {
  try {
    // 1. Authenticate Device via X-Device-Token header
    const deviceToken = request.headers.get('x-device-token');
    const { device, merchant, error: authError } = await authenticateDevice(deviceToken);

    if (authError || !device || !merchant) {
      return Response.json(
        { error: 'Unauthorized', message: authError || 'Invalid device token' },
        { status: 401 }
      );
    }

    const merchantId = merchant.id;
    const body = await request.json();

    let provider;
    let reference_number;
    let amount;
    let currency = 'ETB';
    let payer_name = null;
    let payer_account_or_phone = null;
    let receiver_account = null;
    let transaction_time = null;
    let parsingMethod = 'direct';
    let parsingStage = 'direct';

    // Check if payload is a raw SMS for the Hybrid Tiered Parser
    const rawSmsBody = body.message_body || body.sms_body || body.raw_sms;
    const smsSender = body.sender || body.originating_address;

    if (rawSmsBody && smsSender) {
      // 2A. Execute Hybrid Tiered Pipeline (Pre-Filter Gate -> Fast Regex -> LLM Fallback)
      const parseResult = await parseHybridPaymentSms({
        sender: smsSender,
        messageBody: rawSmsBody,
      });

      if (parseResult.dropped) {
        return Response.json(
          {
            success: false,
            dropped: true,
            stage: parseResult.stage,
            reason: parseResult.reason,
            detail: parseResult.detail,
          },
          { status: 200 }
        );
      }

      if (!parseResult.success) {
        return Response.json(
          {
            success: false,
            stage: parseResult.stage,
            reason: parseResult.reason || 'unrecognized_sms_format',
          },
          { status: 400 }
        );
      }

      // Successfully parsed via Stage 1 (Fast Regex) or Stage 2 (LLM Fallback)
      provider = parseResult.data.provider;
      reference_number = parseResult.data.reference;
      amount = parseResult.data.amount;
      currency = parseResult.data.currency || 'ETB';
      payer_name = parseResult.data.payerName;
      receiver_account = parseResult.data.receiverAccount;
      transaction_time = new Date().toISOString();
      parsingMethod = parseResult.method; // 'regex' or 'llm'
      parsingStage = parseResult.stage;
    } else {
      // 2B. Direct Structured Payload (Backwards compatibility with local-parsing mobile APKs)
      const privacyViolations = [];
      const forbiddenKeys = [
        'balance',
        'current_balance',
        'working_balance',
        'available_balance',
        'raw_sms',
        'sms_body',
        'body',
        'original_text',
      ];

      for (const key of forbiddenKeys) {
        if (body[key] !== undefined) {
          privacyViolations.push(key);
        }
      }

      if (privacyViolations.length > 0) {
        return Response.json(
          {
            error: 'PrivacyViolation',
            message: `Forbidden fields detected: ${privacyViolations.join(', ')}. EthioPay strictly rejects balance fields.`,
          },
          { status: 400 }
        );
      }

      provider = body.provider;
      reference_number = body.reference_number;
      amount = body.amount;
      currency = body.currency || 'ETB';
      payer_name = body.payer_name;
      payer_account_or_phone = body.payer_account_or_phone;
      receiver_account = body.receiver_account;
      transaction_time = body.transaction_time;
    }

    // 3. Validate Required Transaction Fields
    if (!provider || !reference_number || amount === undefined || amount === null) {
      return Response.json(
        {
          error: 'BadRequest',
          message: 'Missing required fields: provider, reference_number, and amount are mandatory.',
        },
        { status: 400 }
      );
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return Response.json(
        { error: 'BadRequest', message: 'Amount must be a positive number.' },
        { status: 400 }
      );
    }

    // 4. Server-Side Amount Defense in Depth:
    // Reject if amount > merchant threshold
    const effectiveThreshold = Number(merchant.max_forwarding_amount || 50000.0);
    if (numericAmount > effectiveThreshold) {
      return Response.json(
        {
          error: 'ThresholdExceeded',
          message: 'Amount exceeds merchant maximum forwarding threshold. Silently dropped.',
        },
        { status: 400 }
      );
    }

    // 5. Deduplication Check: Prevent duplicate processing & duplicate Telegram alerts
    const cleanRef = reference_number.trim();
    const cleanProvider = provider.toUpperCase().trim();

    if (isSupabaseConfigured()) {
      const { data: existingTx } = await supabaseAdmin
        .from('transactions')
        .select('id, telegram_delivered_at')
        .eq('merchant_id', merchantId)
        .eq('provider', cleanProvider)
        .eq('reference_number', cleanRef)
        .maybeSingle();

      if (existingTx) {
        return Response.json({
          success: true,
          duplicate: true,
          method: parsingMethod,
          transaction_id: existingTx.id,
          message: 'Transaction already recorded. Suppressed duplicate Telegram alert.',
        });
      }
    } else {
      const existing = mockState.transactions.find(
        (t) => t.merchant_id === merchantId && t.provider === cleanProvider && t.reference_number === cleanRef
      );
      if (existing) {
        return Response.json({
          success: true,
          duplicate: true,
          method: parsingMethod,
          transaction_id: existing.id,
          message: 'Transaction already recorded in mock store. Suppressed duplicate Telegram alert.',
        });
      }
    }

    // 6. Query Active Cashier Telegram Groups
    let cashierChatIds = [];
    if (isSupabaseConfigured()) {
      const { data: cashiers } = await supabaseAdmin
        .from('cashiers')
        .select('telegram_chat_id')
        .eq('merchant_id', merchantId)
        .eq('is_active', true);

      if (cashiers && cashiers.length > 0) {
        cashierChatIds = cashiers.map((c) => c.telegram_chat_id);
      }
    } else {
      const mockCashier = mockState.cashiers.get(merchantId);
      if (mockCashier && mockCashier.is_active && mockCashier.telegram_chat_id) {
        cashierChatIds = [mockCashier.telegram_chat_id];
      }
    }

    if (cashierChatIds.length === 0 && process.env.TELEGRAM_DEFAULT_CHAT_ID) {
      cashierChatIds = [process.env.TELEGRAM_DEFAULT_CHAT_ID];
    }

    // 7. Dispatch Telegram Alert to Cashier Group
    const txData = {
      provider: cleanProvider,
      reference_number: cleanRef,
      amount: numericAmount,
      currency,
      payer_name: payer_name ? String(payer_name).trim() : null,
      payer_account_or_phone: payer_account_or_phone ? String(payer_account_or_phone).trim() : null,
      receiver_account: receiver_account ? String(receiver_account).trim() : null,
      transaction_time: transaction_time || new Date().toISOString(),
    };

    // 7. Persist Transaction in Database FIRST to acquire atomic deduplication lock
    let transactionId = crypto.randomUUID();

    if (isSupabaseConfigured()) {
      const { data: inserted, error: insertError } = await supabaseAdmin
        .from('transactions')
        .insert({
          id: transactionId,
          merchant_id: merchantId,
          device_id: device.id,
          provider: cleanProvider,
          reference_number: cleanRef,
          amount: numericAmount,
          currency,
          payer_name: txData.payer_name,
          payer_account_or_phone: txData.payer_account_or_phone,
          receiver_account: txData.receiver_account,
          transaction_time: txData.transaction_time,
          status: 'PROCESSED',
          telegram_delivered_at: null,
          telegram_error: null,
        })
        .select('id')
        .single();

      if (insertError) {
        if (insertError.code === '23505') {
          // Unique constraint violation: duplicate received concurrently!
          // Suppress Telegram alert and return duplicate=true
          return Response.json({
            success: true,
            duplicate: true,
            method: parsingMethod,
            message: 'Concurrent duplicate detected and suppressed. No duplicate Telegram alert sent.',
          });
        }
        return Response.json({ error: 'DatabaseError', message: insertError.message }, { status: 500 });
      }

      transactionId = inserted.id;
    } else {
      mockState.transactions.push({
        id: transactionId,
        merchant_id: merchantId,
        device_id: device.id,
        ...txData,
        telegram_delivered: false,
        created_at: new Date().toISOString(),
      });
    }

    // 8. Now that database lock is acquired uniquely, dispatch Telegram Alert to Cashier Group
    const telegramResult = await broadcastToCashiers(cashierChatIds, txData, merchantId);

    // Update telegram delivery status on the persisted record
    if (isSupabaseConfigured()) {
      await supabaseAdmin
        .from('transactions')
        .update({
          telegram_delivered_at: telegramResult.deliveredCount > 0 ? new Date().toISOString() : null,
          telegram_error: telegramResult.errors.length > 0 ? telegramResult.errors.join('; ') : null,
        })
        .eq('id', transactionId);
    } else {
      const tx = mockState.transactions.find((t) => t.id === transactionId);
      if (tx) {
        tx.telegram_delivered = telegramResult.deliveredCount > 0;
      }
    }

    return Response.json({
      success: true,
      duplicate: false,
      method: parsingMethod,
      stage: parsingStage,
      transaction_id: transactionId,
      telegram_delivered: telegramResult.deliveredCount > 0,
      delivered_chat_count: telegramResult.deliveredCount,
      data: {
        provider: cleanProvider,
        reference_number: cleanRef,
        amount: numericAmount,
        currency,
        payer_name: txData.payer_name,
      },
    });
  } catch (error) {
    console.error('Error handling transaction relay:', error);
    return Response.json(
      { error: 'InternalServerError', message: error.message || 'Unexpected server error' },
      { status: 500 }
    );
  }
}
