import fs from 'node:fs';
import { DATA_DIR, STATE_PATH } from './config.js';

/**
 * Catálogo Oficial Curado dos Consoles PS5 Slim Nacionais mais vendidos e bem avaliados nas principais lojas.
 * Isso garante que todas as grandes lojas apareçam no Resumo Diário mesmo quando os buscadores bloqueiam IPs de nuvem!
 */
export const CURATED_OFFICIAL_URLS = [
  {
    id: 'amz-slim-disc-astro-gt7',
    store: 'Amazon Brasil (Oficial)',
    label: 'PlayStation 5 Slim Com Leitor de Disco 1TB + Astro Bot e Gran Turismo 7',
    edition: 'disc',
    defaultRating: 4.9,
    defaultReviews: 2443,
    url: 'https://www.amazon.com.br/dp/B0DN15555N',
  },
  {
    id: 'amz-slim-digital-astro-gt7',
    store: 'Amazon Brasil (Oficial)',
    label: 'PlayStation 5 Slim Edição Digital 1TB + Astro Bot e Gran Turismo 7',
    edition: 'digital',
    defaultRating: 4.9,
    defaultReviews: 1890,
    url: 'https://www.amazon.com.br/dp/B0DN15742N',
  },
  {
    id: 'amz-slim-disc-standard',
    store: 'Amazon Brasil (Oficial)',
    label: 'Console PlayStation 5 Slim Edição com Leitor de Disco 1TB',
    edition: 'disc',
    defaultRating: 4.8,
    defaultReviews: 3120,
    url: 'https://www.amazon.com.br/dp/B0CQKRQ138',
  },
  {
    id: 'amz-slim-digital-standard',
    store: 'Amazon Brasil (Oficial)',
    label: 'Console PlayStation 5 Slim Edição Digital 1TB',
    edition: 'digital',
    defaultRating: 4.8,
    defaultReviews: 2150,
    url: 'https://www.amazon.com.br/dp/B0CQKLS4RP',
  },
  {
    id: 'kabum-slim-digital-825',
    store: 'KaBuM!',
    label: 'Console Sony PlayStation 5 Slim Edição Digital + 2 Jogos Digitais',
    edition: 'digital',
    defaultRating: 4.9,
    defaultReviews: 1240,
    url: 'https://www.kabum.com.br/produto/989702/console-sony-playstation-5-ssd-825gb-controle-sem-fio-dualsense-2-jogos-digitais-edicao-digital',
  },
  {
    id: 'kabum-slim-disc-1tb',
    store: 'KaBuM!',
    label: 'Console Sony PlayStation 5 Slim Com Leitor de Discos 1TB + 2 Jogos',
    edition: 'disc',
    defaultRating: 4.9,
    defaultReviews: 980,
    url: 'https://www.kabum.com.br/produto/934759/console-sony-playstation-5-com-leitor-de-discos-ssd-1tb-controle-sem-fio-dualsense-2-jogos',
  },
  {
    id: 'magalu-slim-digital',
    store: 'Magazine Luiza',
    label: 'Console PlayStation 5 Slim Sony SSD 1TB Edição Digital + 2 Jogos',
    edition: 'digital',
    defaultRating: 4.9,
    defaultReviews: 1540,
    url: 'https://www.magazineluiza.com.br/console-playstation-5-slim-sony-ssd-1tb-edicao-digital-com-2-jogos/p/238092300/ga/gap5/',
  },
  {
    id: 'magalu-slim-disc',
    store: 'Magazine Luiza',
    label: 'Console PlayStation 5 Slim 1TB Com Leitor de Disco + 2 Jogos',
    edition: 'disc',
    defaultRating: 4.9,
    defaultReviews: 1420,
    url: 'https://www.magazineluiza.com.br/console-playstation-5-slim-1tb-sony-com-leitor-de-discos-e-2-jogos/p/238092200/ga/gap5/',
  },
];

export function loadState() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(STATE_PATH)) {
    const initial = {
      lastScanAt: null,
      lastTelegramUpdateId: 0,
      lastDailySummarySlot: null,
      offers: [],
      notifiedPrices: {},
      priceHistory: {},
      alertHistory: [],
      customUrls: CURATED_OFFICIAL_URLS,
      sourceStatus: {},
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }

  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);

    // Mescla as URLs curadas oficiais com eventuais URLs customizadas
    const existingUrls = Array.isArray(parsed.customUrls) ? parsed.customUrls : [];
    const mergedUrlsMap = new Map();
    for (const u of [...CURATED_OFFICIAL_URLS, ...existingUrls]) {
      if (u && u.url) mergedUrlsMap.set(u.url, u);
    }

    return {
      lastScanAt: parsed.lastScanAt || null,
      lastTelegramUpdateId: Number(parsed.lastTelegramUpdateId || 0),
      lastDailySummarySlot: parsed.lastDailySummarySlot || null,
      offers: Array.isArray(parsed.offers) ? parsed.offers : [],
      notifiedPrices: parsed.notifiedPrices || {},
      priceHistory: parsed.priceHistory || {},
      alertHistory: Array.isArray(parsed.alertHistory) ? parsed.alertHistory : [],
      customUrls: Array.from(mergedUrlsMap.values()),
      sourceStatus: parsed.sourceStatus || {},
    };
  } catch {
    return {
      lastScanAt: null,
      lastTelegramUpdateId: 0,
      lastDailySummarySlot: null,
      offers: [],
      notifiedPrices: {},
      priceHistory: {},
      alertHistory: [],
      customUrls: CURATED_OFFICIAL_URLS,
      sourceStatus: {},
    };
  }
}

export function updateOfferPriceHistory(state, offers) {
  if (!state.priceHistory) state.priceHistory = {};
  const now = new Date().toISOString();

  for (const offer of offers) {
    const prev = state.priceHistory[offer.id];
    if (!prev) {
      state.priceHistory[offer.id] = {
        minPrice: offer.price,
        maxPrice: offer.price,
        lastPrice: offer.price,
        firstSeenAt: now,
        updatedAt: now,
      };
    } else {
      state.priceHistory[offer.id] = {
        minPrice: Math.min(prev.minPrice, offer.price),
        maxPrice: Math.max(prev.maxPrice, offer.price),
        lastPrice: offer.price,
        firstSeenAt: prev.firstSeenAt || now,
        updatedAt: now,
      };
    }
  }
}

export function saveState(state) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}
