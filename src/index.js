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
 * Escuta comandos enviados pelo usuário diretamente no bot do Telegram.
 * IMPORTANTE: Salva o lastTelegramUpdateId no state.json e confirma o offset na API do Telegram!
 * Sem isso, quando roda no GitHub Actions a cada 10 min, o Telegram devolvia o mesmo /buscar antigo
 * em toda execução, causando mensagens repetidas da KaBuM!
 */
async function pollTelegramCommands() {
  const config = getConfig();
  if (!config.telegramBotToken) return;

  try {
    const nextOffset = (currentState.lastTelegramUpdateId || 0) + 1;
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?offset=${nextOffset}&timeout=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) return;

    // Pega apenas a última mensagem enviada nas últimas 2 horas (evita reprocessar fila velha)
    let latestUpdate = null;
    for (const update of data.result) {
      if (update.update_id > (currentState.lastTelegramUpdateId || 0)) {
        currentState.lastTelegramUpdateId = update.update_id;
      }
      latestUpdate = update;
    }

    // Confirma imediatamente na API do Telegram que já lemos até currentState.lastTelegramUpdateId
    // Assim o próprio servidor do Telegram limpa a fila mesmo antes do git push!
    await fetch(
      `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?offset=${
        currentState.lastTelegramUpdateId + 1
      }&timeout=0`,
      { signal: AbortSignal.timeout(4000) }
    ).catch(() => {});

    saveState(currentState);

    if (!latestUpdate || !latestUpdate.message) return;

    const msg = latestUpdate.message;
    const msgAgeSeconds = Math.floor(Date.now() / 1000) - Number(msg.date || 0);
    // Se a mensagem tiver mais de 15 minutos, apenas consome o offset sem responder de novo
    if (msgAgeSeconds > 900) {
      return;
    }

    const chatId = msg?.chat?.id ? String(msg.chat.id) : '';
    const text = (msg?.text || '').trim();
    if (!chatId || !text) return;

    const wasUnlinked = !config.telegramChatId;
    if (wasUnlinked || config.telegramChatId !== chatId) {
      updateEnvValues({ TELEGRAM_CHAT_ID: chatId });
    }

    const lower = text.toLowerCase();

    if (lower === '/start' || lower === 'oi' || lower === '/status') {
      if (currentState.offers.length === 0) {
        await runScanAndNotify();
      }
      const summaryMsg = buildDailySummaryMessage(
        currentState.offers,
        config,
        currentState.priceHistory
      );
      await sendTelegramMessage(config.telegramBotToken, chatId, summaryMsg);
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
        `🔎 <b>Varrendo Amazon, KaBuM!, Magalu, Mercado Livre, Pelando e Promobit agora...</b>`
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
