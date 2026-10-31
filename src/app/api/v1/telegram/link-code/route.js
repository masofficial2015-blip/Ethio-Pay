import { authenticateOwner, generateTelegramLinkCode, mockState } from '@/lib/auth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export async function POST(request) {
  try {
    const authHeader = request.headers.get('authorization');
    const { merchant, error: authError } = await authenticateOwner(authHeader);

    if (authError || !merchant) {
      return Response.json({ error: 'Unauthorized', message: authError || 'Authentication required' }, { status: 401 });
    }

    const { code, expiresAt } = generateTelegramLinkCode();

    if (isSupabaseConfigured()) {
      const { error } = await supabaseAdmin.from('telegram_link_codes').insert({
        merchant_id: merchant.id,
        code,
        expires_at: expiresAt.toISOString(),
      });

      if (error) {
        return Response.json({ error: 'DatabaseError', message: error.message }, { status: 500 });
      }
    } else {
      mockState.telegramLinkCodes.set(code, {
        merchant_id: merchant.id,
        code,
        expires_at: expiresAt.toISOString(),
        used: false,
      });
    }

    return Response.json({
      success: true,
      link_code: code,
      expires_at: expiresAt.toISOString(),
      instructions: `Add the Telegram bot to your cashier group as Admin, then send: /link ${code}`,
    });
  } catch (error) {
    return Response.json({ error: 'InternalServerError', message: error.message }, { status: 500 });
  }
}

