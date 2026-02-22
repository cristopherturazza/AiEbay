# sellbot

CLI Node.js + TypeScript per creare e pubblicare inserzioni eBay partendo da `./ToSell/<slug>/`.

## Requisiti

- macOS
- Node.js >= 20
- account [eBay Developers Program](https://developer.ebay.com/)
- app eBay con OAuth abilitato (sandbox o production)

## Setup rapido

```bash
npm install
cp .env.example .env
```

Compila/avvia:

```bash
npm run build
node dist/index.js --help
# oppure in dev
npm run dev -- --help
```

## Configurazione

### 1) `.env`

Variabili principali:

- `EBAY_ENV=sandbox|prod`
- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- `EBAY_REDIRECT_URI` (callback locale, esempio `http://localhost:3000/callback`)
- `EBAY_SCOPES` (scope necessari)
- `EBAY_MARKETPLACE_ID` (default `eBay_IT`)
- `SELLBOT_PORT` (fallback porta callback)

Scope consigliati per questa versione:

- `https://api.ebay.com/oauth/api_scope/sell.inventory`
- `https://api.ebay.com/oauth/api_scope/sell.account.readonly`

Riferimenti OAuth ufficiali:

- [eBay SDKs and Widgets](https://developer.ebay.com/develop/sdks-and-widgets)
- [Authorization code grant](https://developer.ebay.com/api-docs/static/oauth-authorization-code-grant-request.html)
- [Refresh token grant](https://developer.ebay.com/api-docs/static/oauth-refresh-token-request.html)

### 2) `sellbot.config.json` (opzionale ma necessario per publish)

Crea il file nella root usando `sellbot.config.example.json` come base:

```json
{
  "marketplaceId": "eBay_IT",
  "locale": "it-IT",
  "merchantLocationKey": "MILANO_WAREHOUSE",
  "policies": {
    "fulfillmentPolicyId": "6200000000",
    "paymentPolicyId": "6300000000",
    "returnPolicyId": "6400000000"
  }
}
```

### Policy IDs e location

Questa versione **non crea automaticamente** business policies.

Recupero via API (read-only), documentazione ufficiale:

- [getFulfillmentPolicies](https://developer.ebay.com/api-docs/sell/account/resources/fulfillment_policy/methods/getFulfillmentPolicies)
- [getPaymentPolicies](https://developer.ebay.com/api-docs/sell/account/resources/payment_policy/methods/getPaymentPolicies)
- [getReturnPolicies](https://developer.ebay.com/api-docs/sell/account/resources/return_policy/methods/getReturnPolicies)
- [getInventoryLocation](https://developer.ebay.com/api-docs/sell/inventory/resources/location/methods/getInventoryLocation)

In alternativa, inseriscili manualmente dal Seller Hub dove documentato da eBay.

## Struttura dati `ToSell/`

```text
ToSell/
  <slug>/
    photos/           # jpg/png
    notes.txt
    draft.json        # input validato (zod)
    ebay.json         # generato da build
    status.json       # stato listing
```

## Comandi

### `sellbot auth`

Avvia OAuth2 con callback locale su `localhost`, apre il browser e salva token in.
Il flusso OAuth usa la libreria ufficiale eBay `ebay-oauth-nodejs-client`.

- `~/.sellbot/ebay-token.json`

Il token **non** viene salvato nel repository.

### `sellbot scan`

- scansiona `./ToSell/*/`
- verifica `photos/` + almeno 1 immagine
- se manca `draft.json`, genera un draft da `notes.txt` + nomi foto
- crea/aggiorna `status.json` (`draft` o `ready`)
- non pubblica nulla

### `sellbot build <folder>`

- valida `draft.json`
- risolve `category_id` (usa `draft.category_id` se presente, altrimenti Taxonomy API da `category_hint`)
- genera `ebay.json` con i campi usati in publish
- aggiorna `status.json` a `ready` se ok

Riferimenti:

- [getDefaultCategoryTreeId](https://developer.ebay.com/api-docs/commerce/taxonomy/resources/category_tree/methods/getDefaultCategoryTreeId)
- [getCategorySuggestions](https://developer.ebay.com/api-docs/commerce/taxonomy/resources/category_tree/methods/getCategorySuggestions)

### `sellbot publish <folder>`

Flusso:

1. mostra riepilogo (titolo, prezzo target, currency, numero foto, anteprima descrizione)
2. conferma `Y/n`
3. upload immagini (Media API)
4. upsert inventory item
5. create offer
6. publish offer
7. aggiorna `status.json` (`published` oppure `error`)

Riferimenti ufficiali endpoint usati:

- [createImageFromFile](https://developer.ebay.com/api-docs/commerce/media/resources/image/methods/createImageFromFile)
- [createOrReplaceInventoryItem](https://developer.ebay.com/api-docs/sell/inventory/resources/inventory_item/methods/createOrReplaceInventoryItem)
- [createOffer](https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/createOffer)
- [publishOffer](https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/publishOffer)

### `sellbot config:test`

Checklist `OK/KO` su:

- token valido o refresh riuscito
- policy IDs presenti
- `merchantLocationKey` presente
- chiamate GET non distruttive a policy/location

## Note ambiente eBay

Base URL predefiniti:

- sandbox:
  - auth: `https://auth.sandbox.ebay.com`
  - api: `https://api.sandbox.ebay.com`
  - media: `https://apim.sandbox.ebay.com`
- production:
  - auth: `https://auth.ebay.com`
  - api: `https://api.ebay.com`
  - media: `https://apim.ebay.com`

Puoi override con `EBAY_AUTH_BASE_URL`, `EBAY_API_BASE_URL`, `EBAY_MEDIA_BASE_URL`.

Nota: con OAuth via SDK ufficiale, gli endpoint auth/token seguono `EBAY_ENV` (`sandbox`/`prod`).

## Test minimi

```bash
npm test
```

Coperti:

- validazione zod (`draft.json`, `status.json`)
- parsing cartelle e filtro file immagini

## Troubleshooting

- `TOKEN_MISSING` o `TOKEN_EXPIRED`:
  - esegui `sellbot auth`
- scope insufficienti:
  - aggiorna `EBAY_SCOPES`, riautentica con `sellbot auth`
- policy mancanti/invalid:
  - verifica `sellbot.config.json` e usa `sellbot config:test`
- `category_id` non risolta in sandbox:
  - imposta `draft.category_id` manualmente (sandbox Taxonomy può essere meno affidabile)
