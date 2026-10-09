# Rastreio do produto enviado ao criador

API que registra um código de rastreio num agregador (fictício, "RastroHub"), consulta os eventos, traduz o dialeto de cada transportadora para seis status estáveis e avisa quando o pacote passa do prazo de trânsito. Quando o pacote é entregue, devolve `content_due_at`: a data-limite do conteúdo do criador, contada a partir da entrega (entrega + `CONTENT_DAYS_AFTER_DELIVERY`).

Node 22.12+, TypeScript estrito, Hono, `node:sqlite`, vitest.

## Como rodar

```bash
npm install
npm run dev        # API em :3000 + agregador falso em :4001, banco em memória
npm test           # 104 testes
npm run typecheck
```

`npm start` sobe só a API e usa o agregador configurado nas variáveis abaixo. `npm run dev` difere: força o RastroHub falso, usa banco em memória (o agregador falso esquece os códigos ao reiniciar) e liga o webhook com o token `dev-webhook` se `WEBHOOK_TOKEN` não estiver definido.

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `MAX_TRANSIT_HOURS` | `120` | limite de trânsito, em horas |
| `MAX_TRANSIT_HOURS_<TRANSPORTADORA>` | | limite só dessa transportadora, ex. `MAX_TRANSIT_HOURS_JADLOG=72` |
| `CONTENT_DAYS_AFTER_DELIVERY` | `7` | dias de conteúdo depois da entrega (dias de 24h) |
| `POLL_INTERVAL_MS` | `900000` | intervalo da varredura que consulta os não entregues e confere atraso; `0` desliga |
| `PROVIDER` | `rastrohub` | `rastrohub` ou `parcelnet`; outro valor falha na partida |
| `AGGREGATOR_URL`, `AGGREGATOR_API_KEY`, `AGGREGATOR_TIMEOUT_MS` | `http://localhost:4001`, `dev-key`, `5000` | acesso ao agregador |
| `WEBHOOK_TOKEN` | vazio | liga `POST /webhooks/aggregator`; sem token, ou com um agregador sem suporte a webhook (`parcelnet`), a rota não existe |
| `DB_PATH`, `PORT` | `tracking.db`, `3000` | |

## Do payload cru ao status normalizado

O agregador devolve (trecho de `GET /v1/trackings/AA123456789BR`, capturado do agregador falso):

```json
{
  "tracking": { "number": "AA123456789BR", "carrier": "correios" },
  "checkpoints": [
    { "id": "cp-1", "tag": "PO", "message": "Objeto postado",
      "checkpoint_time": "2026-03-06T09:15:00-03:00", "location": { "city": "Recife", "state": "PE" } },
    { "id": "cp-3", "tag": "BDE", "subtag": "01", "message": "Objeto entregue ao destinatário",
      "checkpoint_time": "2026-03-10T14:02:00-03:00", "location": { "city": "São Paulo", "state": "SP" } },
    { "id": "cp-x", "tag": "ZZ7", "message": "Objeto entregue (sic)",
      "checkpoint_time": "2026-03-11T08:00:00-03:00" }
  ]
}
```

A API responde (`GET /shipments/:id`, trecho):

```json
{
  "status": "delivered",
  "status_label": "entregue",
  "delivered_at": "2026-03-10T17:02:00.000Z",
  "content_due_at": "2026-03-17T17:02:00.000Z",
  "delay": { "limit_hours": 120, "started_at": "2026-03-06T12:15:00.000Z", "elapsed_hours": 100.78, "late": false, "alert": null },
  "unmapped_count": 1,
  "history": [
    { "occurred_at": "2026-03-06T12:15:00.000Z", "status": "posted",    "raw_status": "PO",     "location": "Recife/PE" },
    { "occurred_at": "2026-03-10T17:02:00.000Z", "status": "delivered", "raw_status": "BDE/01", "location": "São Paulo/SP" },
    { "occurred_at": "2026-03-11T11:00:00.000Z", "status": "unknown",   "raw_status": "ZZ7",    "raw_description": "Objeto entregue (sic)" }
  ],
  "unmapped_events": [ { "raw_status": "ZZ7", "status": "unknown" } ]
}
```

O horário vem com offset (`-03:00`) e é guardado em UTC. `ZZ7` é um código que a transportadora inventou: fica no histórico com o texto original, aparece em `unmapped_events` para alguém acrescentar o mapeamento, e não vira entregue mesmo com "entregue" na mensagem.

