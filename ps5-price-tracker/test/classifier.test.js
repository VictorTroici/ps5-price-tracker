import assert from 'node:assert/strict';
import { classifyPS5Offer, evaluateTargetHit } from '../src/classifier.js';
import { parseBRLPrice, isOfferInStock } from '../src/scrapers.js';

console.log('🧪 Executando testes do Classificador de Ofertas de PS5...');

// 1. Deve aceitar PS5 Slim Digital e classificar como 'digital'
{
  const res = classifyPS5Offer(
    'Console PlayStation 5 Slim Edição Digital 1TB Branco + 2 Jogos',
    3599.9
  );
  assert.equal(res.isValidConsole, true);
  assert.equal(res.edition, 'digital');
}

// 2. Deve aceitar PS5 Slim Com Leitor de Disco e classificar como 'disc'
{
  const res = classifyPS5Offer(
    'Console Sony PlayStation 5 Slim, Com Leitor de Discos, 1TB, Branco - CFI-2014A',
    3899.0
  );
  assert.equal(res.isValidConsole, true);
  assert.equal(res.edition, 'disc');
}

// 3. Deve rejeitar Controle DualSense avulso (preço baixo e palavra excluída)
{
  const res = classifyPS5Offer('Controle Sem Fio DualSense PS5 Branco', 429.9);
  assert.equal(res.isValidConsole, false);
}

// 4. Deve rejeitar Leitor de Disco avulso para PS5 Slim
{
  const res = classifyPS5Offer('Unidade de Disco para Consoles PS5 Edição Digital Slim', 699.9);
  assert.equal(res.isValidConsole, false);
}

// 5. Deve aceitar Bundle "Console PS5 Slim + Controle DualSense Extra"
{
  const res = classifyPS5Offer(
    'Console PlayStation 5 Slim Edição Digital + Controle DualSense Extra',
    3750.0
  );
  assert.equal(res.isValidConsole, true);
  assert.equal(res.edition, 'digital');
}

// 6. Deve rejeitar console usado ou recondicionado
{
  const res = classifyPS5Offer('Console PS5 Slim 1TB Com Leitor Usado Vitrine', 3100.0);
  assert.equal(res.isValidConsole, false);
}

// 7. Teste de avaliação de meta (Digital <= 3800, Com Disco <= 4000)
{
  const config = { targetPriceDigital: 3800, targetPriceDisc: 4000 };
  const digitalOffer = { edition: 'digital', price: 3650 };
  const discOffer = { edition: 'disc', price: 3950 };
  const expensiveDiscOffer = { edition: 'disc', price: 4199 };

  assert.equal(evaluateTargetHit(digitalOffer, config).isHit, true);
  assert.equal(evaluateTargetHit(digitalOffer, config).savingsFromTarget, 150);
  assert.equal(evaluateTargetHit(discOffer, config).isHit, true);
  assert.equal(evaluateTargetHit(expensiveDiscOffer, config).isHit, false);
}

// 8. Teste de parse de preço BRL
{
  assert.equal(parseBRLPrice('R$ 3.499,90'), 3499.9);
  assert.equal(parseBRLPrice('3.799'), 3799);
  assert.equal(parseBRLPrice('3599.00'), 3599);
}

// 9. Teste de verificação de estoque (ignorar Produto Esgotado / OutOfStock)
{
  assert.equal(
    isOfferInStock({ schemaAvailability: 'https://schema.org/OutOfStock' }),
    false
  );
  assert.equal(
    isOfferInStock({ fullPageHtml: '<div>Produto Esgotado - Avise-me quando chegar</div>' }),
    false
  );
  assert.equal(
    isOfferInStock({ schemaAvailability: 'https://schema.org/InStock', fullPageHtml: '<div>Comprar agora</div>' }),
    true
  );
}

console.log('✅ Todos os testes do classificador, estoque e metas passaram com sucesso!');
