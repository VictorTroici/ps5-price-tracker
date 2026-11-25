import { classifyPS5Offer } from './classifier.js';

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
};

/**
 * Converte strings de preço em BRL (ex: "R$ 3.499,90" ou "3499.90") para Number
 */
export function parseBRLPrice(raw) {
  if (typeof raw === 'number') return raw;
  if (!raw || typeof raw !== 'string') return NaN;
  const cleaned = raw.replace(/[^\d.,]/g, '').trim();
  if (!cleaned) return NaN;

  if (cleaned.includes(',')) {
    const normalized = cleaned.replace(/\./g, '').replace(',', '.');
    return Number(normalized);
  }
  if (/^\d{1,2}\.\d{3}$/.test(cleaned)) {
    return Number(cleaned.replace('.', ''));
  }
  return Number(cleaned);
}

/**
 * Calcula / normaliza informações de pagamento (PIX vs Parcelado em até 10x/12x)
 */
export function enrichPaymentInfo({
  price,
  regularPrice,
  installmentsCount,
  installmentValue,
  paymentMethodLabel,
  couponCode,
  cashbackInfo,
}) {
  const pixPrice = Number(price);
  let cardTotal = regularPrice && Number(regularPrice) >= pixPrice ? Number(regularPrice) : null;
  let maxInstallments = installmentsCount ? Number(installmentsCount) : 10;
  let perInstallment = installmentValue ? Number(installmentValue) : null;

  if (!cardTotal && perInstallment && maxInstallments) {
    cardTotal = Number((perInstallment * maxInstallments).toFixed(2));
  }
  if (cardTotal && !perInstallment && maxInstallments) {
    perInstallment = Number((cardTotal / maxInstallments).toFixed(2));
  }

  return {
    pixPrice,
    cardTotal: cardTotal || pixPrice,
    maxInstallments,
    perInstallment: perInstallment || Number(((cardTotal || pixPrice) / maxInstallments).toFixed(2)),
    hasPixDiscount: Boolean(cardTotal && cardTotal > pixPrice + 5),
    paymentMethodLabel:
      paymentMethodLabel ||
      (cardTotal && cardTotal > pixPrice + 5 ? 'À vista no PIX (c/ desconto)' : 'À vista ou Parcelado'),
    couponCode: couponCode || null,
    cashbackInfo: cashbackInfo || null,
  };
}

/**
 * Verifica se a oferta no JSON-LD (Schema.org) ou no HTML da página está em estoque (Disponível).
 */
export function isOfferInStock({ schemaAvailability, htmlSnippet = '', fullPageHtml = '' }) {
  if (schemaAvailability && typeof schemaAvailability === 'string') {
    const availLower = schemaAvailability.toLowerCase();
    if (
      availLower.includes('outofstock') ||
      availLower.includes('soldout') ||
      availLower.includes('discontinued')
    ) {
      return false;
    }
    if (
      availLower.includes('instock') ||
      availLower.includes('limitedavailability') ||
      availLower.includes('onlineonly')
    ) {
      return true;
    }
  }

  if (htmlSnippet) {
    const snippetLower = htmlSnippet.toLowerCase();
    if (
      snippetLower.includes('produto esgotado') ||
      snippetLower.includes('produto indisponível') ||
      snippetLower.includes('produto indisponivel') ||
      snippetLower.includes('avise-me quando chegar') ||
      snippetLower.includes('não disponível') ||
      snippetLower.includes('oferta encerrada') ||
      snippetLower.includes('promoção encerrada')
    ) {
      return false;
    }
  }

  if (fullPageHtml) {
    const pageLower = fullPageHtml.toLowerCase();
    if (
      pageLower.includes('"availability":"https://schema.org/outofstock"') ||
      pageLower.includes('"availability":"http://schema.org/outofstock"') ||
      pageLower.includes('"available":false') ||
      pageLower.includes('produto esgotado') ||
      pageLower.includes('este produto está indisponível') ||
      pageLower.includes('anúncio pausado')
    ) {
      return false;
    }
  }

  return true;
}

/**
 * 1. Mercado Livre Brasil (API Oficial + Loja Oficial PlayStation + Fallback HTML)
 */
