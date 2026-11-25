import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '..');
export const ENV_PATH = path.join(ROOT_DIR, '.env');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const STATE_PATH = path.join(DATA_DIR, 'state.json');

export function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return;
  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    process.env[key] = val;
  }
}

export function getConfig() {
  loadEnvFile();
  return {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    targetPriceDigital: Number(process.env.TARGET_PRICE_DIGITAL || 3800),
    targetPriceDisc: Number(process.env.TARGET_PRICE_DISC || 4000),
    minConsolePrice: Number(process.env.MIN_CONSOLE_PRICE || 2400),
    minPriceDropReais: Number(process.env.MIN_PRICE_DROP_REAIS || 50),
    dailySummaryHours: (process.env.DAILY_SUMMARY_HOURS || '12,20')
      .split(',')
      .map((h) => Number(h.trim()))
      .filter((h) => !Number.isNaN(h)),
    checkIntervalMinutes: Number(process.env.CHECK_INTERVAL_MINUTES || 10),
    port: Number(process.env.PORT || 3055),
  };
}

export function updateEnvValues(updates) {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null) continue;
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
    process.env[key] = String(value);
  }
  fs.writeFileSync(ENV_PATH, content.trim() + '\n', 'utf-8');
  return getConfig();
}
