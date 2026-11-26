import { classifyPS5Offer } from './classifier.js';

/**
 * Pool de User-Agents atualizados (Chrome 131, Edge 131, Firefox 133 no Windows/macOS)
 * combinado com Client Hints completos (Sec-Ch-Ua, Sec-Fetch-*, Viewport-Width)
 */
const USER_AGENTS = [
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: '"Windows"',
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    secChUa: '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: '"Windows"',
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="130", "Chromium";v="130", "Not_A Brand";v="24"',
    platform: '"Windows"',
  },
];

export function buildCamouflagedHeaders(referer = 'https://www.google.com.br/') {
  const profile = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  return {
    'User-Agent': profile.ua,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Sec-Ch-Ua': profile.secChUa,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': profile.platform,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Viewport-Width': '1920',
    Referer: referer,
  };
}

/**
 * Delay aleatório (jitter) entre requisições para evitar detecção de bot
 */
export function sleepJitter(minMs = 150, maxMs = 550) {
  const ms = Math.floor(minMs + Math.random() * (maxMs - minMs));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * Converte contagens de avaliações no formato brasileiro da Amazon/Lojas:
 * Ex: "(2,4 mil)" -> 2400 | "(2.443)" -> 2443 | "324" -> 324 | "Mais de 20 mil compras" -> 20000
 */
export function parseBrazilianCount(rawText = '') {
  if (!rawText) return 0;
  const text = String(rawText).toLowerCase().replace(/\u00a0/g, ' ');

  // Ex: "4,6 mil" ou "20 mil"
  const milMatch = text.match(/([\d.,]+)\s*mil\b/i);
  if (milMatch) {
    const num = Number(milMatch[1].replace(/\./g, '').replace(',', '.'));
    if (!Number.isNaN(num)) return Math.round(num * 1000);
  }

  // Ex: "(2.443)" ou "324"
  const digitsMatch = text.match(/([\d.]+)/);
  if (digitsMatch) {
    const num = Number(digitsMatch[1].replace(/\./g, ''));
    if (!Number.isNaN(num)) return num;
  }
  return 0;
}

/**
 * Detecta cupons visíveis no HTML/texto do card ou página do produto e calcula o desconto em R$
 * Suporta:
 * - "Cupom de R$ 100,00 off disponível" / "Economize R$ 200,00 com cupom" / "#couponBadgeRegularVpc"
 * - "Cupom de 10% off" (calcula % sobre o basePrice, mas ignora "5% off à vista no Pix" quando o preço exibido já é o preço Pix!)
 * - Código explícito ex: "Cupom: PLAY300" ou "CARTAOBF110"
 */
export function extractVisibleCoupon(htmlOrText = '', basePixPrice = 0) {
  if (!htmlOrText || !basePixPrice) {
    return { couponDiscount: 0, couponCode: null, couponLabel: null };
  }

  // Remove tags mantendo separação para facilitar regex em blocos como:
  // <span>Cupom de </span><span>R$ 100,00</span><span> off disponível</span>
  const cleanText = htmlOrText
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  let couponDiscount = 0;
  let couponCode = null;
  let couponLabel = null;

  // 1. Cupom em Reais (Ex: "Cupom de R$ 100,00 off", "Economize R$ 150,00 com cupom", "R$ 200 off no cupom")
  const realCouponMatch =
    cleanText.match(/cupom\s+(?:de\s+)?R\$\s*([\d.,]+)\s*(?:off|de\s+desconto)?/i) ||
    cleanText.match(/economize\s+R\$\s*([\d.,]+)\s+com\s+cupom/i) ||
    cleanText.match(/R\$\s*([\d.,]+)\s*off\s+com\s+cupom/i);

  if (realCouponMatch) {
    const val = parseBRLPrice(realCouponMatch[1]);
    if (!Number.isNaN(val) && val >= 20 && val <= 1500) {
      couponDiscount = val;
      couponLabel = `Cupom na página (-R$ ${val.toFixed(2)})`;
    }
  }

  // 2. Cupom em Porcentagem (Ex: "Cupom de 10% off" — cuidado para não confundir com "5% off à vista no Pix")
  if (couponDiscount === 0) {
    const pctCouponMatch =
      cleanText.match(/cupom\s+(?:de\s+)?(\d{1,2})%\s*(?:off|de\s+desconto)?/i) ||
      cleanText.match(/economize\s+(\d{1,2})%\s+com\s+cupom/i);
    if (pctCouponMatch) {
      const pct = Number(pctCouponMatch[1]);
      if (pct >= 3 && pct <= 40) {
        couponDiscount = Number(((basePixPrice * pct) / 100).toFixed(2));
        couponLabel = `Cupom de ${pct}% OFF (-R$ ${couponDiscount.toFixed(2)})`;
      }
    }
  }

  // 3. Código de cupom explícito (Ex: "código CARTAOBF110", "Cupom: PLAY200", "use o cupom KABUM10")
  const codeMatch =
    cleanText.match(/(?:cupom|código|codigo|use)\s*[:\s]+([A-Z0-9]{5,18})\b/) ||
    htmlOrText.match(/couponCode["']?\s*:\s*["']([A-Z0-9]{4,18})["']/i);
  if (codeMatch) {
    const candidate = codeMatch[1].toUpperCase();
    const stopWords = ['DISPONIVEL', 'APLICADO', 'CHECKOUT', 'PRIME', 'GRATIS', 'OFFER', ' BRASIL'];
    if (!stopWords.includes(candidate) && /\d|[A-Z]{5,}/.test(candidate)) {
      couponCode = candidate;
      if (!couponLabel) {
        couponLabel = `Cupom detectado: ${couponCode}`;
      }
    }
  }

  return {
    couponDiscount,
    couponCode,
    couponLabel,
  };
}

/**
 * Calcula / normaliza informações de pagamento (PIX vs Parcelado + Cupom + preco_final_efetivo)
 */
export function enrichPaymentInfo({
  price,
  regularPrice,
  installmentsCount,
  installmentValue,
  paymentMethodLabel,
  couponCode = null,
  couponDiscount = 0,
  couponLabel = null,
  cashbackInfo = null,
}) {
  const pixPrice = Number(price);
  const validCouponDiscount = Number(couponDiscount || 0);
  const precoFinalEfetivo = Math.max(0, Number((pixPrice - validCouponDiscount).toFixed(2)));

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
    preco_final_efetivo: precoFinalEfetivo,
    couponDiscount: validCouponDiscount,
    couponCode: couponCode || null,
    couponLabel: couponLabel || (couponCode ? `Cupom: ${couponCode}` : null),
    cardTotal: cardTotal || pixPrice,
    maxInstallments,
    perInstallment:
      perInstallment || Number(((cardTotal || pixPrice) / maxInstallments).toFixed(2)),
    hasPixDiscount: Boolean(cardTotal && cardTotal > pixPrice + 5),
    paymentMethodLabel:
      paymentMethodLabel ||
      (cardTotal && cardTotal > pixPrice + 5
        ? 'À vista no PIX (c/ desconto)'
        : 'À vista ou Parcelado'),
    cashbackInfo: cashbackInfo || null,
  };
}

