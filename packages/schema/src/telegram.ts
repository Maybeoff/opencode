export * as Telegram from "./telegram.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { ascending } from "./identifier.js"
import { Model } from "./model.js"
import { AbsolutePath, optional, statics } from "./schema.js"
import { SessionID } from "./session-id.js"

export const BotID = Schema.String.check(Schema.isStartingWith("tgb_")).pipe(
  Schema.brand("Telegram.BotID"),
  Schema.annotate({ identifier: "Telegram.BotID" }),
  statics((schema) => ({ create: () => schema.make("tgb_" + ascending()) })),
)
export type BotID = typeof BotID.Type

export const Status = Schema.Literals(["running", "stopped", "error"]).annotate({
  identifier: "Telegram.Status",
})
export type Status = typeof Status.Type

export interface Chat extends Schema.Schema.Type<typeof Chat> {}
export const Chat = Schema.Struct({
  chatID: Schema.String.annotate({ description: "Telegram chat ID the bot is paired with" }),
  title: optional(Schema.String).annotate({ description: "Telegram chat title or username" }),
  sessionID: SessionID,
  lastActive: Schema.Finite.annotate({ description: "Milliseconds since the Unix epoch" }),
}).annotate({ identifier: "Telegram.Chat" })

export interface Bot extends Schema.Schema.Type<typeof Bot> {}
export const Bot = Schema.Struct({
  id: BotID,
  agent: Agent.ID,
  directory: AbsolutePath.annotate({ description: "Project directory the bot's sessions belong to" }),
  model: optional(Model.Ref).annotate({
    description: "Model the bot's sessions use; when absent, the server default",
  }),
  enabled: Schema.Boolean,
  username: optional(Schema.String).annotate({ description: "Bot username from Telegram" }),
  status: Status,
  error: optional(Schema.String).annotate({ description: "Last polling error, when status is error" }),
  chats: Schema.Array(Chat).annotate({ description: "Telegram chats paired with this bot" }),
  time: Schema.Struct({
    created: Schema.Finite,
    updated: Schema.Finite,
  }),
}).annotate({ identifier: "Telegram.Bot" })

export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  agent: Agent.ID,
  token: Schema.String.annotate({ description: "Bot token from @BotFather" }),
  model: optional(Model.Ref).annotate({
    description: "Model selected in the chat when the bot was bound",
  }),
}).annotate({ identifier: "Telegram.CreateInput" })

export interface SetModelInput extends Schema.Schema.Type<typeof SetModelInput> {}
export const SetModelInput = Schema.Struct({
  model: Model.Ref.annotate({ description: "Model the bot's sessions should use" }),
}).annotate({ identifier: "Telegram.SetModelInput" })
