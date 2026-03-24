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
cp .env.sandbox.example .env.sandbox
# quando passi in produzione:
# cp .env.prod.example .env.prod
```

Compila/avvia:

```bash
npm run build
node dist/index.js --help
# oppure in dev
npm run dev -- --help
```

## Configurazione

Runbook completo eBay:

- `docs/ebay-setup.md`
- `docs/production-first-listing.md`
- `docs/policy-strategy.md`
- `docs/production-keyset-unblock.md`
- `docs/mcp-server.md`

### 1) `.env`

Caricamento env consigliato:

- `.env`: solo selettore ambiente e valori comuni
- `.env.sandbox`: credenziali e default sandbox
- `.env.prod`: credenziali e default production
- opzionale: `SELLBOT_ENV_FILE` per un ulteriore overlay locale/segreto

Ordine di precedenza:

1. `.env`
2. `.env.sandbox` oppure `.env.prod` in base a `EBAY_ENV`
3. file indicato in `SELLBOT_ENV_FILE`
4. variabili di shell esportate nel terminale

Esempio minimale di `.env`:

```env
EBAY_ENV=sandbox
SELLBOT_PORT=3000
EBAY_MARKETPLACE_ID=EBAY_IT
```

Variabili principali:

- `EBAY_ENV=sandbox|prod`
- `SELLBOT_ENV_FILE` (opzionale, overlay env aggiuntivo)
- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- `EBAY_RUNAME` (Redirect URI name creato nel Developer Portal, non un URL)
- `EBAY_CALLBACK_URL` (opzionale, usato solo per callback automatico locale)
- `EBAY_SCOPES` (scope necessari)
- `EBAY_MARKETPLACE_ID` (default `EBAY_IT`)
- `SELLBOT_CONFIG_FILE` (opzionale, path del file config da usare al posto di `sellbot.config.json`)
- `SELLBOT_PORT` (fallback porta callback)

Note pratiche OAuth:

- `redirect_uri` inviato a eBay e' il `RuName`
- molti account eBay richiedono URL `https` nei campi accepted/declined del RuName
- se lasci vuoto `EBAY_CALLBACK_URL`, `sellbot auth` usa inserimento manuale del `code`
- per separare sandbox/prod e ridurre errori operativi, usa sia file env distinti (`.env.sandbox`, `.env.prod`) sia file config distinti (`SELLBOT_CONFIG_FILE`)

Scope consigliati per questa versione:

- `https://api.ebay.com/oauth/api_scope/sell.inventory`
- `https://api.ebay.com/oauth/api_scope/sell.account.readonly`

Riferimenti OAuth ufficiali:

