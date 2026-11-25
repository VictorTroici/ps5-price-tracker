import { getConfig, updateEnvValues } from './config.js';
import { evaluateTargetHit } from './classifier.js';
import { scanAllStores } from './scrapers.js';
import { loadState, saveState, updateOfferPriceHistory } from './store.js';
import {
  sendTelegramMessage,
  buildOfferAlertMessage,
  buildDailySummaryMessage,
  formatBRL,
} from './telegram.js';
import { startDashboardServer } from './dashboard.js';

let currentState = loadState();
let isScanning = false;

/**
 * Retorna a data e hora atual no fuso de Brasília (America/Sao_Paulo)
 */
function getBrasiliaDateParts() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}

export async function runScanAndNotify() {
  if (isScanning) {
    return { skipped: true, offersCount: currentState.offers.length };
  }
  isScanning = true;

  try {
    const config = getConfig();
    console.log(
      `\n🔎 [${new Date().toLocaleTimeString('pt-BR')}] Iniciando varredura completa de preços do PS5 Slim...`
    );
    console.log(
      `   🎯 Metas -> Digital: ${formatBRL(
        config.targetPriceDigital
      )} | Com Disco: ${formatBRL(config.targetPriceDisc)} | Variação mín.: ${formatBRL(
        config.minPriceDropReais
      )}`
    );

    const { offers, sourceStatus, scannedAt } = await scanAllStores(
      config,
      currentState.customUrls
    );

    currentState.lastScanAt = scannedAt;
    currentState.sourceStatus = sourceStatus;
    currentState.offers = offers;
    updateOfferPriceHistory(currentState, offers);

    let alertsTriggered = 0;
    const minDrop = config.minPriceDropReais || 50;

    for (const offer of offers) {
      const evaluation = evaluateTargetHit(offer, config, currentState.priceHistory);
      const statusIcon = evaluation.isHit ? '🔥 [META ATINGIDA]' : '  ';
      const pay = offer.paymentInfo;
      const cardLog =
        pay && pay.cardTotal
          ? ` | Cartão: ${pay.maxInstallments}x ${formatBRL(pay.perInstallment)} (${formatBRL(
              pay.cardTotal
            )})`
          : '';
      const couponLog = pay?.couponCode ? ` | CUPOM: ${pay.couponCode}` : '';

      console.log(
        `   ${statusIcon} [${offer.store}] ${offer.editionLabel} -> PIX: ${formatBRL(
          offer.price
        )}${cardLog}${couponLog} (${offer.title.slice(0, 50)}...)`
      );

      if (evaluation.isHit) {
        const prevNotifiedPrice = currentState.notifiedPrices[offer.id];
        const shouldNotify =
          prevNotifiedPrice === undefined || offer.price <= prevNotifiedPrice - minDrop;

        if (shouldNotify) {
          if (config.telegramBotToken) {
            const msg = buildOfferAlertMessage(offer, evaluation);
            const tgRes = await sendTelegramMessage(
              config.telegramBotToken,
              config.telegramChatId,
              msg
            );
            if (tgRes.ok) {
              alertsTriggered++;
              currentState.notifiedPrices[offer.id] = offer.price;
              currentState.alertHistory.unshift({
                offerId: offer.id,
                store: offer.store,
                title: offer.title,
                price: offer.price,
                editionLabel: offer.editionLabel,
                url: offer.url,
                alertedAt: new Date().toISOString(),
              });
              console.log(
                `   ✈️ Alerta enviado no Telegram para: ${offer.title} (${formatBRL(
                  offer.price
                )})`
              );
            } else {
              console.warn(`   ⚠️ Falha ao enviar Telegram: ${tgRes.error}`);
            }
          }
        }
      }
    }

    // Verifica se está na hora do Resumo Diário (12h ou 20h horário de Brasília)
    const { dateStr, hour } = getBrasiliaDateParts();
    const summaryHours = config.dailySummaryHours || [12, 20];
    if (summaryHours.includes(hour) && offers.length > 0 && config.telegramBotToken) {
      const slotKey = `${dateStr}-${hour}h`;
      if (currentState.lastDailySummarySlot !== slotKey) {
        const summaryMsg = buildDailySummaryMessage(offers, config, currentState.priceHistory);
        const tgRes = await sendTelegramMessage(
          config.telegramBotToken,
          config.telegramChatId,
          summaryMsg
        );
        if (tgRes.ok) {
          currentState.lastDailySummarySlot = slotKey;
          console.log(`   📊 Resumo Diário (${slotKey}) enviado com sucesso no Telegram!`);
        }
      }
    }

    console.log(
      `✅ Varredura concluída: ${offers.length} ofertas em estoque analisadas | ${alertsTriggered} alertas enviados.`
    );

    saveState(currentState);
    return {
      offersCount: offers.length,
      alertsTriggered,
      scannedAt,
    };
  } finally {
    isScanning = false;
  }
}

/**
 * Escuta comandos enviados pelo usuário diretamente no bot do Telegram:
 * /start ou /status -> Mostra o resumo e os menores preços atuais (PIX e Cartão)
 * /resumo -> Envia o TOP 3 ofertas Digital e Com Disco na hora
 * /buscar -> Faz uma busca imediata em todas as lojas e responde no Telegram
 * /meta 3700 3900 -> Altera a meta do Digital e Com Disco direto pelo Telegram
 */
