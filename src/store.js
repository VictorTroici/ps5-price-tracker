import fs from 'node:fs';
import { DATA_DIR, STATE_PATH } from './config.js';

const DEFAULT_CUSTOM_URLS = [
  {
    id: 'kabum-slim-digital',
    store: 'KaBuM!',
    label: 'Console PS5 Slim Digital 1TB Branco',
    edition: 'digital',
    url: 'https://www.kabum.com.br/produto/542929/console-playstation-5-slim-edicao-digital-branco-1tb-com-2-jogos-1000038914',
  },
  {
    id: 'kabum-slim-disc',
    store: 'KaBuM!',
    label: 'Console PS5 Slim Com Leitor de Disco 1TB',
    edition: 'disc',
    url: 'https://www.kabum.com.br/produto/542928/console-playstation-5-slim-branco-1tb-com-leitor-de-discos-e-2-jogos-1000038899',
  },
];

export function loadState() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(STATE_PATH)) {
    const initial = {
      lastScanAt: null,
      offers: [],
      notifiedPrices: {}, // { [offerId]: lowestNotifiedPrice }
      alertHistory: [],
      customUrls: DEFAULT_CUSTOM_URLS,
      sourceStatus: {},
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }

  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      lastScanAt: parsed.lastScanAt || null,
      offers: Array.isArray(parsed.offers) ? parsed.offers : [],
      notifiedPrices: parsed.notifiedPrices || {},
      alertHistory: Array.isArray(parsed.alertHistory) ? parsed.alertHistory : [],
      customUrls: Array.isArray(parsed.customUrls) ? parsed.customUrls : DEFAULT_CUSTOM_URLS,
      sourceStatus: parsed.sourceStatus || {},
    };
  } catch {
    return {
      lastScanAt: null,
      offers: [],
      notifiedPrices: {},
      alertHistory: [],
      customUrls: DEFAULT_CUSTOM_URLS,
      sourceStatus: {},
    };
  }
}

export function saveState(state) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}
