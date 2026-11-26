import { updateEnvValues } from './config.js';
import { analyzeBlackFridayVerdict, getEffectivePrice } from './classifier.js';

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
  const effectivePrice = getEffectivePrice(offer);
  if (!pay) {
    return `💰 <b>Preço Final:</b> <code>${formatBRL(effectivePrice)}</code>`;
  }

  const lines = [
    `⚡ <b>À vista (PIX / Boleto):</b> <code>${formatBRL(pay.pixPrice)}</code>`,
  ];

  if (pay.couponDiscount > 0 || pay.couponCode) {
    const discountPart =
      pay.couponDiscount > 0 ? `-${formatBRL(pay.couponDiscount)}` : 'Disponível';
    const codePart = pay.couponCode ? ` (Código: <code>${escapeHtml(pay.couponCode)}</code>)` : '';
    lines.push(
      `🎟️ <b>Cupom detectado:</b> ${discountPart}${codePart} | <b>Preço final: <code>${formatBRL(
        effectivePrice
      )}</code></b>`
    );
  }

  if (pay.cardTotal && pay.maxInstallments) {
    lines.push(
      `💳 <b>Parcelado no Cartão:</b> ${formatBRL(pay.cardTotal)} (em até <b>${
        pay.maxInstallments
      }x de ${formatBRL(pay.perInstallment)}</b> sem juros)`
    );
  }

  return lines.join('\n');
}

export function buildOfferAlertMessage(offer, evaluation) {
  const emoji = offer.edition === 'digital' ? '🎮' : '💿';
  const isNearTarget = evaluation.isNearTarget && !evaluation.isHit;

  const headerLine = isNearTarget
    ? `⚠️ <b>QUASE NA META (Verificar cupom no checkout)</b> ${emoji}`
    : `🚨 <b>ALERTA DE PREÇO PS5 (META ATINGIDA!)</b> ${emoji}`;

  const targetComparisonText = isNearTarget
    ? `⚠️ <b>Apenas ${formatBRL(
        evaluation.amountAboveTarget
      )} acima da sua meta!</b> (Teste cupons de checkout de R$ 150 a R$ 300 OFF agora!)`
    : evaluation.savingsFromTarget > 0
    ? `🔥 <b>${formatBRL(evaluation.savingsFromTarget)} abaixo da sua meta!</b>`
    : `🎯 <b>Atingiu exatamente sua meta!</b>`;

  const verdict = evaluation.verdict || analyzeBlackFridayVerdict(offer);
  const historyLines = [
    `🕵️ <b>Termômetro Anti-Black Fraude (Buscapé 90 dias):</b>`,
    `• <b>Veredito:</b> ${verdict.badge}`,
    `• <b>Média real dos últimos 90 dias:</b> ${formatBRL(verdict.average90d)}`,
    `• <b>Análise (Preço Líquido):</b> ${escapeHtml(verdict.explanation)}`,
  ];

  if (verdict.trackedStats) {
    historyLines.push(
      `• <b>Histórico deste link no seu robô:</b> Menor visto: <b>${formatBRL(
        verdict.trackedStats.minSeen
      )}</b> | Maior visto: ${formatBRL(verdict.trackedStats.maxSeen)}`
    );
  }

  return [
    headerLine,
    ``,
    `📦 <b>${escapeHtml(offer.title)}</b>`,
    `🏷️ <b>Edição:</b> ${escapeHtml(offer.editionLabel)}`,
    `🏪 <b>Loja / Fonte:</b> ${escapeHtml(offer.store)}`,
    ``,
    formatPaymentBreakdown(offer),
    `🎯 <b>Sua Meta:</b> ${formatBRL(evaluation.targetPrice)} — ${targetComparisonText}`,
    ``,
    ...historyLines,
    ``,
    `🛒 <a href="${escapeHtml(offer.url)}">CLIQUE AQUI PARA ABRIR A OFERTA</a> | 📈 <a href="${escapeHtml(
      verdict.buscapeHistoryUrl
    )}">Gráfico 6 Meses Buscapé</a>`,
  ].join('\n');
}

/**
 * Seleciona as melhores ofertas garantindo diversidade de lojas (Amazon, KaBuM!, Magalu, Mercado Livre, Americanas...)
 */
