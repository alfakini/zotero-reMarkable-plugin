/** Strings from addon/locale/<lang>/addon.ftl. */
import { config } from "../package.json";

let bundle: Localization | undefined;

/** Translate `id` (without the add-on prefix the build adds to every id). */
export function t(id: string, args?: Record<string, string | number>): string {
  bundle ??= new (
    (globalThis as any).Localization ?? Zotero.getMainWindow().Localization
  )([`${config.addonRef}-addon.ftl`], true);
  const [message] = bundle!.formatMessagesSync([
    { id: `${config.addonRef}-${id}`, args },
  ]);
  return message?.value ?? id;
}
