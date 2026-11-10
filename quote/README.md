# quote

Plugin per OpenCode 2: selezioni del testo nel TUI, premi un tasto, scrivi un commento su quel pezzo e il testo diventa una citazione sopra il campo di scrittura. Puoi aggiungerne fino a 5, ognuna col suo commento. Poi scrivi il prompt e invii: il messaggio parte con ogni citazione come allegato separato (text/plain), chiamato "Citazione 1", "Citazione 2" e così via, nell'ordine in cui le hai aggiunte. Con una sola citazione l'allegato si chiama "Citazione".

## Come si usa

1. Seleziona del testo con il mouse. La copia automatica di OpenCode resta com'è.
2. Compare un avviso per 5 secondi: `ctrl+y per commentare` (in Ghostty `Cmd+Y`). Se premi il tasto si apre una finestra "Il tuo commento su questo pezzo", con l'anteprima della citazione e una riga di testo.
3. In quella finestra:
   - Invio salva la citazione col commento.
   - Invio con la riga vuota salva la citazione senza commento.
   - Esc annulla e non salva niente.
4. Sopra il campo di scrittura vedi una scatola con una riga per citazione, numerata: `1  «anteprima…»  commento`. La scatola segue la larghezza del campo di scrittura, anche quando la finestra cambia misura: se la riga non sta tutta, toglie prima il numero di righe, poi accorcia anteprima e commento (con `…`), e se resta poco posto tiene solo l'anteprima. Anche la riga dei tasti si accorcia, fino a lasciare solo il tasto per inviare. Senza commento la riga dice `senza commento`, in colore tenue. Se la citazione ha più righe compare anche il loro numero.
5. Ripeti per altre citazioni. Alla sesta compare l'avviso "Massimo 5 citazioni".
6. Scrivi il prompt e premi Invio. Il messaggio arriva con il tuo testo e gli allegati. Poi le citazioni spariscono.

Il commento è su una riga sola e al massimo di 2 000 caratteri.

## Che cosa vede il modello

Ogni allegato con commento contiene:

```
Commento:
<il tuo commento>

Testo citato:
<la citazione>
```

Il commento viene prima: è su una riga sola, quindi niente dentro la citazione può fingersi un tuo commento.

Senza commento l'allegato contiene solo il testo citato. La descrizione dell'allegato dice che c'è il testo citato e, quando c'è, anche il tuo commento.

## Tasti e comandi

| Cosa | Tasto | Comando |
| --- | --- | --- |
| Citare la selezione e commentarla | `ctrl+y` | `/citazione` |
| Togliere una citazione | clic sulla sua riga | |
| Togliere l'ultima aggiunta | `alt+y` | palette |
| Togliere tutte le citazioni | | `/togli-citazione` o `/togli-citazioni` |
| Inviare solo le citazioni, senza testo | `alt+s` | `/invia-citazione` |

Il campo di scrittura non invia un messaggio vuoto, per questo l'invio delle sole citazioni ha un tasto suo. Tutti i comandi sono anche nella palette (`ctrl+p`).

`ctrl+y` e `alt+y` non sono usati da nessun comando di OpenCode 2.2. `alt` richiede che il terminale mandi Option come Meta; se non lo fa, usa il clic o il comando.

## Come passa la citazione

La parte TUI e la parte server possono girare in processi diversi, quindi si parlano con un file per sessione:

`~/.local/state/opencode/quote-pending/<sessionID>.json` (oppure `$XDG_STATE_HOME/opencode/quote-pending/`): cartella 0700, file 0600, scritto in modo atomico, link simbolici rifiutati.

- Il TUI lo scrive quando salvi il commento e lo cancella quando togli l'ultima citazione rimasta.
- Il file tiene la lista delle citazioni, ognuna con testo e commento (versione 3). I file vecchi si leggono ancora: la versione 2 (lista di testi) e la versione 1 (un solo testo) diventano citazioni senza commento.
- Il server ha un hook sul prompt: legge solo il file della sessione del messaggio, aggiunge gli allegati e cancella il file (si usa una volta sola).
- La scadenza è 1 ora dall'ultima aggiunta: i file più vecchi vengono ignorati e cancellati.
- Il limite di 20 000 caratteri vale per tutte le citazioni e tutti i commenti insieme. Quando si supera, si taglia il testo citato (con la nota `[citazione troncata]`) e il commento resta intero, perché sono parole tue. Le citazioni dopo il punto di taglio restano al loro posto con la sola nota.
- Se il limite è già pieno, la finestra del commento non si apre: compare l'avviso "Limite di 20 000 caratteri raggiunto". Stesso controllo per il massimo di 5 citazioni.
- L'ID di sessione deve essere `ses_` più lettere e numeri, altrimenti il file non viene toccato.
- Niente rete, niente log del testo citato né dei commenti, nessun altro file letto o scritto.

Se qualcosa va storto, l'hook salta gli allegati e lascia il messaggio com'è: non blocca mai l'invio. Se l'invio fallisce dopo che il file è stato letto, le citazioni si perdono: selezionale e commentale di nuovo.

## Spegnerlo

- Subito: avvia OpenCode con `QUOTE_DISABLED=1`. Il plugin non fa nulla.
- Del tutto: togli la cartella `quote` dalla lista `plugin` di `opencode.json`.

## File

- `quote-core.ts` logica pura: anteprime, limite di dimensione condiviso, formato dell'allegato, nome del file, scadenza, logica dell'hook.
- `quote-io.ts` unico file che tocca il disco (cartella `quote-pending`).
- `index.ts` parte server (l'hook).
- `tui.tsx` parte TUI (avviso, finestra del commento, tasti, scatola).
- `quote-core.test.ts` test: `bun test`.
