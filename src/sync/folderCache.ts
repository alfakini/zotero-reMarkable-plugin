import { isTopLevelFolder, type FolderMetadata } from "../remarkable/cloud";

/**
 * Pure (Zotero-free) decision for the tablet folder id, unit-testable in
 * Node. Finding a folder by name needs every document's metadata, so the id
 * found last time is cached in the sync state. The root index only proves
 * that the entry exists: a folder trashed, moved, renamed or deleted on the
 * tablet stays in it, so the cached folder's own metadata is checked too.
 */

export interface FolderCache {
  getFolderId(name: string): string | undefined;
  setFolderId(name: string, id: string): void;
}

/** The cached id for `name`, if that document still exists in the root. */
export function cachedFolderId(
  cache: Pick<FolderCache, "getFolderId">,
  name: string,
  rootIds: { has(id: string): boolean },
): string | undefined {
  const id = cache.getFolderId(name);
  return id !== undefined && rootIds.has(id) ? id : undefined;
}

/**
 * The id of the top-level folder `name`: the cached one when it is in the
 * root and its metadata (`readMetadata`, one cheap read) still describes the
 * configured folder, otherwise whatever `ensure` finds or creates (which is
 * cached). An empty name means the tablet's root, which needs no folder.
 */
export async function resolveFolderId(
  cache: FolderCache,
  name: string,
  rootIds: { has(id: string): boolean },
  ensure: (name: string) => Promise<string>,
  readMetadata: (id: string) => Promise<FolderMetadata | undefined>,
): Promise<string> {
  if (!name) return "";
  const cached = cachedFolderId(cache, name, rootIds);
  if (
    cached !== undefined &&
    isTopLevelFolder(await readMetadata(cached), name)
  ) {
    return cached;
  }
  const id = await ensure(name);
  cache.setFolderId(name, id);
  return id;
}
