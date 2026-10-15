import { RemarkableService } from "./modules/service";
import { onPrefsLoad } from "./modules/preferences";
import { registerMenus, registerPrefsPane } from "./modules/ui";
import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  initLocale();
  addon.data.service = new RemarkableService();
  await addon.data.service.state.load();
  registerPrefsPane();
  registerMenus();
  addon.data.service.scheduleAutoSync();
  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  addon.data.service?.shutdown();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  if (type === "load") onPrefsLoad(data.window);
}

type Command = "sync" | "syncAll" | "reimport" | "removeImported" | "remove";

async function onCommand(cmd: Command, items: Zotero.Item[]) {
  const service = addon.data.service!;
  try {
    if (!service.connected) {
      service.notify(getString("error-not-connected"), "fail");
      Zotero.Utilities.Internal.openPreferences(
        `${addon.data.config.addonRef}-prefs`,
      );
      return;
    }
    switch (cmd) {
      case "sync":
        return await service.syncSelected(items);
      case "syncAll":
        return await service.syncAll();
      case "reimport":
        return await service.removeImported(items, true);
      case "removeImported":
        return await service.removeImported(items, false);
      case "remove":
        return await service.removeFromTablet(items);
    }
  } catch (e) {
    Zotero.logError(e as Error);
    service.notify((e as Error).message, "fail");
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
  onCommand,
};
