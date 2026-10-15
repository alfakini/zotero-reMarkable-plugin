/** Menus (Zotero.MenuManager, Zotero 8+) and the preferences pane. */
import { config } from "../../package.json";
import { getString } from "../utils/locale";

const icon = `chrome://${config.addonRef}/content/icons/favicon.png`;
const l10n = (id: string) => `${config.addonRef}-${id}`;

function hasPdf(items?: Zotero.Item[]) {
  return !!items?.some(
    (i) =>
      i.isPDFAttachment() ||
      (i.isRegularItem() &&
        Zotero.Items.get(i.getAttachments()).some((a) => a.isPDFAttachment())),
  );
}

export function registerMenus() {
  Zotero.MenuManager.registerMenu({
    menuID: `${config.addonRef}-item`,
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "submenu",
        l10nID: l10n("menu-submenu"),
        icon,
        onShowing: (_e, ctx) => ctx.setVisible(hasPdf(ctx.items)),
        menus: [
          {
            menuType: "menuitem",
            l10nID: l10n("menu-sync"),
            onCommand: (_e, ctx) =>
              addon.hooks.onCommand("sync", ctx.items ?? []),
          },
          {
            menuType: "menuitem",
            l10nID: l10n("menu-reimport"),
            onShowing: (_e, ctx) =>
              ctx.setEnabled(
                !!ctx.items?.some((i) => addon.data.service?.isTracked(i)),
              ),
            onCommand: (_e, ctx) =>
              addon.hooks.onCommand("reimport", ctx.items ?? []),
          },
          {
            menuType: "menuitem",
            l10nID: l10n("menu-remove-imported"),
            onShowing: (_e, ctx) =>
              ctx.setEnabled(
                !!ctx.items?.some((i) => addon.data.service?.isTracked(i)),
              ),
            onCommand: (_e, ctx) =>
              addon.hooks.onCommand("removeImported", ctx.items ?? []),
          },
          { menuType: "separator" },
          {
            menuType: "menuitem",
            l10nID: l10n("menu-remove"),
            onShowing: (_e, ctx) =>
              ctx.setEnabled(
                !!ctx.items?.some((i) => addon.data.service?.isTracked(i)),
              ),
            onCommand: (_e, ctx) =>
              addon.hooks.onCommand("remove", ctx.items ?? []),
          },
        ],
      },
    ],
  });

  Zotero.MenuManager.registerMenu({
    menuID: `${config.addonRef}-tools`,
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "menuitem",
        l10nID: l10n("menu-sync-all"),
        icon,
        onCommand: () => addon.hooks.onCommand("syncAll", []),
      },
    ],
  });
}

export function registerPrefsPane() {
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    id: `${config.addonRef}-prefs`,
    src: `${rootURI}content/preferences.xhtml`,
    label: getString("prefs-title"),
    image: icon,
  });
}
