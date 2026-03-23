# eBay Setup Runbook

Runbook operativo per configurare `sellbot` con le API eBay.

Obiettivo:
- evitare di ricostruire ogni volta i passaggi OAuth / policy / location
- avere un riferimento unico per il passaggio da sandbox a produzione
- documentare i vincoli reali emersi durante i test

Se il portale production mostra `Your Keyset is currently disabled`, usa anche:

- `docs/production-keyset-unblock.md`

## Principi

- Non salvare segreti nel repository.
- Il token utente viene salvato in `~/.sellbot/ebay-token.json`.
- `sellbot` usa OAuth2 user-consent con `RuName`.
- Le business policies non vengono create automaticamente dal tool.
- Le listing create via Inventory API vanno gestite via API anche per le revisioni.

## File Coinvolti

- `.env`: selettore ambiente e valori comuni
- `.env.sandbox`: credenziali e default sandbox
- `.env.prod`: credenziali e default production
- `sellbot.config*.json`: marketplace, location e policy IDs (consigliato separare sandbox/prod)
- `~/.sellbot/ebay-token.json`: token utente locale

Ordine di caricamento env nel progetto:

1. `.env`
2. `.env.sandbox` oppure `.env.prod` in base a `EBAY_ENV`
3. `SELLBOT_ENV_FILE` se valorizzato
4. variabili di shell esportate

## Valori Da Ottenere

Per ogni ambiente (`sandbox` o `prod`) servono:

- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- `EBAY_RUNAME`
- `merchantLocationKey`
- `fulfillmentPolicyId`
- `paymentPolicyId`
- `returnPolicyId`

## Scopes

Per leggere e pubblicare:

```text
https://api.ebay.com/oauth/api_scope/sell.inventory
https://api.ebay.com/oauth/api_scope/sell.account.readonly
```

Per creare business policies serve anche:

```text
https://api.ebay.com/oauth/api_scope/sell.account
```

Valore pratico usato durante il bootstrap:

```text
EBAY_SCOPES=https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account https://api.ebay.com/oauth/api_scope/sell.account.readonly
```

## OAuth

Passi:

1. Creare una app nel portale eBay Developers.
2. Abilitare OAuth.
3. Creare un `RuName`.
4. Mettere il `RuName` in `.env` come `EBAY_RUNAME`.
5. Eseguire:

```bash
node dist/index.js auth
```

Note:

- `redirect_uri` verso eBay e' il `RuName`, non un URL locale.
- Se `EBAY_CALLBACK_URL` e' vuoto, `sellbot auth` usa il flusso manuale:
  apre/stampa l'URL di consenso, poi chiede di incollare l'URL finale o il solo `code`.
- In sandbox si usa un seller test user, non l'account eBay reale.

## Marketplace

Formato canonico nel progetto:

- `EBAY_IT`

Nota:

- In passato era stato usato anche `eBay_IT`.
- Il codice ora normalizza i valori legacy, ma i nuovi file/config devono usare `EBAY_IT`.

## Location e Business Policies

`sellbot publish` richiede:

- `merchantLocationKey`
- `fulfillmentPolicyId` (default) oppure `fulfillmentPolicyIdByProfile.<profilo>`
- `paymentPolicyId`
- `returnPolicyId`

### Location

La location si legge con:

```http
GET /sell/inventory/v1/location
```

Se non esiste, si crea con:

```http
POST /sell/inventory/v1/location/{merchantLocationKey}
```

### Business Policy Eligibility

Prima di leggere/creare le policy, il seller account deve essere opt-in a:

- `SELLING_POLICY_MANAGEMENT`

Verifica:

```http
GET /sell/account/v1/program/get_opted_in_programs
```

Opt-in:

```http
POST /sell/account/v1/program/opt_in
{
  "programType": "SELLING_POLICY_MANAGEMENT"
}
```

Nota:

- l'opt-in puo' non essere immediato
- se le GET delle policy rispondono `User is not eligible for Business Policy`, il problema e' lato account eBay, non lato `sellbot`

### Lettura Policy

