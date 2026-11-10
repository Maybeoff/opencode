import type { LocationRef, TelegramBot } from "@opencode/client"
import { createMemo, createSignal, onMount } from "solid-js"
import { useClient } from "../context/client"
import { useLocal } from "../context/local"
import { useTheme } from "../context/theme"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"

type Props = {
  readonly agent: string
  readonly location: LocationRef
}

const modelRef = (model: { providerID: string; modelID: string; variant?: string } | undefined) =>
  model
    ? { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) }
    : undefined

const modelLabel = (model: TelegramBot["model"]) =>
  model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : undefined

const chatSummary = (bot: TelegramBot) => {
  if (bot.chats.length === 0) return "no chats yet"
  if (bot.chats.length === 1) return "1 chat"
  return `${bot.chats.length} chats`
}

export function DialogTelegram(props: Props) {
  const client = useClient()
  const dialog = useDialog()
  const toast = useToast()
  const theme = useTheme().surface("dialog")
  const [bots, setBots] = createSignal<TelegramBot[]>([])
  const [loading, setLoading] = createSignal(true)

  const load = async () => {
    setLoading(true)
    try {
      const result = await client.api.experimental.telegram.list({ location: props.location })
      setBots(result.data.filter((bot) => bot.agent === props.agent))
    } catch (error) {
      toast.error(error)
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void load())

  const open = (bot: TelegramBot) => {
    dialog.replace(() => (
      <TelegramBotMenu
        bot={bot}
        agent={props.agent}
        location={props.location}
        onBack={() => dialog.replace(() => <DialogTelegram agent={props.agent} location={props.location} />)}
      />
    ))
  }

  const add = () => {
    dialog.replace(() => (
      <AddTelegramBot agent={props.agent} location={props.location} />
    ))
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => [
    {
      title: "Add bot",
      value: "add",
      description: "Bind a bot token from @BotFather to this agent",
      category: "Actions",
      onSelect: add,
    },
    ...bots().map((bot) => ({
      title: bot.username ? `@${bot.username}` : bot.id,
      value: bot.id,
      description: `${bot.enabled ? "Listening for messages" : "Disabled"} · ${modelLabel(bot.model) ?? "default model"}`,
      footer: bot.error ? `error: ${bot.error}` : chatSummary(bot),
      footerColor: bot.error ? theme.text.feedback.error.base : undefined,
      category: "Bots",
      onSelect: () => open(bot),
    })),
  ])

  return (
    <DialogSelect
      title={`Telegram · ${props.agent}`}
      options={options()}
      emptyView={
        <box paddingLeft={2} paddingRight={2}>
          <text fg={theme.text.muted}>
            {loading() ? "Loading bots…" : "No bots yet. Add one with a token from @BotFather."}
          </text>
        </box>
      }
      noMatchView={
        <box paddingLeft={2} paddingRight={2}>
          <text fg={theme.text.muted}>No bots found</text>
        </box>
      }
      actions={[
        {
          command: "dialog.telegram.add",
          title: "add",
          selection: "none",
          onTrigger: add,
        },
      ]}
    />
  )
}

function TelegramBotMenu(props: {
  readonly bot: TelegramBot
  readonly agent: string
  readonly location: LocationRef
  readonly onBack: () => void
}) {
  const client = useClient()
  const local = useLocal()
  const toast = useToast()
  const theme = useTheme().surface("dialog")
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const name = () => (props.bot.username ? `@${props.bot.username}` : props.bot.id)
  const currentModel = () => modelRef(local.model.current())

  const toggle = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await client.api.experimental.telegram.enable({
        botID: props.bot.id,
        enabled: !props.bot.enabled,
        location: props.location,
      })
      props.onBack()
    } catch (error) {
      toast.error(error)
      setBusy(false)
    }
  }

  const setModel = async () => {
    const model = currentModel()
    if (!model || busy()) return
    setBusy(true)
    try {
      await client.api.experimental.telegram.model({
        botID: props.bot.id,
        model,
        location: props.location,
      })
      props.onBack()
    } catch (error) {
      toast.error(error)
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!confirming()) {
      setConfirming(true)
      return
    }
    if (busy()) return
    setBusy(true)
    try {
      await client.api.experimental.telegram.remove({ botID: props.bot.id, location: props.location })
      props.onBack()
    } catch (error) {
      toast.error(error)
      setBusy(false)
    }
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => [
    {
      title: "Use current model",
      value: "model",
      description: currentModel()
        ? `Switch to ${modelLabel(currentModel())}`
        : "No model is selected in this chat",
      category: "Actions",
      disabled: !currentModel(),
      onSelect: () => void setModel(),
    },
    {
      title: props.bot.enabled ? "Disable" : "Enable",
      value: "toggle",
      description: props.bot.enabled ? "Stop listening for messages" : "Start listening for messages",
      category: "Actions",
      onSelect: () => void toggle(),
    },
    {
      title: confirming() ? "Press again to remove" : "Remove bot",
      value: "remove",
      description: "Forget the token and chat pairing; sessions stay",
      category: "Actions",
      bg: confirming() ? theme.background.action.destructive.focused : undefined,
      fg: confirming() ? theme.text.action.destructive.focused : undefined,
      onSelect: () => void remove(),
    },
    {
      title: "Back",
      value: "back",
      category: "Navigation",
      onSelect: () => props.onBack(),
    },
    ...(props.bot.chats.length === 0
      ? [
          {
            title: "No chats yet",
            value: "chats-empty",
            description: "Message the bot on Telegram to pair this chat",
            category: "Chats",
            disabled: true,
          },
        ]
      : props.bot.chats.map((chat) => ({
          title: chat.title ?? chat.chatID,
          value: `chat:${chat.chatID}`,
          description: chat.sessionID,
          footer: new Date(chat.lastActive).toLocaleString(),
          category: "Chats",
          disabled: true,
        }))),
  ])

  return (
    <DialogSelect
      title={`${name()} · ${props.agent}`}
      options={options()}
      footer={
        <text fg={theme.text.muted}>
          {props.bot.directory}
          {` · ${modelLabel(props.bot.model) ?? "default model"}`}
          {props.bot.status === "error" ? ` · ${props.bot.error ?? "polling failed"}` : ""}
        </text>
      }
      actions={[
        {
          command: "dialog.telegram.toggle",
          title: props.bot.enabled ? "disable" : "enable",
          selection: "required",
          onTrigger: () => void toggle(),
        },
        {
          command: "dialog.telegram.delete",
          title: confirming() ? "confirm remove" : "remove",
          selection: "required",
          onTrigger: () => void remove(),
        },
      ]}
    />
  )
}

