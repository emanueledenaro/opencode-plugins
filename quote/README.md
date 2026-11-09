# quote

Plugin per OpenCode 2: selezioni del testo nel TUI, premi un tasto, il testo diventa una citazione sopra il campo di scrittura. Scrivi il commento e invii: il messaggio parte con la citazione come allegato separato, chiamato "Citazione" (text/plain).

## Come si usa

1. Seleziona del testo con il mouse. La copia automatica di OpenCode resta com'è.
2. Compare un avviso per 5 secondi: `ctrl+y per commentare`. Se premi `ctrl+y` il testo diventa la citazione. Altrimenti non cambia nulla.
3. Sopra il campo di scrittura vedi una scatola con le prime 80 lettere tra virgolette e, se sono più righe, il numero di righe.
4. Scrivi il commento e premi Invio. Il messaggio arriva con il tuo testo e l'allegato "Citazione". Poi la citazione sparisce.

Una sola citazione per sessione: un nuovo `ctrl+y` la sostituisce.

## Tasti e comandi

| Cosa | Tasto | Comando |
| --- | --- | --- |
| Citare la selezione | `ctrl+y` | `/citazione` |
| Togliere la citazione | `alt+y`, oppure clic sulla scatola | `/togli-citazione` |
| Inviare solo la citazione, senza testo | `alt+s` | `/invia-citazione` |

Il campo di scrittura non invia un messaggio vuoto, per questo l'invio della sola citazione ha un tasto suo. Tutti e tre sono anche nella palette (`ctrl+p`).

`ctrl+y` e `alt+y` non sono usati da nessun comando di OpenCode 2.2. `alt` richiede che il terminale mandi Option come Meta; se non lo fa, usa il clic o il comando.

## Come passa la citazione

La parte TUI e la parte server possono girare in processi diversi, quindi si parlano con un file per sessione:

`~/.local/state/opencode/quote-pending/<sessionID>.json` (oppure `$XDG_STATE_HOME/opencode/quote-pending/`): cartella 0700, file 0600, scritto in modo atomico, link simbolici rifiutati.

- Il TUI lo scrive quando premi `ctrl+y` e lo cancella quando togli la citazione.
- Il server ha un hook sul prompt: legge solo il file della sessione del messaggio, aggiunge l'allegato e cancella il file (si usa una volta sola).
- I file più vecchi di 1 ora vengono ignorati e cancellati.
- La citazione è tagliata a 20 000 caratteri, con la nota `[citazione troncata]`.
- L'ID di sessione deve essere `ses_` più lettere e numeri, altrimenti il file non viene toccato.
- Niente rete, niente log del testo citato, nessun altro file letto o scritto.

Se qualcosa va storto, l'hook salta l'allegato e lascia il messaggio com'è: non blocca mai l'invio. Se l'invio fallisce dopo che il file è stato letto, la citazione si perde: premi di nuovo `ctrl+y`.

## Spegnerlo

- Subito: avvia OpenCode con `QUOTE_DISABLED=1`. Il plugin non fa nulla.
- Del tutto: togli la cartella `quote` dalla lista `plugin` di `opencode.json`.

## File

- `quote-core.ts` logica pura: anteprima, limite di dimensione, nome del file, scadenza, logica dell'hook.
- `quote-io.ts` unico file che tocca il disco (cartella `quote-pending`).
- `index.ts` parte server (l'hook).
- `tui.tsx` parte TUI (avviso, tasti, scatola).
- `quote-core.test.ts` test: `bun test`.
