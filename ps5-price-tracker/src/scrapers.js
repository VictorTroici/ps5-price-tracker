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
 * Verifica se a oferta no JSON-LD (Schema.org) ou no HTML da página está em estoque (Disponível).
 * Retorna false se detectar OutOfStock, SoldOut, Indisponível ou Produto Esgotado.
 */
export function isOfferInStock({ schemaAvailability, htmlSnippet = '', fullPageHtml = '' }) {
  // 1. Checa campo availability do Schema.org (JSON-LD)
  if (schemaAvailability && typeof schemaAvailability === 'string') {
    const availLower = schemaAvailability.toLowerCase();
    if (
      availLower.includes('outofstock') ||
      availLower.includes('soldout') ||
      availLower.includes('discontinued')
    ) {
      return false;
    }
    if (availLower.includes('instock') || availLower.includes('limitedavailability') || availLower.includes('onlineonly')) {
      return true;
    }
  }

  // 2. Checa fragmento do card na listagem
  if (htmlSnippet) {
    const snippetLower = htmlSnippet.toLowerCase();
    if (
      snippetLower.includes('produto esgotado') ||
      snippetLower.includes('produto indisponível') ||
      snippetLower.includes('produto indisponivel') ||
      snippetLower.includes('avise-me quando chegar') ||
      snippetLower.includes('não disponível')
    ) {
      return false;
    }
  }

  // 3. Checa HTML completo de página de produto individual
  if (fullPageHtml) {
    const pageLower = fullPageHtml.toLowerCase();
    // KaBuM!, Magalu, Amazon, Mercado Livre marcadores explícitos de sem estoque
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
 * 1. Mercado Livre Brasil (API Pública de Busca + Fallback HTML)
 */
export async function fetchMercadoLivreOffers(minConsolePrice = 2400) {
  const results = [];
  const queries = ['console playstation 5 slim', 'ps5 slim digital', 'ps5 slim disco'];

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
          // Garantir que tem estoque disponível
          if (item.available_quantity !== undefined && Number(item.available_quantity) <= 0) {
            continue;
          }
          const price = Number(item.price);
          const classification = classifyPS5Offer(item.title, price, minConsolePrice);
          if (!classification.isValidConsole) continue;

          results.push({
            id: `ml-${item.id}`,
            store: 'Mercado Livre',
            title: item.title,
            price,
            edition: classification.edition,
            editionLabel: classification.editionLabel,
            url: item.permalink,
            thumbnail: item.thumbnail || '',
            inStock: true,
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
      sourceType: 'scraper',
      checkedAt: new Date().toISOString(),
    });
  }
  return offers;
}

/**
 * 2. KaBuM! (Busca via HTML / __NEXT_DATA__ — verificando explicitamente available: true)
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
      // Percorre recursivamente o JSON do Next.js procurando objetos de produtos da KaBuM!
      const products = [];
      findKabumProductsInJson(json, products);

      for (const prod of products) {
        // Na KaBuM!, prod.available === false ou prod.quantity === 0 indica Produto Esgotado!
        if (prod.available === false) continue;
        if (prod.quantity !== undefined && Number(prod.quantity) <= 0) continue;

        const code = prod.code;
        const title = prod.name;
        const slug = prod.friendlyName || 'console-ps5';
        const price = Number(prod.priceWithDiscount || prod.price);

        const classification = classifyPS5Offer(title, price, minConsolePrice);
        if (!classification.isValidConsole) continue;

        results.push({
          id: `kabum-${code}`,
          store: 'KaBuM! (À vista no PIX)',
          title,
          price,
          edition: classification.edition,
          editionLabel: classification.editionLabel,
          url: `https://www.kabum.com.br/produto/${code}/${slug}`,
          inStock: true,
          sourceType: 'next_data',
          checkedAt: new Date().toISOString(),
        });
      }
    }
  } catch {
    // Silencioso caso haja bloqueio temporário
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
 * 3. Amazon Brasil (Busca pública HTML — filtrando apenas itens com preço ativo / em estoque)
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
        sourceType: 'scraper',
        checkedAt: new Date().toISOString(),
      });
    }
  } catch {
    // Silencioso em caso de captcha
  }

  return deduplicateOffers(results);
}

/**
 * 4. Agregadores de Ofertas (Zoom / Buscapé — verificando availability no JSON-LD)
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
              sourceType: 'aggregator',
              checkedAt: new Date().toISOString(),
            });
          }
        } catch {
          // Ignorar JSON-LD malformado
        }
      }
    } catch {
      // Ignorar falha de rede
    }
  }

  return deduplicateOffers(results);
}

/**
 * 5. Monitoramento de URLs Diretas Customizadas (Amazon, Kabum, Magalu, Mercado Livre, etc.)
 * Verifica rigorosamente se o produto NÃO está esgotado (OutOfStock / Produto Esgotado) antes de retornar!
 */
export async function fetchCustomProductUrl(item, minConsolePrice = 2400) {
  try {
    const res = await fetch(item.url, {
      headers: DEFAULT_HEADERS,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    // 1. Tenta JSON-LD primeiro (Schema.org Product)
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

            // Checa disponibilidade no JSON-LD E no HTML da página (ex: "Produto Esgotado" na KaBuM!)
            const inStock = isOfferInStock({
              schemaAvailability: offerObj?.availability,
              fullPageHtml: html,
            });
            if (!inStock) {
              return null; // Ignora produto esgotado!
            }

            const rawPrice = offerObj?.lowPrice || offerObj?.price || offerObj?.highPrice;
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
                sourceType: 'custom_url',
                checkedAt: new Date().toISOString(),
              };
            }
          }
        }
      } catch {
        // Segue para o próximo bloco
      }
    }

    // 2. Fallback meta tags (somente se a página não indicar produto esgotado)
    if (!isOfferInStock({ fullPageHtml: html })) {
      return null;
    }

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

  const [mlResult, kabumResult, amzResult, aggResult, ...customResults] =
    await Promise.allSettled([
      fetchMercadoLivreOffers(minPrice),
      fetchKabumOffers(minPrice),
      fetchAmazonOffers(minPrice),
      fetchAggregatorOffers(minPrice),
      ...customUrls.map((u) => fetchCustomProductUrl(u, minPrice)),
    ]);

  const allOffers = [];
  const sourceStatus = {
    mercadoLivre: { ok: mlResult.status === 'fulfilled', count: mlResult.value?.length || 0 },
    kabum: { ok: kabumResult.status === 'fulfilled', count: kabumResult.value?.length || 0 },
    amazon: { ok: amzResult.status === 'fulfilled', count: amzResult.value?.length || 0 },
    aggregators: { ok: aggResult.status === 'fulfilled', count: aggResult.value?.length || 0 },
  };

  if (mlResult.status === 'fulfilled') allOffers.push(...mlResult.value);
  if (kabumResult.status === 'fulfilled') allOffers.push(...kabumResult.value);
  if (amzResult.status === 'fulfilled') allOffers.push(...amzResult.value);
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
    if (host.includes('mercadolivre')) return 'Mercado Livre';
    if (host.includes('zoom')) return 'Zoom';
    if (host.includes('buscape')) return 'Buscapé';
    if (host.includes('pelando')) return 'Pelando';
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
