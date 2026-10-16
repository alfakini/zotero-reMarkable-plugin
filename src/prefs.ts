/** Typed access to the plugin's preferences (defaults in addon/prefs.js). */
import { config } from "../package.json";

interface Prefs {
  deviceToken: string;
  deviceId: string;
  folder: string;
  syncTag: string;
  appendNotesPages: boolean;
  importHandwriting: boolean;
  autoSyncMinutes: number;
}

export function getPref<K extends keyof Prefs>(key: K): Prefs[K] {
  return Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) as Prefs[K];
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, value, true);
}