## Status

| Status | Significado | Exemplos de código cru |
| --- | --- | --- |
| `posted` (postado) | entrou na transportadora | Correios `PO`; Jadlog `EMISSAO`; Loggi `COLETADO` |
| `in_transit` (em trânsito) | em movimento | Correios `RO`, `DO`; Jadlog `ENTRADA`, `TRANSFERENCIA`; Loggi `EM_TRANSITO` |
| `out_for_delivery` (saiu para entrega) | com o entregador | Correios `OEC`; Jadlog `EM_ROTA`; Loggi `SAIU_PARA_ENTREGA` |
| `delivered` (entregue) | na mão do destinatário | Correios `BDE/01`, `BDI/01`, `BDR/01`; Jadlog `ENTREGUE`; Loggi `ENTREGUE` |
| `exception` (exceção) | algo impediu o fluxo | Correios `BDE/02..04` (ausente, mudou, endereço), `LDI` (aguardando retirada), `FC`, `DEV`; Jadlog `NAO_ENTREGUE`, `OCORRENCIA`, `DEVOLUCAO`; Loggi `TENTATIVA_SEM_SUCESSO`, `DESTINATARIO_AUSENTE`, `DEVOLVIDO` |
| `unknown` (desconhecido) | sem mapeamento, ou shipment sem eventos | qualquer outro |

As tabelas estão em `src/domain/normalize.ts`. Decisões:

- O código da transportadora é a única fonte. A descrição nunca é lida para adivinhar status: "não entregue" e "entrega não efetuada" contêm "entregue". Sem heurística de texto.
- Correios reusa `BDE` com subcódigos. Só `BDE/01` (e `BDI/01`, `BDR/01`) é entregue; `BDE/02` é destinatário ausente. `BDE` sem subcódigo, ou com subcódigo novo, é `unknown`. O retorno ao código sem subcódigo (`RO/01` vira `RO`) nunca produz `delivered`.
- Maiúsculas, acentos e separadores são ignorados (`Saiu para entrega` = `SAIU_PARA_ENTREGA`).
- O status normalizado não é gravado. O banco guarda o texto cru e o status é calculado na leitura, então acrescentar um mapeamento corrige eventos já ingeridos.
- Shipment sem nenhum evento reconhecido tem status `unknown`.

## Ordem e precedência

O status é função do conjunto de eventos, não do último recebido.

1. Eventos `unknown` são ignorados.
2. Ordena por `occurred_at` (horário da transportadora). Empate no mesmo instante: `posted` < `in_transit` < `out_for_delivery` < `exception` < `delivered`.
3. Se existe algum `delivered`, o status é `delivered` e é terminal: nada depois dele muda o status, nem uma exceção posterior. `delivered_at` é o menor instante entre os eventos de entrega.
4. Senão, vale o último evento da ordenação. Logo uma exceção mais nova que o último progresso aparece como `exception`, até chegar um progresso mais novo.

Evento antigo que chega tarde entra no histórico, mas não é o último, então não muda o status. Se o relógio da transportadora estiver errado, vale o horário dela: não há como saber melhor.

Repetição: a identidade do evento é o `id` do agregador, ou, sem id, o hash de (código, transportadora, status cru, instante em UTC, local). Há `UNIQUE (shipment_id, dedup_key)` no banco. Consultar de novo não duplica; a resposta traz `inserted` e `duplicates`. Se o mesmo `id` voltar com conteúdo diferente, vale o primeiro.

## Regra de atraso

- O relógio começa no `occurred_at` do primeiro `posted` ou `in_transit` (se não houver, no primeiro evento de progresso) e para no `occurred_at` do `delivered`.
- `late = (delivered_at ?? agora) - início > limite`. Estritamente maior: no limite exato não é atraso; 1 ms depois é.
- O horário de ingestão nunca entra na conta. Um pacote entregue dentro do prazo, mas cujo evento de entrega só chegou depois do prazo, não é marcado como atrasado. Exemplo real (Jadlog, limite 120h): o pacote ficou 196 h em trânsito sem entrega no sistema, o alerta saiu, e um webhook trouxe a entrega ocorrida 50 h depois do início:

```json
{ "status": "delivered", "delay": { "elapsed_hours": 50, "late": false,
  "alert": { "raised_at": "2026-10-09T15:28:05.015Z", "cleared_at": "2026-10-09T15:28:05.121Z" } } }
```

