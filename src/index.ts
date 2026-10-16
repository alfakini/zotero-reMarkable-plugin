/** Bundle entry point, loaded by addon/bootstrap.js. */
import { config } from "../package.json";
import { plugin } from "./plugin";

(Zotero as any)[config.addonInstance] ??= plugin;