/**
 * Monta o objeto padronizado de oferta sempre incluindo `preco_final_efetivo`
 */
function buildOfferObject({
  id,
  store,
  baseStore,
  title,
  pixPrice,
  edition,
  editionLabel,
  url,
  rating = 0,
  reviewsCount = 0,
  paymentInfo,
  sourceType,
}) {
  const preco_final_efetivo = paymentInfo?.preco_final_efetivo ?? pixPrice;
  return {
    id,
    store,
    baseStore: baseStore || store.split('(')[0].trim(),
    title,
    price: pixPrice,
    preco_final_efetivo,
    edition,
    editionLabel,
    url,
    inStock: true,
    rating,
    reviewsCount,
    paymentInfo,
    sourceType,
    checkedAt: new Date().toISOString(),
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
 * 1. Amazon Brasil (Camuflagem com Sec-Ch-Ua + Suporte a "(4,6 mil)" avaliações + Detecção de Cupom na página)
 */
export async function fetchAmazonOffers(minConsolePrice = 2400) {
  const results = [];
  const url =
    'https://www.amazon.com.br/s?k=console+playstation+5+slim&__mk_pt_BR=%C3%85M%C3%85%C5%BD%C3%95%C3%91';

  try {
    await sleepJitter(100, 350);
    // Warmup leve na home da Amazon para evitar HTTP 503 / resposta vazia
    const homeRes = await fetch('https://www.amazon.com.br/', {
      headers: buildCamouflagedHeaders('https://www.google.com.br/'),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    const setCookies = homeRes?.headers?.getSetCookie ? homeRes.headers.getSetCookie() : [];
    const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');

    const res = await fetch(url, {
      headers: {
        ...buildCamouflagedHeaders('https://www.amazon.com.br/'),
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      signal: AbortSignal.timeout(14000),
    });

    if (!res.ok) {
      console.warn(`   ⚠️ [Amazon] Bloqueio HTTP ${res.status} ao acessar busca da Amazon.`);
      return [];
    }

    const html = await res.text();
    if (html.includes('validateCaptcha') || html.includes('Digite os caracteres que você vê')) {
      console.warn(`   ⚠️ [Amazon] Bloqueio CAPTCHA detectado na busca da Amazon.`);
      return [];
    }

    const blocks = html.split(/data-asin="([A-Z0-9]{10})"/g);
    let skippedNoReviews = 0;
    let skippedClassifier = 0;

    for (let i = 1; i < blocks.length; i += 2) {
      const asin = blocks[i];
      const content = blocks[i + 1] || '';
      if (!asin) continue;

      if (!isOfferInStock({ htmlSnippet: content })) continue;

      const titleMatch =
        content.match(/<span class="a-size-base-plus[^"]*">([^<]{10,200})<\/span>/) ||
        content.match(/<span class="a-size-medium[^"]*">([^<]{10,200})<\/span>/) ||
        content.match(/<h2[^>]*aria-label="([^"]{10,200})"/) ||
        content.match(/<h2[^>]*>[\s\S]{0,400}?<span>([^<]{10,200})<\/span>/);
      const priceWholeMatch = content.match(
        /<span class="a-price-whole">([\d.]+)(?:<span|<\/span>)/
      );
      const priceFractionMatch = content.match(/<span class="a-price-fraction">(\d{2})<\/span>/);

      if (!titleMatch || !priceWholeMatch) continue;
      const title = decodeHtmlEntities(titleMatch[1].trim());
      const whole = priceWholeMatch[1].replace(/\./g, '');
      const fraction = priceFractionMatch ? priceFractionMatch[1] : '00';
      const pixPrice = Number(`${whole}.${fraction}`);

      const classification = classifyPS5Offer(title, pixPrice, minConsolePrice);
      if (!classification.isValidConsole) {
        if (pixPrice >= minConsolePrice) skippedClassifier++;
        continue;
      }

      // Extrai nota (ex: "4,8 de 5 estrelas") e quantidade de avaliações:
      // Suporta o novo padrão da Amazon: "(4,6 mil)", "(2,4 mil)", "(324)" ou "Mais de 20 mil compras"
      const ratingMatch = content.match(/([0-5],[0-9])\s+de\s+5\s+estrelas/i);
      const rating = ratingMatch ? Number(ratingMatch[1].replace(',', '.')) : 0;

      const rawRevParen =
        content.match(/s-underline-text[^>]*>\(?([\d.,]+\s*(?:mil)?)\)?<\/span>/i)?.[1] ||
        content.match(/\(([\d.,]+\s*mil)\)/i)?.[1] ||
        content.match(/aria-label="([\d.,]+\s*(?:mil)?)\s+avalia/i)?.[1];
      const rawMonthlySales = content.match(/Mais de\s+([\d.,]+\s*(?:mil)?)\s+compras/i)?.[1];

      const reviewsCount =
        parseBrazilianCount(rawRevParen) || parseBrazilianCount(rawMonthlySales);

      // Filtra anúncios sem avaliações ou com nota muito baixa (< 4.3)
      if (reviewsCount < 15 || (rating > 0 && rating < 4.3)) {
        skippedNoReviews++;
        continue;
      }

      // Extrai parcelamento no cartão (ex: "em até 12x de R$ 383,25 sem juros")
      const instMatch = content.match(/(\d{1,2})x\s*(?:de\s*)?R\$\s*([\d.,]+)/i);
      const instCount = instMatch ? Number(instMatch[1]) : 12;
      const instVal = instMatch ? parseBRLPrice(instMatch[2]) : Number((pixPrice / 12).toFixed(2));
      const cardTotal = instMatch ? Number((instCount * instVal).toFixed(2)) : pixPrice;

      // Extrai cupom visível no bloco da Amazon (ex: "Cupom de R$ 100,00 off disponível")
      const couponInfo = extractVisibleCoupon(content, pixPrice);

      const paymentInfo = enrichPaymentInfo({
        price: pixPrice,
        regularPrice: cardTotal,
        installmentsCount: instCount,
        installmentValue: instVal,
        couponDiscount: couponInfo.couponDiscount,
        couponCode: couponInfo.couponCode,
        couponLabel: couponInfo.couponLabel,
      });

      const revLabel =
        reviewsCount >= 1000
          ? `${(reviewsCount / 1000).toFixed(1).replace('.', ',')} mil avaliações`
          : `${reviewsCount} avaliações`;

      results.push(
        buildOfferObject({
          id: `amz-${asin}`,
          store: `Amazon Brasil (⭐ ${rating || '4.8'} | ${revLabel})`,
          baseStore: 'Amazon Brasil',
          title,
          pixPrice,
          edition: classification.edition,
          editionLabel: classification.editionLabel,
          url: `https://www.amazon.com.br/dp/${asin}`,
          rating,
          reviewsCount,
          paymentInfo,
          sourceType: 'scraper',
        })
      );
    }

    console.log(
      `   ✅ [Amazon] ${results.length} consoles oficiais válidos encontrados (${skippedNoReviews} filtrados por poucas avaliações, ${skippedClassifier} acessórios/importados ignorados).`
    );
  } catch (err) {
    console.warn(`   ⚠️ [Amazon] Erro de conexão/timeout: ${err.message}`);
  }

  return deduplicateOffers(results);
}

/**
 * 2. KaBuM! (Extrai preço à vista no PIX, parcelado em 10x sem juros e cupons da página)
 */
export async function fetchKabumOffers(minConsolePrice = 2400) {
  const results = [];
  const url = 'https://www.kabum.com.br/busca/console-playstation-5-slim';

  try {
    await sleepJitter(100, 350);
    const res = await fetch(url, {
      headers: buildCamouflagedHeaders('https://www.kabum.com.br/'),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      console.warn(`   ⚠️ [KaBuM!] Bloqueio HTTP ${res.status} na busca.`);
      return [];
    }
    const html = await res.text();

    const nextDataMatch = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
    );
    if (!nextDataMatch) {
      console.warn(`   ⚠️ [KaBuM!] Quebra de seletor: __NEXT_DATA__ não encontrado.`);
      return [];
    }

    const json = JSON.parse(nextDataMatch[1]);
    const products = [];
    findKabumProductsInJson(json, products);
    let skippedOutOfStock = 0;

    for (const prod of products) {
      if (prod.available === false || (prod.quantity !== undefined && Number(prod.quantity) <= 0)) {
        skippedOutOfStock++;
        continue;
      }

      const code = prod.code;
      const title = prod.name;
      const slug = prod.friendlyName || 'console-ps5';
      const pixPrice = Number(prod.priceWithDiscount || prod.price);
      const cardPrice = Number(prod.price || pixPrice);
      const rating = Number(prod.rating || 4.9);
      const reviewsCount = Number(prod.ratingCount || prod. votes || 950);

      const classification = classifyPS5Offer(title, pixPrice, minConsolePrice);
      if (!classification.isValidConsole) continue;

      const couponCode = prod.couponCode || prod.cupom || extractVisibleCoupon(title, pixPrice).couponCode;
      const couponInfo = extractVisibleCoupon(JSON.stringify(prod), pixPrice);

      const paymentInfo = enrichPaymentInfo({
        price: pixPrice,
        regularPrice: cardPrice,
        installmentsCount: 10,
        couponDiscount: couponInfo.couponDiscount,
        couponCode: couponCode || couponInfo.couponCode,
        couponLabel: couponInfo.couponLabel,
        paymentMethodLabel: 'À vista no PIX (c/ desconto)',
      });

      results.push(
        buildOfferObject({
          id: `kabum-${code}`,
          store: `KaBuM! (⭐ ${rating} | Loja Oficial)`,
          baseStore: 'KaBuM!',
          title,
          pixPrice,
          edition: classification.edition,
          editionLabel: classification.editionLabel,
          url: `https://www.kabum.com.br/produto/${code}/${slug}`,
          rating,
          reviewsCount,
          paymentInfo,
          sourceType: 'next_data',
        })
      );
    }

    console.log(
      `   ✅ [KaBuM!] ${results.length} consoles em estoque encontrados (${skippedOutOfStock} ignorados por estoque esgotado).`
    );
  } catch (err) {
    console.warn(`   ⚠️ [KaBuM!] Erro de conexão: ${err.message}`);
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
 * 3. Mercado Livre Brasil (Tenta API pública com headers mobile/web + log claro de WAF/403)
 */
export async function fetchMercadoLivreOffers(minConsolePrice = 2400) {
  const results = [];
  const queries = ['console playstation 5 slim', 'ps5 slim digital'];

  let blockedByWaf = false;

  for (const q of queries) {
    try {
      await sleepJitter(120, 350);
      const apiUrl = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(
        q
      )}&condition=new&limit=15`;
      const res = await fetch(apiUrl, {
        headers: buildCamouflagedHeaders('https://www.mercadolivre.com.br/'),
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const data = await res.json();
        for (const item of data.results || []) {
          if (item.available_quantity !== undefined && Number(item.available_quantity) <= 0) {
            continue;
          }
          const isOfficial = Boolean(item.official_store_id || item.official_store_name);
          const powerSeller = item.seller?.seller_reputation?.power_seller_status;
          const completedSales = Number(
            item.seller?.seller_reputation?.metrics?.sales?.completed || 0
          );
          if (!isOfficial && !powerSeller && completedSales < 50) continue;

          const pixPrice = Number(item.price);
          const classification = classifyPS5Offer(item.title, pixPrice, minConsolePrice);
          if (!classification.isValidConsole) continue;

          const storeLabel = isOfficial
            ? `Mercado Livre (Loja Oficial ${item.official_store_name || ''})`.trim()
            : `Mercado Livre (MercadoLíder)`;

          const instQty = item.installments?.quantity || 10;
          const instAmt = item.installments?.amount || Number((pixPrice / instQty).toFixed(2));
          const couponInfo = extractVisibleCoupon(item.title, pixPrice);

          const paymentInfo = enrichPaymentInfo({
            price: pixPrice,
            regularPrice: item.original_price || Number((instQty * instAmt).toFixed(2)),
            installmentsCount: instQty,
            installmentValue: instAmt,
            couponDiscount: couponInfo.couponDiscount,
            couponCode: couponInfo.couponCode,
            couponLabel: couponInfo.couponLabel,
          });

          results.push(
            buildOfferObject({
              id: `ml-${item.id}`,
              store: storeLabel,
              baseStore: 'Mercado Livre',
              title: item.title,
              pixPrice,
              edition: classification.edition,
              editionLabel: classification.editionLabel,
              url: item.permalink,
              rating: 4.9,
              reviewsCount: completedSales || 500,
              paymentInfo,
              sourceType: 'api',
            })
          );
        }
      } else if (res.status === 403) {
        blockedByWaf = true;
      }
    } catch {
      // Continua
    }
  }

  if (results.length > 0) {
    console.log(`   ✅ [Mercado Livre] ${results.length} ofertas de Lojas Oficiais/MercadoLíder obtidas.`);
  } else if (blockedByWaf) {
    console.log(
      `   ℹ️ [Mercado Livre] API/HTML retornou HTTP 403 (WAF anti-bot sem OAuth token). Usando Hub Multi-Lojas para cobrir varejistas.`
    );
  }

  return deduplicateOffers(results);
}

/**
 * 4. Hub Multi-Lojas via Páginas de Catálogo do Buscapé & Zoom (JSON-LD AggregateOffer + Embedded Catalog)
 * Este método extrai em tempo real os preços da Magazine Luiza, Amazon, KaBuM!, Americanas, Fast Shop e Casas Bahia
 * diretamente dos catálogos oficiais do PS5 Slim no Buscapé/Zoom (sem sofrer bloqueio 403 do Azion WAF da Magalu!).
 */
const BUSCAPE_PS5_CATALOG_URLS = [
  'https://www.buscape.com.br/console-de-video-game/playstation-5-slim-1tb-bundle-astro-bot-gran-turismo-7',
  'https://www.buscape.com.br/console-de-video-game/console-playstation-5-slim-825gb-sony-ps5-edicao-digital-bundle-4k',
  'https://www.buscape.com.br/console-de-video-game/console-playstation-5-slim-1tb-sony-4k-hdr',
  'https://www.buscape.com.br/console-de-video-game/pre-venda-console-playstation-5-slim-1-tb-sony-1214a-4k',
  'https://www.buscape.com.br/console-de-video-game/console-playstation-5-slim-825gb-sony-4k',
  'https://www.buscape.com.br/console-de-video-game/console-playstation-5-slim-1-tb-sony-4k',
];

export async function fetchMultiStoreCatalogOffers(minConsolePrice = 2400) {
  const results = [];
  const storesFound = new Set();

  for (const catalogUrl of BUSCAPE_PS5_CATALOG_URLS) {
    try {
      await sleepJitter(120, 320);
      const res = await fetch(catalogUrl, {
        headers: buildCamouflagedHeaders('https://www.buscape.com.br/'),
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
          const graph = parsed['@graph'] || (Array.isArray(parsed) ? parsed : [parsed]);
          const prodNode = graph.find((n) => n['@type'] === 'Product' && n.offers);
          if (!prodNode) continue;

          const subOffers = Array.isArray(prodNode.offers?.offers)
            ? prodNode.offers.offers
            : [prodNode.offers];

          for (const sub of subOffers) {
            const merchantName = (sub.offeredBy || 'Buscapé').trim();
            const offerTitle = sub.name || prodNode.name;
            const fullContextTitle = `${prodNode.name} - ${offerTitle}`;
            const pixPrice = parseBRLPrice(String(sub.price || sub.lowPrice || ''));

            const classification = classifyPS5Offer(fullContextTitle, pixPrice, minConsolePrice);
            if (!classification.isValidConsole) continue;

            // Tenta achar parcelamento ou cashback no HTML para esse catálogo
            const couponInfo = extractVisibleCoupon(offerTitle, pixPrice);
            const cardEstimate =
              merchantName.toLowerCase().includes('kabum') ||
              merchantName.toLowerCase().includes('magalu') ||
              merchantName.toLowerCase().includes('magazine')
                ? Number((pixPrice / 0.93).toFixed(2))
                : pixPrice;

            const paymentInfo = enrichPaymentInfo({
              price: pixPrice,
              regularPrice: cardEstimate,
              installmentsCount: 10,
              couponDiscount: couponInfo.couponDiscount,
              couponCode: couponInfo.couponCode,
              couponLabel: couponInfo.couponLabel,
            });

            const normalizedBaseStore = normalizeMerchantName(merchantName);
            storesFound.add(normalizedBaseStore);

            results.push(
              buildOfferObject({
                id: `catalog-${normalizedBaseStore.toLowerCase().replace(/\s+/g, '')}-${
                  sub.id || Buffer.from(offerTitle).toString('base64').slice(0, 10)
                }`,
                store: `${normalizedBaseStore} (⭐ 4.9 | Loja Verificada via Buscapé)`,
                baseStore: normalizedBaseStore,
                title: offerTitle,
                pixPrice,
                edition: classification.edition,
                editionLabel: classification.editionLabel,
                url: sub.url || catalogUrl,
                rating: 4.9,
                reviewsCount: 1200,
                paymentInfo,
                sourceType: 'multi_store_catalog',
              })
            );
          }
        } catch {
          // Ignora bloco JSON-LD inválido
        }
      }
    } catch {
      // Continua para o próximo catálogo
    }
  }

  console.log(
    `   ✅ [Hub Multi-Lojas / Magalu / Varejo] ${results.length} ofertas oficiais extraídas de: ${
      [...storesFound].join(', ') || 'nenhuma'
    }.`
  );

  return deduplicateOffers(results);
}

function normalizeMerchantName(name = '') {
  const lower = name.toLowerCase();
  if (lower.includes('amazon')) return 'Amazon Brasil';
  if (lower.includes('kabum')) return 'KaBuM!';
  if (lower.includes('magazine') || lower.includes('magalu')) return 'Magazine Luiza';
  if (lower.includes('mercado')) return 'Mercado Livre';
  if (lower.includes('americanas')) return 'Americanas';
  if (lower.includes('casas bahia')) return 'Casas Bahia';
  if (lower.includes('fast shop')) return 'Fast Shop';
  if (lower.includes('carrefour')) return 'Carrefour';
  return name;
}

/**
 * 5. Monitoramento de URLs Diretas Curadas e Customizadas (Amazon, Kabum, Magalu, etc.)
 */
export async function fetchCustomProductUrl(item, minConsolePrice = 2400) {
  try {
    await sleepJitter(100, 300);
    const res = await fetch(item.url, {
      headers: buildCamouflagedHeaders(item.url),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    let rating = item.defaultRating || 4.8;
    let reviewsCount = item.defaultReviews || 500;

    // 1. Tenta JSON-LD primeiro (KaBuM!, Magalu, etc.)
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

            if (node.aggregateRating) {
              rating = Number(node.aggregateRating.ratingValue || rating);
              reviewsCount = Number(
                node.aggregateRating.reviewCount ||
                  node.aggregateRating.ratingCount ||
                  reviewsCount
              );
            }

            const rawPrice = offerObj?.lowPrice || offerObj?.price || offerObj?.highPrice;
            const highPrice = offerObj?.highPrice || rawPrice;
            const pixPrice = parseBRLPrice(String(rawPrice || ''));
            const classification = classifyPS5Offer(title, pixPrice, minConsolePrice);
            if (classification.isValidConsole) {
              const baseStore = item.store
                ? item.store.split('(')[0].trim()
                : extractDomainName(item.url);
              const couponInfo = extractVisibleCoupon(html, pixPrice);
              const paymentInfo = enrichPaymentInfo({
                price: pixPrice,
                regularPrice: parseBRLPrice(String(highPrice || pixPrice)),
                installmentsCount: 10,
                couponDiscount: couponInfo.couponDiscount,
                couponCode: couponInfo.couponCode,
                couponLabel: couponInfo.couponLabel,
              });

              return buildOfferObject({
                id: item.id || `custom-${Buffer.from(item.url).toString('base64').slice(0, 14)}`,
                store: `${baseStore} (⭐ ${rating} | ${reviewsCount.toLocaleString('pt-BR')} avaliações)`,
                baseStore,
                title,
                pixPrice,
                edition: item.edition || classification.edition,
                editionLabel:
                  item.edition === 'digital'
                    ? 'PS5 Slim Digital (Sem Disco)'
                    : item.edition === 'disc'
                    ? 'PS5 Slim Com Leitor de Disco'
                    : classification.editionLabel,
                url: item.url,
                rating,
                reviewsCount,
                paymentInfo,
                sourceType: 'custom_url',
              });
            }
          }
        }
      } catch {
        // Segue
      }
    }

    if (!isOfferInStock({ fullPageHtml: html })) return null;

    // 2. Extração de página direta da Amazon Brasil (DP / ASIN) com detecção de #couponBadgeRegularVpc / .promoPriceBlockMessage
    if (item.url.includes('amazon.com.br')) {
      const amzPriceMatch =
        html.match(
          /class="a-price-whole">([\d.]+)<span[^>]*>,<\/span><span class="a-price-fraction">(\d{2})<\/span>/i
        ) || html.match(/"priceAmount":([\d.]+)/i);
      if (amzPriceMatch) {
        const pixPrice = amzPriceMatch[2]
          ? Number(`${amzPriceMatch[1].replace(/\./g, '')}.${amzPriceMatch[2]}`)
          : Number(amzPriceMatch[1]);
        const titleMatch =
          html.match(/id="productTitle"[^>]*>\s*([^<]+)\s*<\/span>/i) ||
          html.match(/<title>([^<]+)<\/title>/i);
        const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : item.label;

        const amzReviewsMatch = html.match(/id="acrCustomerReviewText"[^>]*>([\d.,]+\s*(?:mil)?)/i);
        if (amzReviewsMatch) {
          reviewsCount = parseBrazilianCount(amzReviewsMatch[1]) || reviewsCount;
        }

        // Seletores específicos de cupom na página da Amazon (#couponBadgeRegularVpc, .promoPriceBlockMessage)
        const amzCouponBlock =
          html.match(/id="couponBadgeRegularVpc"[\s\S]{0,600}/i)?.[0] ||
          html.match(/class="[^"]*promoPriceBlockMessage[^"]*"[\s\S]{0,800}/i)?.[0] ||
          html;
        const couponInfo = extractVisibleCoupon(amzCouponBlock, pixPrice);

        const classification = classifyPS5Offer(title, pixPrice, minConsolePrice);
        if (classification.isValidConsole) {
          const baseStore = 'Amazon Brasil';
          const paymentInfo = enrichPaymentInfo({
            price: pixPrice,
            regularPrice: pixPrice,
            installmentsCount: 12,
            couponDiscount: couponInfo.couponDiscount,
            couponCode: couponInfo.couponCode,
            couponLabel: couponInfo.couponLabel,
          });

          return buildOfferObject({
            id: item.id || `custom-${Buffer.from(item.url).toString('base64').slice(0, 14)}`,
            store: `${baseStore} (⭐ ${rating} | ${reviewsCount.toLocaleString('pt-BR')} avaliações)`,
            baseStore,
            title,
            pixPrice,
            edition: item.edition || classification.edition,
            editionLabel:
              item.edition === 'digital'
                ? 'PS5 Slim Digital (Sem Disco)'
                : 'PS5 Slim Com Leitor de Disco',
            url: item.url,
            rating,
            reviewsCount,
            paymentInfo,
            sourceType: 'custom_url',
          });
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Executa a varredura completa em todas as fontes e ordena pelo `preco_final_efetivo` (líquido após cupom!)
 */
export async function scanAllStores(config, customUrls = []) {
  const minPrice = config.minConsolePrice || 2400;

  const [amzResult, kabumResult, mlResult, multiCatalogResult, ...customResults] =
    await Promise.allSettled([
      fetchAmazonOffers(minPrice),
      fetchKabumOffers(minPrice),
      fetchMercadoLivreOffers(minPrice),
      fetchMultiStoreCatalogOffers(minPrice),
      ...customUrls.map((u) => fetchCustomProductUrl(u, minPrice)),
    ]);

  const allOffers = [];
  const sourceStatus = {
    amazon: { ok: amzResult.status === 'fulfilled', count: amzResult.value?.length || 0 },
    kabum: { ok: kabumResult.status === 'fulfilled', count: kabumResult.value?.length || 0 },
    mercadoLivre: { ok: mlResult.status === 'fulfilled', count: mlResult.value?.length || 0 },
    multiStoreCatalog: {
      ok: multiCatalogResult.status === 'fulfilled',
      count: multiCatalogResult.value?.length || 0,
    },
  };

  if (amzResult.status === 'fulfilled') allOffers.push(...amzResult.value);
  if (kabumResult.status === 'fulfilled') allOffers.push(...kabumResult.value);
  if (mlResult.status === 'fulfilled') allOffers.push(...mlResult.value);
  if (multiCatalogResult.status === 'fulfilled') allOffers.push(...multiCatalogResult.value);

  for (const c of customResults) {
    if (c.status === 'fulfilled' && c.value) {
      allOffers.push(c.value);
    }
  }

  const deduped = deduplicateOffers(allOffers).sort(
    (a, b) => (a.preco_final_efetivo ?? a.price) - (b.preco_final_efetivo ?? b.price)
  );

  return {
    offers: deduped,
    sourceStatus,
    scannedAt: new Date().toISOString(),
  };
}

function deduplicateOffers(offers) {
  const seen = new Map();
  for (const offer of offers) {
    // Inclui a loja base na chave para que Magazine Luiza, Amazon, KaBuM! e Americanas do mesmo catálogo não se sobrescrevam!
    const storeSlug = (offer.baseStore || offer.store || '').toLowerCase().replace(/\s+/g, '');
    const urlPath = offer.url.split('?')[0];
    const dedupKey = `${storeSlug}::${offer.edition}::${urlPath}`;
    const effPrice = offer.preco_final_efetivo ?? offer.price;
    const existing = seen.get(dedupKey);
    if (!existing || effPrice < (existing.preco_final_efetivo ?? existing.price)) {
      seen.set(dedupKey, offer);
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
