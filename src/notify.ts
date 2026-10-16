/** Small wrapper over Zotero's own progress popup. */
import { config } from "../package.json";

export const ICON = `chrome://${config.addonRef}/content/icons/icon96.png`;

export interface ProgressPopup {
  update(text: string, percent?: number): void;
  finish(text: string, failed: boolean, details?: string[]): void;
}

/** A shown progress window with one line, and that line. */
function open(text: string, percent: number) {
  const win = new Zotero.ProgressWindow({ closeOnClick: true });
  win.changeHeadline(config.addonName, ICON);
  const line = new win.ItemProgress(ICON, text);
  line.setProgress(percent);
  win.show();
  return { win, line };
}

export function notify(text: string, failed = false) {
  const { win, line } = open(text, 100);
  if (failed) line.setError();
  win.startCloseTimer(5000);
}

export function progress(text: string): ProgressPopup {
  const { win, line } = open(text, 0);
  return {
    update(text, percent) {
      line.setText(text);
      if (percent !== undefined) line.setProgress(percent);
    },
    finish(text, failed, details = []) {
      line.setText(text);
      line.setProgress(100);
      if (failed) line.setError();
      for (const d of details) new win.ItemProgress(ICON, d).setError();
      // A thrown error has no details and closes sooner than a report that
      // lists per-document errors.
      win.startCloseTimer(failed ? (details.length ? 15000 : 8000) : 5000);
    },
  };
}
