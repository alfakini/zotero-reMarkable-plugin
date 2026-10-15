/** Behaviour of the preferences pane (pairing with the reMarkable cloud). */
import { config } from "../../package.json";
import { CONNECT_URL } from "../remarkable/cloud";
import { getString } from "../utils/locale";

const PREFIX = `zotero-prefpane-${config.addonRef}-`;

/** All copies of an element: the settings window may hold more than one. */
const all = (doc: Document, id: string) =>
  [...doc.querySelectorAll(`[id="${PREFIX}${id}"]`)] as HTMLElement[];

const bound = new WeakSet<Document>();

export function onPrefsLoad(win: Window) {
  addon.data.prefsWindow = win;
  const doc = win.document;
  update(doc);
  if (bound.has(doc)) return;
  bound.add(doc);
  // Delegate from the document: Zotero re-renders pane content after load,
  // so listeners on individual elements can be lost. XUL buttons fire
  // `command` for mouse, keyboard and accessibility activation alike.
  doc.addEventListener("command", (e: Event) => {
    const target = (e.target as Element).closest?.(`[id^="${PREFIX}"]`);
    if (!target) return;
    const id = target.id.slice(PREFIX.length);
    if (id === "open-connect") Zotero.launchURL(CONNECT_URL);
    else if (id === "connect") void connect(doc, target);
    else if (id === "disconnect") {
      addon.data.service!.disconnect();
      update(doc);
    } else if (id === "sync-now") void addon.hooks.onCommand("syncAll", []);
  });
  doc.addEventListener("change", (e) => {
    if ((e.target as Element).id === `${PREFIX}auto-sync`) {
      // The pref binding writes first; reschedule on the next tick.
      void Promise.resolve().then(() => addon.data.service?.scheduleAutoSync());
    }
  });
}

async function connect(doc: Document, button: Element) {
  const input = (button.parentElement?.querySelector(`[id="${PREFIX}code"]`) ??
    all(doc, "code")[0]) as HTMLInputElement | undefined;
  const code = input?.value.trim();
  if (!code) return;
  setStatus(doc, getString("prefs-connecting"));
  try {
    await addon.data.service!.connect(code);
    for (const el of all(doc, "code")) (el as HTMLInputElement).value = "";
    update(doc);
  } catch (e) {
    setStatus(doc, (e as Error).message, true);
  }
}

function setStatus(doc: Document, text: string, error = false) {
  for (const el of all(doc, "status")) {
    el.textContent = text;
    el.style.color = error ? "var(--accent-red, #d00)" : "";
  }
}

function update(doc: Document) {
  const connected = !!addon.data.service?.connected;
  setStatus(
    doc,
    getString(connected ? "prefs-connected" : "prefs-not-connected"),
  );
  for (const el of all(doc, "pairing")) el.hidden = connected;
  for (const el of all(doc, "paired")) el.hidden = !connected;
}
