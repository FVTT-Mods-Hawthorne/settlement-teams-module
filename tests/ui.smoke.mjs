// Smoke test: load module.mjs against stubbed Foundry globals and render the window HTML for GM and player.
import assert from "node:assert/strict";
import { test } from "node:test";
const hooks = {}; const settings = new Map(); const reg = new Map();
let isGM = true;
globalThis.Hooks = { once: (n, f) => (hooks[n] = f), on: (n, f) => (hooks["on:" + n] = f), callAll() {} };
class AppV2 { rendered = false; render() { this.rendered = true; } }
const actor = { id: "a1", uuid: "Actor.a1", name: "Mara", img: "x.png", system: { details: { level: { value: 1 } } }, perception: { mod: 5 }, skills: { survival: { label: "Survival", mod: 7 }, "<b>": { label: "<script>", mod: 1 } } };
globalThis.foundry = { applications: { api: { ApplicationV2: AppV2 } }, utils: { deepClone: o => structuredClone(o) } };
globalThis.fromUuidSync = () => actor; globalThis.fromUuid = async () => ({ ...actor, documentName: "Actor" });
globalThis.ui = { notifications: { info() {}, warn(m) { throw Error("warn: " + m); } } };
globalThis.ChatMessage = { create: async m => (globalThis.lastChat = m) };
const user = { id: "u1", get isGM() { return isGM; }, active: true };
const mod = {};
globalThis.game = {
  user, users: { filter: f => [{ id: "u1", active: true, isGM: true }].filter(f), get: () => user },
  settings: { register: (m, k, d) => reg.set(k, d), get: (m, k) => settings.has(k) ? settings.get(k) : reg.get(k).default, set: async (m, k, v) => { settings.set(k, structuredClone(v)); } },
  modules: { get: () => mod }, folders: { filter: () => [], get: () => null }, socket: { on() {}, emit() {} }, actors: []
};
await import("../scripts/module.mjs");
hooks.init();
test("api round trip and render for GM and player", async () => {
  const api = mod.api;
  const { addTeam } = await import("../scripts/core.mjs");
  const s = api.getState(); const tid = addTeam(s, "Foragers <x>"); await game.settings.set("settlement-teams", "state", s);
  // GM host path through the public API
  await api.setInjuries(tid, 2); assert.equal(api.getTeam(tid).injuries, 2);
  await api.assign(tid, "forage"); assert.deepEqual(api.actionBudget(tid), { budget: 2, spent: 2 });
  await assert.rejects(api.assign(tid, "travel"));
  const app = api.open();
  // add an actor via the internal action by simulating state
  const st = api.getState(); st.members.a1 = { id: "a1", actorUuid: "Actor.a1", name: "Mara", level: 1, skills: { survival: { label: "Survival", mod: 7 }, "<b>": { label: "<script>", mod: 1 } } };
  st.teams[tid].memberIds.push("a1"); st.teams[tid].stash.push({ id: "i1", name: "BNA tools", qty: 1, toolkit: true, uses: 5 });
  await game.settings.set("settlement-teams", "state", st);
  assert.equal(api.getPassiveScore(tid, "survival").total, 15);
  app.openKeys.add(`${tid}:skills`); app.openKeys.add(`${tid}:stash`); app.openKeys.add("admin");
  const htmlGM = await app._renderHTML();
  assert.ok(htmlGM.includes("Foragers &lt;x&gt;")); assert.ok(!htmlGM.includes("<script>")); assert.ok(htmlGM.includes("GM: roster"));
  assert.ok(htmlGM.includes("Passive Score")); assert.ok(htmlGM.includes("BNA tools"));
  assert.equal(await api.useToolkit(tid, "i1"), 5); assert.equal(api.getTeam(tid).stash[0].uses, 4);
  isGM = false;
  const htmlP = await app._renderHTML();
  assert.ok(!htmlP.includes("GM: roster")); assert.ok(!htmlP.includes('data-action="removeTeam"')); assert.ok(htmlP.includes('data-change="move"'));
  assert.ok(!htmlP.includes('data-action="openSheet"'));
});
