import { supabaseAdmin, isSupabaseConfigured } from '../../../../../lib/supabase.js';
import { mockState } from '../../../../../lib/auth.js';
import { sendTelegramMessage } from '../../../../../lib/telegram.js';

// Global in-memory track of offline alert states per merchant
const offlineStatusTracker = new Map();

/**
 * Checks all active merchants and their devices for missing heartbeats.
 * If a device has not sent a heartbeat for > 3 minutes, dispatches a dead-man warning to the cashier Telegram group.
 * If the device has recovered, dispatches a recovery notice.
 */
export async function checkDeadManSwitches() {
  const OFFLINE_THRESHOLD_MS = (parseInt(process.env.DEVICE_OFFLINE_THRESHOLD_MINUTES, 10) || 3) * 60 * 1000;
  const now = Date.now();
  const results = [];

  let activeMerchants = [];
  if (isSupabaseConfigured()) {
    try {
      const { data, error } = await supabaseAdmin
        .from('merchants')
        .select(`
          id,
          name,
          cashiers (
            telegram_chat_id,
            is_active
          ),
          devices (
            id,
            device_name,
            last_heartbeat_at,
            network_type,
            is_active
          )
        `)
        .eq('is_active', true);

      if (!error && data) {
        activeMerchants = data;
      }
    } catch (e) {
      console.error('Failed to query merchants for dead-man check:', e);
    }
  } else {
    // Mock merchants
    for (const [id, m] of mockState.merchants.entries()) {
      const cashiers = Array.from(mockState.cashiers.values()).filter(c => c.merchant_id === id);
      const devices = Array.from(mockState.devices.values()).filter(d => d.merchant_id === id);
      activeMerchants.push({
        id,
        name: m.name,
        cashiers,
        devices,
      });
    }
  }

  for (const merchant of activeMerchants) {
    const devices = Array.isArray(merchant.devices) ? merchant.devices : [];
    // Pick the most recently active device
    const sortedDevices = devices
      .filter(d => d.is_active)
      .sort((a, b) => new Date(b.last_heartbeat_at || 0) - new Date(a.last_heartbeat_at || 0));
    const activeDevice = sortedDevices[0];

    const cashier = Array.isArray(merchant.cashiers)
      ? merchant.cashiers.find(c => c.is_active)
      : (merchant.cashiers?.is_active ? merchant.cashiers : null);

    const chatId = cashier?.telegram_chat_id || process.env.TELEGRAM_DEFAULT_CHAT_ID;

    if (!activeDevice || !chatId) continue;

    const lastBeatTime = activeDevice.last_heartbeat_at ? new Date(activeDevice.last_heartbeat_at).getTime() : 0;
    const isOffline = now - lastBeatTime > OFFLINE_THRESHOLD_MS;
    
    // Check persistent state across serverless cold starts
    const alertAlreadySent =
      activeDevice.is_offline_alert_sent === true ||
      activeDevice.network_type === 'OFFLINE_ALERTED' ||
      offlineStatusTracker.get(merchant.id)?.alertSent === true;

    if (isOffline && !alertAlreadySent) {
      // Send warning to cashier Telegram group once
      const warningMsg = `⚠️ <b>ALERT: OWNER DEVICE IS OFFLINE</b>\n\n` +
        ` <b>Payment alerts cannot be forwarded here automatically. please verify  transactions manually.</b>`;

      await sendTelegramMessage(chatId, warningMsg, merchant.id);

      // Persist that offline alert was sent
      if (isSupabaseConfigured()) {
        try {
          await supabaseAdmin.from('devices').update({
            is_offline_alert_sent: true,
            network_type: 'OFFLINE_ALERTED',
          }).eq('id', activeDevice.id);
        } catch (e) {
          try {
            await supabaseAdmin.from('devices').update({
              network_type: 'OFFLINE_ALERTED',
            }).eq('id', activeDevice.id);
          } catch (_) {}
        }
      }
      offlineStatusTracker.set(merchant.id, { isOffline: true, alertSent: true });
      results.push({ merchant: merchant.name, action: 'OFFLINE_WARNING_SENT' });
    } else if (!isOffline && alertAlreadySent) {
      // Reconnected! Send recovery notice once
      const recoveryMsg = `🟢 <b> NOTICE: SERVICE RESTORED</b>\n\n` +
        `owner's Device is back online and actively forwarding alerts here.`;

      await sendTelegramMessage(chatId, recoveryMsg, merchant.id);

      // Reset persistent offline alert state
      if (isSupabaseConfigured()) {
        try {
          await supabaseAdmin.from('devices').update({
            is_offline_alert_sent: false,
            network_type: 'ONLINE',
          }).eq('id', activeDevice.id);
        } catch (e) {
          try {
            await supabaseAdmin.from('devices').update({
              network_type: 'ONLINE',
            }).eq('id', activeDevice.id);
          } catch (_) {}
        }
      }
      offlineStatusTracker.set(merchant.id, { isOffline: false, alertSent: false });
      results.push({ merchant: merchant.name, action: 'RECOVERY_NOTICE_SENT' });
    }
  }

  return results;
}

export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  // Enforce mandatory fail-closed authentication in production
  if (process.env.NODE_ENV === 'production' || cronSecret) {
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return Response.json(
        { error: 'Unauthorized', message: 'Valid CRON_SECRET bearer token is required' },
        { status: 401 }
      );
    }
  }

  const results = await checkDeadManSwitches();
  return Response.json({
    success: true,
    timestamp: new Date().toISOString(),
    checked: results.length,
    results,
  });
}
