import { getConfig, updateEnvValues } from './config.js';
import { evaluateTargetHit, getEffectivePrice } from './classifier.js';
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

/**
 * Gera chave de deduplicação por Loja + Modelo/Edição + ID da oferta
 * E verifica se deve enviar alerta (somente se o preço final líquido caiu ou se apareceu um cupom novo!)
 */
export function shouldTriggerDedupedAlert(offer, evaluation, notifiedPricesMap = {}, minDrop = 1) {
  if (!evaluation.shouldAlert) return false;

  const effectivePrice = getEffectivePrice(offer);
  const couponSignature =
    offer.paymentInfo?.couponCode ||
    (offer.paymentInfo?.couponDiscount > 0 ? `DESC-${offer.paymentInfo.couponDiscount}` : 'NO_COUPON');

  // Chave por oferta individual e por Loja+Edição para evitar flood do mesmo modelo na mesma loja
  const storeModelKey = `storemodel:${(offer.baseStore || offer.store).toLowerCase()}:${offer.edition}`;
  const prevRecordRaw = notifiedPricesMap[offer.id] ?? notifiedPricesMap[storeModelKey];

  if (prevRecordRaw === undefined || prevRecordRaw === null) {
    return true;
  }

  // Suporta formato legado (number) e novo formato estruturado ({ effectivePrice, couponSignature })
  const prevEffectivePrice =
    typeof prevRecordRaw === 'number'
      ? prevRecordRaw
      : Number(prevRecordRaw.effectivePrice ?? Infinity);
  const prevCouponSig =
    typeof prevRecordRaw === 'object' && prevRecordRaw.couponSignature
      ? prevRecordRaw.couponSignature
      : 'NO_COUPON';

  // 1) Se o preço final líquido caiu pelo menos minDrop em relação ao último alerta
  if (effectivePrice <= prevEffectivePrice - minDrop) {
    return true;
  }

  // 2) Se apareceu um cupom novo que não existia no alerta anterior (e o preço não subiu)
  if (
    couponSignature !== 'NO_COUPON' &&
    couponSignature !== prevCouponSig &&
    effectivePrice <= prevEffectivePrice
  ) {
    return true;
  }

  return false;
}

export function recordNotifiedOffer(offer, notifiedPricesMap) {
  const effectivePrice = getEffectivePrice(offer);
  const couponSignature =
    offer.paymentInfo?.couponCode ||
    (offer.paymentInfo?.couponDiscount > 0 ? `DESC-${offer.paymentInfo.couponDiscount}` : 'NO_COUPON');
  const record = {
    effectivePrice,
    pixPrice: offer.price,
    couponSignature,
    notifiedAt: new Date().toISOString(),
  };

  const storeModelKey = `storemodel:${(offer.baseStore || offer.store).toLowerCase()}:${offer.edition}`;
  notifiedPricesMap[offer.id] = record;
  notifiedPricesMap[storeModelKey] = record;
}