```http
GET /sell/account/v1/fulfillment_policy?marketplace_id=EBAY_IT
GET /sell/account/v1/payment_policy?marketplace_id=EBAY_IT
GET /sell/account/v1/return_policy?marketplace_id=EBAY_IT
```

### Creazione Policy

Ordine consigliato:

1. `return_policy`
2. `payment_policy`
3. `fulfillment_policy`

Motivo:

- `fulfillment_policy` richiede un servizio di spedizione valido del marketplace

### Servizi di Spedizione

Non usare valori arbitrari per la fulfillment policy.

Prima leggere i servizi validi:

```http
GET /sell/metadata/v1/shipping/marketplace/EBAY_IT/get_shipping_services
```

Comando locale equivalente:

```bash
node dist/index.js shipping:services --carrier POST_ITALIANO --domestic
node dist/index.js shipping:services --json --carrier POST_ITALIANO --domestic
```

Usare solo servizi con:

- `validForSellingFlow = true`

Durante i test sandbox e' stato usato con successo:

- `shippingCarrierCode`: `POST_ITALIANO`
- `shippingServiceCode`: `IT_Posta1`

Nota:

- nella Metadata API il costo puo' apparire come `FLAT`
- nella fulfillment policy il `costType` da inviare e' `FLAT_RATE`

## Configurazione Locale Attesa

`.env` minimo:

```env
EBAY_ENV=sandbox
EBAY_MARKETPLACE_ID=EBAY_IT
SELLBOT_PORT=3000
```

`.env.sandbox` minimo:

```env
EBAY_CLIENT_ID=
EBAY_CLIENT_SECRET=
EBAY_RUNAME=
EBAY_CALLBACK_URL=
EBAY_SCOPES=https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account.readonly
SELLBOT_CONFIG_FILE=sellbot.config.sandbox.json
```

Durante il bootstrap delle policy:

```env
EBAY_SCOPES=https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account https://api.ebay.com/oauth/api_scope/sell.account.readonly
```

`sellbot.config.json`:

```json
{
  "marketplaceId": "EBAY_IT",
  "locale": "it-IT",
  "merchantLocationKey": "YOUR_LOCATION_KEY",
  "shippingProfiles": {
    "book": {
      "label": "Libro standard Italia",
      "carrierCode": "POST_ITALIANO",
      "serviceCode": "IT_Posta1",
      "pricingMode": "separate_charge",
      "buyerCharge": {
        "value": 4.9,
        "currency": "EUR"
      },
      "estimatedCarrierCost": {
        "value": 4.9,
        "currency": "EUR"
      }
    },
    "book_heavy": {
      "label": "Libro pesante / spesso",
      "carrierCode": "POST_ITALIANO",
      "serviceCode": "IT_Posta1ExtraStandard",
      "pricingMode": "separate_charge",
      "buyerCharge": {
        "value": 5.9,
        "currency": "EUR"
      },
      "estimatedCarrierCost": {
        "value": 5.9,
        "currency": "EUR"
      }
    }
  },
  "policies": {
    "fulfillmentPolicyId": "YOUR_FULFILLMENT_POLICY_ID",
    "fulfillmentPolicyIdByProfile": {
      "book": "YOUR_BOOK_FULFILLMENT_POLICY_ID",
      "book_heavy": "YOUR_BOOK_HEAVY_FULFILLMENT_POLICY_ID"
    },
    "paymentPolicyId": "YOUR_PAYMENT_POLICY_ID",
    "returnPolicyId": "YOUR_RETURN_POLICY_ID"
  }
}
```

Regola di risoluzione fulfillment policy:

- se `draft.shipping_profile` e' valorizzato e trova mapping in `fulfillmentPolicyIdByProfile`, `sellbot` usa quel policy ID
- altrimenti usa `policies.fulfillmentPolicyId` come fallback
- `shippingProfiles.<profilo>` non cambia l'API call verso eBay: serve a tenere in locale servizio scelto, costo compratore e costo vettore stimato
- la Metadata API di eBay restituisce i servizi validi (`shippingServiceCode`), non la tariffa del corriere
- per i libri, `sellbot` puo' usare `peso`, `spessore`, `pagine` e `binding` per suggerire `book` o `book_heavy`