export async function fetchMercadoLivreOffers(minConsolePrice = 2400) {
  const results = [];
  const queries = [
    'console playstation 5 slim',
    'ps5 slim digital',
    'ps5 slim com leitor',
    'playstation 5 slim loja oficial',
  ];

  for (const q of queries) {
    try {
      const apiUrl = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(
        q
      )}&condition=new&limit=15`;
      const res = await fetch(apiUrl, {
        headers: DEFAULT_HEADERS,
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const data = await res.json();
        for (const item of data.results || []) {
          if (item.available_quantity !== undefined && Number(item.available_quantity) <= 0) {
            continue;
          }
          const price = Number(item.price);
          const classification = classifyPS5Offer(item.title, price, minConsolePrice);
          if (!classification.isValidConsole) continue;

          const isOfficial = Boolean(item.official_store_id || item.official_store_name);
          const storeLabel = isOfficial
            ? `Mercado Livre (${item.official_store_name || 'Loja Oficial'})`
            : 'Mercado Livre';

          const instQty = item.installments?.quantity || 10;
          const instAmt = item.installments?.amount || Number((price / instQty).toFixed(2));
          const paymentInfo = enrichPaymentInfo({
            price,
            regularPrice: item.original_price || price,
            installmentsCount: instQty,
            installmentValue: instAmt,
          });

          results.push({
            id: `ml-${item.id}`,
            store: storeLabel,
            title: item.title,
            price,
            edition: classification.edition,
            editionLabel: classification.editionLabel,
            url: item.permalink,
            inStock: true,
            paymentInfo,
            sourceType: 'api',
            checkedAt: new Date().toISOString(),
          });
        }
      } else {
        const htmlOffers = await fetchMercadoLivreHtmlFallback(q, minConsolePrice);
        results.push(...htmlOffers);
      }
    } catch {
      const htmlOffers = await fetchMercadoLivreHtmlFallback(q, minConsolePrice).catch(() => []);
      results.push(...htmlOffers);
    }
  }

  return deduplicateOffers(results);
}

async function fetchMercadoLivreHtmlFallback(query, minConsolePrice) {
  const slug = query.replace(/\s+/g, '-');
  const url = `https://lista.mercadolivre.com.br/${encodeURIComponent(slug)}_Novo`;
  const res = await fetch(url, {
    headers: DEFAULT_HEADERS,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return [];
  const html = await res.text();
  const offers = [];

  const cardRegex =
    /<a[^>]+href="(https:\/\/(?:www\.|produto\.)?mercadolivre\.com\.br\/[^"]+)"[^>]*>([^<]{10,160})<\/a>[\s\S]{0,1200}?andes-money-amount__fraction[^>]*>([\d.]+)</gi;
  let match;
  while ((match = cardRegex.exec(html)) !== null) {
    const link = match[1].split('#')[0].split('?')[0];
    const title = decodeHtmlEntities(match[2].trim());
    const price = parseBRLPrice(match[3]);
    const classification = classifyPS5Offer(title, price, minConsolePrice);
    if (!classification.isValidConsole) continue;

    offers.push({
      id: `ml-html-${Buffer.from(link).toString('base64').slice(0, 16)}`,
      store: 'Mercado Livre',
      title,
      price,
      edition: classification.edition,
      editionLabel: classification.editionLabel,
      url: link,
      inStock: true,
      paymentInfo: enrichPaymentInfo({ price, installmentsCount: 10 }),
      sourceType: 'scraper',
      checkedAt: new Date().toISOString(),
    });
  }
  return offers;
}

/**
 * 2. KaBuM! (Extrai tanto o preço à vista no PIX quanto o preço parcelado em 10x sem juros)
 */
export async function fetchKabumOffers(minConsolePrice = 2400) {
  const results = [];
  const url = 'https://www.kabum.com.br/busca/console-playstation-5-slim';

  try {
    const res = await fetch(url, {
      headers: DEFAULT_HEADERS,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const html = await res.text();

    const nextDataMatch = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
    );
    if (nextDataMatch) {
      const json = JSON.parse(nextDataMatch[1]);
      const products = [];
      findKabumProductsInJson(json, products);

      for (const prod of products) {
        if (prod.available === false) continue;
        if (prod.quantity !== undefined && Number(prod.quantity) <= 0) continue;

        const code = prod.code;
        const title = prod.name;
        const slug = prod.friendlyName || 'console-ps5';
        const pixPrice = Number(prod.priceWithDiscount || prod.price);
        const cardPrice = Number(prod.price || pixPrice);

        const classification = classifyPS5Offer(title, pixPrice, minConsolePrice);
        if (!classification.isValidConsole) continue;

        const paymentInfo = enrichPaymentInfo({
          price: pixPrice,
          regularPrice: cardPrice,
          installmentsCount: 10,
          paymentMethodLabel: 'À vista no PIX (10% OFF)',
        });

        results.push({
          id: `kabum-${code}`,
          store: 'KaBuM!',
          title,
          price: pixPrice,
          edition: classification.edition,
          editionLabel: classification.editionLabel,
          url: `https://www.kabum.com.br/produto/${code}/${slug}`,
          inStock: true,
          paymentInfo,
          sourceType: 'next_data',
          checkedAt: new Date().toISOString(),
        });
      }
    }
  } catch {
    // Silencioso
  }

  return deduplicateOffers(results);
}

function findKabumProductsInJson(node, acc) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) findKabumProductsInJson(item, acc);
    return;
  }
  if (
    typeof node.code === 'number' &&
    typeof node.name === 'string' &&
    (node.priceWithDiscount !== undefined || node.price !== undefined)
  ) {
    acc.push(node);
    return;
  }
  for (const val of Object.values(node)) {
    if (val && typeof val === 'object') {
      findKabumProductsInJson(val, acc);
    }
  }
}

