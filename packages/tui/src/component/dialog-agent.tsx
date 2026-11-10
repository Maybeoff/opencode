import { createMemo } from "solid-js"
import { useData } from "../context/data"
import { useLocal } from "../context/local"
import { useLocation } from "../context/location"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogTelegram } from "./dialog-telegram"

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()
  const data = useData()
  const location = useLocation()

  const options = createMemo(() =>
    local.agent.list().map((item) => {
      return {
        value: item.id,
        title: item.id,
        description: item.description,
      }
    }),
  )

  return (
    <DialogSelect
      title="Select agent"
      searchInTitle
      titlePlaceholder="Search agents"
      current={local.agent.current()?.id}
      options={options()}
      actions={[
        {
          command: "dialog.agent.telegram",
          title: "telegram",
          selection: "required",
          onTrigger: (option) => {
            dialog.replace(() => (
              <DialogTelegram agent={option.value} location={location.ref ?? data.location.default()} />
            ))
          },
        },
      ]}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}
