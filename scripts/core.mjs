/** Settlement Teams: pure rules with no dependency on Foundry, so they can be tested in Node. */
export const MAX_INJURIES = 4;
export const BASE_TEAM_ACTIONS = 2;
export const ACTIVITIES = [
  { id: "travel", name: "Travel", cost: 1, teams: true },
  { id: "explore", name: "Explore", cost: 2, teams: true },
  { id: "forage", name: "Forage", cost: 2, teams: true },
  { id: "work", name: "Work", cost: 2, teams: true },
  { id: "improve", name: "Improve", cost: 2, teams: true },
  { id: "craft", name: "Craft", cost: 1, teams: true },
  { id: "research", name: "Research", cost: 1, teams: true },
  { id: "recover", name: "Recover", cost: 3, teams: true },
  { id: "aid", name: "Aid", cost: 1, teams: false }
];
export const SKILL_METHODS = ["highest", "average", "lowest"];
export const LEADER_MODES = ["add", "higher", "none"];

export const uid = () => globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const clampInt = (value, min = 0, max = 999999) => Math.max(min, Math.min(max, Math.trunc(Number(value) || 0)));
const text = (value, max = 200) => String(value ?? "").slice(0, max);

export const blankState = () => ({ schema: 1, revision: 0, week: 0, teams: {}, order: [], members: {} });
export const blankTeam = (id, name = "New Team") => ({
  id, name: text(name, 80) || "New Team", memberIds: [], leaderId: "", injuries: 0,
  nearSecure: false, pcLed: false, location: { sceneId: "", hexKey: "" }, assignments: [], stash: [], notes: ""
});

/** Normalize anything read from storage so the rest of the code can trust its shape. */
export function validateState(raw) {
  const s = { ...blankState(), ...(raw && typeof raw === "object" ? raw : {}) };
  s.revision = clampInt(s.revision); s.week = clampInt(s.week);
  const members = {};
  for (const [id, m] of Object.entries(s.members || {})) {
    if (!m || typeof m !== "object") continue;
    const skills = {};
    for (const [slug, sk] of Object.entries(m.skills || {})) {
      skills[text(slug, 60)] = { label: text(sk?.label || slug, 60), mod: clampInt(sk?.mod, -99, 99) };
    }
    members[id] = {
      id, actorUuid: text(m.actorUuid, 200), name: text(m.name, 80) || "Unnamed", alias: text(m.alias, 80),
      img: text(m.img, 1000), level: clampInt(m.level, -5, 30), leader: !!m.leader, skills
    };
  }
  s.members = members;
  const teams = {};
  for (const [id, t] of Object.entries(s.teams || {})) {
    if (!t || typeof t !== "object") continue;
    const team = { ...blankTeam(id, t.name), ...t, id };
    team.name = text(team.name, 80) || "New Team";
    team.memberIds = [...new Set((team.memberIds || []).filter(m => members[m] && !members[m].leader))];
    team.leaderId = members[team.leaderId]?.leader ? team.leaderId : "";
    team.injuries = clampInt(team.injuries, 0, MAX_INJURIES);
    team.nearSecure = !!team.nearSecure; team.pcLed = !!team.pcLed;
    team.location = { sceneId: text(team.location?.sceneId, 40), hexKey: text(team.location?.hexKey, 40) };
    team.assignments = (team.assignments || []).filter(a => ACTIVITIES.some(x => x.id === a?.activity))
      .map(a => ({ id: text(a.id || uid(), 60), activity: a.activity, note: text(a.note, 200) }));
    team.stash = (team.stash || []).filter(i => i && typeof i === "object").map(i => ({
      id: text(i.id || uid(), 60), name: text(i.name, 120) || "Item", qty: clampInt(i.qty, 0),
      toolkit: !!i.toolkit, uses: clampInt(i.uses, 0, 99), img: text(i.img, 1000)
    }));
    team.notes = text(team.notes, 5000);
    teams[id] = team;
  }
  // A member can only be in one place.
  const seen = new Set();
  for (const t of Object.values(teams)) {
    t.memberIds = t.memberIds.filter(m => !seen.has(m) && seen.add(m));
    if (t.leaderId) { if (seen.has(t.leaderId)) t.leaderId = ""; else seen.add(t.leaderId); }
  }
  s.teams = teams;
  s.order = [...new Set([...(s.order || []).filter(id => teams[id]), ...Object.keys(teams)])];
  return s;
}

