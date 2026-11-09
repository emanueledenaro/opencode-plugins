// TUI part of the quote plugin (OpenCode 2 plugin API, docs: /build/plugins/cli).
// Select text, press the key, the text becomes a pending quote shown above the composer. The server
// part (./index.ts) attaches it to the next message as "Citazione". The two parts talk through one
// file per session, see ./quote-core.ts and ./README.md.
import { Plugin } from "@opencode/plugin/tui"
import { ErrorBoundary, Show, createSignal, onMount } from "solid-js"
import {
  QUOTE_NAME,
  chipSummary,
  clearPending,
  loadPending,
  normalizeSelection,
  savePending,
  selectionFresh,
  type Selection,
} from "./quote-core.ts"
import { createPendingFs, sweepExpired } from "./quote-io.ts"

const QUOTE_KEY = "ctrl+y"
const REMOVE_KEY = "alt+y"
const SEND_KEY = "alt+s"
const TOAST_MS = 5_000
const TOAST_DELAY_MS = 700
const SYNC_MS = 1_000

export default Plugin.define({
  id: "local.quote",
  async setup(context) {
    if (process.env.QUOTE_DISABLED === "1") return

    const theme = context.theme
    const fs = createPendingFs()
    sweepExpired(fs)

    // sessionID -> quote text. The file is the truth; this is what the chip shows.
    const [quotes, setQuotes] = createSignal<Record<string, string>>({})
    const setQuote = (sessionID: string, text: string | undefined) =>
      setQuotes((current) => {
        if (current[sessionID] === text) return current
        const next = { ...current }
        if (text === undefined) delete next[sessionID]
        else next[sessionID] = text
        return next
      })

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
          context.ui.toast.show({ message: `${QUOTE_KEY} per commentare`, variant: "info", duration: TOAST_MS })
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

    const addQuote = () => {
      const sessionID = currentSessionID()
      if (!sessionID) {
        context.ui.toast.show({ message: "Apri una sessione per citare", variant: "warning", duration: 3000 })
        return
      }
      if (!selectionFresh(selection, Date.now()) || !selection) {
        context.ui.toast.show({ message: "Seleziona prima del testo", variant: "warning", duration: 3000 })
        return
      }
      if (!savePending(sessionID, selection.text, fs, Date.now())) {
        context.ui.toast.show({ message: "Citazione non salvata", variant: "error", duration: 4000 })
        return
      }
      selection = undefined
      setQuote(sessionID, loadPending(sessionID, fs, Date.now()))
      context.ui.toast.show({ message: "Citazione pronta: scrivi il commento e invia", variant: "success", duration: 3000 })
    }

    const removeQuote = (sessionID: string | undefined) => {
      if (!sessionID) return
      clearPending(sessionID, fs)
      setQuote(sessionID, undefined)
    }

    // The composer does not submit an empty message, so a quote alone goes through the prompt API. It
    // reaches the same server hook, which attaches the pending quote.
    const sendQuoteAlone = async () => {
      const sessionID = currentSessionID()
      // Re-read the file: the in-memory copy may be older than its expiry.
      if (!sessionID || loadPending(sessionID, fs, Date.now()) === undefined) {
        if (sessionID) setQuote(sessionID, undefined)
        context.ui.toast.show({ message: "Nessuna citazione da inviare", variant: "warning", duration: 3000 })
        return
      }
      try {
        await context.client.session.prompt({ sessionID, text: "" })
      } catch {
        context.ui.toast.show({ message: "Invio della citazione non riuscito", variant: "error", duration: 4000 })
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "local.quote.add",
          title: "Cita il testo selezionato",
          group: "Citazione",
          bind: QUOTE_KEY,
          palette: true,
          slash: { name: "citazione" },
          run: () => addQuote(),
        },
        {
          id: "local.quote.send",
          title: "Invia solo la citazione",
          group: "Citazione",
          bind: SEND_KEY,
          palette: true,
          slash: { name: "invia-citazione" },
          run: () => void sendQuoteAlone(),
        },
        {
          id: "local.quote.remove",
          title: "Togli la citazione",
          group: "Citazione",
          bind: REMOVE_KEY,
          palette: true,
          slash: { name: "togli-citazione" },
          run: () => removeQuote(currentSessionID()),
        },
      ],
    }))

    // The server consumes the file when the message is sent; this keeps the chip in step with the file.
    const timer = setInterval(() => {
      const current = currentSessionID()
      const known = Object.keys(quotes())
      // Also the current session, so a quote added in another OpenCode window shows here too.
      for (const sessionID of current && !known.includes(current) ? [...known, current] : known) {
        setQuote(sessionID, loadPending(sessionID, fs, Date.now()))
      }
    }, SYNC_MS)

    const Chip = (props: { sessionID: string }) => {
      onMount(() => {
        const text = loadPending(props.sessionID, fs, Date.now())
        if (text !== undefined) setQuote(props.sessionID, text)
      })
      const text = () => quotes()[props.sessionID]
      return (
        <Show when={text()}>
          {(value) => {
            const summary = () => chipSummary(value())
            return (
              <box
                flexDirection="column"
                border={true}
                borderColor={theme.text.faint}
                paddingLeft={1}
                paddingRight={1}
              >
                <box flexDirection="row">
                  <text fg={theme.text.action?.primary?.base ?? theme.text.base}>{QUOTE_NAME}</text>
                  <Show when={summary().lineLabel !== ""}>
                    <text fg={theme.text.faint}>{`  ${summary().lineLabel}`}</text>
                  </Show>
                </box>
                <text fg={theme.text.muted}>{summary().preview}</text>
                <box onMouseDown={() => removeQuote(props.sessionID)}>
                  <text fg={theme.text.faint}>{`${REMOVE_KEY} o clic qui per togliere, ${SEND_KEY} per inviarla da sola`}</text>
                </box>
              </box>
            )
          }}
        </Show>
      )
    }

    const unregisterSlot = context.ui.slot({
      append: "session.composer.top",
      render: (input: { sessionID: string }) => (
        <ErrorBoundary
          fallback={<text fg={theme.text.feedback.warning.base}>{"Citazione: errore di visualizzazione"}</text>}
        >
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
