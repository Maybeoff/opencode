export * as Telegram from "./telegram.js"

import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { AbsolutePath, optional } from "@opencode/schema/schema"
import { SessionMessage } from "@opencode/schema/session-message"
import { Telegram as TelegramSchema } from "@opencode/schema/telegram"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Cause, Context, Effect, Fiber, FiberMap, Layer, Option, Ref, Schema, Semaphore } from "effect"
import { KV } from "./kv.js"
import { Session } from "./session.js"
import { SessionSchema } from "./session/schema.js"

export class InvalidTokenError extends Schema.TaggedError<InvalidTokenError>()("Telegram.InvalidTokenError", {
  message: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Telegram.NotFoundError", {
  botID: TelegramSchema.BotID,
}) {
  override get message() {
    return `Telegram bot not found: ${this.botID}`
  }
}

class ApiError extends Schema.TaggedError<ApiError>()("Telegram.ApiError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

const BotPrefix = "telegram:bot:"
const OwnerPrefix = "telegram:owner:"
const OffsetPrefix = "telegram:offset:"
const ChatPrefix = (botID: string) => `telegram:chat:${botID}:`
const botKey = (botID: string) => BotPrefix + botID
const ownerKey = (botID: string) => OwnerPrefix + botID
const offsetKey = (botID: string) => OffsetPrefix + botID
const chatKey = (botID: string, chatID: string) => ChatPrefix(botID) + chatID

const MESSAGE_LIMIT = 4000
const TURN_TIMEOUT = "30 minutes"
const POLL_TIMEOUT_SECONDS = 25
const RECONCILE_INTERVAL = "2 seconds"
const RETRY_INTERVAL = "10 seconds"

const StoredBot = Schema.Struct({
  id: TelegramSchema.BotID,
  agent: Agent.ID,
  token: Schema.String,
  directory: AbsolutePath,
  model: optional(Model.Ref),
  enabled: Schema.Boolean,
  username: optional(Schema.String),
  time: Schema.Struct({ created: Schema.Finite, updated: Schema.Finite }),
})
type StoredBot = typeof StoredBot.Type

const StoredChat = Schema.Struct({
  chatID: Schema.String,
  title: optional(Schema.String),
  sessionID: SessionSchema.ID,
  agent: optional(Agent.ID),
  model: optional(Model.Ref),
  lastActive: Schema.Finite,
})
type StoredChat = typeof StoredChat.Type

const Envelope = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
  error_code: Schema.optional(Schema.Number),
})

const TelegramChat = Schema.Struct({
  id: Schema.Finite,
  type: Schema.String,
  title: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
  first_name: Schema.optional(Schema.String),
  last_name: Schema.optional(Schema.String),
})
type TelegramChat = typeof TelegramChat.Type

const TelegramMessage = Schema.Struct({
  message_id: Schema.Finite,
  date: Schema.Finite,
  text: Schema.optional(Schema.String),
  chat: TelegramChat,
  from: Schema.optional(
    Schema.Struct({
      id: Schema.Finite,
      username: Schema.optional(Schema.String),
      first_name: Schema.optional(Schema.String),
    }),
  ),
})
type TelegramMessage = typeof TelegramMessage.Type

const Update = Schema.Struct({
  update_id: Schema.Finite,
  message: Schema.optional(TelegramMessage),
})
type Update = typeof Update.Type

const Me = Schema.Struct({ id: Schema.Finite, username: Schema.optional(Schema.String) })

const help = [
  "Send a message and I'll run it with opencode in the background, then reply here.",
  "",
  "/new — start a new session",
  "/status — show the current session",
  "/stop — stop the current run",
  "/agent <id> — switch the agent for this chat",
  "/model <provider/model> — switch the model for this chat",
  "/help — show this help",
].join("\n")

const text = (value: unknown) => (value instanceof Error ? value.message : String(value))

const causeText = (cause: Cause.Cause<unknown>) => text(Cause.squash(cause))

const chatTitle = (chat: TelegramChat) =>
  chat.title ?? chat.username ?? ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || String(chat.id))

