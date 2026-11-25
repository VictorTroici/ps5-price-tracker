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
];

const CONSOLE_REQUIRED_KEYWORDS = [
  'ps5',
  'playstation 5',
  'play 5',
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

export function normalizeText(text = '') {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Classifica um título de produto e preço:
 * Retorna:
 *  - isValidConsole: boolean
 *  - edition: 'digital' | 'disc' | 'pro' | 'unknown'
 *  - editionLabel: string
 *  - reason?: string (se ignorado)
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

  // Tem que mencionar PS5 ou PlayStation 5
  const mentionsPS5 = CONSOLE_REQUIRED_KEYWORDS.some((kw) => norm.includes(normalizeText(kw)));
  if (!mentionsPS5) {
    return { isValidConsole: false, edition: 'unknown', reason: 'Não menciona PS5 / PlayStation 5' };
  }

  // Verificar palavras de exclusão (acessórios, jogos avulsos, apenas leitor, etc.)
  // Cuidado: "Console PS5 + Controle DualSense" é válido, mas "Controle DualSense PS5" não.
  const startsWithAccessory = /^(controle|jogo|game|tampa|capa|suporte|headset|base|leitor de disco|unidade de disco|cabo|cooler|skin|adesivo)\b/i.test(
    norm.trim()
  );
  if (startsWithAccessory) {
    return { isValidConsole: false, edition: 'unknown', reason: 'Inicia com nome de acessório ou jogo' };
  }

  for (const kw of EXCLUDED_KEYWORDS) {
    const normKw = normalizeText(kw);
    // Permitir "controle" ou "dualsense" apenas se a palavra "console" também estiver no título
    if ((normKw === 'controle' || normKw === 'dualsense') && norm.includes('console')) {
      continue;
    }
    if (norm.includes(normKw)) {
      return { isValidConsole: false, edition: 'unknown', reason: `Contém termo excluído: "${kw}"` };
    }
  }

  // Checar se é PS5 Pro
  if (/\bps5\s+pro\b|\bplaystation\s+5\s+pro\b/.test(norm)) {
    return {
      isValidConsole: true,
      edition: 'pro',
      editionLabel: 'PS5 Pro',
    };
  }

  // Determinar se é Digital (Sem Disco) ou Com Leitor de Disco
  const isDigital = DIGITAL_KEYWORDS.some((kw) => norm.includes(normalizeText(kw)));
  const isDisc = DISC_KEYWORDS.some((kw) => norm.includes(normalizeText(kw)));

  // Se diz "sem leitor de disco" ou "sem disco", é digital mesmo contendo a palavra "disco"
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

  // Se é um Console PS5 válido mas o título não especifica explícito "Digital" nem "Com Disco",
  // classificamos pelo padrão ou como 'disc' / 'digital' dependendo de pistas adicionais
  return {
    isValidConsole: true,
    edition: 'disc', // Na dúvida, assume-se ou avalia-se pelo teto
    editionLabel: 'PS5 Console (Verificar Edição no Link)',
  };
}

export function evaluateTargetHit(offer, config) {
  const target =
    offer.edition === 'digital'
      ? config.targetPriceDigital
      : config.targetPriceDisc;

  const isHit = offer.price <= target;
  const diff = target - offer.price;

  return {
    isHit,
    targetPrice: target,
    savingsFromTarget: diff,
  };
}
