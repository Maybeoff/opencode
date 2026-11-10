import { Location } from "@opencode/core/location"
import { Telegram } from "@opencode/core/telegram"
import { InvalidRequestError, TelegramBotNotFoundError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { response } from "../location"

const missing = (error: Telegram.NotFoundError) =>
  new TelegramBotNotFoundError({ botID: error.botID, message: error.message })

export const TelegramHandler = HttpApiBuilder.group(Api, "server.telegram", (handlers) =>
  Effect.gen(function* () {
    const telegram = yield* Telegram.Service
    return handlers
      .handle(
        "telegram.list",
        Effect.fn("server.telegram.list")(function* () {
          const location = yield* Location.Service
          return yield* response(telegram.list(location.directory))
        }),
      )
      .handle(
        "telegram.create",
        Effect.fn("server.telegram.create")(function* (ctx) {
          const location = yield* Location.Service
          return yield* response(
            telegram.create({ ...ctx.payload, directory: location.directory }).pipe(
              Effect.mapError(
                (error) =>
                  new InvalidRequestError({
                    message: error.message,
                    kind: "telegram_token",
                    field: "token",
                  }),
              ),
            ),
          )
        }),
      )
      .handle(
        "telegram.enable",
        Effect.fn("server.telegram.enable")(function* (ctx) {
          return yield* response(
            telegram
              .setEnabled({ botID: ctx.params.botID, enabled: ctx.payload.enabled })
              .pipe(Effect.mapError(missing)),
          )
        }),
      )
      .handle(
        "telegram.model",
        Effect.fn("server.telegram.model")(function* (ctx) {
          return yield* response(
            telegram
              .setModel({ botID: ctx.params.botID, model: ctx.payload.model })
              .pipe(Effect.mapError(missing)),
          )
        }),
      )
      .handle(
        "telegram.remove",
        Effect.fn("server.telegram.remove")(function* (ctx) {
          yield* telegram.remove(ctx.params.botID).pipe(Effect.mapError(missing))
        }),
      )
  }),
)