const modelLabel = (model: Model.Ref | undefined) =>
  model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : undefined

const chunks = (value: string) => {
  if (value.length <= MESSAGE_LIMIT) return [value]
  const result: string[] = []
  let rest = value
  while (rest.length > MESSAGE_LIMIT) {
    const cut = rest.lastIndexOf("\n", MESSAGE_LIMIT)
    const index = cut > MESSAGE_LIMIT / 2 ? cut : MESSAGE_LIMIT
    result.push(rest.slice(0, index))
    rest = rest.slice(index).trimStart()
  }
  result.push(rest)
  return result
}

const formatReply = (messages: readonly SessionMessage.Info[], idle: SessionMessage.Info) => {
  const reply = messages
    .filter((message) => message.type === "assistant")
    .flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .join("\n\n")
    .trim()
  if (idle.type !== "idle") return reply || "Done."
  if (idle.outcome === "failed")
    return [reply, `The run failed: ${idle.error?.message ?? "unknown error"}`].filter(Boolean).join("\n\n")
  if (idle.outcome === "interrupted") return reply || "Stopped."
  return reply || "Done."
}

interface Interface {
  readonly list: (directory: AbsolutePath) => Effect.Effect<TelegramSchema.Bot[]>
  readonly create: (
    input: TelegramSchema.CreateInput & { readonly directory: AbsolutePath },
  ) => Effect.Effect<TelegramSchema.Bot, InvalidTokenError>
  readonly remove: (botID: TelegramSchema.BotID) => Effect.Effect<void, NotFoundError>
  readonly setEnabled: (input: {
    readonly botID: TelegramSchema.BotID
    readonly enabled: boolean
  }) => Effect.Effect<TelegramSchema.Bot, NotFoundError>
  readonly setModel: (input: {
    readonly botID: TelegramSchema.BotID
    readonly model: Model.Ref
  }) => Effect.Effect<TelegramSchema.Bot, NotFoundError>
  /** Long-polls every enabled bot until interrupted. */
  readonly run: Effect.Effect<never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Telegram") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const sessions = yield* Session.Service
    const statuses = yield* Ref.make(new Map<string, { status: TelegramSchema.Status; error?: string }>())
    const locks = new Map<string, Semaphore.Semaphore>()

    const statusOf = (botID: string) =>
      Ref.get(statuses).pipe(Effect.map((current) => current.get(botID) ?? { status: "stopped" as const }))

    const setStatus = (botID: string, status: { status: TelegramSchema.Status; error?: string }) =>
      Ref.update(statuses, (current) => new Map(current).set(botID, status))

    const readBot = (botID: string) =>
      kv.get(botKey(botID)).pipe(
        Effect.map((value) => Option.getOrUndefined(Schema.decodeUnknownOption(StoredBot)(value))),
      )

    const readBots = () =>
      Effect.gen(function* () {
        const page = yield* kv.scan({ prefix: BotPrefix, limit: 1000 })
        return page.entries.flatMap((entry) => {
          const decoded = Schema.decodeUnknownOption(StoredBot)(entry.value)
          return Option.isSome(decoded) ? [decoded.value] : []
        })
      })

    const readChat = (botID: string, chatID: string) =>
      kv.get(chatKey(botID, chatID)).pipe(
        Effect.map((value) => Option.getOrUndefined(Schema.decodeUnknownOption(StoredChat)(value))),
      )

    const readChats = (botID: string) =>
      Effect.gen(function* () {
        const page = yield* kv.scan({ prefix: ChatPrefix(botID), limit: 1000 })
        return page.entries.flatMap((entry) => {
          const decoded = Schema.decodeUnknownOption(StoredChat)(entry.value)
          return Option.isSome(decoded)
            ? [
                TelegramSchema.Chat.make({
                  chatID: decoded.value.chatID,
                  title: decoded.value.title,
                  sessionID: SessionSchema.ID.make(decoded.value.sessionID),
                  lastActive: decoded.value.lastActive,
                }),
              ]
            : []
        })
      })

