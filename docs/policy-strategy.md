# Policy Strategy (Pratica)

Strategia consigliata per usare `sellbot` in produzione senza bloccare il flusso operativo.

## Obiettivo

- `payment` e `return` quasi fisse
- `shipping` variabile per tipo oggetto/costo
- scelta spedizione per listing tramite `draft.shipping_profile`

## 1) Payment Policy

Impostazione pratica:

- una sola payment policy per marketplace
- pagamenti elettronici gestiti da eBay

In `sellbot.config*.json`:

- `policies.paymentPolicyId`: ID fisso

## 2) Return Policy

Se vuoi "reso solo in casi gravi":

- usa una return policy restrittiva (no resi volontari)
- tieni `returnShippingCostPayer=BUYER` solo dove consentito dalla policy configurata

Nota operativa:

- i casi "item not as described" e gli obblighi normativi possono prevalere sulla policy scelta.

In `sellbot.config*.json`:

- `policies.returnPolicyId`: ID fisso

## 3) Fulfillment / Shipping Policy

Qui conviene usare profili multipli.

Esempio:

- `book`: libro standard, costo basso/tracciabile
- `book_heavy`: libro spesso/pesante fuori soglia standard
- `small`: oggetti piccoli non fragili
- `fragile`: corriere/imballo protetto
- fallback `default`

In `sellbot.config*.json`:

```json
{
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
    "fulfillmentPolicyId": "DEFAULT_POLICY_ID",
    "fulfillmentPolicyIdByProfile": {
      "book": "BOOK_POLICY_ID",
      "book_heavy": "BOOK_HEAVY_POLICY_ID",
      "small": "SMALL_POLICY_ID",
      "fragile": "FRAGILE_POLICY_ID"
    }
  }
}
```

Regola di risoluzione in `sellbot`:

1. se `draft.shipping_profile` ha mapping, usa quello
2. altrimenti usa `policies.fulfillmentPolicyId` (fallback)

Per recuperare i servizi disponibili prima di creare o aggiornare una fulfillment policy:

```bash
node dist/index.js shipping:services --carrier POST_ITALIANO --domestic
node dist/index.js shipping:services --json --carrier POST_ITALIANO --domestic
```

Nota architetturale:

- la listing non sceglie direttamente il servizio di spedizione
- la listing sceglie una fulfillment policy
- quindi, lato MCP, la scelta del servizio dovra' tradursi in scelta o aggiornamento della fulfillment policy
- il listino del corriere non arriva da eBay Metadata API: eBay espone i `shippingServiceCode` validi, ma il costo reale va deciso/configurato da te

Strategia consigliata per i costi:

- `pricingMode=separate_charge`: il prezzo articolo resta separato dalla spedizione; `buyerCharge` e `estimatedCarrierCost` dovrebbero idealmente coincidere
- `pricingMode=included_in_item_price`: il prezzo articolo deve gia' assorbire il costo spedizione; `estimatedCarrierCost` serve per capire il netto reale
- `sellbot publish`, `sellbot revise` e `sellbot publish:preflight` mostrano il totale lato compratore e l'impatto spedizione sul margine quando questi dati sono presenti
- per i libri, `IT_Posta1` ha una soglia pratica di `2.5 cm` di spessore: oltre conviene un profilo dedicato tipo `book_heavy`

## 4) Come usarla nella listing

Nel `draft.json`:

```json
{
  "shipping_profile": "book"
}
```

Per il modulo libri (`enrich --module book`) viene impostato automaticamente `shipping_profile: "book"`.

## 5) Checklist rapida

1. crea policy eBay reali per ogni profilo spedizione che userai
2. salva gli ID in `sellbot.config.prod.json`
3. lancia `node dist/index.js config:test`
4. lancia `node dist/index.js publish:preflight <folder>`
5. pubblica solo se non ci sono `KO`
