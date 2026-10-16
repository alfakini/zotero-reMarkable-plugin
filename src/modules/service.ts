/** Glue between Zotero UI and the sync engine. */
import {
  pairDevice,
  RemarkableCloud,
  registerDevice,
} from "../remarkable/cloud";
import { uuid4 } from "../remarkable/hash";
import { SyncEngine, type SyncReport } from "../sync/engine";
import { Mutex } from "../sync/mutex";
import { SyncStateStore } from "../sync/state";
import { pdfAttachments } from "../sync/zotero";
import { t } from "../l10n";
import { notify, progress } from "../notify";
import { getPref, setPref } from "../prefs";

export class RemarkableService {
  private engine?: SyncEngine;
  private timerGeneration = 0;
  /** Shared by every engine so a replaced engine cannot overlap a running one. */
  private readonly lock = new Mutex();
  readonly state = new SyncStateStore(
    PathUtils.join(Zotero.DataDirectory.dir, "remarkable-sync", "state.json"),
  );

  /** True while a sync, tablet removal or re-import cleanup is running or queued. */
  get busy() {
    return this.lock.locked;
  }

  get connected() {
    return !!getPref("deviceToken");
  }

  private getEngine(): SyncEngine {
    if (!this.connected) throw new Error(t("error-not-connected"));
    if (!this.engine) {
      const cloud = new RemarkableCloud({
        fetch: fetch.bind(globalThis),
        deviceToken: getPref("deviceToken"),
        clientId: this.deviceId(),
        log: (m) => Zotero.debug(`[reMarkable] ${m}`),
      });
      this.engine = new SyncEngine(
        cloud,
        this.state,
        () => ({
          folder: getPref("folder") ?? "",
          appendNotesPages: getPref("appendNotesPages"),
          importHandwriting: getPref("importHandwriting"),
        }),
        this.deviceId(),
        this.lock,
      );
    }
    return this.engine;
  }

  private deviceId() {
    let id = getPref("deviceId");
    if (!id) {
      id = uuid4();
      setPref("deviceId", id);
    }
    return id;
  }

  /** Pair with the reMarkable cloud using a one-time code. */
  async connect(code: string) {
    const deviceId = this.deviceId();
    await pairDevice({
      register: () => registerDevice(fetch.bind(globalThis), code, deviceId),
      // Validate before storing so a bad token never reaches the preferences.
      validate: (token) =>
        new RemarkableCloud({
          fetch: fetch.bind(globalThis),
          deviceToken: token,
        }).refreshUserToken(),
      store: (token) => {
        setPref("deviceToken", token);
        this.engine = undefined;
      },
    });
  }

  disconnect() {
    setPref("deviceToken", "");
    this.engine = undefined;
  }

  /** Items tagged with the sync tag. */
  private async taggedItems(): Promise<Zotero.Item[]> {
    const tag = getPref("syncTag");
    if (!tag) return [];
    const out: Zotero.Item[] = [];
    for (const lib of Zotero.Libraries.getAll()) {
      const s = new Zotero.Search({ libraryID: lib.libraryID });
      s.addCondition("tag", "is", tag);
      out.push(...Zotero.Items.get(await s.search()));
    }
    return out;
  }

  async syncSelected(items: Zotero.Item[]) {
    const atts = await pdfAttachments(items);
    if (!atts.length) {
      notify(t("error-no-pdf"), true);
      return;
    }
    await this.run(atts);
  }

  async syncAll(silent = false) {
    const engine = this.getEngine();
    const atts = new Map<number, Zotero.Item>();
    for (const a of await engine.trackedAttachments()) atts.set(a.id, a);
    for (const a of await pdfAttachments(await this.taggedItems()))
      atts.set(a.id, a);
    await this.run([...atts.values()], silent);
  }

  async removeFromTablet(items: Zotero.Item[]) {
    const engine = this.getEngine();
    let n = 0;
    for (const att of await pdfAttachments(items))
      if (await engine.remove(att)) n++;
    notify(t("removed-docs", { count: n }));
  }

  async removeImported(items: Zotero.Item[], reimport: boolean) {
    const n = await this.getEngine().removeImported(
      await pdfAttachments(items),
      reimport,
    );
    if (reimport) await this.syncSelected(items);
    else notify(t("removed-imported", { count: n }));
  }

  isTracked(item: Zotero.Item) {
    const atts = item.isPDFAttachment()
      ? [item]
      : item.isRegularItem()
        ? Zotero.Items.get(item.getAttachments())
        : [];
    return atts.some((a) => this.state.get(a.libraryID, a.key));
  }

  private async run(atts: Zotero.Item[], silent = false) {
    const engine = this.getEngine();
    const popup = silent ? undefined : progress(t("sync-start"));
    let report: SyncReport;
    try {
      report = await engine.sync(atts, (text, fraction) =>
        popup?.update(text, Math.round((fraction ?? 0) * 100)),
      );
    } catch (e) {
      Zotero.logError(e as Error);
      popup?.finish((e as Error).message, true);
      return;
    }
    popup?.finish(
      t("sync-done", {
        uploaded: report.uploaded,
        updated: report.updated,
        imported: report.imported,
        removed: report.removed,
        notes: report.notes,
      }),
      report.errors.length > 0,
      report.errors,
    );
  }

  /** (Re)start the periodic background sync from preferences. */
  scheduleAutoSync() {
    // Each schedule gets a generation number; stale timers become no-ops.
    // Zotero.setTimeout is used because plugin sandboxes may lack timers.
    const generation = ++this.timerGeneration;
    const minutes = Number(getPref("autoSyncMinutes")) || 0;
    if (minutes <= 0) return;
    const tick = () => {
      if (generation !== this.timerGeneration) return;
      const next = () =>
        (Zotero as any).setTimeout(tick, Math.max(5, minutes) * 60_000);
      if (!this.connected) return next();
      this.syncAll(true)
        .catch((e) => Zotero.logError(e))
        .finally(next);
    };
    (Zotero as any).setTimeout(tick, Math.max(5, minutes) * 60_000);
  }

  shutdown() {
    this.timerGeneration++;
  }
}