    const removePrefix = (prefix: string) =>
      Effect.gen(function* () {
        while (true) {
          const page = yield* kv.scan({ prefix, limit: 200 })
          if (page.entries.length === 0) return
          yield* Effect.forEach(page.entries, (entry) => kv.remove(entry.key), { discard: true })
        }
      })

    const publicInfo = (bot: StoredBot) =>
      Effect.gen(function* () {
        const status = yield* statusOf(bot.id)
        const chats = yield* readChats(bot.id)
        return TelegramSchema.Bot.make({
          id: bot.id,
          agent: bot.agent,
          directory: bot.directory,
          model: bot.model,
          enabled: bot.enabled,
          username: bot.username,
          status: status.status,
          error: status.error,
          chats,
          time: bot.time,
        })
      })

    const call = (token: string, method: string, body?: Record<string, unknown>) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(`https://api.telegram.org/bot${token}/${method}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body ?? {}),
              signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
            }),
          catch: (cause) => new ApiError({ message: text(cause) }),
        })
        const json = yield* Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: (cause) => new ApiError({ message: text(cause) }),
        })
        const envelope = yield* Schema.decodeUnknownEffect(Envelope)(json).pipe(
          Effect.mapError(() => new ApiError({ message: "Telegram returned an invalid response" })),
        )
        if (!envelope.ok)
          return yield* new ApiError({
            message: envelope.description ?? "Telegram request failed",
            status: envelope.error_code,
          })
        return envelope.result
      })

    const getMe = (token: string) =>
      call(token, "getMe").pipe(Effect.flatMap((result) => Schema.decodeUnknownEffect(Me)(result)))

    const getUpdates = (token: string, offset: number) =>
      call(token, "getUpdates", {
        offset,
        timeout: POLL_TIMEOUT_SECONDS,
        allowed_updates: ["message"],
      }).pipe(Effect.flatMap((result) => Schema.decodeUnknownEffect(Schema.Array(Update))(result)))

    const sendMessage = (token: string, chatID: string, value: string) =>
      Effect.forEach(
        chunks(value),
        (chunk) =>
          call(token, "sendMessage", {
            chat_id: chatID,
            text: chunk,
            link_preview_options: { is_disabled: true },
          }),
        { discard: true },
      )

    const sendTyping = (token: string, chatID: string) =>
      call(token, "sendChatAction", { chat_id: chatID, action: "typing" }).pipe(Effect.ignore)

    const typingLoop = (token: string, chatID: string) =>
      Effect.gen(function* () {
        while (true) {
          yield* sendTyping(token, chatID)
          yield* Effect.sleep("4 seconds")
        }
      })

    const reply = (token: string, chatID: string, value: string) =>
      sendMessage(token, chatID, value).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("telegram reply failed", { chatID, error: causeText(cause) }),
        ),
      )

    const lockFor = (key: string) => {
      const current = locks.get(key)
      if (current) return current
      const lock = Semaphore.makeUnsafe(1)
      locks.set(key, lock)
      return lock
    }

    const ensureChat = Effect.fnUntraced(function* (bot: StoredBot, message: TelegramMessage) {
      const chatID = String(message.chat.id)
      const existing = yield* readChat(bot.id, chatID)
      if (existing) {
        const session = yield* sessions.get(SessionSchema.ID.make(existing.sessionID)).pipe(Effect.option)
        if (Option.isSome(session)) return existing
      }
      const session = yield* sessions.create({
        location: { directory: bot.directory },
        agent: existing?.agent ?? bot.agent,
        model: existing?.model ?? bot.model,
        title: chatTitle(message.chat),
      })
      const chat: StoredChat = {
        chatID,
        title: chatTitle(message.chat),
        sessionID: session.id,
        agent: existing?.agent ?? bot.agent,
        model: existing?.model ?? bot.model,
        lastActive: Date.now(),
      }
      yield* kv.set(chatKey(bot.id, chatID), chat)
      return chat
    })

    const waitForTurn = (sessionID: SessionSchema.ID, messageID: SessionMessage.ID) =>
      Effect.gen(function* () {
        while (true) {
          const messages = yield* sessions.messages({ sessionID })
          const index = messages.findIndex((message) => message.id === messageID)
          if (index >= 0) {
            const tail = messages.slice(index + 1)
            const idle = tail.find((message) => message.type === "idle")
            if (idle) return formatReply(tail.slice(0, tail.indexOf(idle) + 1), idle)
          }
          yield* Effect.sleep("750 millis")
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: TURN_TIMEOUT,
          orElse: () => Effect.succeed("Still working on it. Send /status to check progress."),
        }),
      )

    const runPrompt = Effect.fnUntraced(function* (bot: StoredBot, message: TelegramMessage, input: string) {
      const chat = yield* ensureChat(bot, message)
      const messageID = SessionMessage.ID.create()
      yield* sessions.prompt({
        sessionID: chat.sessionID,
        id: messageID,
        text: input,
        delivery: "queue",
        metadata: { telegram: { botID: bot.id, chatID: chat.chatID } },
      })
      const typing = yield* typingLoop(bot.token, chat.chatID).pipe(Effect.forkChild)
      const answer = yield* waitForTurn(chat.sessionID, messageID).pipe(Effect.ensuring(Fiber.interrupt(typing)))
      yield* kv.set(chatKey(bot.id, chat.chatID), { ...chat, lastActive: Date.now() })
      yield* reply(bot.token, chat.chatID, answer)
    })

    const runCommand = Effect.fnUntraced(function* (bot: StoredBot, message: TelegramMessage, input: string) {
      const chatID = String(message.chat.id)
      const [name, argument] = input.split(/\s+/, 2)
      const command = name.toLowerCase().replace(/@.*$/, "")
      const chat = yield* readChat(bot.id, chatID)
      if (command === "/start" || command === "/help") return yield* reply(bot.token, chatID, help)
      if (command === "/new") {
        yield* kv.remove(chatKey(bot.id, chatID))
        return yield* reply(bot.token, chatID, "Started a new session. Send a message to begin.")
      }
      if (command === "/stop") {
        if (!chat) return yield* reply(bot.token, chatID, "There is no session to stop yet.")
        yield* sessions.interrupt(SessionSchema.ID.make(chat.sessionID))
        return yield* reply(bot.token, chatID, "Stopped the current run.")
      }
      if (command === "/status") {
        if (!chat) return yield* reply(bot.token, chatID, "No session yet. Send a message to start one.")
        const sessionID = SessionSchema.ID.make(chat.sessionID)
        const session = yield* sessions.get(sessionID).pipe(Effect.option)
        if (Option.isNone(session))
          return yield* reply(bot.token, chatID, "The session is gone. Send /new to start another one.")
        const active = (yield* sessions.active).has(sessionID)
        return yield* reply(
          bot.token,
          chatID,
          [
            `Session: ${sessionID}`,
            `Agent: ${session.value.agent ?? chat.agent ?? bot.agent}`,
            `Model: ${modelLabel(chat.model ?? bot.model) ?? "server default"}`,
            `Status: ${active ? "working" : "idle"}`,
          ].join("\n"),
        )
      }
      if (command === "/agent") {
        if (!argument) return yield* reply(bot.token, chatID, "Usage: /agent <id>")
        const agent = Agent.ID.make(argument)
        if (chat) {
          yield* sessions.switchAgent({ sessionID: SessionSchema.ID.make(chat.sessionID), agent }).pipe(
            Effect.catchTag("Session.NotFoundError", () => Effect.void),
          )
          yield* kv.set(chatKey(bot.id, chatID), { ...chat, agent, lastActive: Date.now() })
        }
        return yield* reply(bot.token, chatID, `Agent set to ${agent}.`)
      }
      if (command === "/model") {
        const current = chat?.model ?? bot.model
        if (!argument)
          return yield* reply(
            bot.token,
            chatID,
            current
              ? `Model: ${modelLabel(current)}. Use /model <provider/model> to change it.`
              : "Model: server default. Use /model <provider/model> to choose one.",
          )
        const model = yield* Effect.try({
          try: () => Model.Ref.parse(argument),
          catch: () => new Error("invalid model reference"),
        }).pipe(Effect.option)
        if (Option.isNone(model))
          return yield* reply(
            bot.token,
            chatID,
            "Usage: /model <provider/model>, for example opencode/deepseek-v4.1-flash-free",
          )
        if (chat) {
          yield* sessions.switchModel({ sessionID: SessionSchema.ID.make(chat.sessionID), model: model.value }).pipe(
            Effect.catchTag("Session.NotFoundError", () => Effect.void),
          )
          yield* kv.set(chatKey(bot.id, chatID), { ...chat, model: model.value, lastActive: Date.now() })
        }
        yield* kv.set(botKey(bot.id), {
          ...bot,
          model: model.value,
          time: { ...bot.time, updated: Date.now() },
        })
        return yield* reply(bot.token, chatID, `Model set to ${modelLabel(model.value)}.`)
      }
      return yield* reply(bot.token, chatID, `Unknown command: ${command}. Send /help for the list.`)
    })

    const handleUpdate = Effect.fnUntraced(function* (botID: TelegramSchema.BotID, update: Update) {
      const message = update.message
      if (!message) return
      const bot = yield* readBot(botID)
      if (!bot || !bot.enabled) return
      const chatID = String(message.chat.id)
      const owner = yield* kv.get(ownerKey(bot.id))
      if (owner === undefined) {
        yield* kv.set(ownerKey(bot.id), chatID)
        yield* reply(
          bot.token,
          chatID,
          "Paired with this chat. This bot only answers here from now on.\n\n" + help,
        )
        return
      }
      if (owner !== chatID) return yield* reply(bot.token, chatID, "This bot is paired with another chat.")
      const input = message.text?.trim()
      if (!input) return yield* reply(bot.token, chatID, "Only text messages are supported right now.")
      if (input.startsWith("/"))
        return yield* runCommand(bot, message, input).pipe(
          Effect.catchCause((cause) => reply(bot.token, chatID, `Command failed: ${causeText(cause)}`)),
        )
      yield* lockFor(`${bot.id}:${chatID}`).withPermit(
        runPrompt(bot, message, input).pipe(
          Effect.catchCause((cause) => reply(bot.token, chatID, `The run failed: ${causeText(cause)}`)),
        ),
      )
    })

    const poll = (bot: StoredBot) =>
      Effect.gen(function* () {
        yield* setStatus(bot.id, { status: "running" })
        let offset = Number((yield* kv.get(offsetKey(bot.id))) ?? 0)
        while (true) {
          const updates = yield* getUpdates(bot.token, offset).pipe(
            Effect.catchCause((cause) =>
              setStatus(bot.id, { status: "error", error: causeText(cause) }).pipe(
                Effect.andThen(Effect.logWarning("telegram polling failed", { botID: bot.id, error: causeText(cause) })),
                Effect.andThen(Effect.sleep(RETRY_INTERVAL)),
                Effect.as([] as Update[]),
              ),
            ),
          )
          if (updates.length === 0) continue
          offset = Math.max(...updates.map((update) => update.update_id)) + 1
          yield* kv.set(offsetKey(bot.id), offset)
          yield* setStatus(bot.id, { status: "running" })
          yield* Effect.forEach(
            updates,
            (update) =>
              handleUpdate(bot.id, update).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("telegram update failed", { botID: bot.id, error: causeText(cause) }),
                ),
                Effect.forkChild,
              ),
            { discard: true },
          )
        }
      })

    const list = Effect.fn("Telegram.list")(function* (directory: AbsolutePath) {
      const bots = (yield* readBots()).filter((bot) => bot.directory === directory)
      return yield* Effect.forEach(bots, publicInfo)
    })

    const create = Effect.fn("Telegram.create")(function* (
      input: TelegramSchema.CreateInput & { readonly directory: AbsolutePath },
    ) {
      const token = input.token.trim()
      if (!token) return yield* new InvalidTokenError({ message: "Bot token is empty" })
      const existing = (yield* readBots()).find((bot) => bot.token === token)
      if (existing)
        return yield* new InvalidTokenError({
          message: existing.username
            ? `This bot is already bound as @${existing.username}.`
            : "This bot is already bound.",
        })
      const me = yield* getMe(token).pipe(
        Effect.mapError((error) => new InvalidTokenError({ message: error.message })),
      )
      const now = Date.now()
      const bot: StoredBot = {
        id: TelegramSchema.BotID.create(),
        agent: input.agent,
        token,
        directory: input.directory,
        model: input.model,
        enabled: true,
        username: me.username,
        time: { created: now, updated: now },
      }
      yield* kv.set(botKey(bot.id), bot)
      yield* setStatus(bot.id, { status: "stopped" })
      return yield* publicInfo(bot)
    })

    const find = Effect.fnUntraced(function* (botID: TelegramSchema.BotID) {
      const bot = yield* readBot(botID)
      if (!bot) return yield* new NotFoundError({ botID })
      return bot
    })

    const remove = Effect.fn("Telegram.remove")(function* (botID: TelegramSchema.BotID) {
      yield* find(botID)
      yield* kv.remove(botKey(botID))
      yield* kv.remove(ownerKey(botID))
      yield* kv.remove(offsetKey(botID))
      yield* removePrefix(ChatPrefix(botID))
      yield* Ref.update(statuses, (current) => {
        const next = new Map(current)
        next.delete(botID)
        return next
      })
    })

    const setEnabled = Effect.fn("Telegram.setEnabled")(function* (input: {
      readonly botID: TelegramSchema.BotID
      readonly enabled: boolean
    }) {
      const bot = yield* find(input.botID)
      const updated: StoredBot = {
        ...bot,
        enabled: input.enabled,
        time: { ...bot.time, updated: Date.now() },
      }
      yield* kv.set(botKey(bot.id), updated)
      if (!input.enabled) yield* setStatus(bot.id, { status: "stopped" })
      return yield* publicInfo(updated)
    })

    const setModel = Effect.fn("Telegram.setModel")(function* (input: {
      readonly botID: TelegramSchema.BotID
      readonly model: Model.Ref
    }) {
      const bot = yield* find(input.botID)
      const updated: StoredBot = {
        ...bot,
        model: input.model,
        time: { ...bot.time, updated: Date.now() },
      }
      yield* kv.set(botKey(bot.id), updated)
      // Apply the model to paired chats too, so the next message uses it without starting over.
      const chats = yield* readChats(bot.id)
      yield* Effect.forEach(
        chats,
        (chat) =>
          sessions.switchModel({ sessionID: SessionSchema.ID.make(chat.sessionID), model: input.model }).pipe(
            Effect.catchTag("Session.NotFoundError", () => Effect.void),
          ),
        { discard: true },
      )
      return yield* publicInfo(updated)
    })

    const run = Effect.scoped(
      Effect.gen(function* () {
        const running = yield* FiberMap.make<TelegramSchema.BotID>()
        while (true) {
          const bots = yield* readBots()
          const enabled = bots.filter((bot) => bot.enabled)
          const enabledIDs = new Set(enabled.map((bot) => bot.id))
          for (const [id] of Array.from(running)) {
            if (enabledIDs.has(id)) continue
            yield* FiberMap.remove(running, id)
            yield* setStatus(id, { status: "stopped" })
          }
          for (const bot of enabled) {
            if (yield* FiberMap.has(running, bot.id)) continue
            yield* FiberMap.run(running, bot.id, poll(bot), {
              onlyIfMissing: true,
              startImmediately: true,
            })
          }
          yield* Effect.sleep(RECONCILE_INTERVAL)
        }
      }),
    )

    return Service.of({ list, create, remove, setEnabled, setModel, run })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [KV.node, Session.node],
})
