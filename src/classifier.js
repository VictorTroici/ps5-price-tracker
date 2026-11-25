const EXCLUDED_KEYWORDS = [
  'controle',
  'dualshock',
  'dualsense',
  'base de carregamento',
  'estacao de recarga',
  'estação de recarga',
  'suporte vertical',
  'suporte horizontal',
  'capa protetora',
  'tampa para console',
  'console cover',
  'faceplate',
  'headset',
  'pulse 3d',
  'pulse elite',
  'pulse explore',
  'camera hd',
  'câmera hd',
  'controle de midia',
  'controle de mídia',
  'leitor de disco avulso',
  'unidade de disco para',
  'drive de disco para',
  'adesivo',
  'skin para',
  'bolsa de transporte',
  'maleta',
  'cooler',
  'ventilador',
  'cabo hdmi',
  'playstation portal',
  'ps portal',
  'ps4',
  'playstation 4',
  'usado',
  'recondicionado',
  'vitrine',
  'defeito',
  'sucata',
  'caixa vazia',
  'apenas caixa',
  'aluguel',
  // Versões importadas / mercado cinza sem garantia Sony Brasil e sem avaliações:
  'uae version',
  'middle east version',
  'international version',
  'japan version',
  'jp version',
  'uk version',
  'eu version',
  'us version',
  'asian version',
  'versao importada',
  'versão importada',
  '1 year manufacturer warranty',
  'bundle gta vi',
  'bundle marvel',
  'wolverine +',
];

const CONSOLE_REQUIRED_KEYWORDS = [
  'ps5',
  'playstation 5',
  'play 5',
  'playstation®5',
];

const DIGITAL_KEYWORDS = [
  'digital',
  'sem disco',
  'sem leitor',
  'all-digital',
  'edicao digital',
  'edição digital',
  'CFI-2014B',
  'CFI-2015B',
  'CFI-2000B',
  'CFI-1214B',
  'CFI-1114B',
];

const DISC_KEYWORDS = [
  'com leitor',
  'com disco',
  'slim disk',
  'slim disc',
  'edicao padrao',
  'edição padrão',
  'standard',
  'leitor de blu-ray',
  'blu-ray',
  'midia fisica',
  'mídia física',
  'disco',
  'CFI-2014A',
  'CFI-2015A',
  'CFI-2000A',
  'CFI-1214A',
  'CFI-1114A',
];

/**
 * Benchmarks reais do histórico de preços de 90 dias (Buscapé / Zoom) para PS5 Slim Nacional (Lacrado)
 */
export const MARKET_BENCHMARKS = {
  digital: {
    average90d: 3749, // Média normal dos últimos 90 dias fora de promoção
    goodDealMax: 3599, // Preço de promoção real
    historicLowMax: 3350, // Menor preço histórico / Black Friday real
    inflatedMin: 3899, // Acima disso é preço cheio/inflado
    buscapeHistoryUrl:
      'https://www.buscape.com.br/console-de-videogame/console-playstation-5-slim-digital-edicao-digital?_lc=88#historico-de-precos',
  },
  disc: {
    average90d: 4049, // Média normal dos últimos 90 dias fora de promoção
    goodDealMax: 3849, // Preço de promoção real
    historicLowMax: 3600, // Menor preço histórico / Black Friday real
    inflatedMin: 4199, // Acima disso é preço cheio/inflado
    buscapeHistoryUrl:
      'https://www.buscape.com.br/console-de-videogame/console-playstation-5-slim-1tb-sony?_lc=88#historico-de-precos',
  },
  pro: {
    average90d: 6699,
    goodDealMax: 6299,
    historicLowMax: 5899,
    inflatedMin: 6999,
    buscapeHistoryUrl:
      'https://www.buscape.com.br/search?q=playstation+5+pro',
  },
};