export async function runScanAndNotify() {
  if (isScanning) {
    return { skipped: true, offersCount: currentState.offers.length };
  }
  isScanning = true;

  try {
    const config = getConfig();
    const marginTol = config.couponMarginTolerance || 300;
    console.log(
      `\n🔎 [${new Date().toLocaleTimeString('pt-BR')}] Iniciando varredura Black Friday PS5 Slim...`
    );
    console.log(
      `   🎯 Metas -> Digital: ${formatBRL(
        config.targetPriceDigital
      )} (Margem Cupom: até ${formatBRL(
        config.targetPriceDigital + marginTol
      )}) | Com Disco: ${formatBRL(
        config.targetPriceDisc
      )} (Margem Cupom: até ${formatBRL(config.targetPriceDisc + marginTol)})`
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

    for (const offer of offers) {
      const evaluation = evaluateTargetHit(offer, config, currentState.priceHistory);
      const effectivePrice = evaluation.effectivePrice;
      const statusIcon = evaluation.isHit
        ? '🔥 [META ATINGIDA]'
        : evaluation.isNearTarget
        ? '⚠️ [QUASE NA META - MARGEM CUPOM]'
        : '  ';

      const pay = offer.paymentInfo;
      const couponLog =
        pay?.couponDiscount > 0 || pay?.couponCode
          ? ` | 🎟️ Cupom: -${formatBRL(pay.couponDiscount || 0)} -> Final: ${formatBRL(
              effectivePrice
            )}`
          : '';
      const cardLog =
        pay && pay.cardTotal
          ? ` | Cartão: ${pay.maxInstallments}x ${formatBRL(pay.perInstallment)}`
          : '';

      console.log(
        `   ${statusIcon} [${offer.baseStore || offer.store}] ${offer.editionLabel} -> PIX: ${formatBRL(
          offer.price
        )}${couponLog}${cardLog} (${offer.title.slice(0, 48)}...)`
      );

      if (evaluation.shouldAlert) {
        const shouldNotify = shouldTriggerDedupedAlert(
          offer,
          evaluation,
          currentState.notifiedPrices,
          1
        );

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
              recordNotifiedOffer(offer, currentState.notifiedPrices);
              currentState.alertHistory.unshift({
                offerId: offer.id,
                store: offer.store,
                title: offer.title,
                price: offer.price,
                preco_final_efetivo: effectivePrice,
                alertType: evaluation.alertType,
                editionLabel: offer.editionLabel,
                url: offer.url,
                alertedAt: new Date().toISOString(),
              });
              console.log(
                `   ✈️ Alerta (${evaluation.alertType}) enviado no Telegram: ${
                  offer.title
                } (Final: ${formatBRL(effectivePrice)})`
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
      `✅ Varredura concluída: ${offers.length} ofertas analisadas | ${alertsTriggered} novos alertas enviados.`
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
 * Escuta comandos enviados pelo usuário diretamente no bot do Telegram
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

    let latestUpdate = null;
    for (const update of data.result) {
      if (update.update_id > (currentState.lastTelegramUpdateId || 0)) {
        currentState.lastTelegramUpdateId = update.update_id;
      }
      latestUpdate = update;
    }

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
    if (msgAgeSeconds > 900) return;

    const chatId = msg?.chat?.id ? String(msg.chat.id) : '';
    const text = (msg?.text || '').trim();
    if (!chatId || !text) return;

    const wasUnlinked = !config.telegramChatId;
    if (wasUnlinked || config.telegramChatId !== chatId) {
      updateEnvValues({ TELEGRAM_CHAT_ID: chatId });
    }

    const lower = text.toLowerCase();

    if (lower === '/start' || lower === 'oi' || lower === '/status' || lower === '/resumo') {
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
        `🔎 <b>Varrendo Amazon, KaBuM!, Magalu, Americanas e Comparadores agora...</b>`
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

/**
 * Agenda o próximo ciclo com intervalo base de 3 minutos + Jitter aleatório de 10 a 30 segundos
 */
function scheduleNextScanWithJitter(config) {
  const baseMs = Math.max(1, config.checkIntervalMinutes || 3) * 60 * 1000;
  const minJitterMs = (config.jitterMinSeconds ?? 10) * 1000;
  const maxJitterMs = (config.jitterMaxSeconds ?? 30) * 1000;
  const jitterMs = Math.floor(minJitterMs + Math.random() * (maxJitterMs - minJitterMs + 1));
  const totalWaitMs = baseMs + jitterMs;

  console.log(
    `⏱️ Próxima varredura agendada em ${(totalWaitMs / 1000).toFixed(0)}s (${
      config.checkIntervalMinutes || 3
    } min + ${(jitterMs / 1000).toFixed(0)}s de jitter anti-bot)...`
  );

  setTimeout(async () => {
    await runScanAndNotify().catch((err) =>
      console.error('Erro no ciclo de monitoramento:', err.message)
    );
    scheduleNextScanWithJitter(getConfig());
  }, totalWaitMs);
}

async function main() {
  const args = process.argv.slice(2);
  const config = getConfig();

  if (args.includes('--send-summary')) {
    await runScanAndNotify();
    const summaryMsg = buildDailySummaryMessage(
      currentState.offers,
      config,
      currentState.priceHistory
    );
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

  scheduleNextScanWithJitter(config);
}

import { fileURLToPath } from 'node:url';

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase();

if (isDirectRun) {
  main().catch((err) => {
    console.error('Erro fatal:', err);
    process.exit(1);
  });
}
