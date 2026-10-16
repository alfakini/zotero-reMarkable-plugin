/**
 * The plugin instance: created by src/index.ts when bootstrap.js loads the
 * bundle, and driven by bootstrap.js's lifecycle functions.
 */
import { config } from "../package.json";
import { t } from "./l10n";
import { notify } from "./notify";
import { onPrefsLoad } from "./preferences";
import { RemarkableService } from "./service";
import { registerMenus, registerPrefsPane } from "./ui";

export type Command =
  | "sync"
  | "syncAll"
  | "reimport"
  | "removeImported"
  | "remove";

export class Plugin {
  service!: RemarkableService;
  /** Set once startup has finished. */
  ready = false;

  async startup(rootURI: string) {
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]);
    this.service = new RemarkableService();
    try {
      await this.service.state.load();
    } catch (e) {
      // An unreadable state file must not break startup. The store stays
      // unloaded, so the first sync attempt retries load() and reports it.
      Zotero.logError(e as Error);
    }
    await registerPrefsPane(rootURI);
    registerMenus();
    this.service.scheduleAutoSync();
    for (const win of Zotero.getMainWindows()) this.onMainWindowLoad(win);
    this.ready = true;
  }

  onMainWindowLoad(win: _ZoteroTypes.MainWindow) {
    win.MozXULElement.insertFTLIfNeeded(`${config.addonRef}-mainWindow.ftl`);
  }

  shutdown() {
    this.service?.shutdown();
    // Menus and the preferences pane are removed by Zotero automatically.
    delete (Zotero as any)[config.addonInstance];
  }

  onPrefsLoad(win: Window) {
    onPrefsLoad(win);
  }

  async command(cmd: Command, items: Zotero.Item[]) {
    const service = this.service;
    try {
      if (!service.connected) {
        notify(t("error-not-connected"), true);
        Zotero.Utilities.Internal.openPreferences(`${config.addonRef}-prefs`);
        return;
      }
      if (cmd === "sync") await service.syncSelected(items);
      else if (cmd === "syncAll") await service.syncAll();
      else if (cmd === "reimport") await service.removeImported(items, true);
      else if (cmd === "removeImported")
        await service.removeImported(items, false);
      else if (cmd === "remove") await service.removeFromTablet(items);
    } catch (e) {
      Zotero.logError(e as Error);
      notify((e as Error).message, true);
    }
  }
}

export const plugin = new Plugin();
