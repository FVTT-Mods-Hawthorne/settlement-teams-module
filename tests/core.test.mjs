import assert from "node:assert/strict";
import { test } from "node:test";
import * as C from "../scripts/core.mjs";

const mk = () => {
  const s = C.blankState();
  const a = C.addTeam(s, "Foragers"), b = C.addTeam(s, "Builders");
  C.upsertMember(s, { id: "m1", name: "Ana", skills: { survival: { label: "Survival", mod: 7 }, nature: { label: "Nature", mod: 3 } } });
  C.upsertMember(s, { id: "m2", name: "Bo", skills: { survival: { label: "Survival", mod: 4 } } });
  C.upsertMember(s, { id: "L1", name: "Lead", leader: true, skills: { survival: { label: "Survival", mod: 6 } } });
  return { s, a, b };
};

test("members live in exactly one team", () => {
  const { s, a, b } = mk();
  C.moveMember(s, "m1", a); C.moveMember(s, "m1", b);
  assert.deepEqual(s.teams[a].memberIds, []); assert.deepEqual(s.teams[b].memberIds, ["m1"]);
  assert.equal(C.teamOf(s, "m1").id, b); assert.equal(C.unassigned(s).length, 2);
  C.moveMember(s, "m1", null); assert.equal(C.teamOf(s, "m1"), null);
});
test("leaders take the leader slot and replace placement", () => {
  const { s, a, b } = mk();
  C.moveMember(s, "L1", a); assert.equal(s.teams[a].leaderId, "L1"); assert.deepEqual(s.teams[a].memberIds, []);
  C.moveMember(s, "L1", b); assert.equal(s.teams[a].leaderId, ""); assert.equal(s.teams[b].leaderId, "L1");
});
test("removing a team frees its people", () => {
  const { s, a } = mk(); C.moveMember(s, "m1", a); C.removeTeam(s, a);
  assert.equal(C.teamOf(s, "m1"), null); assert.ok(s.members.m1);
});
test("team skill methods", () => {
  const { s, a } = mk(); C.moveMember(s, "m1", a); C.moveMember(s, "m2", a);
  assert.equal(C.teamSkillMod(s, a, "survival", "highest"), 7);
  assert.equal(C.teamSkillMod(s, a, "survival", "average"), 5);
  assert.equal(C.teamSkillMod(s, a, "survival", "lowest"), 4);
  assert.equal(C.teamSkillMod(s, a, "nature", "lowest"), 3);
  assert.equal(C.teamSkillMod(s, a, "arcana"), 0);
});
test("passive score: leader modes, injuries, toolkit", () => {
  const { s, a } = mk(); C.moveMember(s, "m1", a); C.moveMember(s, "L1", a);
  assert.equal(C.passiveScore(s, a, "survival").total, 23);
  assert.equal(C.passiveScore(s, a, "survival", { leaderMode: "higher" }).total, 17);
  assert.equal(C.passiveScore(s, a, "survival", { leaderMode: "none" }).total, 17);
  C.setInjuries(s, a, 9); assert.equal(s.teams[a].injuries, 4);
  assert.equal(C.passiveScore(s, a, "survival", { leaderMode: "none", toolkit: 5 }).total, 18);
});
test("degrees: no team crit unless PC-led", () => {
  assert.equal(C.degree(29, 19), "success"); assert.equal(C.degree(29, 19, { canCrit: true }), "criticalSuccess");
  assert.equal(C.degree(19, 19), "success"); assert.equal(C.degree(18, 19), "failure"); assert.equal(C.degree(9, 19), "criticalFailure");
});
test("weekly action budget", () => {
  const { s, a } = mk();
  C.assign(s, a, "forage"); assert.throws(() => C.assign(s, a, "travel"));
  s.teams[a].nearSecure = true; C.assign(s, a, "travel"); assert.equal(C.actionsSpent(s.teams[a]), 3);
  assert.throws(() => C.assign(s, a, "craft")); assert.throws(() => C.assign(s, a, "aid"));
  C.resetWeek(s); assert.equal(s.teams[a].assignments.length, 0); assert.equal(s.week, 1);
  s.teams[a].nearSecure = false; assert.throws(() => C.assign(s, a, "recover")); 
});
test("natural recovery", () => {
  const { s, a } = mk(); C.setInjuries(s, a, 3);
  assert.equal(C.applyRecovery(s, a, [14, 15, 3]), 1); assert.equal(s.teams[a].injuries, 2);
  assert.equal(C.applyRecovery(s, a, [20, 20]), 2); assert.equal(s.teams[a].injuries, 0);
});
test("toolkit bonus equals uses and counts down", () => {
  const { s, a, b } = mk(); const id = C.stashAdd(s, a, { name: "BNA tools", toolkit: true, uses: 5 });
  assert.equal(C.useToolkit(s, a, id), 5); assert.equal(C.useToolkit(s, a, id), 4);
  C.stashUpdate(s, a, id, { uses: 0 }); assert.throws(() => C.useToolkit(s, a, id));
  C.stashMove(s, a, id, b); assert.equal(s.teams[a].stash.length, 0); assert.equal(s.teams[b].stash[0].name, "BNA tools");
});
test("validateState repairs bad data", () => {
  const { s, a, b } = mk(); C.moveMember(s, "m1", a);
  s.teams[b].memberIds.push("m1", "ghost"); s.teams[a].injuries = 99; s.teams[a].assignments.push({ activity: "claim" });
  s.teams[a].leaderId = "m2";
  const v = C.validateState(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(v.teams[b].memberIds, []); assert.equal(v.teams[a].injuries, 4);
  assert.equal(v.teams[a].assignments.length, 0); assert.equal(v.teams[a].leaderId, "");
  assert.deepEqual(C.validateState(null).teams, {});
});
