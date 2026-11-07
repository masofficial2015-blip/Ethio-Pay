import crypto from 'crypto';
import { supabaseAdmin, isSupabaseConfigured } from './supabase.js';

// In-memory fallback stores for offline local testing / development
export const mockState = {
  merchants: new Map([
    [
      '41a1a72d-6218-40a1-873d-9d41315579fa',
      {
        id: '41a1a72d-6218-40a1-873d-9d41315579fa',
        name: 'Kalu Pharmacy',
        owner_email: 'owner@kalupharma.com',
        phone_number: '+251911223344',
        max_forwarding_amount: 50000.0,
        is_active: true,
      },
    ],
  ]),
  devices: new Map([
    [
      // Hash of "ethiopay_live_demo_device_token_secret_123"
      '3023425e1af4778f0dae3927bb27f8e5ebba6917d0dd14e6d39a1f6bafa69b5e',
      {
        id: 'a90b4104-e34b-441c-8b89-98319f36f903',
        merchant_id: '41a1a72d-6218-40a1-873d-9d41315579fa',
        device_name: 'Owner Samsung Galaxy S23',
        is_active: true,
        battery_level: 88,
        is_battery_charging: false,
        network_type: 'WIFI',
        is_foreground_service_running: true,
        has_sms_permission: true,
        has_notification_permission: true,
        is_battery_optimization_ignored: true,
        last_heartbeat_at: new Date().toISOString(),
      },
    ],
  ]),
  cashiers: new Map([
    [
      '41a1a72d-6218-40a1-873d-9d41315579fa',
      {
        id: 'e7a9b1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c',
        merchant_id: '41a1a72d-6218-40a1-873d-9d41315579fa',
        telegram_chat_id: '-1001234567890',
        name: 'Kalu Cashiers Group',
        is_active: true,
        linked_at: new Date().toISOString(),
      },
    ],
  ]),
  transactions: [],
  pairingCodes: new Map(),
  telegramLinkCodes: new Map(),
};

/**
 * Computes SHA-256 hex digest of a token.
 */
export function hashDeviceToken(token) {
  if (!token || typeof token !== 'string') return '';
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

/**
 * Generates a cryptographically secure random device token.
 */
export function generateDeviceToken() {
  const randomBytes = crypto.randomBytes(24).toString('hex');
  const rawToken = `ethiopay_live_${randomBytes}`;
  const tokenHash = hashDeviceToken(rawToken);
  return { rawToken, tokenHash };
}

/**
 * Generates a short-lived 6-digit numeric pairing code.
 */
export function generatePairingCode() {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  return { code, expiresAt };
}

/**
 * Generates an expiring Telegram group linking code (e.g., EP-4921).
 */
export function generateTelegramLinkCode() {
  const num = Math.floor(1000 + Math.random() * 9000);
  const code = `EP-${num}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
  return { code, expiresAt };
}

/**
 * Authenticates an Android relay request via X-Device-Token.
 */
export async function authenticateDevice(rawToken) {
  if (!rawToken) {
    return { device: null, merchant: null, error: 'Missing X-Device-Token header' };
  }

  const tokenHash = hashDeviceToken(rawToken);

  if (isSupabaseConfigured()) {
    try {
      const { data, error } = await supabaseAdmin
        .from('devices')
        .select(`
          id,
          merchant_id,
          device_name,
          is_active,
          battery_level,
          is_battery_charging,
          network_type,
          is_foreground_service_running,
          has_sms_permission,
          has_notification_permission,
          is_battery_optimization_ignored,
          is_offline_alert_sent,
          last_heartbeat_at,
          merchants (
            id,
            name,
            max_forwarding_amount,
            is_active
          )
        `)
        .eq('device_token_hash', tokenHash)
        .eq('is_active', true)
        .single();

      if (error || !data) {
        return { device: null, merchant: null, error: 'Invalid or revoked device token' };
      }

      if (data.merchants && !data.merchants.is_active) {
        return { device: null, merchant: null, error: 'Merchant account is inactive' };
      }

      return { device: data, merchant: data.merchants, error: null };
    } catch (err) {
      console.error('Database authentication error:', err);
      return { device: null, merchant: null, error: 'Database connection failure' };
    }
  }

  // Mock fallback
  if (process.env.NODE_ENV === 'production') {
    return { device: null, merchant: null, error: 'Invalid or revoked device token' };
  }

  const mockDev = mockState.devices.get(tokenHash);
  if (mockDev && mockDev.is_active) {
    const merchant = mockState.merchants.get(mockDev.merchant_id);
    return { device: mockDev, merchant, error: null };
  }

  return { device: null, merchant: null, error: 'Invalid or revoked device token' };
}

/**
 * Authenticates an owner request via Supabase Auth JWT (Authorization: Bearer <token>).
 */
export async function authenticateOwner(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { user: null, merchant: null, error: 'Missing or malformed Authorization header' };
  }

  const token = authHeader.replace('Bearer ', '').trim();

  if (isSupabaseConfigured()) {
    try {
      // Allow mock owner token only in non-production development/test mode
      if (token === 'mock_jwt_owner_kalu_pharma_token_2026') {
        if (process.env.NODE_ENV === 'production') {
          return { user: null, merchant: null, error: 'Unauthorized: Mock tokens disabled in production' };
        }
        const defaultMerchant = mockState.merchants.get('41a1a72d-6218-40a1-873d-9d41315579fa');
        return {
          user: { id: '04a335e6-fedd-4eda-b46e-7ba048e739c8', email: 'owner@kalupharma.com' },
          merchant: defaultMerchant,
          error: null,
        };
      }

      const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
      if (authError || !user) {
        return { user: null, merchant: null, error: 'Invalid session token' };
      }

      // Query merchant owned by user
      const { data: merchant, error: merchError } = await supabaseAdmin
        .from('merchants')
        .select('*')
        .eq('owner_id', user.id)
        .eq('is_active', true)
        .maybeSingle();

      if (merchError || !merchant) {
        // Fallback: check by email match if owner_id not set yet
        const { data: emailMerchant } = await supabaseAdmin
          .from('merchants')
          .select('*')
          .eq('owner_email', user.email)
          .eq('is_active', true)
          .maybeSingle();

        if (emailMerchant) {
          return { user, merchant: emailMerchant, error: null };
        }

        return { user, merchant: null, error: 'No active merchant linked to this owner' };
      }

      return { user, merchant, error: null };
    } catch (err) {
      console.error('Owner authentication error:', err);
      return { user: null, merchant: null, error: 'Authentication service failure' };
    }
  }

  // Mock fallback for local testing
  if (process.env.NODE_ENV === 'production') {
    return { user: null, merchant: null, error: 'Unauthorized: Database not configured' };
  }

  const defaultMerchant = mockState.merchants.get('41a1a72d-6218-40a1-873d-9d41315579fa');
  return {
    user: { id: 'mock-owner-uuid', email: 'owner@kalupharma.com' },
    merchant: defaultMerchant,
    error: null,
  };
}
