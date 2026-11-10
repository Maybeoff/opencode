import { Telegram } from "@opencode/schema/telegram"
import { Location } from "@opencode/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { InvalidRequestError, TelegramBotNotFoundError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export const TelegramGroup = HttpApiGroup.make("server.telegram")
  .add(
    HttpApiEndpoint.get("telegram.list", "/api/experimental/telegram/bots", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Telegram.Bot)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.telegram.list",
          summary: "List Telegram bots",
          description:
            "List the Telegram bots bound to the requested location, including their polling status and paired chats.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("telegram.create", "/api/experimental/telegram/bots", {
      query: LocationQuery,
      payload: Telegram.CreateInput,
      success: Location.response(Telegram.Bot),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.telegram.create",
          summary: "Bind a Telegram bot",
          description:
            "Validate a bot token with Telegram and bind the bot to an agent in the requested location. The first chat that messages the bot is paired with it.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("telegram.enable", "/api/experimental/telegram/bots/:botID/enable", {
      params: { botID: Telegram.BotID },
      query: LocationQuery,
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: Location.response(Telegram.Bot),
      error: TelegramBotNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.telegram.enable",
          summary: "Enable or disable a Telegram bot",
          description: "Start or stop polling a bound Telegram bot without removing its token or sessions.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("telegram.model", "/api/experimental/telegram/bots/:botID/model", {
      params: { botID: Telegram.BotID },
      query: LocationQuery,
      payload: Telegram.SetModelInput,
      success: Location.response(Telegram.Bot),
      error: TelegramBotNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.telegram.model",
          summary: "Set a Telegram bot's model",
          description:
            "Choose the model the bot's sessions use. Paired chats switch to it on their next message.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("telegram.remove", "/api/experimental/telegram/bots/:botID", {
      params: { botID: Telegram.BotID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: TelegramBotNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.telegram.remove",
          summary: "Remove a Telegram bot",
          description: "Stop polling a bound Telegram bot and forget its token and chat pairing.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "telegram",
      description: "Experimental Telegram bot routes.",
    }),
  )
