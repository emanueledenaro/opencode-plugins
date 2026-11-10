# quote

Plugin per OpenCode 2: selezioni del testo nel TUI, premi un tasto, il testo diventa una citazione sopra il campo di scrittura. Puoi aggiungerne fino a 5. Scrivi il commento e invii: il messaggio parte con ogni citazione come allegato separato (text/plain), chiamato "Citazione 1", "Citazione 2" e così via, nell'ordine in cui le hai aggiunte. Con una sola citazione l'allegato si chiama "Citazione".

## Come si usa

1. Seleziona del testo con il mouse. La copia automatica di OpenCode resta com'è.
2. Compare un avviso per 5 secondi: `ctrl+y per commentare`. Se premi `ctrl+y` il testo si aggiunge alle citazioni. Altrimenti non cambia nulla.
3. Sopra il campo di scrittura vedi una scatola con una riga per citazione, numerata: `1  «prime 80 lettere…»`, più il numero di righe quando sono più di una.
4. Ripeti per altre citazioni. Alla sesta compare l'avviso "Massimo 5 citazioni".
5. Scrivi il commento e premi Invio. Il messaggio arriva con il tuo testo e gli allegati. Poi le citazioni spariscono.

## Tasti e comandi

| Cosa | Tasto | Comando |
| --- | --- | --- |
| Aggiungere la selezione come citazione | `ctrl+y` | `/citazione` |
| Togliere una citazione | clic sulla sua riga | |
| Togliere l'ultima aggiunta | `alt+y` | palette |
| Togliere tutte le citazioni | | `/togli-citazione` o `/togli-citazioni` |
| Inviare solo le citazioni, senza testo | `alt+s` | `/invia-citazione` |

Il campo di scrittura non invia un messaggio vuoto, per questo l'invio delle sole citazioni ha un tasto suo. Tutti i comandi sono anche nella palette (`ctrl+p`).

`ctrl+y` e `alt+y` non sono usati da nessun comando di OpenCode 2.2. `alt` richiede che il terminale mandi Option come Meta; se non lo fa, usa il clic o il comando.

## Come passa la citazione

La parte TUI e la parte server possono girare in processi diversi, quindi si parlano con un file per sessione:

`~/.local/state/opencode/quote-pending/<sessionID>.json` (oppure `$XDG_STATE_HOME/opencode/quote-pending/`): cartella 0700, file 0600, scritto in modo atomico, link simbolici rifiutati.

- Il TUI lo scrive quando premi `ctrl+y` e lo cancella quando togli l'ultima citazione rimasta.
- Il file tiene la lista delle citazioni (versione 2). I file vecchi con una sola citazione (versione 1) si leggono come una lista di una.
- Il server ha un hook sul prompt: legge solo il file della sessione del messaggio, aggiunge gli allegati e cancella il file (si usa una volta sola).
- La scadenza è 1 ora dall'ultima aggiunta: i file più vecchi vengono ignorati e cancellati.
- Il limite di 20 000 caratteri vale per tutte le citazioni insieme. Le ultime vengono tagliate, con la nota `[citazione troncata]`.
- L'ID di sessione deve essere `ses_` più lettere e numeri, altrimenti il file non viene toccato.
- Niente rete, niente log del testo citato, nessun altro file letto o scritto.

Se qualcosa va storto, l'hook salta l'allegato e lascia il messaggio com'è: non blocca mai l'invio. Se l'invio fallisce dopo che il file è stato letto, le citazioni si perdono: ripremi `ctrl+y`.

## Spegnerlo

- Subito: avvia OpenCode con `QUOTE_DISABLED=1`. Il plugin non fa nulla.
- Del tutto: togli la cartella `quote` dalla lista `plugin` di `opencode.json`.

## File

- `quote-core.ts` logica pura: anteprima, limite di dimensione condiviso, nome del file, scadenza, logica dell'hook.
- `quote-io.ts` unico file che tocca il disco (cartella `quote-pending`).
- `index.ts` parte server (l'hook).
- `tui.tsx` parte TUI (avviso, tasti, scatola).
- `quote-core.test.ts` test: `bun test`.
