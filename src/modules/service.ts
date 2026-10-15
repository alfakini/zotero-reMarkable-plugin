/** Glue between Zotero UI and the sync engine. */
import { RemarkableCloud, registerDevice } from "../remarkable/cloud";
import { uuid4 } from "../remarkable/hash";
import { SyncEngine, type SyncReport } from "../sync/engine";
import { SyncStateStore } from "../sync/state";
import { pdfAttachments } from "../sync/zotero";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";

export class RemarkableService {
  private engine?: SyncEngine;
  private timerGeneration = 0;
  readonly state = new SyncStateStore(
    PathUtils.join(Zotero.DataDirectory.dir, "remarkable-sync", "state.json"),
  );

  get connected() {
    return !!getPref("deviceToken");
  }

  private getEngine(): SyncEngine {
    if (!this.connected) throw new Error(getString("error-not-connected"));
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
    const token = await registerDevice(
      fetch.bind(globalThis),
      code,
      this.deviceId(),
    );
    setPref("deviceToken", token);
    this.engine = undefined;
    // Validate right away so a bad token surfaces in the preferences.
    await new RemarkableCloud({
      fetch: fetch.bind(globalThis),
      deviceToken: token,
    }).refreshUserToken();
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
      this.notify(getString("error-no-pdf"), "fail");
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
    this.notify(getString("removed-docs", { args: { count: n } }));
  }

  async removeImported(items: Zotero.Item[], reimport: boolean) {
    const n = await this.getEngine().removeImported(
      await pdfAttachments(items),
      reimport,
    );
    if (reimport) await this.syncSelected(items);
    else this.notify(getString("removed-imported", { args: { count: n } }));
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
    const win = silent
      ? undefined
      : new ztoolkit.ProgressWindow(addon.data.config.addonName, {
          closeOnClick: true,
          closeTime: -1,
        })
          .createLine({
            text: getString("sync-start"),
            type: "default",
            progress: 0,
          })
          .show();
    let report: SyncReport;
    try {
      report = await engine.sync(atts, (text, fraction) =>
        win?.changeLine({ text, progress: Math.round((fraction ?? 0) * 100) }),
      );
    } catch (e) {
      Zotero.logError(e as Error);
      win?.changeLine({
        text: (e as Error).message,
        type: "fail",
        progress: 100,
      });
      win?.startCloseTimer(8000);
      return;
    }
    const summary = getString("sync-done", {
      args: {
        uploaded: report.uploaded,
        updated: report.updated,
        imported: report.imported,
        removed: report.removed,
        notes: report.notes,
      },
    });
    if (win) {
      win.changeLine({
        text: summary,
        type: report.errors.length ? "fail" : "success",
        progress: 100,
      });
      for (const err of report.errors)
        win.createLine({ text: err, type: "fail" });
      win.startCloseTimer(report.errors.length ? 15000 : 5000);
    }
  }

  notify(text: string, type: "success" | "fail" | "default" = "success") {
    new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeTime: 5000,
    })
      .createLine({ text, type })
      .show();
  }

  /** (Re)start the periodic background sync from preferences. */
  scheduleAutoSync() {
    // Each schedule gets a generation number; stale timers become no-ops.
    // Zotero.setTimeout is used because plugin sandboxes may lack timers.
    const generation = ++this.timerGeneration;
    const minutes = Number(getPref("autoSyncMinutes")) || 0;
    if (minutes <= 0) return;
    const tick = () => {
      if (generation !== this.timerGeneration || !addon.data.alive) return;
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
