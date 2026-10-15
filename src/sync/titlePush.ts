/**
 * The title to write to the tablet document, or undefined to leave its name
 * alone. `pushedTitle` is the Zotero title last sent to the tablet.
 *
 * A rename is only pushed when the Zotero title changed since then, so a
 * rename done on the tablet survives PDF rebuilds. Documents synced before
 * `pushedTitle` was recorded have none: the caller records the current title
 * without renaming, rather than overwriting whatever the tablet shows.
 */
export function titleToPush(
  pushedTitle: string | undefined,
  title: string,
): string | undefined {
  return pushedTitle !== undefined && pushedTitle !== title ? title : undefined;
}
