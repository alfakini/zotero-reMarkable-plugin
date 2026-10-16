/** Menus (Zotero.MenuManager, Zotero 8+) and the preferences pane. */
import { config } from "../../package.json";
import { t } from "../l10n";
import { ICON } from "../notify";
import { plugin } from "../plugin";

const icon = ICON;
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
            onCommand: (_e, ctx) => plugin.command("sync", ctx.items ?? []),
          },
          {
            menuType: "menuitem",
            l10nID: l10n("menu-reimport"),
            onShowing: (_e, ctx) =>
              ctx.setEnabled(
                !!ctx.items?.some((i) => plugin.service?.isTracked(i)),
              ),
            onCommand: (_e, ctx) => plugin.command("reimport", ctx.items ?? []),
          },
          {
            menuType: "menuitem",
            l10nID: l10n("menu-remove-imported"),
            onShowing: (_e, ctx) =>
              ctx.setEnabled(
                !!ctx.items?.some((i) => plugin.service?.isTracked(i)),
              ),
            onCommand: (_e, ctx) =>
              plugin.command("removeImported", ctx.items ?? []),
          },
          { menuType: "separator" },
          {
            menuType: "menuitem",
            l10nID: l10n("menu-remove"),
            onShowing: (_e, ctx) =>
              ctx.setEnabled(
                !!ctx.items?.some((i) => plugin.service?.isTracked(i)),
              ),
            onCommand: (_e, ctx) => plugin.command("remove", ctx.items ?? []),
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
        onCommand: () => plugin.command("syncAll", []),
      },
    ],
  });
}

export function registerPrefsPane(rootURI: string) {
  return Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    id: `${config.addonRef}-prefs`,
    src: `${rootURI}content/preferences.xhtml`,
    label: t("prefs-title"),
    image: icon,
  });
}
