import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ParagraphStyle as S,
  type RmParagraph,
} from "../../src/remarkable/rmscene";
import { plainText } from "../../src/sync/notes";
import { applyPairPlan, decide, planPair } from "../../src/sync/noteSync";
import type { NotePageRecord } from "../../src/sync/state";

const para = (text: string) => ({ style: S.PLAIN, text });
const MERGED = "Edited on reMarkable at the same time";

type Kind = "none" | "toTablet" | "toZotero" | "conflict";
type FailAt = "zotero1" | "zotero2" | "update" | "step2" | "step3" | undefined;

interface Pair {
  /** False while the page exists but no pairing was recorded for it yet. */
  recorded?: boolean;
  rec: NotePageRecord;
  zotero: RmParagraph[];
  tablet: RmParagraph[];
}

/**
 * Replays the sequencing of syncNotes (existing pairs, new tablet pages, new
 * Zotero notes, one tablet write) against in-memory sides, with a failure
 * injected at one step. Only the effects of steps that completed are visible.
 */
function makeWorld(kinds: [Kind, Kind], drawing: boolean) {
  const edit = (k: Kind, i: number): Pair => {
    const orig = `original ${i}`;
    return {
      rec: { noteKey: `N${i}`, base: orig },
      zotero: [
        para(k === "toTablet" || k === "conflict" ? `zotero ${i}` : orig),
      ],
      tablet: [
        para(k === "toZotero" || k === "conflict" ? `tablet ${i}` : orig),
      ],
    };
  };
  const world = {
    pairs: { P1: edit(kinds[0], 1), P2: edit(kinds[1], 2) } as Record<
      string,
      Pair
    >,
    /** A page typed on the tablet that has no note yet. */
    newTabletPage: [para("fresh page")] as RmParagraph[] | undefined,
    /** A "reMarkable Note" made in Zotero that has no page yet. */
    newZoteroNote: [para("fresh note")] as RmParagraph[] | undefined,
    pageNotes: {} as Record<string, RmParagraph[]>, // paired notes created in step 2
    tabletWrites: 0,
    sync(failAt: FailAt) {
      const boom = (at: FailAt) => {
        if (failAt === at) throw new Error(`injected ${at}`);
      };
      const commits: (() => void)[] = [];
      const writes = new Map<string, RmParagraph[]>();
      const newPages = new Map<string, RmParagraph[]>();
      let n = 0;
      const run = async () => {
        for (const [id, p] of Object.entries(world.pairs)) {
          if (p.recorded === false) continue;
          const plan = planPair(p.rec.base, p.zotero, p.tablet);
          if (plan.tabletBody) writes.set(id, plan.tabletBody);
          const needsWrite =
            !!plan.zoteroBody || (drawing && p.rec.drawingHash !== "d1");
          await applyPairPlan(
            p.rec,
            plan,
            needsWrite
              ? async () => {
                  boom(`zotero${++n}` as FailAt);
                  if (plan.zoteroBody) p.zotero = plan.zoteroBody;
                  if (drawing) {
                    p.rec.drawingHash = "d1";
                    p.rec.drawingKey = "K";
                  }
                }
              : undefined,
            commits,
          );
        }
        // 2. new tablet page -> new Zotero note, paired right away
        if (world.newTabletPage) {
          boom("step2");
          world.pageNotes.N3 = world.newTabletPage;
          world.pairs.P3 = {
            rec: { noteKey: "N3", base: plainText(world.newTabletPage) },
            zotero: world.newTabletPage,
            tablet: world.newTabletPage,
          };
          world.newTabletPage = undefined;
        }
        // 3. new Zotero note -> new page, paired after the tablet write
        if (world.newZoteroNote) {
          boom("step3");
          const body = world.newZoteroNote;
          newPages.set("P4", body);
          commits.push(() => {
            world.pairs.P4.recorded = true;
            world.pairs.P4.rec = { noteKey: "N4", base: plainText(body) };
          });
        }
        if (writes.size || newPages.size) {
          boom("update");
          // The tablet write is atomic: all pages or none.
          for (const [id, body] of writes) world.pairs[id].tablet = body;
          for (const [id, body] of newPages)
            world.pairs[id] = {
              recorded: false,
              rec: { noteKey: "N4" },
              zotero: body,
              tablet: body,
            };
          world.tabletWrites++;
          world.newZoteroNote = undefined;
        }
        for (const f of commits.splice(0)) f();
      };
      return run();
    },
  };
  return world;
}

const actionsOf = (w: ReturnType<typeof makeWorld>) =>
  Object.values(w.pairs).map((p) =>
    decide(p.rec.base, plainText(p.zotero), plainText(p.tablet)),
  );