- [eBay SDKs and Widgets](https://developer.ebay.com/develop/sdks-and-widgets)
- [RuName / Redirect URI setup](https://developer.ebay.com/api-docs/static/oauth-redirect-uri.html)
- [Authorization code grant](https://developer.ebay.com/api-docs/static/oauth-authorization-code-grant-request.html)
- [Refresh token grant](https://developer.ebay.com/api-docs/static/oauth-refresh-token-request.html)

### 2) `sellbot.config.json` (opzionale ma necessario per publish)

Crea il file nella root usando `sellbot.config.example.json` come base:

```json
{
  "marketplaceId": "EBAY_IT",
  "locale": "it-IT",
  "merchantLocationKey": "MILANO_WAREHOUSE",
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
    "fulfillmentPolicyId": "6200000000",
    "fulfillmentPolicyIdByProfile": {
      "book": "6200000001",
      "book_heavy": "6200000003",
      "fragile": "6200000002"
    },
    "paymentPolicyId": "6300000000",
    "returnPolicyId": "6400000000"
  }
}
```

Note:

- `paymentPolicyId` e `returnPolicyId` restano globali.
- la spedizione puo' variare per listing impostando `draft.shipping_profile` (es. `book`) e mappandolo in `policies.fulfillmentPolicyIdByProfile`.
- fallback: se `shipping_profile` manca o non ha mapping, viene usato `policies.fulfillmentPolicyId`.
- `shippingProfiles.<profilo>` serve solo a modellare servizio scelto, costo stimato e strategia commerciale (`separate_charge` vs `included_in_item_price`).
- `sellbot publish` e `sellbot publish:preflight` mostrano questi dati, ma la pubblicazione su eBay continua a usare solo policy/location documentate.
- la Metadata API di eBay restituisce i servizi validi per il selling flow, non il listino del corriere; la tariffa reale va configurata localmente o gestita con rate table/policy tue.
- per i libri ha senso distinguere almeno `book` e `book_heavy`; l'intake puo' chiedere `peso` e `spessore` solo se la soglia non e' chiara.

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
    photos/           # jpg/png/heic
    notes.txt
    draft.json        # input validato (zod)
    enrichment.json   # output del modulo di enrichment (opzionale)
    intake.json       # report agent-friendly con dati mancanti e pricing suggestion
    ebay.json         # generato da build
    status.json       # stato listing
```

Per i libri puoi aggiungere nel `draft.json` anche dati logistici opzionali:

```json
{
  "shipping_profile": "book",
  "shipping": {
    "weight_g": 320,
    "thickness_cm": 2.1,
    "pages": 256,
    "binding": "paperback"
  }
}
```

Se `shipping_profile` manca, `sellbot` prova a inferirlo per i libri usando soprattutto `spessore`, `peso`, `pagine` e `binding`.

## Comandi

### `sellbot mcp`

Avvia il server MCP su `stdio`.

Opzioni pratiche:

```bash
# via CLI principale
node dist/index.js mcp

# bin dedicato
node dist/mcp/server.js

# in dev
npm run mcp
```

### `sellbot mcp:http`

Avvia il server MCP via `Streamable HTTP`.

```bash
# via CLI principale
node dist/index.js mcp:http --host 127.0.0.1 --port 3000

# bin dedicato
node dist/mcp/http-server.js

# in dev
npm run mcp:http
```

Endpoint:

- MCP: `http://127.0.0.1:3000/mcp`
- health: `http://127.0.0.1:3000/healthz`

Il server MCP espone tool per:

- auth OAuth a due step (`sellbot_auth_start`, `sellbot_auth_complete`, `sellbot_auth_status`)
- ispezione listing (`sellbot_listings_list`, `sellbot_listing_get`, `sellbot_remote_listings_list`)
- pipeline contenuti (`sellbot_scan`, `sellbot_listing_enrich`, `sellbot_listing_patch_draft`, `sellbot_listing_intake_check`, `sellbot_listing_build`, `sellbot_listing_prepare_for_publish`)
- metadata/config (`sellbot_config_test`, `sellbot_category_suggest`, `sellbot_category_conditions`, `sellbot_shipping_services`)
- sell flow (`sellbot_listing_preflight`, `sellbot_listing_publish`, `sellbot_listing_revise`)

Nota importante:

- il server MCP non apre browser e non chiede conferme interattive
- per OAuth il flusso corretto e':
  1. `sellbot_auth_start`
  2. apri il `consentUrl`
  3. copia l'URL finale di redirect
  4. `sellbot_auth_complete`
- `sellbot_listings_list` usa di default `scope=current_env`, quindi in `prod` non mostra le listing sandbox gia' pubblicate salvo richiesta esplicita
- `sellbot_remote_listings_list` interroga davvero eBay sull'env attivo; per la produzione usare `EBAY_ENV=prod`
- `sellbot_remote_listings_list` usa Inventory API: vede le offer inventory-backed dell'account, non le listing legacy create fuori da Inventory API
- per correzioni incrementali del contenuto, il tool giusto e' `sellbot_listing_patch_draft`
- per agenti, il tool workflow consigliato e' `sellbot_listing_prepare_for_publish`
- i tool `publish` e `revise` via MCP equivalgono a `--yes`

Config example:

- stdio: `/Users/cristopher.turazza/Developer/mastrota/docs/mcp-client-config.example.json`
- HTTP: `/Users/cristopher.turazza/Developer/mastrota/docs/mcp-client-config.http.example.json`

### `sellbot auth`

Avvia OAuth2 user-consent, apre il browser e salva token in:
Il flusso OAuth usa la libreria ufficiale eBay `ebay-oauth-nodejs-client`.

- `~/.sellbot/ebay-token.<env>.<client-id>.json`

Il token **non** viene salvato nel repository.

Modalita':

- callback automatico: `EBAY_CALLBACK_URL=http://localhost:3000/callback`
- fallback manuale: incolla URL finale/code nel terminale

### `sellbot notifications:serve`

Avvia localmente l'endpoint richiesto da eBay per le `Marketplace Account Deletion Notifications`.

Prerequisiti:

- `SELLBOT_NOTIFICATION_ENDPOINT_URL` configurato con un URL pubblico `https`
- `SELLBOT_NOTIFICATION_VERIFICATION_TOKEN` configurato con lo stesso token impostato nel portale eBay

Uso tipico:

```bash
node dist/index.js notifications:serve --host 127.0.0.1 --port 8080
```

Questo comando espone:

- `GET` per il `challenge_code` di validazione eBay
- `POST` per ricevere le notifiche reali e fare `204 No Content`

Nota pratica:

- per renderlo raggiungibile da eBay serve un tunnel pubblico HTTPS, ad esempio `cloudflared` o `tailscale funnel`
- `tailscale` da solo non basta: serve `funnel`, non solo rete tailnet privata

### `sellbot scan`

- scansiona `./ToSell/*/`
- verifica `photos/` + almeno 1 immagine (`.jpg/.jpeg/.png/.heic`)
- se manca `draft.json`, genera un draft da `notes.txt` + nomi foto
- crea/aggiorna `status.json` (`draft` o `ready`)
- non pubblica nulla

Nota: su macOS le foto `.heic` vengono convertite automaticamente in JPEG al momento dell'upload verso eBay, per compatibilità pratica con la Media API sandbox.

### `sellbot build <folder>`

- valida `draft.json`
- risolve `category_id` (usa `draft.category_id` se presente, altrimenti Taxonomy API da `category_hint`)
- propaga `draft.shipping_profile` in `ebay.json` (usato in publish/revise per selezionare la fulfillment policy)
- genera `ebay.json` con i campi usati in publish
- converte `draft.description` in HTML pulito per `listingDescription`, mantenendo `product.description` come testo semplice
- aggiorna `status.json` a `ready` se ok

Riferimenti:

- [getDefaultCategoryTreeId](https://developer.ebay.com/api-docs/commerce/taxonomy/resources/category_tree/methods/getDefaultCategoryTreeId)
- [getCategorySuggestions](https://developer.ebay.com/api-docs/commerce/taxonomy/resources/category_tree/methods/getCategorySuggestions)

### `sellbot category:suggest <folder>`

Mostra le categorie suggerite da Taxonomy API per una listing:

- usa `draft.category_hint` oppure `--query`
- `--top <n>` limita il numero di risultati mostrati
- `--pick <rank>` salva nel `draft.json` la suggestion scelta in `draft.category_id`

Nota: in sandbox eBay documenta che le category suggestions non sono pienamente affidabili. Usa questo comando come supporto, non come fonte di verita'.

### `sellbot category:conditions <categoryId>`

Mostra le condition policy ufficiali per una categoria nel marketplace corrente:

- legge le condizioni ammesse da Metadata API
- utile per verificare se `LIKE_NEW`, `USED_GOOD`, ecc. sono validi prima del publish

Riferimento:

- [getItemConditionPolicies](https://developer.ebay.com/api-docs/sell/metadata/resources/marketplace/methods/getItemConditionPolicies)

### `sellbot shipping:services`

Legge i servizi di spedizione disponibili dal marketplace corrente via Metadata API usando application token.

Uso tipico:

```bash
node dist/index.js shipping:services --carrier POST_ITALIANO --domestic
node dist/index.js shipping:services --json --carrier POST_ITALIANO --domestic
```

Opzioni utili:

- `--carrier <code>` filtra per carrier, ad esempio `POST_ITALIANO`
- `--service <code>` filtra per service code, ad esempio `IT_Posta1`
- `--domestic` oppure `--international`
- `--all` include anche servizi non validi per il selling flow
- `--json` per output machine-readable, adatto a orchestratori/MCP

Nota pratica:

- `sellbot publish` non invia direttamente un `shippingServiceCode` nell'offerta.
- La listing usa una `fulfillment policy`.
- Quindi, in prospettiva MCP, la scelta del servizio serve a selezionare o costruire la fulfillment policy corretta.

Riferimento:

- [getShippingServices](https://developer.ebay.com/api-docs/sell/metadata/resources/shipping%3Amarketplace/methods/getShippingServices)

### `sellbot enrich <folder>`

Genera `enrichment.json` tramite un modulo dedicato e crea `draft.json` se manca.

Opzioni:

- `--module auto|generic|book`
- `--force` per rigenerare `draft.json` anche se esiste gia'

Uso consigliato:

1. `scan` per setup iniziale
2. `enrich --module book` per libri
3. `build`
4. `publish` oppure `revise`

### `sellbot intake:check <folder>`

Genera un report pensato per orchestratori/chatbot e lo salva in `intake.json`.

Contenuti:

- campi presenti, mancanti o incerti
- distinzione `search first` / `ask user`
- eventuali blocker prima della pubblicazione
- suggerimento prezzo basato sul prezzo del nuovo e sulla condizione

Opzioni:

- `--module auto|generic|book`
- `--json` per output machine-readable su stdout
- `--no-save` per non scrivere `intake.json`

Strategia prezzo predefinita:

- `prezzo del nuovo - 20%` se la condizione e' pari al nuovo
- `prezzo del nuovo - 40%` se chiaramente usato
- `prezzo del nuovo - 60%` se con difetto documentato

Il prezzo resta un suggerimento: l'utente puo' comunque impostare un target diverso nel `draft.json`.

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

### `sellbot publish:preflight <folder>`

Esegue un controllo read-only prima del publish:

- verifica foto presenti
- verifica config publish
- risolve la fulfillment policy in base a `shipping_profile` (fallback default)
- verifica condition policy per la categoria selezionata
- controlla aspects richiesti e lunghezza valori
- verifica accessibilita' di policy e location con token utente

Se trova almeno un check `KO`, termina con exit code non-zero.

### `sellbot revise <folder>`

Corregge una inserzione già pubblicata via API (prezzo, descrizione, immagini), mantenendo `offer_id` esistente:

1. mostra riepilogo aggiornamenti e chiede conferma `Y/n`
2. sincronizza `ebay.json` dai dati correnti (`draft.json` + `photos/`)
3. ricarica immagini con Media API
4. aggiorna Inventory Item (`createOrReplaceInventoryItem`) per titolo/descrizione/aspects/immagini
5. legge l'offerta corrente (`getOffer`) e invia `updateOffer` con payload completo (merge dei campi esistenti + nuovi valori)
6. aggiorna `status.json` mantenendo `state=\"published\"`

Riferimenti ufficiali:

- [getOffer](https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/getOffer)
- [updateOffer](https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/updateOffer)
- [createOrReplaceInventoryItem](https://developer.ebay.com/api-docs/sell/inventory/resources/inventory_item/methods/createOrReplaceInventoryItem)

### `sellbot open <folder>`

Stampa la URL della listing pubblicata e prova ad aprirla nel browser:

- usa `status.json` se contiene gia' `ebay.url`
- altrimenti deriva la URL da `listing_id` + marketplace + ambiente (`sandbox`/`prod`)
- persiste la URL calcolata in `status.json`

Opzioni:

- `--print-only`: stampa solo la URL senza aprire il browser

### `sellbot config:test`

Checklist `OK/KO` su:

- token valido o refresh riuscito
- policy IDs presenti
- verifica policy fulfillment default e per ogni profilo configurato
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

Nota: con OAuth via SDK ufficiale, gli endpoint auth/token seguono `EBAY_ENV` (`sandbox`/`prod`), quindi `EBAY_AUTH_BASE_URL` non viene usato dal flusso OAuth.

Nota importante: le inserzioni create con Inventory API vanno corrette via API (`updateOffer` / `createOrReplaceInventoryItem`), non dal portale Seller Hub.

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
  - verifica il file config attivo (`sellbot.config.json` o `SELLBOT_CONFIG_FILE`) e usa `sellbot config:test`
- `category_id` non risolta in sandbox:
  - imposta `draft.category_id` manualmente (sandbox Taxonomy può essere meno affidabile)

## Prima Inserzione In Produzione (Canary)

Sequenza consigliata:

1. crea un file dedicato produzione (es. `sellbot.config.prod.json`) con location e policy reali
2. imposta ambiente produzione:
   - `EBAY_ENV=prod`
   - `SELLBOT_CONFIG_FILE=sellbot.config.prod.json`
3. esegui `node dist/index.js auth` autenticandoti con account venditore reale
4. esegui `node dist/index.js config:test`
5. prepara una sola cartella canary in `ToSell/` con metadata già verificati
6. esegui `node dist/index.js intake:check <folder>`
7. esegui `node dist/index.js build <folder>`
8. esegui `node dist/index.js publish:preflight <folder>`
9. esegui `node dist/index.js publish <folder>`
10. verifica la pagina live con `node dist/index.js open <folder> --print-only`
11. prova una `revise` minima per validare anche il post-publish

Regola operativa:

- non passare al batch di inserzioni finché la canary non è chiusa end-to-end.
