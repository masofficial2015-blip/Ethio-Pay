import { authenticateOwner, mockState } from '@/lib/auth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';
import { linkTelegramGroup, sendTelegramMessage } from '@/lib/telegram';

export async function POST(request) {
  try {
    const authHeader = request.headers.get('authorization');
    const { merchant, error: authError } = await authenticateOwner(authHeader);

    if (authError || !merchant) {
      return Response.json({ error: 'Unauthorized', message: authError || 'Authentication required' }, { status: 401 });
    }

    const body = await request.json();
    const { chat_id, group_name = 'Cashiers Group', link_code } = body;

    if (!chat_id && !link_code) {
      return Response.json(
        { error: 'BadRequest', message: 'Either chat_id or link_code must be provided' },
        { status: 400 }
      );
    }

    let targetChatId = chat_id ? String(chat_id).trim() : null;

    if (link_code) {
      const cleanCode = String(link_code).trim().toUpperCase();

      if (isSupabaseConfigured()) {
        const { data: record, error } = await supabaseAdmin
          .from('telegram_link_codes')
          .select('id, merchant_id, expires_at, used_at')
          .eq('code', cleanCode)
          .eq('merchant_id', merchant.id)
          .is('used_at', null)
          .gt('expires_at', new Date().toISOString())
          .maybeSingle();

        if (error || !record) {
          return Response.json({ error: 'InvalidCode', message: 'Invalid or expired link code' }, { status: 400 });
        }

        await supabaseAdmin
          .from('telegram_link_codes')
          .update({ used_at: new Date().toISOString() })
          .eq('id', record.id);
      } else {
        const mockCode = mockState.telegramLinkCodes.get(cleanCode);
        if (!mockCode || mockCode.used || new Date(mockCode.expires_at) < new Date()) {
          return Response.json({ error: 'InvalidCode', message: 'Invalid or expired link code' }, { status: 400 });
        }
        mockCode.used = true;
      }
    }

    if (!targetChatId) {
      return Response.json({ error: 'BadRequest', message: 'Telegram group chat_id is required' }, { status: 400 });
    }

    // Link in database
    const linkResult = await linkTelegramGroup(merchant.id, targetChatId, group_name);
    if (!linkResult.success) {
      return Response.json({ error: 'LinkError', message: linkResult.error }, { status: 500 });
    }

    const linkedTimeStr = new Date().toLocaleTimeString('en-US', {
      timeZone: 'Africa/Addis_Ababa',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });

    // Send confirmation message to group
    const confirmationText = `✅ <b>Telegram Cashier Group Successfully Linked!</b>
━━━━━━━━━━━━━━━━━━━━━
🏢 <b>Pharmacy:</b> ${merchant.name}
🔢 <b>Chat ID:</b> <code>${targetChatId}</code>
🕒 <b>Linked At:</b> ${linkedTimeStr}
━━━━━━━━━━━━━━━━━━━━━
<i>Eligible payment alerts from the owner's phone will now arrive here automatically.</i>`;

    await sendTelegramMessage(targetChatId, confirmationText);

    return Response.json({
      success: true,
      message: `Telegram cashier group successfully linked to ${merchant.name}`,
      chat_id: targetChatId,
      group_name,
    });
  } catch (error) {
    return Response.json({ error: 'InternalServerError', message: error.message }, { status: 500 });
  }
}

