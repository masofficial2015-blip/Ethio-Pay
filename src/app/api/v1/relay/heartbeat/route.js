import { authenticateDevice, hashDeviceToken, mockState } from '@/lib/auth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export async function POST(request) {
  try {
    const rawToken = request.headers.get('x-device-token');
    const { device, merchant, error: authError } = await authenticateDevice(rawToken);

    if (authError || !device || !merchant) {
      return Response.json(
        { error: 'Unauthorized', message: authError || 'Invalid device token' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const {
      battery_level,
      is_battery_charging,
      network_type,
      is_foreground_service_running,
      has_sms_permission,
      has_notification_permission,
      is_battery_optimization_ignored,
      app_version,
    } = body;

    const tokenHash = hashDeviceToken(rawToken);
    const now = new Date().toISOString();

    const healthUpdate = {
      battery_level: typeof battery_level === 'number' ? battery_level : device.battery_level,
      is_battery_charging: typeof is_battery_charging === 'boolean' ? is_battery_charging : device.is_battery_charging,
      network_type: network_type || device.network_type,
      is_foreground_service_running:
        typeof is_foreground_service_running === 'boolean'
          ? is_foreground_service_running
          : device.is_foreground_service_running,
      has_sms_permission:
        typeof has_sms_permission === 'boolean' ? has_sms_permission : device.has_sms_permission,
      has_notification_permission:
        typeof has_notification_permission === 'boolean'
          ? has_notification_permission
          : device.has_notification_permission,
      is_battery_optimization_ignored:
        typeof is_battery_optimization_ignored === 'boolean'
          ? is_battery_optimization_ignored
          : device.is_battery_optimization_ignored,
      app_version: app_version || device.app_version,
      last_heartbeat_at: now,
      is_offline_alert_sent: false,
    };

    if (isSupabaseConfigured()) {
      await supabaseAdmin.from('devices').update(healthUpdate).eq('id', device.id);
      await supabaseAdmin.from('device_heartbeats').insert({
        device_id: device.id,
        battery_level: healthUpdate.battery_level,
        is_battery_charging: healthUpdate.is_battery_charging,
        network_type: healthUpdate.network_type,
        is_foreground_service_running: healthUpdate.is_foreground_service_running,
        recorded_at: now,
      });
    } else {
      const mockDev = mockState.devices.get(tokenHash);
      if (mockDev) {
        Object.assign(mockDev, healthUpdate);
      }
    }

    return Response.json({
      success: true,
      server_time: now,
      settings: {
        merchant_name: merchant.name,
        max_forwarding_amount: merchant.max_forwarding_amount,
      },
    });
  } catch (error) {
    console.error('Error handling device heartbeat:', error);
    return Response.json(
      { error: 'InternalServerError', message: error.message || 'Heartbeat processing failed' },
      { status: 500 }
    );
  }
}
