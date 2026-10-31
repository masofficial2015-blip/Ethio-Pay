import { authenticateOwner, mockState } from '@/lib/auth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';
import { getLinkedGroup } from '@/lib/telegram';

export async function GET(request) {
  try {
    const authHeader = request.headers.get('authorization');
    const { user, merchant, error: authError } = await authenticateOwner(authHeader);

    if (authError || !merchant) {
      return Response.json({ error: 'Unauthorized', message: authError || 'Authentication required' }, { status: 401 });
    }

    let device = null;
    let todayCount = 0;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    if (isSupabaseConfigured()) {
      // Fetch primary active device for merchant
      const { data: dev } = await supabaseAdmin
        .from('devices')
        .select('*')
        .eq('merchant_id', merchant.id)
        .eq('is_active', true)
        .order('last_heartbeat_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();

      device = dev;

      // Count today's transactions
      const { count } = await supabaseAdmin
        .from('transactions')
        .select('*', { count: 'exact', head: true })
        .eq('merchant_id', merchant.id)
        .gte('created_at', startOfToday.toISOString());

      todayCount = count || 0;
    } else {
      // Mock lookup
      for (const dev of mockState.devices.values()) {
        if (dev.merchant_id === merchant.id) {
          device = dev;
          break;
        }
      }
      todayCount = mockState.transactions.filter(
        (tx) => tx.merchant_id === merchant.id && new Date(tx.created_at) >= startOfToday
      ).length;
    }

    const linkedGroup = await getLinkedGroup(merchant.id);

    // Compute device freshness
    const lastHeartbeat = device?.last_heartbeat_at ? new Date(device.last_heartbeat_at) : null;
    const minutesSinceHeartbeat = lastHeartbeat ? (Date.now() - lastHeartbeat.getTime()) / 60000 : 999;
    const isDeviceOnline = minutesSinceHeartbeat < 15 && (device?.is_foreground_service_running ?? false);

    // Collect actionable warnings
    const warnings = [];
    if (!linkedGroup || !linkedGroup.telegram_chat_id) {
      warnings.push({
        id: 'no_telegram',
        level: 'WARNING',
        message: 'Telegram cashier group is not linked. Cashiers will not receive payment alerts.',
      });
    }

    if (!isDeviceOnline) {
      warnings.push({
        id: 'device_offline',
        level: 'CRITICAL',
        message: 'owner device is offline. Cashiers must physically verify customer payments.',
      });
    }

    if (device && !device.has_sms_permission) {
      warnings.push({
        id: 'missing_sms_perm',
        level: 'CRITICAL',
        message: 'SMS capture permission is revoked on the owner device.',
      });
    }

    if (device && !device.is_battery_optimization_ignored) {
      warnings.push({
        id: 'battery_saver_active',
        level: 'WARNING',
        message: 'Battery optimization is enabled. SMS relay may sleep when phone is locked.',
      });
    }

    return Response.json({
      success: true,
      merchant: {
        id: merchant.id,
        name: merchant.name,
        max_forwarding_amount: merchant.max_forwarding_amount,
      },
      device: device
        ? {
          id: device.id,
          name: device.device_name,
          is_online: isDeviceOnline,
          battery_level: device.battery_level,
          is_battery_charging: device.is_battery_charging,
          network_type: device.network_type,
          is_foreground_service_running: device.is_foreground_service_running,
          has_sms_permission: device.has_sms_permission,
          has_notification_permission: device.has_notification_permission,
          is_battery_optimization_ignored: device.is_battery_optimization_ignored,
          last_heartbeat_at: device.last_heartbeat_at,
        }
        : null,
      telegram: {
        is_linked: !!linkedGroup?.telegram_chat_id,
        chat_id: linkedGroup?.telegram_chat_id || null,
        name: linkedGroup?.name || null,
      },
      today_transaction_count: todayCount,
      warnings,
      server_time: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching merchant status:', error);
    return Response.json({ error: 'InternalServerError', message: error.message }, { status: 500 });
  }
}