- Alerta: uma linha por shipment (`delay_alerts`). Sai uma vez (callback `onDelayAlert`; o servidor registra no log). É avaliado a cada ingestão (refresh, webhook) e na varredura periódica, inclusive quando o agregador está fora do ar ou devolve um lote recusado. A varredura não consulta mais um shipment entregue, exceto se o histórico dele não tem `posted`/`in_transit`: o início ainda pode chegar, e sem ele o atraso é medido do primeiro evento de progresso que existir (no pior caso, a própria entrega). Entregues com início conhecido não são consultados, mas o alerta deles é reavaliado, para o caso de o limite ter mudado. Se depois se descobre que não houve atraso (caso acima), a linha ganha `cleared_at`; se voltar a atrasar, é reaberta sem novo aviso.
- `GET /shipments?late=true` calcula com o relógio atual, sem esperar a varredura.
- Limite por transportadora: `MAX_TRANSIT_HOURS_JADLOG=72`.

## API

| Rota | O que faz |
| --- | --- |
| `POST /shipments` `{code, carrier, campaign_id?}` | registra no agregador e guarda. 201 novo, 200 se já existe igual, 409 se o código existe com outra transportadora ou campanha, 400 se inválido |
| `POST /shipments/:id/refresh` | consulta o agregador e ingere. Devolve o shipment mais `refresh: {fetched, inserted, duplicates}`. Falha do agregador: 502 com `provider_unavailable`, `provider_not_found`, `provider_unauthorized`, `provider_rejected` ou `provider_invalid_response` |
| `GET /shipments/:id` | status, histórico ordenado, atraso, `unmapped_events` |
| `GET /shipments?late=true\|false&campaign_id=` | lista sem histórico |
| `POST /webhooks/aggregator` | push do agregador, header `x-webhook-token`. 202 mesmo para código desconhecido (o agregador retentaria um 404) |

Transportadoras aceitas: `correios`, `jadlog`, `loggi`. Código Correios: `AA123456789BR`.

```bash
curl -s -X POST localhost:3000/shipments -H 'content-type: application/json' \
  -d '{"code":"AA123456789BR","carrier":"correios","campaign_id":"camp-42"}'

# simula o agregador entregando fora de ordem, com repetição e um código inventado
curl -s -X POST localhost:4001/_sim/trackings/AA123456789BR/checkpoints -H 'content-type: application/json' \
  -d '[{"id":"cp-3","tag":"BDE","subtag":"01","message":"Objeto entregue ao destinatário","checkpoint_time":"2026-03-10T14:02:00-03:00"},
       {"id":"cp-1","tag":"PO","message":"Objeto postado","checkpoint_time":"2026-03-06T09:15:00-03:00"},
       {"id":"cp-3","tag":"BDE","subtag":"01","message":"Objeto entregue ao destinatário","checkpoint_time":"2026-03-10T14:02:00-03:00"},
       {"id":"cp-x","tag":"ZZ7","message":"Objeto entregue (sic)","checkpoint_time":"2026-03-11T08:00:00-03:00"}]'
# {"checkpoints":4}

curl -s -X POST localhost:3000/shipments/$ID/refresh      # "refresh":{"fetched":4,"inserted":3,"duplicates":1}  (na 1a vez)
curl -s -X POST localhost:3000/shipments/$ID/refresh      # {"fetched":4,"inserted":0,"duplicates":4}
curl -s "localhost:3000/shipments?late=true"              # {"shipments":[]}

curl -s -X POST localhost:4001/_sim/fail -H 'content-type: application/json' -d '{"status":503}'
curl -s -X POST localhost:3000/shipments/$ID/refresh      # {"error":{"code":"provider_unavailable",...}} -> 502
```

Na execução real o segundo `refresh` devolveu `{"fetched":4,"inserted":0,"duplicates":4}` e a falha simulada devolveu 502 `provider_unavailable`. A simulação do agregador (`/_sim/...`) só existe no agregador falso.

## Como trocar o agregador

O resto do código só conhece `TrackingProvider` (`src/provider/provider.ts`): `register(code, carrier)` e `fetchEvents(code)` devolvendo `CarrierEvent`, mais `parseWebhook` opcional. O formato do RastroHub fica em `src/provider/rastrohub/` (cliente HTTP e `mapper.ts`). Trocar = escrever outra pasta de adaptador e acrescentar um `case` em `src/provider/factory.ts`. Ninguém mais muda.

