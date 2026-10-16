/*
 * Firefox/Zotero bootstrap entry points for reMarkable Sync for Zotero.
 * The build fills in the double-underscore placeholders from package.json.
 * Empty entry points are still part of the bootstrap API.
 */

let chromeRegistration;

function install() {}

async function startup({ rootURI }) {
  const addonManager = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  // Makes chrome://__addonRef__/content/ point at the add-on's content/ folder.
  chromeRegistration = addonManager.registerChrome(
    Services.io.newURI(`${rootURI}manifest.json`),
    [["content", "__addonRef__", `${rootURI}content/`]],
  );
  // The bundle registers the plugin as Zotero.__addonInstance__.
  Services.scriptloader.loadSubScript(
    `${rootURI}content/scripts/__addonRef__.js`,
    {},
  );
  await Zotero.__addonInstance__.startup(rootURI);
}

function onMainWindowLoad({ window }) {
  Zotero.__addonInstance__?.onMainWindowLoad(window);
}

function onMainWindowUnload() {}

function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) return;
  Zotero.__addonInstance__?.shutdown();
  chromeRegistration?.destruct();
  chromeRegistration = undefined;
}

function uninstall() {}