function selectDiverseTopOffers(offers, edition, limit = 4) {
  const filtered = offers
    .filter((o) => o.edition === edition)
    .sort((a, b) => getEffectivePrice(a) - getEffectivePrice(b));

  const selected = [];
  const usedBaseStores = new Set();

  for (const offer of filtered) {
    const storeKey = (offer.baseStore || offer.store || '').split('(')[0].trim();
    if (!usedBaseStores.has(storeKey)) {
      usedBaseStores.add(storeKey);
      selected.push(offer);
      if (selected.length >= limit) break;
    }
  }

  for (const offer of filtered) {
    if (selected.length >= limit) break;
    if (!selected.includes(offer)) {
      selected.push(offer);
    }
  }

  return selected.sort((a, b) => getEffectivePrice(a) - getEffectivePrice(b));
}

export function buildDailySummaryMessage(offers, config, priceHistoryMap = {}) {
  const topDigital = selectDiverseTopOffers(offers, 'digital', 4);
  const topDisc = selectDiverseTopOffers(offers, 'disc', 4);

  const formatList = (list, targetPrice) => {
    if (list.length === 0) return `   <i>Nenhuma oferta em estoque nesta categoria agora.</i>`;
    return list
      .map((o, idx) => {
        const pay = o.paymentInfo;
        const effectivePrice = getEffectivePrice(o);
        const cardText =
          pay && pay.cardTotal
            ? ` | 💳 ${pay.maxInstallments}x ${formatBRL(pay.perInstallment)}`
            : '';
        const couponLine =
          pay?.couponDiscount > 0 || pay?.couponCode
            ? `\n      🎟️ <b>Cupom detectado:</b> -${formatBRL(
                pay.couponDiscount || 0
              )}${pay.couponCode ? ` (<code>${escapeHtml(pay.couponCode)}</code>)` : ''} | <b>Preço final: ${formatBRL(
                effectivePrice
              )}</b>`
            : '';

        const nearTargetBadge =
          effectivePrice > targetPrice && effectivePrice <= targetPrice + (config.couponMarginTolerance || 300)
            ? `\n      ⚠️ <b>QUASE NA META (+${formatBRL(
                effectivePrice - targetPrice
              )}) — Teste cupom no checkout!</b>`
            : '';

        const verdict = analyzeBlackFridayVerdict(o, priceHistoryMap[o.id]);
        const shortTitle =
          o.title.length > 68 ? `${o.title.slice(0, 68).trim()}...` : o.title;

        return [
          `   ${idx + 1}. 🏪 <b>${escapeHtml(o.store)}</b>`,
          `      📦 ${escapeHtml(shortTitle)}`,
          `      💰 <b>${formatBRL(o.price)} no PIX</b>${cardText}${couponLine}${nearTargetBadge}`,
          `      ${verdict.badge} — <a href="${escapeHtml(o.url)}">Abrir Anúncio Oficial</a>`,
        ].join('\n');
      })
      .join('\n\n');
  };

  return [
    `📊 <b>COMPARATIVO DAS PRINCIPAIS LOJAS (OFICIAIS & BEM AVALIADOS)</b>`,
    `<i>Preços líquidos já considerando cupons na página e filtro Anti-Black Fraude:</i>`,
    ``,
    `🎮 <b>PS5 Slim Digital — Principais Lojas (Meta: ${formatBRL(
      config.targetPriceDigital
    )} | Margem Cupom: até ${formatBRL(
      config.targetPriceDigital + (config.couponMarginTolerance || 300)
    )}):</b>`,
    formatList(topDigital, config.targetPriceDigital),
    ``,
    `💿 <b>PS5 Slim Com Leitor de Disco — Principais Lojas (Meta: ${formatBRL(
      config.targetPriceDisc
    )} | Margem Cupom: até ${formatBRL(
      config.targetPriceDisc + (config.couponMarginTolerance || 300)
    )}):</b>`,
    formatList(topDisc, config.targetPriceDisc),
    ``,
    `🔕 <i>Alertas automáticos disparam quando atingir a Meta ou entrar na Margem para Cupom (até +R$ 300)!</i>`,
  ].join('\n');
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