const need = (state, teamId) => { const t = state.teams[teamId]; if (!t) throw Error("Unknown team"); return t; };

export function addTeam(state, name) {
  const id = uid(); state.teams[id] = blankTeam(id, name); state.order.push(id); return id;
}
export function removeTeam(state, teamId) {
  need(state, teamId); delete state.teams[teamId]; state.order = state.order.filter(id => id !== teamId);
}
export function renameTeam(state, teamId, name) { need(state, teamId).name = text(name, 80) || "New Team"; }

export function teamOf(state, memberId) {
  return Object.values(state.teams).find(t => t.leaderId === memberId || t.memberIds.includes(memberId)) || null;
}
export function unassigned(state) {
  return Object.values(state.members).filter(m => !teamOf(state, m.id));
}
/** Add or refresh a roster entry. Existing alias, leader flag and placement are kept. */
export function upsertMember(state, member) {
  const id = member.id || uid(); const old = state.members[id] || {};
  state.members[id] = { alias: "", leader: false, ...old, ...member, id };
  return id;
}
export function removeMember(state, memberId) {
  moveMember(state, memberId, null); delete state.members[memberId];
}
/** Move a member to a team, or to nobody (teamId null). Leaders take the team's leader slot. */
export function moveMember(state, memberId, teamId) {
  const m = state.members[memberId]; if (!m) throw Error("Unknown member");
  for (const t of Object.values(state.teams)) {
    t.memberIds = t.memberIds.filter(id => id !== memberId);
    if (t.leaderId === memberId) t.leaderId = "";
  }
  if (!teamId) return;
  const team = need(state, teamId);
  if (m.leader) team.leaderId = memberId; else team.memberIds.push(memberId);
}
export function setLeaderFlag(state, memberId, leader) {
  const m = state.members[memberId]; if (!m) throw Error("Unknown member");
  const team = teamOf(state, memberId);
  moveMember(state, memberId, null); m.leader = !!leader;
  if (team) moveMember(state, memberId, team.id);
}

/* ---------- skills and checks ---------- */
export function skillSlugs(state) {
  const all = new Map();
  for (const m of Object.values(state.members)) for (const [slug, sk] of Object.entries(m.skills || {})) all.set(slug, sk.label || slug);
  return [...all.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([slug, label]) => ({ slug, label }));
}
/** The team's own modifier in a skill, from its members (not the leader). */
export function teamSkillMod(state, teamId, slug, method = "highest") {
  const mods = need(state, teamId).memberIds.map(id => state.members[id]?.skills?.[slug]?.mod).filter(n => Number.isFinite(n));
  if (!mods.length) return 0;
  if (method === "average") return Math.floor(mods.reduce((a, b) => a + b, 0) / mods.length);
  if (method === "lowest") return Math.min(...mods);
  return Math.max(...mods);
}
export function leaderSkillMod(state, teamId, slug) {
  const leader = state.members[need(state, teamId).leaderId];
  const mod = leader?.skills?.[slug]?.mod;
  return Number.isFinite(mod) ? mod : null;
}
/** Passive Score = 10 + team skill modifier + leader + toolkit + other bonus - injuries. */
export function passiveScore(state, teamId, slug, { method = "highest", leaderMode = "add", toolkit = 0, bonus = 0 } = {}) {
  const team = need(state, teamId);
  const base = teamSkillMod(state, teamId, slug, method);
  const lead = leaderSkillMod(state, teamId, slug);
  let skill = base, leaderPart = 0;
  if (lead !== null && leaderMode === "add") leaderPart = lead;
  if (lead !== null && leaderMode === "higher") skill = Math.max(base, lead);
  const total = 10 + skill + leaderPart + clampInt(toolkit, 0, 99) + clampInt(bonus, -99, 99) - team.injuries;
  return { total, parts: { base: 10, skill, leader: leaderPart, toolkit: clampInt(toolkit, 0, 99), bonus: clampInt(bonus, -99, 99), injuries: -team.injuries } };
}
/** PF2e degrees of success for a fixed score. Teams cannot critically succeed unless PC-led. */
export function degree(score, dc, { canCrit = false } = {}) {
  if (score >= dc + 10) return canCrit ? "criticalSuccess" : "success";
  if (score >= dc) return "success";
  if (score <= dc - 10) return "criticalFailure";
  return "failure";
}