export function normalizeText(text = '') {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Classifica um título de produto e preço
 */
export function classifyPS5Offer(title, price, minConsolePrice = 2400) {
  if (!title || typeof price !== 'number' || Number.isNaN(price)) {
    return { isValidConsole: false, edition: 'unknown', reason: 'Dados inválidos' };
  }

  if (price < minConsolePrice) {
    return {
      isValidConsole: false,
      edition: 'unknown',
      reason: `Preço (R$ ${price.toFixed(2)}) abaixo do mínimo de console (R$ ${minConsolePrice})`,
    };
  }

  if (price > 8500) {
    return {
      isValidConsole: false,
      edition: 'unknown',
      reason: `Preço acima do limite razoável (R$ ${price.toFixed(2)})`,
    };
  }

  const norm = normalizeText(title);

  const mentionsPS5 = CONSOLE_REQUIRED_KEYWORDS.some((kw) => norm.includes(normalizeText(kw)));
  if (!mentionsPS5) {
    return { isValidConsole: false, edition: 'unknown', reason: 'Não menciona PS5 / PlayStation 5' };
  }

  const startsWithAccessory =
    /^(controle|jogo|game|tampa|capa|suporte|headset|base|leitor de disco|unidade de disco|cabo|cooler|skin|adesivo)\b/i.test(
      norm.trim()
    );
  if (startsWithAccessory) {
    return { isValidConsole: false, edition: 'unknown', reason: 'Inicia com nome de acessório ou jogo' };
  }

  for (const kw of EXCLUDED_KEYWORDS) {
    const normKw = normalizeText(kw);
    if ((normKw === 'controle' || normKw === 'dualsense') && norm.includes('console')) {
      continue;
    }
    if (norm.includes(normKw)) {
      return { isValidConsole: false, edition: 'unknown', reason: `Contém termo excluído: "${kw}"` };
    }
  }

  if (/\bps5\s+pro\b|\bplaystation\s*®?\s*5\s+pro\b/.test(norm)) {
    return {
      isValidConsole: true,
      edition: 'pro',
      editionLabel: 'PS5 Pro',
    };
  }

  const isDigital = DIGITAL_KEYWORDS.some((kw) => norm.includes(normalizeText(kw)));
  const isDisc = DISC_KEYWORDS.some((kw) => norm.includes(normalizeText(kw)));

  if (norm.includes('sem disco') || norm.includes('sem leitor') || isDigital) {
    return {
      isValidConsole: true,
      edition: 'digital',
      editionLabel: 'PS5 Slim Digital (Sem Disco)',
    };
  }

  if (isDisc) {
    return {
      isValidConsole: true,
      edition: 'disc',
      editionLabel: 'PS5 Slim Com Leitor de Disco',
    };
  }

  return {
    isValidConsole: true,
    edition: 'disc',
    editionLabel: 'PS5 Slim Com Leitor de Disco',
  };
}

/**
 * Detector Anti-Black Fraude:
 * Compara o preço atual com a média histórica de 90 dias (Buscapé/Zoom) e com o histórico local salvo no state.json
 */
export function analyzeBlackFridayVerdict(offer, priceHistoryRecord = null) {
  const bench = MARKET_BENCHMARKS[offer.edition] || MARKET_BENCHMARKS.disc;
  const price = offer.price;
  const diffFromAvg90d = bench.average90d - price;
  const pctFromAvg90d = Math.round((diffFromAvg90d / bench.average90d) * 100);

  // Detecta se a loja colocou um preço "De: R$ 5.200" mentiroso acima da média real de 90 dias
  const claimedOriginal = offer.paymentInfo?.cardTotal || price;
  const isFakeAnchor = claimedOriginal > bench.average90d + 450 && price > bench.goodDealMax;

  let tier = 'normal';
  let badge = '🟡 PREÇO NORMAL DE MERCADO';
  let explanation = `Está na faixa normal dos últimos 90 dias (Média histórica: R$ ${bench.average90d}).`;

  if (price <= bench.historicLowMax) {
    tier = 'historic_low';
    badge = '🔥 PREÇO HISTÓRICO DE BLACK FRIDAY (VALE MUITO!)';
    explanation = `Está R$ ${diffFromAvg90d.toFixed(0)} (${pctFromAvg90d}%) ABAIXO da média dos últimos 90 dias (R$ ${bench.average90d})! Desconto 100% real!`;
  } else if (price <= bench.goodDealMax) {
    tier = 'good_deal';
    badge = '🟢 PROMOÇÃO REAL (ABAIXO DA MÉDIA DE 90 DIAS)';
    explanation = `Economia real de R$ ${diffFromAvg90d.toFixed(0)} (${pctFromAvg90d}% menor que a média de 90 dias de R$ ${bench.average90d}).`;
  } else if (price >= bench.inflatedMin) {
    tier = 'inflated';
    badge = isFakeAnchor
      ? '🚨 ALERTA BLACK FRAUDE (PREÇO INFLADO)'
      : '🔴 ACIMA DA MÉDIA DOS ÚLTIMOS 90 DIAS';
    explanation = `Está R$ ${Math.abs(diffFromAvg90d).toFixed(0)} mais caro que a média normal de 90 dias (R$ ${bench.average90d}). Não vale a pena agora.`;
  }

  let trackedStats = null;
  if (priceHistoryRecord && priceHistoryRecord.minPrice) {
    trackedStats = {
      minSeen: Math.min(priceHistoryRecord.minPrice, price),
      maxSeen: Math.max(priceHistoryRecord.maxPrice || price, price),
      lastPrice: priceHistoryRecord.lastPrice || price,
      isLowestEverSeenByBot: price <= priceHistoryRecord.minPrice,
    };
  }

  return {
    tier,
    badge,
    explanation,
    average90d: bench.average90d,
    diffFromAvg90d,
    pctFromAvg90d,
    isFakeAnchor,
    buscapeHistoryUrl: bench.buscapeHistoryUrl,
    trackedStats,
  };
}

export function evaluateTargetHit(offer, config, priceHistoryMap = {}) {
  const target =
    offer.edition === 'digital'
      ? config.targetPriceDigital
      : config.targetPriceDisc;

  const isHit = offer.price <= target;
  const diff = target - offer.price;
  const historyRecord = priceHistoryMap[offer.id] || null;
  const verdict = analyzeBlackFridayVerdict(offer, historyRecord);

  return {
    isHit,
    targetPrice: target,
    savingsFromTarget: diff,
    verdict,
  };
}
