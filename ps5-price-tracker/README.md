# 🎮 PS5 Slim Price Tracker + Alerta no Telegram

Sistema completo em **Node.js** (zero dependências externas) para monitorar o preço do **PlayStation 5 Slim (Edição Digital e Com Leitor de Disco)** nas principais lojas (**Amazon Brasil, KaBuM!, Mercado Livre, Magazine Luiza**) e agregadores de ofertas/cashback (**Zoom, Buscapé, Pelando, Promobit**), disparando alertas instantâneos no seu **Telegram** quando atingir a sua meta de preço.

---

## 🎯 Suas Metas Configuradas por Padrão

No arquivo [`.env`](file:///C:/Users/Gamer/.gemini/antigravity/scratch/ps5-price-tracker/.env):
- **PS5 Slim Digital (Sem Leitor de Disco):** alerta quando estiver por **`<= R$ 3.800,00`**
- **PS5 Slim Com Leitor de Disco:** alerta quando estiver por **`<= R$ 4.000,00`**
- **Filtro Anti-Acessórios:** ignora automaticamente controles DualSense avulsos, leitor de disco vendido separado, jogos, tampas, capas, suportes e consoles usados/recondicionados.

*(Dica: em promoções com cupom ou PIX, o PS5 Slim Digital costuma aparecer na faixa de R$ 3.300 a R$ 3.600 e o Com Disco entre R$ 3.550 e R$ 3.850 — você receberá no Telegram o valor exato e quanto economizou abaixo da sua meta!)*

---

## 📲 Como Configurar seu Bot do Telegram (Leva 1 minuto)

1. Abra o Telegram e procure por **`@BotFather`**.
2. Envie o comando `/newbot`.
3. Escolha um nome (ex: `Meu Alerta PS5`) e um usuário terminado em `bot` (ex: `meu_alerta_ps5_bot`).
4. O `@BotFather` vai te entregar um **Token** (algo como `712345678:AAH...`).
5. **Importante:** Clique no link do seu novo bot que o BotFather mostrou e envie um **"Oi"** para ele (para abrir a conversa).
6. Cole o Token no arquivo [`.env`](file:///C:/Users/Gamer/.gemini/antigravity/scratch/ps5-price-tracker/.env) em `TELEGRAM_BOT_TOKEN=` **ou** direto pela interface do Dashboard Web!
   - Você nem precisa descobrir seu `TELEGRAM_CHAT_ID` manualmente: ao rodar o teste após mandar "Oi" para o bot, o script descobre e salva seu `CHAT_ID` sozinho!

---

## 🚀 Como Rodar

Abra o terminal na pasta do projeto (`C:\Users\Gamer\.gemini\antigravity\scratch\ps5-price-tracker`):

### 1. Iniciar o Monitoramento Contínuo + Dashboard Web
```powershell
npm start
```
Isso vai:
- Subir o **Dashboard Web** em `http://localhost:3055`
- Fazer uma varredura imediata nas lojas
- Continuar verificando a cada **15 minutos** em segundo plano e te avisar no Telegram sempre que surgir um preço menor ou igual à sua meta!

### 2. Testar apenas o envio para o Telegram
```powershell
npm run test-telegram
```

### 3. Rodar apenas uma verificação única no terminal
```powershell
npm run check
```
