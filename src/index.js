import { getConfig, updateEnvValues } from './config.js';
import { evaluateTargetHit } from './classifier.js';
import { scanAllStores } from './scrapers.js';
import { loadState, saveState } from './store.js';
import {
  sendTelegramMessage,
  buildOfferAlertMessage,
  formatBRL,
} from './telegram.js';
import { startDashboardServer } from './dashboard.js';

let currentState = loadState();
let isScanning = false;

export async function runScanAndNotify() {
  if (isScanning) {
    return { skipped: true, offersCount: currentState.offers.length };
  }
  isScanning = true;

  try {
    const config = getConfig();
    console.log(
      `\n🔎 [${new Date().toLocaleTimeString('pt-BR')}] Iniciando varredura de preços do PS5 Slim...`
    );
    console.log(
      `   🎯 Metas atuais -> Digital (Sem Disco): ${formatBRL(
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

    let alertsTriggered = 0;
    const minDrop = config.minPriceDropReais || 50;

    for (const offer of offers) {
      const evaluation = evaluateTargetHit(offer, config);
      const statusIcon = evaluation.isHit ? '🔥 [META ATINGIDA]' : '  ';
      console.log(
        `   ${statusIcon} [${offer.store}] ${offer.editionLabel} -> ${formatBRL(
          offer.price
        )} (${offer.title.slice(0, 60)}...)`
      );

      if (evaluation.isHit) {
        const prevNotifiedPrice = currentState.notifiedPrices[offer.id];
        // Só envia no Telegram se nunca enviou com sucesso antes OU se teve uma queda significativa (>= minDrop, padrão R$ 50)
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
              // IMPORTANTE: Só grava que notificou DEPOIS que o Telegram confirmar envio!
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
          } else {
            console.log(
              `   💡 [Dica] Oferta atingiu sua meta! Configure TELEGRAM_BOT_TOKEN no .env para receber no celular.`
            );
          }
        }
      }
    }

    if (offers.length === 0) {
      console.log(
        `   ℹ️ Nenhuma oferta retornada diretamente na varredura automática.`
      );
    } else {
      console.log(
        `✅ Varredura concluída: ${offers.length} ofertas de PS5 analisadas | ${alertsTriggered} alertas enviados no Telegram.`
      );
    }

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
 * /start ou /status -> Mostra o resumo e os menores preços atuais
 * /buscar -> Faz uma busca imediata nas lojas e responde no Telegram
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

      // Se o TELEGRAM_CHAT_ID ainda não estava salvo, salva agora automaticamente e dispara varredura!
      const wasUnlinked = !config.telegramChatId;
      if (wasUnlinked || config.telegramChatId !== chatId) {
        updateEnvValues({ TELEGRAM_CHAT_ID: chatId });
        console.log(`🔗 Telegram vinculado automaticamente ao Chat ID: ${chatId}`);
      }

      const lower = text.toLowerCase();

      if (lower === '/start' || lower === 'oi' || lower === '/status') {
        const bestDigital = currentState.offers
          .filter((o) => o.edition === 'digital')
          .sort((a, b) => a.price - b.price)[0];
        const bestDisc = currentState.offers
          .filter((o) => o.edition === 'disc')
          .sort((a, b) => a.price - b.price)[0];

        const reply = [
          `🤖 <b>Monitor Automático PS5 Slim Ativo!</b>`,
          ``,
          `⏱️ <b>Verificação automática:</b> de hora em hora (só envia alerta quando bater a meta ou cair pelo menos ${formatBRL(
            config.minPriceDropReais
          )}).`,
          `🎯 <b>Sua Meta Digital:</b> ${formatBRL(config.targetPriceDigital)}`,
          `🎯 <b>Sua Meta Com Disco:</b> ${formatBRL(config.targetPriceDisc)}`,
          ``,
          `📊 <b>Melhores preços da última varredura:</b>`,
          bestDigital
            ? `🎮 Digital: <b>${formatBRL(bestDigital.price)}</b> (${bestDigital.store}) — <a href="${bestDigital.url}">Ver</a>`
            : `🎮 Digital: Sem oferta carregada`,
          bestDisc
            ? `💿 Com Disco: <b>${formatBRL(bestDisc.price)}</b> (${bestDisc.store}) — <a href="${bestDisc.url}">Ver</a>`
            : `💿 Com Disco: Sem oferta carregada`,
          ``,
          `💡 <b>Comandos aqui no Telegram:</b>`,
          `• /buscar — Verifica todas as lojas agora mesmo`,
          `• /status — Mostra os menores preços atuais`,
          `• /meta 3700 3950 — Muda suas metas (Digital e Com Disco)`,
        ].join('\n');

        await sendTelegramMessage(config.telegramBotToken, chatId, reply);

        // Se acabou de vincular e já tinha oferta batendo a meta que falhou antes, envia o alerta agora!
        if (wasUnlinked) {
          await runScanAndNotify();
        }
      } else if (lower === '/buscar') {
        await sendTelegramMessage(
          config.telegramBotToken,
          chatId,
          `🔎 <b>Varrendo Amazon, KaBuM!, Mercado Livre, Zoom e Buscapé agora...</b>`
        );
        await runScanAndNotify();
        const best = currentState.offers[0];
        if (best) {
          await sendTelegramMessage(
            config.telegramBotToken,
            chatId,
            `✅ Varredura concluída! Menor preço encontrado agora:\n<b>${best.title}</b>\n💰 <b>${formatBRL(
              best.price
            )}</b> na <b>${best.store}</b>\n🛒 <a href="${best.url}">Abrir Oferta</a>`
          );
        }
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
            `ℹ️ Use o formato: <code>/meta 3700 3950</code> (Digital e Com Disco)`
          );
        }
      }
    }
  } catch {
    // Silencioso em falha temporária de polling
  }
}

async function main() {
  const args = process.argv.slice(2);
  const config = getConfig();

  // Se houve alerta salvo sem ter sido enviado no Telegram (quando o CHAT_ID estava vazio), limpa para poder enviar!
  if (!config.telegramChatId && Object.keys(currentState.notifiedPrices || {}).length > 0) {
    currentState.notifiedPrices = {};
    saveState(currentState);
  }

  if (args.includes('--test-telegram')) {
    console.log('📲 Testando envio de alerta para o Telegram...');
    const msg = [
      `✅ <b>Teste do Monitor de Preços PS5 Slim!</b>`,
      ``,
      `Seu alerta está funcionando! Assim que um PS5 atingir sua meta, você receberá o link direto aqui.`,
      `🎮 <b>Meta Digital (Sem Disco):</b> ${formatBRL(config.targetPriceDigital)}`,
      `💿 <b>Meta Com Leitor de Disco:</b> ${formatBRL(config.targetPriceDisc)}`,
    ].join('\n');

    const res = await sendTelegramMessage(
      config.telegramBotToken,
      config.telegramChatId,
      msg
    );
    if (res.ok) {
      console.log(`🎉 Sucesso! Mensagem enviada para o Chat ID: ${res.chatId}`);
    } else {
      console.error(`❌ Erro ao enviar mensagem: ${res.error}`);
    }
    return;
  }

  if (args.includes('--once')) {
    await pollTelegramCommands();
    await runScanAndNotify();
    return;
  }

  // Modo contínuo + Comandos no Telegram + Dashboard Web
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

  // Escuta mensagens que você mandar para o bot no Telegram a cada 5 segundos
  setInterval(() => {
    pollTelegramCommands();
  }, 5000);

  const intervalMs = Math.max(1, config.checkIntervalMinutes || 60) * 60 * 1000;
  console.log(
    `⏱️ Monitoramento automático de hora em hora ativo! (Verificando lojas a cada ${
      config.checkIntervalMinutes || 60
    } minutos e escutando seu bot no Telegram em tempo real).`
  );

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