Há um segundo adaptador, `src/provider/parcelnet/`, com dialeto diferente (eventos planos, epoch em segundos, código dividido em dois campos). O teste `test/provider/parcelnet.test.ts` roda o mesmo serviço com ele e obtém o mesmo status. Escolha com `PROVIDER=parcelnet`; ele não tem agregador falso, só teste com `fetch` simulado.

Erros e respostas malformadas do agregador viram `ProviderError` com um `kind`; o formato dele não vaza para domínio, banco ou API. Cada adaptador confere que a resposta é do código pedido, e o serviço recusa o lote inteiro se algum evento vier de outra transportadora que não a registrada (um `ENTREGUE` da Loggi não entrega um pacote dos Correios). Campos validados (`subtag`, `id`, `message`, `location`) com tipo errado (por exemplo `subtag: 99`) são recusados em vez de descartados, porque descartar poderia transformar um código desconhecido em entregue.

Estrutura:

```
src/domain/          normalização, projeção, atraso, identidade do evento (puro, sem I/O)
src/provider/        interface, adaptadores e clientes HTTP
src/fake-aggregator/ agregador falso (testes e npm run dev)
src/repository.ts    SQL; src/db.ts é o único que importa node:sqlite
src/service.ts       orquestra: registrar, ingerir, alertar
src/http/app.ts      rotas Hono
```

## O que ficou de fora

- Retentativa com backoff no cliente HTTP: uma falha vira 502 e a varredura tenta de novo no próximo ciclo.
- Autenticação e autorização da API de entrada (só o token do webhook).
- Paginação em `GET /shipments`; a listagem recalcula cada shipment em memória.
- Entrega de alerta além do log (e-mail, fila). O ponto de extensão é `onDelayAlert`.
- Timestamp sem offset do agregador é recusado (502 no refresh, 400 no webhook) em vez de assumir fuso. Um evento inválido derruba o lote inteiro; é barulhento de propósito.
- Mapeamento de códigos reais das transportadoras: as tabelas cobrem os casos da proposta, não o catálogo completo.
- Prazo de conteúdo por campanha: usa uma configuração global.
- Migrações: o esquema é criado na abertura do banco.

## Testes

`npm test`: 104 testes, relógio controlado (`ManualClock`) onde o tempo importa.

- fora de ordem: entregue e depois chega um `in_transit` antigo, status continua entregue
- status inventado: `unknown`, não entrega, listado em `unmapped_events`
- consulta repetida e repetição dentro do mesmo lote: sem duplicar histórico
- atraso: no limite não é atraso, 1 ms depois é; entregue dentro do prazo e ingerido tarde não é atraso; entregue depois do prazo é atraso; alerta único; alerta limpo
- cliente HTTP contra o agregador falso em porta real: sucesso, 404, 5xx, credencial errada, conexão recusada; resposta que não é JSON, corpo que falha na leitura e 204 usam `fetch` simulado
- API (chamada em processo com `app.request`) sobre o cliente real e o agregador falso em porta real: registro, refresh, lista de atrasados, webhook
- dados malformados e de outra transportadora, registro concorrente, e config

## Uso de IA

Usei mais de um modelo de IA, cada um num papel: Claude Opus 5.5 para planejar, dividir o trabalho e conferir as entregas; Claude Sonnet 5.5 para escrever o código e os testes; e GPT-6.1 Sol para uma revisão independente contra o enunciado, cujos achados válidos entraram como correção. Eu dirigi o processo e revisei o resultado. Eu revisei e ajustei:

- A tabela de Correios: `BDE`, `BDI` e `BDR` só viram entregue com subcódigo `01`. Subcódigos de "destinatário ausente" viram exceção e `BDE` solto vira `unknown`.
- O parse de data do agregador: confirmei que `Date.parse("2026-02-31T10:00:00Z")` rola para março em vez de falhar, e por isso a validação do calendário e a recusa de horário sem offset ficam em `src/provider/time.ts`.
- Onde o atraso é avaliado: também quando o agregador está fora do ar, e o status normalizado não é gravado, para que um mapeamento novo corrija o histórico.
- Os testes de atraso, que fixam o relógio e conferem o limite exato, 1 ms depois e o caso de entrega ingerida tarde. Rodei o servidor com `curl` e conferi as saídas citadas aqui.