/* ---------- weekly actions ---------- */
export const actionBudget = team => BASE_TEAM_ACTIONS + (team.nearSecure ? 1 : 0);
export const actionsSpent = team => team.assignments.reduce((n, a) => n + (ACTIVITIES.find(x => x.id === a.activity)?.cost || 0), 0);
export function assign(state, teamId, activityId, note = "") {
  const team = need(state, teamId); const act = ACTIVITIES.find(a => a.id === activityId);
  if (!act) throw Error("Unknown activity");
  if (!act.teams) throw Error(`${act.name} is for PCs only`);
  if (actionsSpent(team) + act.cost > actionBudget(team)) throw Error(`${team.name} does not have ${act.cost} action(s) left this week`);
  const id = uid(); team.assignments.push({ id, activity: act.id, note: text(note, 200) }); return id;
}
export function unassign(state, teamId, assignmentId) {
  const team = need(state, teamId); team.assignments = team.assignments.filter(a => a.id !== assignmentId);
}
export function resetWeek(state) {
  for (const t of Object.values(state.teams)) { t.assignments = []; t.pcLed = false; }
  state.week++;
}

/* ---------- injuries ---------- */
export function setInjuries(state, teamId, n) { need(state, teamId).injuries = clampInt(n, 0, MAX_INJURIES); }
/** Weekly natural recovery: one d20 per Injury. 15+ heals 1, a natural 20 heals 2. */
export function applyRecovery(state, teamId, rolls) {
  const team = need(state, teamId);
  const healed = Math.min(team.injuries, rolls.slice(0, team.injuries).reduce((n, r) => n + (r >= 20 ? 2 : r >= 15 ? 1 : 0), 0));
  team.injuries -= healed; return healed;
}

/* ---------- stash and toolkits ---------- */
export function stashAdd(state, teamId, item) {
  const team = need(state, teamId); const id = uid();
  team.stash.push({ id, name: text(item?.name, 120) || "Item", qty: clampInt(item?.qty ?? 1, 0), toolkit: !!item?.toolkit, uses: clampInt(item?.uses, 0, 99), img: text(item?.img, 1000) });
  return id;
}
export function stashUpdate(state, teamId, itemId, patch) {
  const item = need(state, teamId).stash.find(i => i.id === itemId); if (!item) throw Error("Unknown stash item");
  if ("name" in patch) item.name = text(patch.name, 120) || item.name;
  if ("qty" in patch) item.qty = clampInt(patch.qty, 0);
  if ("uses" in patch) item.uses = clampInt(patch.uses, 0, 99);
  if ("toolkit" in patch) item.toolkit = !!patch.toolkit;
}
export function stashRemove(state, teamId, itemId) {
  const team = need(state, teamId); team.stash = team.stash.filter(i => i.id !== itemId);
}
export function stashMove(state, fromTeamId, itemId, toTeamId) {
  const from = need(state, fromTeamId), to = need(state, toTeamId);
  const item = from.stash.find(i => i.id === itemId); if (!item) throw Error("Unknown stash item");
  from.stash = from.stash.filter(i => i.id !== itemId); to.stash.push(item);
}
/** A toolkit's item bonus equals its current Uses; using it costs 1 Use. Returns the bonus granted. */
export function useToolkit(state, teamId, itemId) {
  const item = need(state, teamId).stash.find(i => i.id === itemId);
  if (!item?.toolkit) throw Error("Not a toolkit");
  if (item.uses <= 0) throw Error(`${item.name} has no Uses left`);
  const bonus = item.uses; item.uses -= 1; return bonus;
}
