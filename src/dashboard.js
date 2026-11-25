import http from 'node:http';
import { getConfig, updateEnvValues } from './config.js';
import { evaluateTargetHit } from './classifier.js';
import { sendTelegramMessage, formatBRL } from './telegram.js';

export function startDashboardServer({ getState, runScanNow, updateCustomUrls }) {
  const config = getConfig();
  const port = config.port || 3055;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const currentConfig = getConfig();
      const state = getState();
      const enrichedOffers = (state.offers || []).map((offer) => ({
        ...offer,
        evaluation: evaluateTargetHit(offer, currentConfig),
      }));

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          config: {
            targetPriceDigital: currentConfig.targetPriceDigital,
            targetPriceDisc: currentConfig.targetPriceDisc,
            minConsolePrice: currentConfig.minConsolePrice,
            checkIntervalMinutes: currentConfig.checkIntervalMinutes,
            hasTelegramToken: Boolean(currentConfig.telegramBotToken),
            telegramChatId: currentConfig.telegramChatId,
          },
          lastScanAt: state.lastScanAt,
          sourceStatus: state.sourceStatus,
          offers: enrichedOffers,
          alertHistory: (state.alertHistory || []).slice(0, 20),
          customUrls: state.customUrls || [],
        })
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/scan') {
      const scanRes = await runScanNow();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ...scanRes }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readJsonBody(req);
      const updates = {};
      if (body.targetPriceDigital !== undefined)
        updates.TARGET_PRICE_DIGITAL = Number(body.targetPriceDigital);
      if (body.targetPriceDisc !== undefined)
        updates.TARGET_PRICE_DISC = Number(body.targetPriceDisc);
      if (body.checkIntervalMinutes !== undefined)
        updates.CHECK_INTERVAL_MINUTES = Number(body.checkIntervalMinutes);
      if (body.telegramBotToken !== undefined && body.telegramBotToken.trim() !== '')
        updates.TELEGRAM_BOT_TOKEN = body.telegramBotToken.trim();
      if (body.telegramChatId !== undefined)
        updates.TELEGRAM_CHAT_ID = body.telegramChatId.trim();

      const newCfg = updateEnvValues(updates);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, config: newCfg }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/test-telegram') {
      const cfg = getConfig();
      const msg = [
        `✅ <b>Teste do Monitor de Preços PS5!</b>`,
        ``,
        `Seu bot do Telegram está conectado e pronto para enviar alertas!`,
        `🎮 <b>Meta PS5 Digital (Sem Disco):</b> ${formatBRL(cfg.targetPriceDigital)}`,
        `💿 <b>Meta PS5 Com Leitor de Disco:</b> ${formatBRL(cfg.targetPriceDisc)}`,
      ].join('\n');

      const result = await sendTelegramMessage(cfg.telegramBotToken, cfg.telegramChatId, msg);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/custom-urls') {
      const body = await readJsonBody(req);
      const updated = updateCustomUrls(body);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, customUrls: updated }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboardHtml());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(`🌐 Dashboard Web disponível em: http://localhost:${port}`);
  });

  return server;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PS5 Price Tracker & Alertas Telegram</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card: #131b2e;
      --border: #1e2a45;
      --primary: #0070d1;
      --primary-hover: #0084f4;
      --success: #10b981;
      --warning: #f59e0b;
      --text: #f1f5f9;
      --muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
      line-height: 1.5;
    }
    .container { max-width: 1180px; margin: 0 auto; }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    h1 { font-size: 1.5rem; display: flex; align-items: center; gap: 10px; }
    .badge {
      font-size: 0.78rem;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(0, 112, 209, 0.2);
      color: #60a5fa;
      border: 1px solid rgba(96, 165, 250, 0.3);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 20px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }
    .card h2 {
      font-size: 1.05rem;
      margin-bottom: 14px;
      color: #e2e8f0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .form-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 12px;
    }
    label { font-size: 0.85rem; color: var(--muted); }
    input, select {
      background: #090d16;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 9px 12px;
      border-radius: 8px;
      font-size: 0.92rem;
    }
    .btn {
      background: var(--primary);
      color: white;
      border: none;
      padding: 9px 16px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.9rem;
      transition: background 0.15s;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn-secondary {
      background: #1e293b;
      border: 1px solid var(--border);
    }
    .btn-secondary:hover { background: #334155; }
    .btn-success { background: #059669; }
    .btn-success:hover { background: #10b981; }
    .quick-links {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .quick-links a {
      text-decoration: none;
      font-size: 0.82rem;
      color: #93c5fd;
      background: rgba(30, 58, 138, 0.35);
      border: 1px solid rgba(59, 130, 246, 0.3);
      padding: 6px 11px;
      border-radius: 8px;
    }
    .quick-links a:hover { background: rgba(30, 58, 138, 0.6); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    th, td {
      text-align: left;
      padding: 12px 10px;
      border-bottom: 1px solid var(--border);
    }
    th { color: var(--muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
    .price-hit {
      color: var(--success);
      font-weight: 700;
    }
    .tag-hit {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.35);
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 0.78rem;
      font-weight: 600;
    }
    .tag-above {
      background: rgba(148, 163, 184, 0.12);
      color: var(--muted);
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 0.78rem;
    }
    .status-msg {
      margin-top: 10px;
      font-size: 0.85rem;
      color: #38bdf8;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>🎮 PS5 Slim Price Tracker <span class="badge" id="lastScanBadge">Carregando...</span></h1>
        <p style="color: var(--muted); font-size: 0.88rem; margin-top: 4px;">
          Monitorando Amazon, KaBuM!, Mercado Livre, Zoom e Buscapé com alertas no Telegram.
        </p>
      </div>
      <div style="display: flex; gap: 10px;">
        <button class="btn" id="scanBtn" onclick="triggerScan()">🔍 Buscar Preços Agora</button>
      </div>
    </header>

    <div class="grid">
      <div class="card">
        <h2>🎯 Metas de Preço & Intervalo</h2>
        <div class="form-row">
          <label>Meta PS5 Slim Digital / Sem Disco (R$)</label>
          <input type="number" id="targetDigital" value="3800" />
        </div>
        <div class="form-row">
          <label>Meta PS5 Slim Com Leitor de Disco (R$)</label>
          <input type="number" id="targetDisc" value="4000" />
        </div>
        <div class="form-row">
          <label>Intervalo de Verificação Automática (minutos)</label>
          <input type="number" id="intervalMin" value="15" />
        </div>
        <button class="btn" onclick="saveSettings()">💾 Salvar Metas</button>
        <div id="settingsStatus" class="status-msg"></div>
      </div>

      <div class="card">
        <h2>✈️ Configuração de Alerta no Telegram</h2>
        <div class="form-row">
          <label>Bot Token (crie no @BotFather com /newbot)</label>
          <input type="password" id="botToken" placeholder="Cole seu token ex: 123456:ABC-DEF..." />
        </div>
        <div class="form-row">
          <label>Chat ID (opcional se você enviar 'Oi' para o bot antes de testar)</label>
          <input type="text" id="chatId" placeholder="Ex: 123456789" />
        </div>
        <div style="display: flex; gap: 10px; flex-wrap: wrap;">
          <button class="btn" onclick="saveSettings()">Salvar Telegram</button>
          <button class="btn btn-success" onclick="testTelegram()">📲 Testar Alerta no Telegram</button>
        </div>
        <div id="telegramStatus" class="status-msg"></div>
      </div>

      <div class="card">
        <h2>⚡ Atalhos Diretos (Comunidade & Lojas)</h2>
        <p style="font-size: 0.84rem; color: var(--muted); margin-bottom: 12px;">
          Links diretos já filtrados pelo menor preço e comunidades de cupons/cashback:
        </p>
        <div class="quick-links">
          <a href="https://www.pelando.com.br/busca/ps5" target="_blank">🔥 Pelando (Cupons PS5)</a>
          <a href="https://www.promobit.com.br/buscar?q=ps5" target="_blank">🏷️ Promobit (Ofertas PS5)</a>
          <a href="https://www.zoom.com.br/search?q=console+playstation+5+slim" target="_blank">📉 Zoom (Histórico & Cashback)</a>
          <a href="https://www.buscape.com.br/search?q=console+playstation+5+slim" target="_blank">📊 Buscapé (Comparador)</a>
          <a href="https://www.amazon.com.br/s?k=console+playstation+5+slim" target="_blank">📦 Amazon Brasil</a>
          <a href="https://www.kabum.com.br/busca/console-playstation-5-slim" target="_blank">⚡ KaBuM! (PIX)</a>
          <a href="https://www.magazineluiza.com.br/busca/console+playstation+5+slim/" target="_blank">🛍️ Magazine Luiza</a>
          <a href="https://lista.mercadolivre.com.br/console-playstation-5-slim_Novo" target="_blank">🤝 Mercado Livre</a>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 24px;">
      <h2>
        <span>📋 Ofertas de PS5 Encontradas (<span id="offersCount">0</span>)</span>
      </h2>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Loja / Fonte</th>
              <th>Console</th>
              <th>Edição</th>
              <th>Preço Atual</th>
              <th>Status vs. Sua Meta</th>
              <th>Ação</th>
            </tr>
          </thead>
          <tbody id="offersTableBody">
            <tr><td colspan="6" style="color: var(--muted);">Carregando ofertas...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    function formatBRL(v) {
      return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
    }

    async function loadStatus() {
      const res = await fetch('/api/status');
      const data = await res.json();

      document.getElementById('targetDigital').value = data.config.targetPriceDigital;
      document.getElementById('targetDisc').value = data.config.targetPriceDisc;
      document.getElementById('intervalMin').value = data.config.checkIntervalMinutes;
      if (data.config.telegramChatId) {
        document.getElementById('chatId').value = data.config.telegramChatId;
      }

      const lastScanText = data.lastScanAt
        ? 'Última checagem: ' + new Date(data.lastScanAt).toLocaleTimeString('pt-BR')
        : 'Ainda não verificado';
      document.getElementById('lastScanBadge').textContent = lastScanText;

      const offers = data.offers || [];
      document.getElementById('offersCount').textContent = offers.length;
      const tbody = document.getElementById('offersTableBody');

      if (offers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="color: var(--muted);">Nenhuma oferta carregada ainda. Clique em "Buscar Preços Agora".</td></tr>';
        return;
      }

      tbody.innerHTML = offers.map(o => {
        const hit = o.evaluation?.isHit;
        const target = o.evaluation?.targetPrice || 4000;
        const diff = target - o.price;
        const statusBadge = hit
          ? '<span class="tag-hit">🎯 ABAIXO DA META (' + formatBRL(Math.abs(diff)) + ' menor!)</span>'
          : '<span class="tag-above">Acima da meta (+ ' + formatBRL(Math.abs(diff)) + ')</span>';

        return '<tr>' +
          '<td><strong>' + o.store + '</strong></td>' +
          '<td style="max-width: 380px;">' + o.title + '</td>' +
          '<td>' + o.editionLabel + '</td>' +
          '<td class="' + (hit ? 'price-hit' : '') + '">' + formatBRL(o.price) + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td><a class="btn btn-secondary" style="text-decoration:none; padding: 6px 12px; font-size: 0.82rem;" href="' + o.url + '" target="_blank">Abrir Loja ↗</a></td>' +
        '</tr>';
      }).join('');
    }

    async function triggerScan() {
      const btn = document.getElementById('scanBtn');
      btn.disabled = true;
      btn.textContent = '⏳ Varrendo Lojas...';
      try {
        await fetch('/api/scan', { method: 'POST' });
        await loadStatus();
      } finally {
        btn.disabled = false;
        btn.textContent = '🔍 Buscar Preços Agora';
      }
    }

    async function saveSettings() {
      const payload = {
        targetPriceDigital: Number(document.getElementById('targetDigital').value),
        targetPriceDisc: Number(document.getElementById('targetDisc').value),
        checkIntervalMinutes: Number(document.getElementById('intervalMin').value),
        telegramBotToken: document.getElementById('botToken').value,
        telegramChatId: document.getElementById('chatId').value,
      };
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      document.getElementById('settingsStatus').textContent = '✅ Configurações salvas com sucesso!';
      await loadStatus();
    }

    async function testTelegram() {
      await saveSettings();
      const statusEl = document.getElementById('telegramStatus');
      statusEl.textContent = '⏳ Enviando mensagem de teste para o Telegram...';
      const res = await fetch('/api/test-telegram', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        statusEl.textContent = '✅ Mensagem enviada com sucesso! Verifique seu Telegram (Chat ID: ' + data.chatId + ')';
        await loadStatus();
      } else {
        statusEl.textContent = '❌ Erro: ' + data.error;
      }
    }

    loadStatus();
  </script>
</body>
</html>`;
}