function AddTelegramBot(props: Props) {
  const client = useClient()
  const local = useLocal()
  const dialog = useDialog()
  const toast = useToast()
  const theme = useTheme().surface("dialog")
  const [busy, setBusy] = createSignal(false)
  const currentModel = () => modelRef(local.model.current())

  const submit = async (value: string) => {
    const token = value.trim()
    if (!token || busy()) return
    setBusy(true)
    try {
      const model = currentModel()
      const result = await client.api.experimental.telegram.create({
        agent: props.agent,
        token,
        ...(model ? { model } : {}),
        location: props.location,
      })
      toast.show({
        title: "Telegram bot bound",
        message: `${result.data.username ? `@${result.data.username}` : "The bot"} is listening${
          model ? ` · ${model.providerID}/${model.id}` : ""
        }`,
        variant: "info",
      })
      dialog.replace(() => <DialogTelegram agent={props.agent} location={props.location} />)
    } catch (error) {
      toast.error(error)
      setBusy(false)
    }
  }

  return (
    <DialogPrompt
      title="Telegram bot token"
      placeholder="123456:ABC-DEF…"
      busy={busy()}
      busyText="Checking the token with Telegram…"
      description={() => (
        <text fg={theme.text.muted}>Create a bot with @BotFather, then paste the token it gives you.</text>
      )}
      onConfirm={(value) => void submit(value)}
      onCancel={() => dialog.replace(() => <DialogTelegram agent={props.agent} location={props.location} />)}
    />
  )
}