let lastUpdateId = 0;
async function pollTelegramCommands() {
  const config = getConfig();
  if (!config.telegramBotToken) return;

  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?offset=${
      lastUpdateId + 1
    }&timeout=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) return;

    for (const update of data.result) {
      if (update.update_id > lastUpdateId) {
        lastUpdateId = update.update_id;
      }
      const msg = update.message;
      const chatId = msg?.chat?.id ? String(msg.chat.id) : '';
      const text = (msg?.text || '').trim();
      if (!chatId || !text) continue;

      const wasUnlinked = !config.telegramChatId;
      if (wasUnlinked || config.telegramChatId !== chatId) {
        updateEnvValues({ TELEGRAM_CHAT_ID: chatId });
      }

      const lower = text.toLowerCase();

      if (lower === '/start' || lower === 'oi' || lower === '/status') {
        const bestDigital = currentState.offers
          .filter((o) => o.edition === 'digital')
          .sort((a, b) => a.price - b.price)[0];
        const bestDisc = currentState.offers
          .filter((o) => o.edition === 'disc')
          .sort((a, b) => a.price - b.price)[0];

        const formatBest = (o, label) => {
          if (!o) return `${label}: Sem oferta em estoque`;
          const pay = o.paymentInfo;
          const cardStr =
            pay && pay.cardTotal
              ? ` | 💳 ${pay.maxInstallments}x de ${formatBRL(pay.perInstallment)}`
              : '';
          return `${label}: <b>${formatBRL(o.price)} no PIX</b>${cardStr} (${
            o.store
          }) — <a href="${o.url}">Ver</a>`;
        };

        const reply = [
          `🤖 <b>Monitor Automático PS5 Slim Pro Ativo!</b>`,
          ``,
          `🏪 <b>Fontes monitoradas:</b> Amazon, KaBuM!, Mercado Livre (Lojas Oficiais), Magazine Luiza, Carrefour, Casas Bahia, Pelando, Promobit, Zoom e Buscapé.`,
          `📊 <b>Resumo Diário Automático:</b> Todo dia às 12h e às 20h.`,
          `🎯 <b>Sua Meta Digital:</b> ${formatBRL(config.targetPriceDigital)}`,
          `🎯 <b>Sua Meta Com Disco:</b> ${formatBRL(config.targetPriceDisc)}`,
          ``,
          `🏆 <b>Menores preços EM ESTOQUE agora:</b>`,
          formatBest(bestDigital, '🎮 Digital'),
          formatBest(bestDisc, '💿 Com Disco'),
          ``,
          `💡 <b>Comandos no Telegram:</b>`,
          `• /resumo — Envia o TOP 3 Digital e Com Disco agora`,
          `• /buscar — Verifica todas as lojas agora mesmo`,
          `• /status — Mostra os menores preços atuais`,
          `• /meta 3700 3950 — Muda suas metas`,
        ].join('\n');

        await sendTelegramMessage(config.telegramBotToken, chatId, reply);
      } else if (lower === '/resumo') {
        if (currentState.offers.length === 0) {
          await runScanAndNotify();
        }
        const summaryMsg = buildDailySummaryMessage(
          currentState.offers,
          config,
          currentState.priceHistory
        );
        await sendTelegramMessage(config.telegramBotToken, chatId, summaryMsg);
      } else if (lower === '/buscar') {
        await sendTelegramMessage(
          config.telegramBotToken,
          chatId,
          `🔎 <b>Varrendo todas as lojas, Pelando e Promobit agora...</b>`
        );
        await runScanAndNotify();
        const summaryMsg = buildDailySummaryMessage(
          currentState.offers,
          config,
          currentState.priceHistory
        );
        await sendTelegramMessage(config.telegramBotToken, chatId, summaryMsg);
      } else if (lower.startsWith('/meta')) {
        const parts = lower.split(/\s+/);
        const newDig = Number(parts[1]);
        const newDisc = Number(parts[2]);
        if (newDig > 2000 && newDisc > 2000) {
          updateEnvValues({
            TARGET_PRICE_DIGITAL: newDig,
            TARGET_PRICE_DISC: newDisc,
          });
          await sendTelegramMessage(
            config.telegramBotToken,
            chatId,
            `✅ <b>Novas metas salvas!</b>\n🎮 Digital: ${formatBRL(
              newDig
            )}\n💿 Com Disco: ${formatBRL(newDisc)}`
          );
        } else {
          await sendTelegramMessage(
            config.telegramBotToken,
            chatId,
            `ℹ️ Use o formato: <code>/meta 3700 3950</code>`
          );
        }
      }
    }
  } catch {
    // Silencioso
  }
}

async function main() {
  const args = process.argv.slice(2);
  const config = getConfig();

  if (args.includes('--send-summary')) {
    await runScanAndNotify();
    const summaryMsg = buildDailySummaryMessage(currentState.offers, config);
    await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, summaryMsg);
    return;
  }

  if (args.includes('--once')) {
    await pollTelegramCommands();
    await runScanAndNotify();
    return;
  }

  startDashboardServer({
    getState: () => currentState,
    runScanNow: () => runScanAndNotify(),
    updateCustomUrls: (newUrls) => {
      if (Array.isArray(newUrls)) {
        currentState.customUrls = newUrls;
        saveState(currentState);
      }
      return currentState.customUrls;
    },
  });

  await pollTelegramCommands();
  await runScanAndNotify();

  setInterval(() => {
    pollTelegramCommands();
  }, 5000);

  const intervalMs = Math.max(1, config.checkIntervalMinutes || 10) * 60 * 1000;
  setInterval(() => {
    runScanAndNotify().catch((err) =>
      console.error('Erro no ciclo de monitoramento:', err.message)
    );
  }, intervalMs);
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
