# First Production Listing Checklist

Checklist operativa per pubblicare la prima inserzione reale in produzione con rischio controllato.

## 1) Prerequisiti

- `.env` con:
  - `EBAY_ENV=prod`
- `.env.prod` con:
  - `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` production
  - `EBAY_RUNAME` production
  - `SELLBOT_CONFIG_FILE=sellbot.config.prod.json`
- `sellbot.config.prod.json` con:
  - `merchantLocationKey` reale
  - `fulfillmentPolicyId` reale (fallback)
  - eventuale `fulfillmentPolicyIdByProfile` (es. `book`, `fragile`)
  - `paymentPolicyId` reale
  - `returnPolicyId` reale
  - eventuale `shippingProfiles.<profilo>` con `carrierCode`, `serviceCode` e strategia costo (`buyerCharge` / `estimatedCarrierCost`)
- cartella listing completa in `ToSell/<slug>/`

## 2) Gating Tecnico

Eseguire in ordine:

```bash
npm run build
node dist/index.js auth
node dist/index.js config:test
```

Passare oltre solo con checklist `OK` completa.

## 3) Gating Dati Listing

Per la cartella canary:

```bash
node dist/index.js intake:check <slug>
node dist/index.js build <slug>
node dist/index.js publish:preflight <slug>
```

Passare oltre solo se:

- `publish:preflight` non ha `KO`
- non ci sono dubbi su prezzo, condizione, categoria, immagini
- se usi `shipping_profile` nel draft, il mapping policy per quel profilo e' presente
- se usi `shippingProfiles.<profilo>`, il costo buyer-facing e il costo vettore stimato sono coerenti con la tua strategia

## 4) Pubblicazione Canary

```bash
node dist/index.js publish <slug>
node dist/index.js open <slug> --print-only
```

Verifiche manuali obbligatorie:

- titolo e descrizione corretti
- immagini corrette e nell'ordine atteso
- prezzo corretto
- condition e item specifics coerenti
- policy spedizione/pagamento/reso applicate

## 5) Verifica Post-Publish

Provare una revisione minima:

```bash
node dist/index.js revise <slug>
```

Obiettivo:

- verificare che il flusso post-publish sia operativo in produzione

## 6) Go/No-Go Batch

Go batch solo se la canary e' confermata su tutti i punti:

- publish riuscito
- open URL valido
- revise riuscita
- pagina eBay coerente

Se uno dei punti fallisce:

- fermare il batch
- correggere processo/config
- ripetere una nuova canary
