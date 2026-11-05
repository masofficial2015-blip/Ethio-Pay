import { authenticateOwner, authenticateDevice } from '@/lib/auth';
import { getLinkedGroup, sendTelegramMessage } from '@/lib/telegram';

export async function POST(request) {
  try {
    let merchant = null;

    const authHeader = request.headers.get('authorization');
    if (authHeader) {
      const ownerAuth = await authenticateOwner(authHeader);
      merchant = ownerAuth.merchant;
    }

    if (!merchant) {
      const deviceToken = request.headers.get('x-device-token');
      if (deviceToken) {
        const deviceAuth = await authenticateDevice(deviceToken);
        merchant = deviceAuth.merchant;
      }
    }

    if (!merchant) {
      return Response.json(
        { error: 'Unauthorized', message: 'Authentication required via Bearer JWT or X-Device-Token' },
        { status: 401 }
      );
    }

    const linkedGroup = await getLinkedGroup(merchant.id);
    const targetChatId = linkedGroup?.telegram_chat_id || process.env.TELEGRAM_DEFAULT_CHAT_ID;

    if (!targetChatId) {
      return Response.json(
        {
          error: 'NoTelegramGroup',
          message: 'No Telegram group is linked. Link your cashier group first.',
        },
        { status: 400 }
      );
    }

    const testMessage = `🧪 <b>EthioPay Telegram Connection Test</b>
━━━━━━━━━━━━━━━━━━━━━
✅ <b>Status:</b> Connected & Operational
🏢 <b>Pharmacy:</b> ${merchant.name}
🔢 <b>Chat ID:</b> <code>${targetChatId}</code>
🕒 <b>Sent At:</b> ${new Date().toLocaleTimeString()}
━━━━━━━━━━━━━━━━━━━━━
<i>If you see this alert, the cashier group is active and ready to receive real-time payment alerts.</i>`;

    const result = await sendTelegramMessage(targetChatId, testMessage, merchant.id);

    if (!result.success) {
      return Response.json(
        {
          success: false,
          error: result.error,
          chat_id: targetChatId,
          suggestion: 'Ensure your bot is added to the group and promoted to Administrator.',
        },
        { status: 502 }
      );
    }

    return Response.json({
      success: true,
      message: 'Test alert sent successfully to cashier group',
      chat_id: targetChatId,
      telegram_message_id: result.messageId,
      simulated: !!result.simulated,
    });
  } catch (error) {
    console.error('Error sending test Telegram message:', error);
    return Response.json({ error: 'InternalServerError', message: error.message }, { status: 500 });
  }
}
