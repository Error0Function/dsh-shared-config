// src/index.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveConfig } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import ConfigEditor from "@deepseek-ai/dsh-config-editor";
import { composeEntries, loadOptionalPatches, loadProfileDirectory, readProfilePatches, reconcileProfilePatches } from "@deepseek-ai/dsh-app-boot";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import yaml from "js-yaml";

// src/document.ts
import { isMap, isSeq, parseDocument, Scalar, visit } from "yaml";
function patchDocument(raw) {
  const doc = parseDocument(raw, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => value }] });
  if (doc.errors[0]) throw doc.errors[0];
  if (!isSeq(doc.contents)) throw new Error("Shared patch must be a YAML sequence");
  doc.contents.flow = false;
  return doc;
}
function editPatch(raw, id, name, config) {
  const doc = patchDocument(raw);
  if (!isSeq(doc.contents)) throw new Error("Shared patch must be a YAML sequence");
  const indices = doc.contents.items.flatMap((item, index) => isMap(item) && doc.getIn([index, "id"]) === id && !item.has("insert") ? [index] : []);
  for (const index of indices) {
    const row = doc.contents.items[index];
    if (isMap(row) && row.has("name") && doc.getIn([index, "name"]) !== name) throw new Error(`Shared entry "${id}" belongs to another plugin`);
  }
  if (config === void 0) {
    for (const index of indices.reverse()) {
      const row = doc.contents.items[index];
      if (!isMap(row)) continue;
      row.delete("config");
      if (row.items.every((item) => item.key instanceof Scalar && ["id", "name"].includes(String(item.key.value)))) doc.delete(index);
    }
  } else if (indices.length === 0) {
    doc.add(doc.createNode({ id, name, config }));
  } else {
    const index = indices.at(-1);
    const row = doc.contents.items[index];
    if (isMap(row)) doc.setIn([index, "config"], config);
  }
  visit(doc, { Map(_key, node) {
    if (node.items.length !== 1 || typeof node.get("__jsExpr") !== "string") return;
    const value = new Scalar(node.get("__jsExpr"));
    value.tag = "tag:yaml.org,2002:js";
    return value;
  } });
  return String(doc);
}

// src/index.ts
var flatten = (rows) => rows.flatMap((row) => [
  row,
  ...row.group && Array.isArray(row.config) ? flatten(row.config) : []
]);
var ACTIVE = 2;
var SharedConfigEditor = class extends ConfigEditor {
  constructor(sharedContext, options) {
    super(sharedContext);
    this.sharedContext = sharedContext;
    this.options = options;
  }
  sharedContext;
  options;
  static Config = z.object({
    lockWaitMs: z.number().step(1).min(1).default(3e4)
  });
  get documentPath() {
    return join(this.sharedContext.profileContext.home, "cordis.patch.yml");
  }
  configuration() {
    const profile = this.sharedContext.profileContext;
    const loaded = loadProfileDirectory("dsh", profile.dir, profile.installAnchor);
    const home = loadOptionalPatches("dsh", this.documentPath) ?? [];
    const inheritedRows = flatten(composeEntries([...loaded.layers.map((layer) => layer.patches), loaded.patches]));
    return this.entries().map((entry) => ({
      entry,
      inherited: structuredClone(inheritedRows.find((row) => row.id === entry.options.id)?.config ?? {}),
      override: structuredClone(home.findLast((row) => row.id === entry.options.id && row.config !== void 0)?.config ?? {})
    }));
  }
  async edit(entry, change) {
    const run = async () => withFileLock(this.documentPath, async () => {
      const ctx = this.sharedContext;
      const beforePatches = readProfilePatches("dsh", ctx.profileContext);
      await reconcileProfilePatches(ctx.root, beforePatches, "dsh");
      if (!this.entries().includes(entry) || entry.fiber?.state !== ACTIVE) throw new Error("Configuration entry changed during reload");
      const profile = ctx.profileContext;
      const loaded = loadProfileDirectory("dsh", profile.dir, profile.installAnchor);
      let before;
      try {
        before = await readFile(this.documentPath, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        before = "[]\n";
      }
      const home = yaml.load(before, { schema: entryListSchema });
      const inheritedRows = flatten(composeEntries([...loaded.layers.map((layer) => layer.patches), loaded.patches]));
      const inherited = structuredClone(inheritedRows.find((candidate2) => candidate2.id === entry.options.id)?.config ?? {});
      const currentRows = flatten(composeEntries([
        ...loaded.layers.map((layer) => layer.patches),
        loaded.patches,
        home,
        [...profile.overlays]
      ]));
      const current = structuredClone(currentRows.find((candidate2) => candidate2.id === entry.options.id)?.config ?? {});
      const next = change(current, inherited);
      const after = editPatch(
        before,
        entry.options.id,
        entry.options.name,
        isDeepStrictEqual(next, inherited) ? void 0 : next
      );
      const candidate = yaml.load(after, { schema: entryListSchema });
      const effective = flatten(composeEntries([
        ...loaded.layers.map((layer) => layer.patches),
        loaded.patches,
        candidate,
        [...profile.overlays]
      ])).find((candidate2) => candidate2.id === entry.options.id);
      if (!isDeepStrictEqual(effective?.config ?? {}, next)) {
        throw new Error(`Configuration for "${entry.options.id}" is overridden by a command-line overlay`);
      }
      const fiber = entry.fiber;
      const resolved = fiber.ctx.waterfall(fiber, "internal/config", next, () => next);
      resolveConfig(fiber.runtime, resolved);
      await writeFileAtomic(this.documentPath, after, { mode: 384 });
      try {
        await reconcileProfilePatches(ctx.root, readProfilePatches("dsh", profile), "dsh", [entry.options.id]);
      } catch (error) {
        await writeFileAtomic(this.documentPath, before, { mode: 384 });
        await reconcileProfilePatches(ctx.root, beforePatches, "dsh");
        throw error;
      }
    }, { waitMs: this.options.lockWaitMs });
    const hmr = this.sharedContext.get("hmr");
    await (hmr === void 0 ? run() : hmr.runExclusive(run));
  }
};
export {
  SharedConfigEditor as default
};
