import { generateDeviceToken, hashDeviceToken, mockState } from '@/lib/auth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export async function POST(request) {
  try {
    const body = await request.json();
    const { pairing_code, device_name = 'Owner Android Phone', app_version = '1.0.0' } = body;

    if (!pairing_code) {
      return Response.json({ error: 'BadRequest', message: 'pairing_code is required' }, { status: 400 });
    }

    const cleanCode = String(pairing_code).trim();
    let merchantId = null;

    if (isSupabaseConfigured()) {
      const { data: record, error } = await supabaseAdmin
        .from('pairing_codes')
        .select('id, merchant_id, expires_at, used_at')
        .eq('code', cleanCode)
        .is('used_at', null)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

      if (error || !record) {
        return Response.json(
          { error: 'InvalidCode', message: 'Invalid, expired, or already used pairing code' },
          { status: 400 }
        );
      }

      merchantId = record.merchant_id;

      // Mark pairing code used
      await supabaseAdmin
        .from('pairing_codes')
        .update({ used_at: new Date().toISOString() })
        .eq('id', record.id);
    } else {
      if (process.env.NODE_ENV === 'production') {
        return Response.json(
          { error: 'ServiceUnavailable', message: 'Backend database is not configured for pairing.' },
          { status: 503 }
        );
      }

      const mockRecord = mockState.pairingCodes.get(cleanCode);
      if (!mockRecord || mockRecord.used || new Date(mockRecord.expires_at) < new Date()) {
        // Also allow the fallback master test code "888888" only in development mode
        if (cleanCode === '888888') {
          merchantId = '41a1a72d-6218-40a1-873d-9d41315579fa';
        } else {
          return Response.json(
            { error: 'InvalidCode', message: 'Invalid, expired, or already used pairing code' },
            { status: 400 }
          );
        }
      } else {
        merchantId = mockRecord.merchant_id;
        mockRecord.used = true;
      }
    }

    // Generate revocable device credentials
    const { rawToken, tokenHash } = generateDeviceToken();
    let deviceId = crypto.randomUUID();
    let merchantName = 'Kalu Pharmacy';
    let maxThreshold = 50000.0;

    if (isSupabaseConfigured()) {
      const { data: merchant } = await supabaseAdmin
        .from('merchants')
        .select('name, max_forwarding_amount')
        .eq('id', merchantId)
        .single();

      if (merchant) {
        merchantName = merchant.name;
        maxThreshold = merchant.max_forwarding_amount;
      }

      const { data: dev, error: devError } = await supabaseAdmin
        .from('devices')
        .insert({
          id: deviceId,
          merchant_id: merchantId,
          device_name,
          device_token_hash: tokenHash,
          app_version,
          is_active: true,
          last_heartbeat_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (devError) {
        return Response.json({ error: 'DatabaseError', message: devError.message }, { status: 500 });
      }
      deviceId = dev.id;
    } else {
      const m = mockState.merchants.get(merchantId);
      if (m) {
        merchantName = m.name;
        maxThreshold = m.max_forwarding_amount;
      }

      mockState.devices.set(tokenHash, {
        id: deviceId,
        merchant_id: merchantId,
        device_name,
        device_token_hash: tokenHash,
        app_version,
        is_active: true,
        battery_level: 90,
        is_battery_charging: false,
        network_type: 'WIFI',
        is_foreground_service_running: true,
        has_sms_permission: true,
        has_notification_permission: true,
        is_battery_optimization_ignored: true,
        last_heartbeat_at: new Date().toISOString(),
      });
    }

    return Response.json({
      success: true,
      device_id: deviceId,
      device_token: rawToken,
      merchant_id: merchantId,
      merchant_name: merchantName,
      max_forwarding_amount: maxThreshold,
      message: 'Device successfully paired and activated.',
    });
  } catch (error) {
    return Response.json({ error: 'InternalServerError', message: error.message }, { status: 500 });
  }
}

