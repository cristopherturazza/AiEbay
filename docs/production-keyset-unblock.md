# Production Keyset Unblock

Procedura pratica per sbloccare il keyset `Production` eBay quando il portale mostra:

`Your Keyset is currently disabled`

## Obiettivo

- esporre l'endpoint richiesto da eBay per `Marketplace Account Deletion Notifications`
- completare la compliance minima per poter creare il keyset production

## 1) Configurazione locale

Nel `.env`:

```env
EBAY_ENV=prod
```

e nel `.env.prod`:

```env
SELLBOT_NOTIFICATION_ENDPOINT_URL=https://REPLACE_PUBLIC_HOST/ebay/notifications
SELLBOT_NOTIFICATION_VERIFICATION_TOKEN=REPLACE_WITH_LONG_RANDOM_TOKEN
```

Poi avvia il server locale:

```bash
node dist/index.js notifications:serve --host 127.0.0.1 --port 8080
```

## 2) Esposizione pubblica HTTPS

### Opzione A: Cloudflare Tunnel rapido

Per un test veloce:

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```

Ottieni un host pubblico `https://xxxx.trycloudflare.com`.

Aggiorna quindi:

```env
SELLBOT_NOTIFICATION_ENDPOINT_URL=https://xxxx.trycloudflare.com/ebay/notifications
```

Riavvia `notifications:serve`.

Nota:

- il dominio Quick Tunnel cambia ogni volta
- utile per sblocco rapido, meno per uso stabile

### Opzione B: Tailscale Funnel

Se il server gira in una tailnet e vuoi un endpoint piu' vicino all'assetto finale:

```bash
tailscale funnel 8080
```

Oppure, se vuoi un path dedicato, usa la variante documentata da Tailscale con `--set-path`.

Nota:

- `tailscale` da solo non basta
- serve `funnel`, che rende il servizio pubblico su Internet via HTTPS

## 3) Portale eBay

Nel portale eBay Developers:

1. vai su `Application Keys`
2. apri `Notifications`
3. scegli `Marketplace Account Deletion`
4. imposta:
   - `Endpoint URL`: stesso valore di `SELLBOT_NOTIFICATION_ENDPOINT_URL`
   - `Verification Token`: stesso valore di `SELLBOT_NOTIFICATION_VERIFICATION_TOKEN`
5. salva

eBay chiamera' il tuo endpoint con `GET ?challenge_code=...`.

## 4) Verifica tecnica

Test locale rapido:

```bash
node dist/index.js notifications:serve --host 127.0.0.1 --port 8080
```

Poi apri dal browser:

```text
https://PUBLIC_HOST/ebay/notifications?challenge_code=test123
```

Devi ricevere JSON con:

```json
{
  "challengeResponse": "..."
}
```

## 5) Dopo lo sblocco

Quando il keyset production e' abilitato:

1. crea `Client ID` e `Client Secret` production
2. crea `RuName` production
3. completa `.env` e `sellbot.config.prod.json`
4. esegui `node dist/index.js auth`
5. esegui `node dist/index.js config:test`

## Riferimenti Ufficiali

- eBay keysets: https://developer.ebay.com/api-docs/static/gs_create-the-ebay-api-keysets.html
- eBay marketplace account deletion: https://developer.ebay.com/develop/guides-v2/marketplace-user-account-deletion
- Cloudflare Tunnel docs: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
- Tailscale Funnel docs: https://tailscale.com/kb/1223/funnel
