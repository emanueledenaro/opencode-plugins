// TUI part of the quote plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// Select text, press the key, a small dialog asks for a comment on that piece, and the quote with its
// comment is shown above the composer (up to five). The server part (./index.ts) attaches them to the next
// message as "Citazione 1", "Citazione 2", ...
// The two parts talk through one file per session, see ./quote-core.ts and ./README.md.
import { Plugin } from "@opencode/plugin/tui"
import { ErrorBoundary, For, Show, createSignal, onMount } from "solid-js"
import {
  MAX_QUOTES,
  addPending,
  clearPending,
  dialogPreview,
  loadPending,
  normalizeSelection,
  pendingRoom,
  removePending,
  rowSummary,
  sameList,
  selectionFresh,
  type PendingQuote,
  type Selection,
} from "./quote-core.ts"
import { createPendingFs, sweepExpired } from "./quote-io.ts"

const QUOTE_KEY = "ctrl+y"
const REMOVE_KEY = "alt+y"
const SEND_KEY = "alt+s"
// Labels shown to the user. In Ghostty the README config maps Cmd keys to the binds above.
const IN_GHOSTTY = process.env.TERM_PROGRAM === "ghostty"
const QUOTE_LABEL = IN_GHOSTTY ? "Cmd+Y" : QUOTE_KEY
const REMOVE_LABEL = IN_GHOSTTY ? "Cmd+Shift+Y" : REMOVE_KEY
const SEND_LABEL = IN_GHOSTTY ? "Cmd+Shift+S" : SEND_KEY
const TOAST_MS = 5_000
const TOAST_DELAY_MS = 700
const SYNC_MS = 1_000

