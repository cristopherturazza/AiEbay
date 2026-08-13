# Regole di compilazione inserzioni (EBAY_IT)

Regole vincolanti per titoli, item specifics e categorie su marketplace `EBAY_IT`.
Derivano da un'analisi fatta il 2026-08-13 su 17 inserzioni reali, di cui 9 su 10
attive avevano **zero visualizzazioni**.

## Il problema che queste regole risolvono

Zero visualizzazioni non e' un problema di prezzo: e' un problema di visibilita'.
Un'inserzione che nessuno vede non si vende neanche a meta' prezzo, quindi
abbassare i prezzi prima di aver sistemato titolo e specifics e' sprecato.

Le due cause misurate:

1. **Titoli troppo corti.** eBay concede 80 caratteri e il titolo e' il campo che
   pesa di piu' nella ricerca. Le inserzioni ferme usavano 8-44 caratteri
   (`Zia Mame` ne usava 8). Le uniche due con titolo pieno (75 e 80 caratteri)
   erano il bundle venduto e la strategia nuova.
2. **Item specifics con nomi in inglese.** `Author`, `Book Title`, `Publisher`,
   `Language`, `Format`, `Topic` **non esistono** come aspect su `EBAY_IT`:
   venivano accettati come aspect liberi e non alimentavano nessun filtro di
   ricerca. I nomi veri sono italiani.

## Titolo

- **Massimo 80 caratteri**, e vanno usati quasi tutti. Sotto i 60 stai sprecando
  il tuo principale strumento di posizionamento.
- Formula: `<Titolo> - <Autore> - <Editore> - <qualificatore> - Libro usato`
  Il qualificatore e' opzionale (`Saga Poldark 1`, `Romanzo young adult`).
- L'ordine conta: il titolo del libro e l'autore vanno per primi, perche' sono
  quello che la gente digita davvero.
- **Accenti corretti**: `Così`, non `Cosi'`. `è`, non `e'`. `sé`, non `se'`.
  L'apostrofo spezza la parola in due token e fa sembrare l'inserzione
  trascurata.
- Niente maiuscolo urlato, niente `!!!`, niente parole tipo `OFFERTA`: eBay
  penalizza il keyword stuffing e non aggiungono ricerche.

## Item specifics: usare i nomi italiani

Gli aspect sono localizzati per marketplace. Su `EBAY_IT` usare **sempre**:

| Sbagliato (inglese) | Corretto (`EBAY_IT`) |
|---|---|
| `Author` | `Autore` |
| `Book Title` | `Titolo` |
| `Publisher` | `Editore` |
| `Language` | `Lingua` |
| `Format` | `Formato` |
| `Topic` | `Genere` (narrativa) o `Materia` (saggistica) |

`ISBN` non e' un aspect di categoria: resta come aspect libero, utile perche' il
testo degli item specifics viene comunque indicizzato.

Per scoprire gli aspect di una categoria (nomi, obbligatorieta' e valori ammessi)
serve un **application token**, non il token utente: il token utente ha solo gli
scope `sell.*` e la Taxonomy API risponde `403`.

```js
const token = (await createAppOAuthClient(config).createApplicationToken()).access_token;
const treeId = await taxonomy.getDefaultCategoryTreeId(token, config.ebayMarketplaceId);
const aspects = await taxonomy.getItemAspectsForCategory(token, treeId, categoryId);
```

### Valori vincolati

Gli aspect `SELECTION_ONLY` accettano solo i valori dell'enum: un valore inventato
viene scartato e perdi il filtro.

- `Genere` (171228): `Azione e avventura`, `Classici`, `Drammatico`, `Fantasy`,
  `Fiabe`, `Horror`, `Letteratura antica`, `Letteratura erotica`,
  `Narrativa femminile`, `Religiosi`, `Science fiction`, `Sentimentale`,
  `Storici`, `Umorismo`, `Western`
- `Tipo` (171228): `Antologico`, `Poesia`, `Romanzo`
- `Materia` (171243): `Affari, economia e industria`, `Ambiente e natura`,
  `Arte e cultura`, `Cibi e bevande`, `Filosofia`, `Ingegneria e tecnologia`,
  `Legge`, `Matematica e scienze`, `Psicologia e self-help`,
  `Puzzle e giochi da tavolo`, `Sport`, `Tempo libero, hobby e lifestyle`,
  `Trasporti`, `Viaggio`
- `Fascia d'età`: `Adulta`, `Giovane`

`Formato` e' `FREE_TEXT` ma conviene usare un valore della lista per finire nei
filtri: **`Brossura` non e' un valore di eBay**, il corrispondente e'
`Rilegatura flessibile` (il tascabile vero e' `Tascabile`).

### Un solo valore per aspect

`Autore` (e in generale gli aspect con cardinalita' singola) accetta **un valore
solo**: passarne piu' di uno fa fallire il publish con errore 25002 ("Autore deve
contenere un solo valore"). Per i lotti multi-autore usare `Autori vari` e
`Editori vari`, mettendo i nomi veri nel titolo e nella descrizione, che sono
comunque indicizzati.

Attenzione: `sellbot_listing_patch_draft` accetta array e li persiste joinati con
` | `, splittandoli in `aspects[]` alla build. E' corretto per gli aspect
multi-valore (es. `Lingua`), ma su quelli a cardinalita' singola produce un
payload che eBay rifiuta.

**Non inventare valori che non conosci.** Meglio un aspect assente che un
`Anno di pubblicazione` sbagliato: l'anno non e' recuperabile da eBay per le
inserzioni reimportate, quindi va lasciato vuoto finche' non lo si ha dal libro
fisico.

## Categorie

| Categoria | Uso | Aspect disponibili |
|---|---|---|
| `171228` | Narrativa, romanzi | 24 |
| `171243` | Saggistica, self-help, business | 22 |
| `268` | **Non usare** | 11, senza `Titolo`, `Genere`, `Lingua`, `Formato` |

La `268` e' una categoria generica: ci era finita una inserzione, tagliata fuori
da tutte le ricerche filtrate di sezione. Corretta a `171243`.

La categoria del `draft.json` e' la fonte di verita': `revise` la invia a eBay
sovrascrivendo quella dell'offer remota, quindi una categoria sbagliata si
corregge modificando il draft e rilanciando `sellbot revise`.

## Decisioni di progetto

- **Niente Promoted Listings.** Il margine sui libri usati e' gia' sottile: a €4
  con €3,90 di spedizione la spedizione e' meta' dell'incasso. Deciso il
  2026-08-13, da non riproporre senza un cambio di condizioni.
- **I bundle funzionano, i singoli economici no.** L'unica vendita registrata e'
  un bundle (3 romanzi Sally Rooney a €16, mentre gli stessi singoli a €7-8
  erano rimasti invenduti). Il bundle alza il valore dell'ordine sopra la soglia
  della spedizione e riduce la concorrenza: un cofanetto ha molti meno
  concorrenti di una copia singola di un romanzo diffuso.
