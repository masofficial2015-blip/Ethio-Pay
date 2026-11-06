import { supabaseAdmin, isSupabaseConfigured } from './supabase.js';
import { mockState } from './auth.js';

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const PROVIDER_NAMES = {
  CBE: 'Commercial Bank of Ethiopia (CBE)',
  TELEBIRR: 'telebirr (Ethio telecom)',
  MPESA: 'M-PESA (Safaricom)',
  BOA: 'Bank of Abyssinia (BOA)',
  NIB: 'Nib International Bank (NIB)',
  BERHAN: 'Berhan Bank',
  HIBRET: 'Hibret Bank',
  AWASH: 'Awash Bank',
  CBE_BIRR: 'CBE Birr',
};

export function formatCashierAlert(transaction) {
  const providerLabel = PROVIDER_NAMES[transaction.provider] || transaction.provider;
  const formattedAmount = Number(transaction.amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const payerInfo = transaction.payer_name
    ? `${escapeHtml(transaction.payer_name)}${transaction.payer_account_or_phone ? ` (${escapeHtml(transaction.payer_account_or_phone)})` : ''
    }`
    : transaction.payer_account_or_phone
      ? escapeHtml(transaction.payer_account_or_phone)
      : 'Customer';

  const timeStr = transaction.transaction_time
    ? new Date(transaction.transaction_time).toLocaleTimeString('en-US', {
      timeZone: 'Africa/Addis_Ababa',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    })
    : new Date().toLocaleTimeString('en-US', {
      timeZone: 'Africa/Addis_Ababa',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });

  const dateStr = transaction.transaction_time
    ? new Date(transaction.transaction_time).toLocaleDateString('en-CA', { timeZone: 'Africa/Addis_Ababa' })
    : new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Addis_Ababa' });

  return `🔔 <b>PAYMENT RECEIVED</b>
━━━━━━━━━━━━━━━━━━━━━
💰 <b>Amount:</b> <b>${transaction.currency || 'ETB'} ${formattedAmount}</b>
🏦 <b>Provider:</b> ${escapeHtml(providerLabel)}
👤 <b>From:</b> ${payerInfo}
🔢 <b>Reference:</b> <code>${escapeHtml(transaction.reference_number)}</code>
🕒 <b>Time:</b> ${timeStr} (${dateStr})
━━━━━━━━━━━━━━━━━━━━━
`;
}

export async function sendTelegramMessage(chatId, messageHtml, merchantId = null) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken || botToken.includes('XYZ') || botToken.includes('placeholder')) {
    console.log(`[SIMULATED TELEGRAM ALERT] -> Chat ID: ${chatId}`);
    console.log(messageHtml);
    return {
      success: true,
      simulated: true,
      messageId: Math.floor(Math.random() * 100000) + 1,
    };
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    let currentChatId = String(chatId).trim();
    let response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: currentChatId,
        text: messageHtml,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    let data = await response.json();

    // Handle Telegram Group upgraded to Supergroup migration automatically
    if (!response.ok || !data.ok) {
      const migrateToChatId = data.parameters?.migrate_to_chat_id;
      const isSupergroupUpgrade =
        migrateToChatId ||
        (data.description && data.description.toLowerCase().includes('upgraded to a supergroup'));

      if (isSupergroupUpgrade) {
        // If migrate_to_chat_id is provided by Telegram, use it; otherwise prepend -100 if it was a plain negative ID
        const newChatId = migrateToChatId
          ? String(migrateToChatId)
          : currentChatId.startsWith('-100')
          ? currentChatId
          : `-100${currentChatId.replace('-', '')}`;

        console.log(`[Telegram Auto-Migration] Group ${currentChatId} upgraded to supergroup ${newChatId}. Auto-migrating & retrying...`);

        // If merchantId is provided, update DB / mockState with the new supergroup ID immediately
        if (merchantId) {
          try {
            await linkTelegramGroup(merchantId, newChatId);
          } catch (e) {
            console.error('[Telegram Auto-Migration] Failed to persist migrated chat ID:', e);
          }
        }

        // Retry sending to the new supergroup ID
        const retryResponse = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: newChatId,
            text: messageHtml,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        });

        const retryData = await retryResponse.json();
        if (retryResponse.ok && retryData.ok) {
          return {
            success: true,
            messageId: retryData.result?.message_id,
            migratedToChatId: newChatId,
          };
        }

        return {
          success: false,
          error: retryData.description || 'Failed to deliver to migrated supergroup',
          migratedToChatId: newChatId,
        };
      }

      return {
        success: false,
        error: data.description || 'Unknown Telegram API error',
      };
    }

    return {
      success: true,
      messageId: data.result?.message_id,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Network failure communicating with Telegram API',
    };
  }
}

export async function linkTelegramGroup(merchantId, chatId, groupName = 'Cashiers Group') {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabaseAdmin
      .from('cashiers')
      .upsert(
        {
          merchant_id: merchantId,
          telegram_chat_id: String(chatId).trim(),
          name: groupName,
          is_active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'merchant_id' }
      )
      .select()
      .single();

    if (error) {
      console.error('Failed to link Telegram group in DB:', error);
      return { success: false, error: error.message };
    }
    return { success: true, cashier: data };
  }

  // Mock store
  mockState.cashiers.set(merchantId, {
    merchant_id: merchantId,
    telegram_chat_id: String(chatId).trim(),
    name: groupName,
    is_active: true,
    linked_at: new Date().toISOString(),
  });

  return { success: true };
}

export async function getLinkedGroup(merchantId) {
  if (isSupabaseConfigured()) {
    const { data } = await supabaseAdmin
      .from('cashiers')
      .select('telegram_chat_id, name, is_active, updated_at')
      .eq('merchant_id', merchantId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    return data;
  }

  return mockState.cashiers.get(merchantId) || null;
}

export async function broadcastToCashiers(chatIds, transaction, merchantId = null) {
  const messageHtml = formatCashierAlert(transaction);
  const targetChats = chatIds && chatIds.length > 0
    ? chatIds
    : [process.env.TELEGRAM_DEFAULT_CHAT_ID || '-1001234567890'];

  let deliveredCount = 0;
  const errors = [];

  for (const chatId of targetChats) {
    if (!chatId) continue;
    const result = await sendTelegramMessage(chatId, messageHtml, merchantId);
    if (result.success) {
      deliveredCount++;
    } else {
      errors.push(`Chat ${chatId}: ${result.error}`);
    }
  }

  return { deliveredCount, errors };
}