const kinds: Kind[] = ["none", "toTablet", "toZotero", "conflict"];
const failPoints: FailAt[] = ["zotero1", "zotero2", "update", "step2", "step3"];

for (const k1 of kinds) {
  for (const k2 of kinds) {
    for (const drawing of [false, true]) {
      for (const failAt of failPoints) {
        test(`${k1}/${k2} drawing=${drawing}: failure at ${failAt} loses nothing and converges`, async () => {
          const w = makeWorld([k1, k2], drawing);
          const zoteroEdits = Object.values(w.pairs).map((p) =>
            plainText(p.zotero),
          );
          const tabletEdits = Object.values(w.pairs).map((p) =>
            plainText(p.tablet),
          );
          const orig = (i: number) => `original ${i}`;
          let injected = false;
          try {
            await w.sync(failAt);
          } catch {
            injected = true;
          }
          // After a failure, no pair may be set to overwrite an unsynced
          // Zotero edit with the old tablet text.
          if (injected) {
            Object.values(w.pairs).forEach((p, i) => {
              const z = plainText(p.zotero);
              if (p.rec.noteKey === `N${i + 1}` && z !== orig(i + 1)) {
                const t = plainText(p.tablet);
                if (z !== t && !z.includes(MERGED)) {
                  assert.notEqual(
                    decide(p.rec.base, z, t),
                    "toZotero",
                    `pair ${i + 1} would lose "${z}"`,
                  );
                }
              }
            });
          }
          // Retry until settled (a fresh sync without failure).
          await w.sync(undefined);
          const settled = w.tabletWrites;
          await w.sync(undefined);
          assert.equal(
            w.tabletWrites,
            settled,
            "second clean sync writes nothing",
          );
          assert.ok(
            actionsOf(w).every((a) => a === "none"),
            "converges to none",
          );

          Object.values(w.pairs).forEach((p, i) => {
            if (!/^N[12]$/.test(p.rec.noteKey)) return;
            const z = plainText(p.zotero);
            assert.equal(z, plainText(p.tablet));
            // Both sides' edits survive, the merge section appears at most once.
            if (zoteroEdits[i] !== orig(i + 1))
              assert.ok(z.includes(zoteroEdits[i]), `kept zotero edit: ${z}`);
            if (tabletEdits[i] !== orig(i + 1))
              assert.ok(z.includes(tabletEdits[i]), `kept tablet edit: ${z}`);
            assert.ok(z.split(MERGED).length <= 2, `merged once: ${z}`);
          });
          // The new page and new note were each paired exactly once.
          assert.equal(w.pairs.P3?.rec.noteKey, "N3");
          assert.equal(w.pairs.P4?.recorded, true);
          assert.equal(w.pairs.P4?.rec.noteKey, "N4");
          assert.equal(
            Object.values(w.pairs).filter((p) => p.rec.noteKey === "N3").length,
            1,
          );
        });
      }
    }
  }
}

test("a Zotero write that throws leaves the record untouched", async () => {
  const rec: NotePageRecord = { noteKey: "N", base: "a" };
  const plan = planPair(rec.base, [para("a")], [para("b")]);
  assert.equal(plan.action, "toZotero");
  const commits: (() => void)[] = [];
  await assert.rejects(
    applyPairPlan(
      rec,
      plan,
      async () => Promise.reject(new Error("x")),
      commits,
    ),
  );
  assert.equal(rec.base, "a");
  for (const f of commits.splice(0)) f();
  assert.equal(rec.base, "a");
});

test("a failed tablet write keeps the old base for toTablet and the tablet text for conflict", async () => {
  const toTablet: NotePageRecord = { noteKey: "N", base: "a" };
  const c1: (() => void)[] = [];
  await applyPairPlan(
    toTablet,
    planPair("a", [para("z")], [para("a")]),
    undefined,
    c1,
  );
  assert.equal(toTablet.base, "a"); // not "z" until the tablet write is done
  for (const f of c1.splice(0)) f();
  assert.equal(toTablet.base, "z");

  const conflict: NotePageRecord = { noteKey: "N", base: "a" };
  const c2: (() => void)[] = [];
  const plan = planPair("a", [para("z")], [para("t")]);
  await applyPairPlan(conflict, plan, async () => {}, c2);
  // Zotero holds the merged text, the tablet still "t": the retry is a push.
  assert.equal(conflict.base, "t");
  assert.equal(
    decide(conflict.base, plainText(plan.zoteroBody!), "t"),
    "toTablet",
  );
  for (const f of c2.splice(0)) f();
  assert.equal(conflict.base, plainText(plan.zoteroBody!));
});
