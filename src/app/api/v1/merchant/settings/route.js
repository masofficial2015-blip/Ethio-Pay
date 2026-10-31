import { authenticateOwner, mockState } from '@/lib/auth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export async function GET(request) {
  try {
    const authHeader = request.headers.get('authorization');
    const { merchant, error: authError } = await authenticateOwner(authHeader);

    if (authError || !merchant) {
      return Response.json({ error: 'Unauthorized', message: authError || 'Authentication required' }, { status: 401 });
    }

    return Response.json({
      success: true,
      settings: {
        merchant_id: merchant.id,
        merchant_name: merchant.name,
        max_forwarding_amount: merchant.max_forwarding_amount,
      },
    });
  } catch (error) {
    return Response.json({ error: 'InternalServerError', message: error.message }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const authHeader = request.headers.get('authorization');
    const { merchant, error: authError } = await authenticateOwner(authHeader);

    if (authError || !merchant) {
      return Response.json({ error: 'Unauthorized', message: authError || 'Authentication required' }, { status: 401 });
    }

    const body = await request.json();
    const { max_forwarding_amount } = body;

    if (max_forwarding_amount === undefined || max_forwarding_amount === null) {
      return Response.json({ error: 'BadRequest', message: 'max_forwarding_amount is required' }, { status: 400 });
    }

    const numericAmount = parseFloat(max_forwarding_amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return Response.json({ error: 'BadRequest', message: 'Amount must be a positive number' }, { status: 400 });
    }

    if (numericAmount > 10000000) {
      return Response.json({ error: 'BadRequest', message: 'Maximum threshold cannot exceed 10,000,000 ETB' }, { status: 400 });
    }

    if (isSupabaseConfigured()) {
      const { data, error } = await supabaseAdmin
        .from('merchants')
        .update({ max_forwarding_amount: numericAmount, updated_at: new Date().toISOString() })
        .eq('id', merchant.id)
        .select()
        .single();

      if (error) {
        return Response.json({ error: 'DatabaseError', message: error.message }, { status: 500 });
      }

      return Response.json({
        success: true,
        message: 'Settings updated successfully',
        settings: {
          merchant_id: data.id,
          merchant_name: data.name,
          max_forwarding_amount: data.max_forwarding_amount,
        },
      });
    }

    // Mock store
    const mockM = mockState.merchants.get(merchant.id);
    if (mockM) {
      mockM.max_forwarding_amount = numericAmount;
    }

    return Response.json({
      success: true,
      message: 'Settings updated in mock store',
      settings: {
        merchant_id: merchant.id,
        merchant_name: merchant.name,
        max_forwarding_amount: numericAmount,
      },
    });
  } catch (error) {
    return Response.json({ error: 'InternalServerError', message: error.message }, { status: 500 });
  }
}