export default Plugin.define({
  id: "local.quote",
  async setup(context) {
    if (process.env.QUOTE_DISABLED === "1") return

    const theme = context.theme
    const primary = theme.text.action?.primary?.base ?? theme.text.base
    const warning = theme.text.feedback?.warning?.base ?? theme.text.base
    const fs = createPendingFs()
    sweepExpired(fs)

    // sessionID -> quotes in the order added. The file is the truth; this is what the box shows.
    const [quotes, setQuotes] = createSignal<Record<string, PendingQuote[]>>({})
    const setList = (sessionID: string, list: PendingQuote[] | undefined) =>
      setQuotes((current) => {
        const next = list !== undefined && list.length > 0 ? list : undefined
        if (sameList(current[sessionID], next)) return current
        const copy = { ...current }
        if (next === undefined) delete copy[sessionID]
        else copy[sessionID] = next
        return copy
      })
    const refresh = (sessionID: string) => setList(sessionID, loadPending(sessionID, fs, Date.now()))

    // The last finished selection, kept for a few seconds so the key can use it.
    let selection: Selection | undefined
    let toastTimer: ReturnType<typeof setTimeout> | undefined

    const onSelection = (value: unknown) => {
      try {
        const raw = (value as { getSelectedText?: () => unknown } | undefined)?.getSelectedText?.()
        const text = normalizeSelection(raw)
        if (text === null) return
        const mine: Selection = { text, at: Date.now() }
        selection = mine
        // OpenCode shows its own "copied" toast right now and only one toast fits, so ours comes just after.
        if (toastTimer) clearTimeout(toastTimer)
        toastTimer = setTimeout(() => {
          if (selection !== mine) return
          context.ui.toast.show({ message: `${QUOTE_LABEL} per commentare`, variant: "info", duration: TOAST_MS })
        }, TOAST_DELAY_MS)
      } catch {
        // a selection we cannot read is simply not offered as a quote
      }
    }
    const renderer = context.renderer as unknown as {
      on?: (event: string, listener: (value: unknown) => void) => unknown
      off?: (event: string, listener: (value: unknown) => void) => unknown
    }
    renderer.on?.("selection", onSelection)

    const currentSessionID = (): string | undefined => {
      const route = context.ui.router.current() as { type?: string; sessionID?: string } | undefined
      return route?.type === "session" ? route.sessionID : undefined
    }

    const refuse = (status: string): boolean => {
      if (status === "full") {
        context.ui.toast.show({ message: `Massimo ${MAX_QUOTES} citazioni`, variant: "warning", duration: 3000 })
        return true
      }
      if (status === "limit") {
        context.ui.toast.show({ message: "Limite di 20 000 caratteri raggiunto", variant: "warning", duration: 3000 })
        return true
      }
      if (status !== "ok" && status !== "added") {
        context.ui.toast.show({ message: "Citazione non salvata", variant: "error", duration: 4000 })
        return true
      }
      return false
    }

    // One dialog at a time: the key does nothing while the comment dialog is open. The latch expires
    // after 2 minutes in case OpenCode closes the dialog without settling the promise.
    let askingSince = 0

    const addQuote = async () => {
      if (Date.now() - askingSince < 120_000) return
      const sessionID = currentSessionID()
      if (!sessionID) {
        context.ui.toast.show({ message: "Apri una sessione per citare", variant: "warning", duration: 3000 })
        return
      }
      if (!selectionFresh(selection, Date.now()) || !selection) {
        context.ui.toast.show({ message: "Seleziona prima del testo", variant: "warning", duration: 3000 })
        return
      }
      // Ask first whether there is room, so nobody writes a comment that cannot be saved.
      if (refuse(pendingRoom(sessionID, fs, Date.now()))) return

      const picked = selection
      askingSince = Date.now()
      let comment: string | undefined
      try {
        // Enter on an empty field gives "" (quote without comment); Escape gives undefined (nothing saved).
        comment = await context.ui.dialog.prompt({
          title: "Il tuo commento su questo pezzo",
          description: dialogPreview(picked.text),
          placeholder: "Scrivi il commento e premi Invio",
        })
      } catch {
        context.ui.toast.show({ message: "Commento non disponibile", variant: "error", duration: 4000 })
        return
      } finally {
        askingSince = 0
      }
      if (comment === undefined) return

      const result = addPending(sessionID, picked.text, comment, fs, Date.now())
      if (refuse(result.status) || result.status !== "added") return
      if (selection === picked) selection = undefined
      setList(sessionID, result.quotes)
      const count = result.quotes.length
      context.ui.toast.show({
        message: count === 1 ? "Citazione pronta: scrivi il prompt e invia" : `Citazione ${count} aggiunta`,
        variant: "success",
        duration: 3000,
      })
    }

    // Removing re-reads the file, so the box always shows what the server will attach.
    const removeAt = (sessionID: string | undefined, which: number | "last", expected?: PendingQuote) => {
      if (!sessionID) return
      removePending(sessionID, which, fs, Date.now(), expected)
      refresh(sessionID)
    }

    const removeAll = (sessionID: string | undefined) => {
      if (!sessionID) return
      clearPending(sessionID, fs)
      setList(sessionID, undefined)
    }

    // The composer does not submit an empty message, so quotes alone go through the prompt API. It
    // reaches the same server hook, which attaches the pending quotes.
    const sendQuotesAlone = async () => {
      const sessionID = currentSessionID()
      // Re-read the file: the in-memory copy may be older than its expiry.
      if (!sessionID || loadPending(sessionID, fs, Date.now()) === undefined) {
        if (sessionID) setList(sessionID, undefined)
        context.ui.toast.show({ message: "Nessuna citazione da inviare", variant: "warning", duration: 3000 })
        return
      }
      try {
        await context.client.session.prompt({ sessionID, text: "" })
      } catch {
        context.ui.toast.show({ message: "Invio delle citazioni non riuscito", variant: "error", duration: 4000 })
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "local.quote.add",
          title: "Cita il testo selezionato e commentalo",
          group: "Citazione",
          bind: QUOTE_KEY,
          palette: true,
          slash: { name: "citazione" },
          run: () => void addQuote(),
        },
        {
          id: "local.quote.send",
          title: "Invia solo le citazioni",
          group: "Citazione",
          bind: SEND_KEY,
          palette: true,
          slash: { name: "invia-citazione" },
          run: () => void sendQuotesAlone(),
        },
        {
          id: "local.quote.removeLast",
          title: "Togli l'ultima citazione",
          group: "Citazione",
          bind: REMOVE_KEY,
          palette: true,
          run: () => removeAt(currentSessionID(), "last"),
        },
        {
          id: "local.quote.remove",
          title: "Togli tutte le citazioni",
          group: "Citazione",
          palette: true,
          slash: { name: "togli-citazione", aliases: ["togli-citazioni"] },
          run: () => removeAll(currentSessionID()),
        },
      ],
    }))

    // The server consumes the file when the message is sent; this keeps the box in step with the file.
    const timer = setInterval(() => {
      const current = currentSessionID()
      const known = Object.keys(quotes())
      // Also the current session, so a quote added in another OpenCode window shows here too.
      for (const sessionID of current && !known.includes(current) ? [...known, current] : known) {
        refresh(sessionID)
      }
    }, SYNC_MS)

    const Chip = (props: { sessionID: string }) => {
      onMount(() => refresh(props.sessionID))
      const list = () => quotes()[props.sessionID]
      return (
        <Show when={list()}>
          {(items) => (
            <box flexDirection="column" border={true} borderColor={theme.text.faint} paddingLeft={1} paddingRight={1}>
              <box flexDirection="row">
                <text fg={primary}>{items().length === 1 ? "Citazione" : "Citazioni"}</text>
                <Show when={items().length > 1}>
                  <text fg={theme.text.faint}>{`  ${items().length} di ${MAX_QUOTES}`}</text>
                </Show>
              </box>
              <For each={items()}>
                {(quote, index) => {
                  const row = () => rowSummary(quote)
                  return (
                    <box flexDirection="row" onMouseDown={() => removeAt(props.sessionID, index(), quote)}>
                      <text fg={theme.text.muted}>{`${index() + 1}  ${row().preview}`}</text>
                      <Show when={row().lineLabel !== ""}>
                        <text fg={theme.text.faint}>{`  ${row().lineLabel}`}</text>
                      </Show>
                      <Show
                        when={row().comment !== ""}
                        fallback={<text fg={theme.text.faint}>{"  senza commento"}</text>}
                      >
                        <text fg={theme.text.base}>{`  ${row().comment}`}</text>
                      </Show>
                    </box>
                  )
                }}
              </For>
              <text fg={theme.text.faint}>{`clic su una riga per togliere, ${REMOVE_LABEL} toglie l'ultima, ${SEND_LABEL} invia solo le citazioni`}</text>
            </box>
          )}
        </Show>
      )
    }

    const unregisterSlot = context.ui.slot({
      append: "session.composer.top",
      render: (input: { sessionID: string }) => (
        <ErrorBoundary fallback={<text fg={warning}>{"Citazione: errore di visualizzazione"}</text>}>
          <Chip sessionID={input.sessionID} />
        </ErrorBoundary>
      ),
    })

    return () => {
      clearInterval(timer)
      if (toastTimer) clearTimeout(toastTimer)
      renderer.off?.("selection", onSelection)
      unregisterSlot()
    }
  },
})
