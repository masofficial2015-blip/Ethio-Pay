import { authenticateOwner, generatePairingCode, mockState } from '@/lib/auth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export async function POST(request) {
  try {
    const authHeader = request.headers.get('authorization');
    const { merchant, error: authError } = await authenticateOwner(authHeader);

    if (authError || !merchant) {
      return Response.json({ error: 'Unauthorized', message: authError || 'Authentication required' }, { status: 401 });
    }

    const { code, expiresAt } = generatePairingCode();

    if (isSupabaseConfigured()) {
      const { error } = await supabaseAdmin.from('pairing_codes').insert({
        merchant_id: merchant.id,
        code,
        expires_at: expiresAt.toISOString(),
      });

      if (error) {
        return Response.json({ error: 'DatabaseError', message: error.message }, { status: 500 });
      }
    } else {
      mockState.pairingCodes.set(code, {
        merchant_id: merchant.id,
        code,
        expires_at: expiresAt.toISOString(),
        used: false,
      });
    }

    return Response.json({
      success: true,
      pairing_code: code,
      expires_at: expiresAt.toISOString(),
      instructions: 'Enter this 6-digit code in the EthioPay Android app to pair your phone securely.',
    });
  } catch (error) {
    return Response.json({ error: 'InternalServerError', message: error.message }, { status: 500 });
  }
}

