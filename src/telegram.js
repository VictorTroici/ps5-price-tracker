import { updateEnvValues } from './config.js';

export function formatBRL(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}

/**
 * Se o usuário configurou apenas o TELEGRAM_BOT_TOKEN e mandou um "Oi" para o bot,
 * podemos descobrir automaticamente o TELEGRAM_CHAT_ID via getUpdates.
 */
export async function resolveTelegramChatId(botToken, currentChatId) {
  if (!botToken) return '';
  if (currentChatId) return currentChatId;

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const updates = data.result || [];
    for (let i = updates.length - 1; i >= 0; i--) {
      const chatId =
        updates[i]?.message?.chat?.id ||
        updates[i]?.my_chat_member?.chat?.id ||
        updates[i]?.channel_post?.chat?.id;
      if (chatId) {
        updateEnvValues({ TELEGRAM_CHAT_ID: String(chatId) });
        return String(chatId);
      }
    }
  } catch {
    return '';
  }
  return '';
}

export async function sendTelegramMessage(botToken, chatId, htmlText) {
  if (!botToken) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN não configurado no arquivo .env' };
  }

  const resolvedChatId = await resolveTelegramChatId(botToken, chatId);
  if (!resolvedChatId) {
    return {
      ok: false,
      error:
        'TELEGRAM_CHAT_ID não encontrado. Envie uma mensagem "Oi" para o seu bot no Telegram e tente novamente.',
    };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: resolvedChatId,
        text: htmlText,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.description || `HTTP ${res.status}` };
    }
    return { ok: true, chatId: resolvedChatId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function buildOfferAlertMessage(offer, evaluation) {
  const emoji = offer.edition === 'digital' ? '🎮' : '💿';
  const savingsText =
    evaluation.savingsFromTarget > 0
      ? `🔥 <b>${formatBRL(evaluation.savingsFromTarget)} abaixo da sua meta!</b>`
      : `🎯 <b>Atingiu exatamente sua meta!</b>`;

  return [
    `🚨 <b>ALERTA DE PREÇO PS5!</b> ${emoji}`,
    ``,
    `📦 <b>${escapeHtml(offer.title)}</b>`,
    `🏷️ <b>Edição:</b> ${escapeHtml(offer.editionLabel)}`,
    `🏪 <b>Loja:</b> ${escapeHtml(offer.store)}`,
    ``,
    `💰 <b>Preço Encontrado:</b> <code>${formatBRL(offer.price)}</code>`,
    `🎯 <b>Sua Meta:</b> ${formatBRL(evaluation.targetPrice)}`,
    savingsText,
    ``,
    `🛒 <a href="${escapeHtml(offer.url)}">CLIQUE AQUI PARA ABRIR A OFERTA</a>`,
  ].join('\n');
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
