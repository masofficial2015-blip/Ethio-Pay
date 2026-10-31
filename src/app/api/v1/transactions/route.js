import { authenticateOwner, mockState } from '@/lib/auth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export async function GET(request) {
  try {
    const authHeader = request.headers.get('authorization');
    const { merchant, error: authError } = await authenticateOwner(authHeader);

    if (authError || !merchant) {
      return Response.json({ error: 'Unauthorized', message: authError || 'Authentication required' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    if (isSupabaseConfigured()) {
      const { data, count, error } = await supabaseAdmin
        .from('transactions')
        .select('*', { count: 'exact' })
        .eq('merchant_id', merchant.id)
        .order('transaction_time', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        return Response.json({ error: 'DatabaseError', message: error.message }, { status: 500 });
      }

      return Response.json({
        success: true,
        total: count || 0,
        limit,
        offset,
        transactions: data || [],
      });
    }

    // Mock store
    const list = mockState.transactions
      .filter((t) => t.merchant_id === merchant.id)
      .sort((a, b) => new Date(b.transaction_time) - new Date(a.transaction_time));

    return Response.json({
      success: true,
      total: list.length,
      limit,
      offset,
      transactions: list.slice(offset, offset + limit),
    });
  } catch (error) {
    return Response.json({ error: 'InternalServerError', message: error.message }, { status: 500 });
  }
}