/**
 * 3. Amazon Brasil (Extrai preço à vista e parcelamento do card)
 */
export async function fetchAmazonOffers(minConsolePrice = 2400) {
  const results = [];
  const url = 'https://www.amazon.com.br/s?k=console+playstation+5+slim';

  try {
    const res = await fetch(url, {
      headers: {
        ...DEFAULT_HEADERS,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const html = await res.text();

    const blocks = html.split(/data-asin="([A-Z0-9]{10})"/g);
    for (let i = 1; i < blocks.length; i += 2) {
      const asin = blocks[i];
      const content = blocks[i + 1] || '';
      if (!asin) continue;

      if (!isOfferInStock({ htmlSnippet: content })) continue;

      const titleMatch =
        content.match(/<span class="a-size-base-plus[^"]*">([^<]{10,200})<\/span>/) ||
        content.match(/<span class="a-size-medium[^"]*">([^<]{10,200})<\/span>/) ||
        content.match(/<h2[^>]*aria-label="([^"]{10,200})"/);
      const priceWholeMatch = content.match(
        /<span class="a-price-whole">([\d.]+)(?:<span|<\/span>)/
      );
      const priceFractionMatch = content.match(/<span class="a-price-fraction">(\d{2})<\/span>/);

      if (!titleMatch || !priceWholeMatch) continue;
      const title = decodeHtmlEntities(titleMatch[1].trim());
      const whole = priceWholeMatch[1].replace(/\./g, '');
      const fraction = priceFractionMatch ? priceFractionMatch[1] : '00';
      const price = Number(`${whole}.${fraction}`);

      // Tenta extrair texto de parcelamento da Amazon ex: "Em até 10x R$ 379,90 sem juros"
      const instMatch = content.match(/(\d{1,2})x\s*(?:de\s*)?R\$\s*([\d.,]+)/i);
      const instCount = instMatch ? Number(instMatch[1]) : 10;
      const instVal = instMatch ? parseBRLPrice(instMatch[2]) : Number((price / 10).toFixed(2));

      const classification = classifyPS5Offer(title, price, minConsolePrice);
      if (!classification.isValidConsole) continue;

      results.push({
        id: `amz-${asin}`,
        store: 'Amazon Brasil',
        title,
        price,
        edition: classification.edition,
        editionLabel: classification.editionLabel,
        url: `https://www.amazon.com.br/dp/${asin}`,
        inStock: true,
        paymentInfo: enrichPaymentInfo({
          price,
          regularPrice: Number((instCount * instVal).toFixed(2)),
          installmentsCount: instCount,
          installmentValue: instVal,
        }),
        sourceType: 'scraper',
        checkedAt: new Date().toISOString(),
      });
    }
  } catch {
    // Silencioso
  }

  return deduplicateOffers(results);
}

/**
 * 4. Pelando & Promobit (Comunidades de Promoções, Cupons e Cashback)
 * Onde aparecem os PS5 de R$ 3.100 a R$ 3.600 com cupom!
 */
export async function fetchCommunityDealOffers(minConsolePrice = 2400) {
  const results = [];

  // 4.1 Promobit (Busca de ofertas ativas de PS5)
  try {
    const promobitUrl = 'https://www.promobit.com.br/buscar?q=playstation%205%20slim';
    const res = await fetch(promobitUrl, {
      headers: DEFAULT_HEADERS,
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const html = await res.text();
      // Extrai de JSON-LD ou __NEXT_DATA__ do Promobit
      const nextMatch = html.match(
        /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
      );
      if (nextMatch) {
        const json = JSON.parse(nextMatch[1]);
        const offersList = [];
        findCommunityDealsInJson(json, offersList);
        for (const deal of offersList) {
          if (deal.expired || deal.status === 'expired' || deal.isExpired) continue;
          const title = deal.title || deal.name;
          const price = parseBRLPrice(String(deal.price || ''));
          const classification = classifyPS5Offer(title, price, minConsolePrice);
          if (!classification.isValidConsole) continue;

          const coupon = deal.coupon || deal.couponCode || extractCouponFromText(title);
          const storeName = deal.storeName || deal.merchant || 'Promobit';
          const link = deal.slug
            ? `https://www.promobit.com.br/oferta/${deal.slug}`
            : promobitUrl;

          results.push({
            id: `promobit-${deal.id || Buffer.from(link).toString('base64').slice(0, 12)}`,
            store: `Promobit (${storeName})`,
            title,
            price,
            edition: classification.edition,
            editionLabel: classification.editionLabel,
            url: link,
            inStock: true,
            paymentInfo: enrichPaymentInfo({
              price,
              couponCode: coupon,
              paymentMethodLabel: coupon ? `Com Cupom: ${coupon}` : 'Oferta Comunidade',
            }),
            sourceType: 'community',
            checkedAt: new Date().toISOString(),
          });
        }
      }
    }
  } catch {
    // Ignorar falha
  }

  // 4.2 Pelando (Busca de ofertas de PS5)
  try {
    const pelandoUrl = 'https://www.pelando.com.br/busca/playstation%205%20slim';
    const res = await fetch(pelandoUrl, {
      headers: DEFAULT_HEADERS,
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const html = await res.text();
      const nextMatch = html.match(
        /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
      );
      if (nextMatch) {
        const json = JSON.parse(nextMatch[1]);
        const offersList = [];
        findCommunityDealsInJson(json, offersList);
        for (const deal of offersList) {
          if (deal.expired || deal.status === 'EXPIRED' || deal.isExpired || deal.cold) continue;
          const title = deal.title || deal.name;
          const price = parseBRLPrice(String(deal.price || ''));
          const classification = classifyPS5Offer(title, price, minConsolePrice);
          if (!classification.isValidConsole) continue;

          const coupon = deal.couponCode || deal.coupon || extractCouponFromText(title);
          const storeName = deal.merchant?.name || deal.store?.name || 'Pelando';
          const link = deal.url?.startsWith('http')
            ? deal.url
            : deal.id
            ? `https://www.pelando.com.br/d/${deal.id}`
            : pelandoUrl;

          results.push({
            id: `pelando-${deal.id || Buffer.from(link).toString('base64').slice(0, 12)}`,
            store: `Pelando (${storeName})`,
            title,
            price,
            edition: classification.edition,
            editionLabel: classification.editionLabel,
            url: link,
            inStock: true,
            paymentInfo: enrichPaymentInfo({
              price,
              couponCode: coupon,
              paymentMethodLabel: coupon ? `Com Cupom: ${coupon}` : 'Oferta Comunidade',
            }),
            sourceType: 'community',
            checkedAt: new Date().toISOString(),
          });
        }
      }
    }
  } catch {
    // Ignorar falha
  }

  return deduplicateOffers(results);
}

function findCommunityDealsInJson(node, acc) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) findCommunityDealsInJson(item, acc);
    return;
  }
  if (
    typeof node.title === 'string' &&
    node.price !== undefined &&
    Number(node.price) > 1000
  ) {
    acc.push(node);
    return;
  }
  for (const val of Object.values(node)) {
    if (val && typeof val === 'object') {
      findCommunityDealsInJson(val, acc);
    }
  }
}

function extractCouponFromText(text = '') {
  const m = text.match(/cupom[:\s]+([A-Z0-9]{4,20})/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * 5. Magazine Luiza, Carrefour e Casas Bahia (Varejistas Diretos via JSON-LD)
 */
export async function fetchDirectRetailersOffers(minConsolePrice = 2400) {
  const results = [];
  const retailers = [
    {
      name: 'Magazine Luiza',
      prefix: 'magalu',
      baseUrl: 'https://www.magazineluiza.com.br',
      searchUrl: 'https://www.magazineluiza.com.br/busca/console+playstation+5+slim/',
    },
    {
      name: 'Carrefour',
      prefix: 'carrefour',
      baseUrl: 'https://www.carrefour.com.br',
      searchUrl: 'https://www.carrefour.com.br/busca/console-playstation-5-slim',
    },
    {
      name: 'Casas Bahia',
      prefix: 'casasbahia',
      baseUrl: 'https://www.casasbahia.com.br',
      searchUrl: 'https://www.casasbahia.com.br/console-playstation-5-slim/b',
    },
  ];

  for (const ret of retailers) {
    try {
      const res = await fetch(ret.searchUrl, {
        headers: DEFAULT_HEADERS,
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      const jsonLdMatches = html.matchAll(
        /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
      );

      for (const m of jsonLdMatches) {
        try {
          const parsed = JSON.parse(m[1]);
          const items =
            parsed?.itemListElement ||
            (parsed['@graph'] ? parsed['@graph'] : Array.isArray(parsed) ? parsed : [parsed]);
          for (const entry of items) {
            const prod = entry?.item || entry;
            if (!prod?.name) continue;

            const offerObj = Array.isArray(prod.offers) ? prod.offers[0] : prod.offers;
            const availability = offerObj?.availability;
            if (!isOfferInStock({ schemaAvailability: availability })) continue;

            const rawPrice = offerObj?.lowPrice || offerObj?.price;
            const highPrice = offerObj?.highPrice || rawPrice;
            const price = parseBRLPrice(String(rawPrice || ''));
            const classification = classifyPS5Offer(prod.name, price, minConsolePrice);
            if (!classification.isValidConsole) continue;

            const link = prod.url?.startsWith('http')
              ? prod.url
              : `${ret.baseUrl}${prod.url || ''}`;

            results.push({
              id: `${ret.prefix}-${Buffer.from(link).toString('base64').slice(0, 14)}`,
              store: ret.name,
              title: prod.name,
              price,
              edition: classification.edition,
              editionLabel: classification.editionLabel,
              url: link,
              inStock: true,
              paymentInfo: enrichPaymentInfo({
                price,
                regularPrice: parseBRLPrice(String(highPrice || price)),
                installmentsCount: 10,
              }),
              sourceType: 'retailer',
              checkedAt: new Date().toISOString(),
            });
          }
        } catch {
          // Ignorar JSON-LD malformado
        }
      }
    } catch {
      // Ignorar bloqueio de rede
    }
  }

  return deduplicateOffers(results);
}

/**
 * 6. Agregadores de Ofertas (Zoom / Buscapé — verificando availability no JSON-LD)
 */
export async function fetchAggregatorOffers(minConsolePrice = 2400) {
  const results = [];
  const sources = [
    {
      name: 'Zoom (Comparador / Cashback)',
      prefix: 'zoom',
      baseUrl: 'https://www.zoom.com.br',
      searchUrl: 'https://www.zoom.com.br/search?q=console+playstation+5+slim',
    },
    {
      name: 'Buscapé (Comparador)',
      prefix: 'buscape',
      baseUrl: 'https://www.buscape.com.br',
      searchUrl: 'https://www.buscape.com.br/search?q=console+playstation+5+slim',
    },
  ];

  for (const src of sources) {
    try {
      const res = await fetch(src.searchUrl, {
        headers: DEFAULT_HEADERS,
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      const jsonLdMatches = html.matchAll(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g
      );
      for (const m of jsonLdMatches) {
        try {
          const parsed = JSON.parse(m[1]);
          const items = parsed?.itemListElement || (Array.isArray(parsed) ? parsed : [parsed]);
          for (const entry of items) {
            const prod = entry?.item || entry;
            if (!prod?.name) continue;

            const availability =
              prod?.offers?.availability || prod?.offers?.offers?.[0]?.availability;
            if (!isOfferInStock({ schemaAvailability: availability })) continue;

            const rawPrice =
              prod?.offers?.lowPrice ||
              prod?.offers?.price ||
              prod?.offers?.offers?.[0]?.price;
            const highPrice = prod?.offers?.highPrice || rawPrice;
            const price = parseBRLPrice(String(rawPrice || ''));
            const classification = classifyPS5Offer(prod.name, price, minConsolePrice);
            if (!classification.isValidConsole) continue;

            const link = prod.url?.startsWith('http')
              ? prod.url
              : `${src.baseUrl}${prod.url || '/search?q=ps5+slim'}`;

            results.push({
              id: `${src.prefix}-${Buffer.from(link).toString('base64').slice(0, 14)}`,
              store: src.name,
              title: prod.name,
              price,
              edition: classification.edition,
              editionLabel: classification.editionLabel,
              url: link,
              inStock: true,
              paymentInfo: enrichPaymentInfo({
                price,
                regularPrice: parseBRLPrice(String(highPrice || price)),
                installmentsCount: 10,
              }),
              sourceType: 'aggregator',
              checkedAt: new Date().toISOString(),
            });
          }
        } catch {
          // Ignorar
        }
      }
    } catch {
      // Ignorar
    }
  }

  return deduplicateOffers(results);
}

/**
 * 7. Monitoramento de URLs Diretas Customizadas (Amazon, Kabum, Magalu, Mercado Livre, etc.)
 */
export async function fetchCustomProductUrl(item, minConsolePrice = 2400) {
  try {
    const res = await fetch(item.url, {
      headers: DEFAULT_HEADERS,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    const jsonLdMatches = html.matchAll(
      /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
    );
    for (const m of jsonLdMatches) {
      try {
        const data = JSON.parse(m[1]);
        const candidates = Array.isArray(data) ? data : data['@graph'] ? data['@graph'] : [data];
        for (const node of candidates) {
          if (node['@type'] === 'Product' || node.offers) {
            const title = node.name || item.label || 'Console PS5';
            const offerObj = Array.isArray(node.offers) ? node.offers[0] : node.offers;

            const inStock = isOfferInStock({
              schemaAvailability: offerObj?.availability,
              fullPageHtml: html,
            });
            if (!inStock) return null;

            const rawPrice = offerObj?.lowPrice || offerObj?.price || offerObj?.highPrice;
            const highPrice = offerObj?.highPrice || rawPrice;
            const price = parseBRLPrice(String(rawPrice || ''));
            const classification = classifyPS5Offer(title, price, minConsolePrice);
            if (classification.isValidConsole) {
              return {
                id: `custom-${Buffer.from(item.url).toString('base64').slice(0, 14)}`,
                store: item.store || extractDomainName(item.url),
                title,
                price,
                edition: item.edition || classification.edition,
                editionLabel:
                  item.edition === 'digital'
                    ? 'PS5 Slim Digital (Sem Disco)'
                    : item.edition === 'disc'
                    ? 'PS5 Slim Com Leitor de Disco'
                    : classification.editionLabel,
                url: item.url,
                inStock: true,
                paymentInfo: enrichPaymentInfo({
                  price,
                  regularPrice: parseBRLPrice(String(highPrice || price)),
                  installmentsCount: 10,
                }),
                sourceType: 'custom_url',
                checkedAt: new Date().toISOString(),
              };
            }
          }
        }
      } catch {
        // Segue
      }
    }

    if (!isOfferInStock({ fullPageHtml: html })) return null;

    const metaPrice =
      html.match(/property="product:price:amount"\s+content="([\d.,]+)"/i) ||
      html.match(/name="twitter:data1"\s+content="R\$\s*([\d.,]+)"/i);
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (metaPrice && titleMatch) {
      const price = parseBRLPrice(metaPrice[1]);
      const title = decodeHtmlEntities(titleMatch[1]);
      const classification = classifyPS5Offer(title, price, minConsolePrice);
      if (classification.isValidConsole) {
        return {
          id: `custom-${Buffer.from(item.url).toString('base64').slice(0, 14)}`,
          store: item.store || extractDomainName(item.url),
          title,
          price,
          edition: item.edition || classification.edition,
          editionLabel: classification.editionLabel,
          url: item.url,
          inStock: true,
          paymentInfo: enrichPaymentInfo({ price, installmentsCount: 10 }),
          sourceType: 'custom_url',
          checkedAt: new Date().toISOString(),
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Executa a varredura completa em todas as fontes em paralelo
 */
export async function scanAllStores(config, customUrls = []) {
  const minPrice = config.minConsolePrice || 2400;

  const [
    mlResult,
    kabumResult,
    amzResult,
    communityResult,
    retailersResult,
    aggResult,
    ...customResults
  ] = await Promise.allSettled([
    fetchMercadoLivreOffers(minPrice),
    fetchKabumOffers(minPrice),
    fetchAmazonOffers(minPrice),
    fetchCommunityDealOffers(minPrice),
    fetchDirectRetailersOffers(minPrice),
    fetchAggregatorOffers(minPrice),
    ...customUrls.map((u) => fetchCustomProductUrl(u, minPrice)),
  ]);

  const allOffers = [];
  const sourceStatus = {
    mercadoLivre: { ok: mlResult.status === 'fulfilled', count: mlResult.value?.length || 0 },
    kabum: { ok: kabumResult.status === 'fulfilled', count: kabumResult.value?.length || 0 },
    amazon: { ok: amzResult.status === 'fulfilled', count: amzResult.value?.length || 0 },
    communityDeals: {
      ok: communityResult.status === 'fulfilled',
      count: communityResult.value?.length || 0,
    },
    retailers: {
      ok: retailersResult.status === 'fulfilled',
      count: retailersResult.value?.length || 0,
    },
    aggregators: { ok: aggResult.status === 'fulfilled', count: aggResult.value?.length || 0 },
  };

  if (mlResult.status === 'fulfilled') allOffers.push(...mlResult.value);
  if (kabumResult.status === 'fulfilled') allOffers.push(...kabumResult.value);
  if (amzResult.status === 'fulfilled') allOffers.push(...amzResult.value);
  if (communityResult.status === 'fulfilled') allOffers.push(...communityResult.value);
  if (retailersResult.status === 'fulfilled') allOffers.push(...retailersResult.value);
  if (aggResult.status === 'fulfilled') allOffers.push(...aggResult.value);

  for (const c of customResults) {
    if (c.status === 'fulfilled' && c.value) {
      allOffers.push(c.value);
    }
  }

  const deduped = deduplicateOffers(allOffers).sort((a, b) => a.price - b.price);

  return {
    offers: deduped,
    sourceStatus,
    scannedAt: new Date().toISOString(),
  };
}

function deduplicateOffers(offers) {
  const seen = new Map();
  for (const offer of offers) {
    const key = offer.url.split('?')[0];
    const existing = seen.get(key);
    if (!existing || offer.price < existing.price) {
      seen.set(key, offer);
    }
  }
  return Array.from(seen.values());
}

function extractDomainName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.includes('amazon')) return 'Amazon Brasil';
    if (host.includes('kabum')) return 'KaBuM!';
    if (host.includes('magazineluiza') || host.includes('magalu')) return 'Magazine Luiza';
    if (host.includes('carrefour')) return 'Carrefour';
    if (host.includes('casasbahia')) return 'Casas Bahia';
    if (host.includes('mercadolivre')) return 'Mercado Livre';
    if (host.includes('zoom')) return 'Zoom';
    if (host.includes('buscape')) return 'Buscapé';
    if (host.includes('pelando')) return 'Pelando';
    if (host.includes('promobit')) return 'Promobit';
    return host;
  } catch {
    return 'Loja Customizada';
  }
}

function decodeHtmlEntities(str = '') {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
