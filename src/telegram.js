import { updateEnvValues } from './config.js';
import { analyzeBlackFridayVerdict } from './classifier.js';

export function formatBRL(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}

/**
 * Se o usuário configurou apenas o TELEGRAM_BOT_TOKEN e mandou um "Oi" para o bot,
 * descobre automaticamente o TELEGRAM_CHAT_ID via getUpdates.
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

export function formatPaymentBreakdown(offer) {
  const pay = offer.paymentInfo;
  if (!pay) {
    return `💰 <b>Preço:</b> <code>${formatBRL(offer.price)}</code>`;
  }

  const lines = [
    `⚡ <b>À vista (PIX / Boleto):</b> <code>${formatBRL(pay.pixPrice)}</code>`,
  ];

  if (pay.cardTotal && pay.maxInstallments) {
    lines.push(
      `💳 <b>Parcelado no Cartão:</b> ${formatBRL(pay.cardTotal)} (em até <b>${
        pay.maxInstallments
      }x de ${formatBRL(pay.perInstallment)}</b> sem juros)`
    );
  }

  if (pay.couponCode) {
    lines.push(`🎟️ <b>CUPOM:</b> <code>${escapeHtml(pay.couponCode)}</code>`);
  }

  return lines.join('\n');
}

export function buildOfferAlertMessage(offer, evaluation) {
  const emoji = offer.edition === 'digital' ? '🎮' : '💿';
  const savingsText =
    evaluation.savingsFromTarget > 0
      ? `🔥 <b>${formatBRL(evaluation.savingsFromTarget)} abaixo da sua meta!</b>`
      : `🎯 <b>Atingiu exatamente sua meta!</b>`;

  const verdict = evaluation.verdict || analyzeBlackFridayVerdict(offer);
  const historyLines = [
    `🕵️ <b>Termômetro Anti-Black Fraude (Buscapé 90 dias):</b>`,
    `• <b>Veredito:</b> ${verdict.badge}`,
    `• <b>Média real dos últimos 90 dias:</b> ${formatBRL(verdict.average90d)}`,
    `• <b>Análise:</b> ${escapeHtml(verdict.explanation)}`,
  ];

  if (verdict.trackedStats) {
    historyLines.push(
      `• <b>Histórico deste link no seu robô:</b> Menor visto: <b>${formatBRL(
        verdict.trackedStats.minSeen
      )}</b> | Maior visto: ${formatBRL(verdict.trackedStats.maxSeen)}`
    );
  }

  return [
    `🚨 <b>ALERTA DE PREÇO PS5 (EM ESTOQUE)!</b> ${emoji}`,
    ``,
    `📦 <b>${escapeHtml(offer.title)}</b>`,
    `🏷️ <b>Edição:</b> ${escapeHtml(offer.editionLabel)}`,
    `🏪 <b>Loja / Fonte:</b> ${escapeHtml(offer.store)}`,
    ``,
    formatPaymentBreakdown(offer),
    `🎯 <b>Sua Meta:</b> ${formatBRL(evaluation.targetPrice)} (${savingsText})`,
    ``,
    ...historyLines,
    ``,
    `🛒 <a href="${escapeHtml(offer.url)}">CLIQUE AQUI PARA ABRIR A OFERTA</a> | 📈 <a href="${escapeHtml(
      verdict.buscapeHistoryUrl
    )}">Gráfico 6 Meses Buscapé</a>`,
  ].join('\n');
}

export function buildDailySummaryMessage(offers, config, priceHistoryMap = {}) {
  const topDigital = offers
    .filter((o) => o.edition === 'digital')
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);

  const topDisc = offers
    .filter((o) => o.edition === 'disc')
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);

  const formatList = (list) => {
    if (list.length === 0) return `   <i>Nenhuma oferta em estoque nesta categoria agora.</i>`;
    return list
      .map((o, idx) => {
        const pay = o.paymentInfo;
        const cardText =
          pay && pay.cardTotal
            ? ` | 💳 ${pay.maxInstallments}x ${formatBRL(pay.perInstallment)}`
            : '';
        const couponText = pay?.couponCode ? ` | 🎟️ Cupom: <code>${pay.couponCode}</code>` : '';
        const verdict = analyzeBlackFridayVerdict(o, priceHistoryMap[o.id]);
        return [
          `   ${idx + 1}. <b>${formatBRL(o.price)} no PIX</b>${cardText}${couponText}`,
          `      ${verdict.badge} (Média 90d: ${formatBRL(verdict.average90d)})`,
          `      🏪 ${escapeHtml(o.store)} — <a href="${escapeHtml(o.url)}">Abrir Loja</a>`,
        ].join('\n');
      })
      .join('\n\n');
  };

  return [
    `📊 <b>RESUMO DIÁRIO + DETECTOR ANTI-BLACK FRAUDE</b>`,
    `<i>Comparando preços atuais em estoque com a média real dos últimos 90 dias (Buscapé/Zoom):</i>`,
    ``,
    `🎮 <b>TOP 3 PS5 Slim Digital (Sua Meta: ${formatBRL(config.targetPriceDigital)} | Média 90d: R$ 3.749):</b>`,
    formatList(topDigital),
    ``,
    `💿 <b>TOP 3 PS5 Slim Com Disco (Sua Meta: ${formatBRL(config.targetPriceDisc)} | Média 90d: R$ 4.049):</b>`,
    formatList(topDisc),
    ``,
    `💡 <i>Envie /buscar a qualquer momento para forçar uma varredura ou /resumo para ver este ranking.</i>`,
  ].join('\n');
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
