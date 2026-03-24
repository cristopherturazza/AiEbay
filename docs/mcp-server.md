# MCP server

`sellbot` puo' essere eseguito come server MCP su `stdio` oppure via `Streamable HTTP`.

## Avvio `stdio`

Produzione locale:

```bash
npm run build
node dist/index.js mcp
```

Entry-point diretto:

```bash
node dist/mcp/server.js
```

Dev mode:

```bash
npm run mcp
```

Configurazione client pronta da copiare:

- `/Users/cristopher.turazza/Developer/mastrota/docs/mcp-client-config.example.json`

## Avvio `Streamable HTTP`

CLI principale:

```bash
node dist/index.js mcp:http --host 127.0.0.1 --port 3000
```

Entry-point diretto:

```bash
node dist/mcp/http-server.js
```

Dev mode:

```bash
npm run mcp:http
```

Endpoint esposti:

- MCP: `http://127.0.0.1:3000/mcp`
- health: `http://127.0.0.1:3000/healthz`

Configurazione client HTTP pronta da copiare:

- `/Users/cristopher.turazza/Developer/mastrota/docs/mcp-client-config.http.example.json`

## Tool disponibili

Autenticazione:

- `sellbot_auth_status`
- `sellbot_auth_start`
- `sellbot_auth_complete`

Stato/config:

- `sellbot_config_test`
- `sellbot_listings_list`
- `sellbot_listing_get`
- `sellbot_remote_listings_list`

Pipeline listing:

- `sellbot_scan`
- `sellbot_listing_enrich`
- `sellbot_listing_patch_draft`
- `sellbot_listing_intake_check`
- `sellbot_listing_build`
- `sellbot_listing_prepare_for_publish`
- `sellbot_listing_preflight`
- `sellbot_listing_publish`
- `sellbot_listing_revise`

Metadata:

- `sellbot_category_suggest`
- `sellbot_category_conditions`
- `sellbot_shipping_services`

## OAuth in MCP

Nel server MCP non usiamo browser/callback locale come prerequisito del tool.
Il flusso corretto e':

1. chiamare `sellbot_auth_start`
2. aprire `consentUrl` nel browser
3. completare login/consenso eBay
4. copiare l'URL finale di redirect oppure il solo `code`
5. chiamare `sellbot_auth_complete`

La sessione OAuth pendente viene salvata localmente in:

- `~/.sellbot/ebay-auth.pending.<env>.<client-id>.json`

Il token utente continua a essere salvato in:

- `~/.sellbot/ebay-token.<env>.<client-id>.json`

## Note operative

- il logger usa `stderr`, cosi' non inquina il protocollo MCP su `stdout`
- `sellbot_listing_publish` e `sellbot_listing_revise` saltano la conferma interattiva
- `sellbot_listing_patch_draft` e' il punto giusto per gli agenti quando devono correggere prezzo, descrizione, specifics o profilo spedizione senza riscrivere l'intero file
- i tool che parlano con eBay usano le stesse policy/token/config della CLI
- il server MCP e' pensato come adapter sottile sopra la business logic gia' esistente
- `sellbot_listings_list` usa di default `scope=current_env`, quindi non mischia sandbox e production salvo richiesta esplicita
- `sellbot_remote_listings_list` interroga eBay sull'env attivo; per colpire la produzione serve `EBAY_ENV=prod`
- `sellbot_remote_listings_list` usa Inventory API, quindi restituisce le offer inventory-backed e non le listing legacy create fuori da Inventory API
- `sellbot_listing_prepare_for_publish` e' il tool workflow consigliato per agenti: enrich -> intake -> build -> preflight

## Smoke test usato nel repo

`stdio` e' stato verificato con:

1. spawn via `StdioClientTransport`
2. `listTools`
3. `callTool` su `sellbot_auth_status`

`HTTP` e' stato verificato con:

1. avvio server su `127.0.0.1`
2. `GET /healthz`
3. handshake via `StreamableHTTPClientTransport`
4. `listTools`

Nel sandbox dei test il bind locale puo' essere bloccato; per questo il test automatico degrada in modo pulito, mentre lo smoke test reale va eseguito fuori sandbox.