Per separare ambienti e ridurre errori operativi:

- usa file distinti, ad esempio `.env.sandbox`, `.env.prod`, `sellbot.config.sandbox.json` e `sellbot.config.prod.json`
- seleziona il file attivo con `SELLBOT_CONFIG_FILE` nel file env dell'ambiente (`.env.sandbox` / `.env.prod`)

## Valori Sandbox Verificati

Ultimo setup sandbox verificato localmente:

```json
{
  "marketplaceId": "EBAY_IT",
  "locale": "it-IT",
  "merchantLocationKey": "CEREA-01",
  "policies": {
    "fulfillmentPolicyId": "6219331000",
    "fulfillmentPolicyIdByProfile": {
      "book": "6219331000"
    },
    "paymentPolicyId": "6219333000",
    "returnPolicyId": "6219332000"
  }
}
```

Questi valori sono utili solo in sandbox.
Non riusarli in produzione.

## Comandi Utili

```bash
node dist/index.js auth
node dist/index.js config:test
node dist/index.js shipping:services --carrier POST_ITALIANO --domestic
node dist/index.js intake:check <folder>
node dist/index.js scan
node dist/index.js build <folder>
node dist/index.js publish:preflight <folder>
node dist/index.js publish <folder>
node dist/index.js revise <folder>
```

## Errori Reali Gia' Incontrati

### `Invalid value for header Accept-Language`

Causa:

- le Inventory API sandbox richiedono esplicitamente gli header lingua anche in chiamate dove non era ovvio

Stato:

- corretto nel client `inventory`

### `The specified marketplace ID was not found`

Causa:

- Taxonomy API non accetta il formato legacy `eBay_IT`

Stato:

- corretto con normalizzazione marketplace

### `Could not serialize field [marketplaceId]`

Causa:

- `createOffer` richiede `EBAY_IT`, non `eBay_IT`

Stato:

- corretto con normalizzazione marketplace

### `Offer entity already exists`

Causa:

- un tentativo precedente aveva gia' creato l'offerta

Stato:

- `publish` ora riusa l'`offerId` invece di fallire

### `Invalid item condition information`

Causa:

- condition non compatibile con la categoria suggerita

Nota:

- questo non e' un bug del client, ma un vincolo business di eBay

## Passaggio a Produzione

Runbook operativo step-by-step:

- `docs/production-first-listing.md`

Checklist configurazione:

1. creare keyset Production separato
2. creare `RuName` Production
3. creare/recuperare location e policy reali del seller reale
4. predisporre un file dedicato (`sellbot.config.prod.json`) senza riusare ID sandbox
5. impostare:
   - `EBAY_ENV=prod`
   - `SELLBOT_CONFIG_FILE=sellbot.config.prod.json`
6. autenticarsi con account venditore reale (`node dist/index.js auth`)
7. verificare setup (`node dist/index.js config:test`)

Go-live canary consigliato:

1. creare una sola listing canary, con prezzo basso e informazioni complete
2. eseguire:
   - `node dist/index.js intake:check <folder>`
   - `node dist/index.js build <folder>`
   - `node dist/index.js publish:preflight <folder>`
   - `node dist/index.js publish <folder>`
3. verificare URL live:
   - `node dist/index.js open <folder> --print-only`
4. provare una revisione minima:
   - `node dist/index.js revise <folder>`
5. solo dopo una canary valida passare al batch

## Riferimenti Ufficiali

- OAuth SDKs: https://developer.ebay.com/develop/sdks-and-widgets
- RuName / redirect URI: https://developer.ebay.com/api-docs/static/oauth-redirect-uri.html
- Authorization code grant: https://developer.ebay.com/api-docs/static/oauth-authorization-code-grant-request.html
- Refresh token grant: https://developer.ebay.com/api-docs/static/oauth-refresh-token-request.html
- Business policies overview: https://developer.ebay.com/api-docs/sell/static/seller-accounts/business-policies.html
- Inventory overview: https://developer.ebay.com/api-docs/sell/inventory/overview.html
- getShippingServices: https://developer.ebay.com/api-docs/sell/metadata/resources/shipping%3Amarketplace/methods/getShippingServices
