import * as C from "./core.mjs";

const ID = "settlement-teams", CHANNEL = `module.${ID}`;
const esc = s => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const sign = n => (n >= 0 ? `+${n}` : `${n}`);
const notify = (msg, type = "info") => ui.notifications?.[type]?.(String(msg));
const gm = () => !!game.user?.isGM;
const authority = () => game.users?.filter(u => u.active && u.isGM).sort((a, b) => a.id.localeCompare(b.id))[0]?.id;
const host = () => gm() && authority() === game.user.id;
const setting = key => game.settings.get(ID, key);
const getState = () => C.validateState(foundry.utils.deepClone(setting("state")));
const DEGREE_LABEL = { criticalSuccess: "Critical Success", success: "Success", failure: "Failure", criticalFailure: "Critical Failure" };

/* ------------------------------------------------------------------ */
/* Permissions: which actions a player may request, and under which setting */
const PLAYER_ACTIONS = {
  moveMember: "playersCanManage", assign: "playersCanManage", unassign: "playersCanManage", setPcLed: "playersCanManage",
  stashAdd: "playersCanEditStash", stashUpdate: "playersCanEditStash", stashRemove: "playersCanEditStash",
  stashMove: "playersCanEditStash", useToolkit: "playersCanEditStash"
};
const can = action => gm() || (PLAYER_ACTIONS[action] ? !!setting(PLAYER_ACTIONS[action]) : false);

/* ------------------------------------------------------------------ */
/* Actor snapshots. Only the GM's client reads the NPC actors; players only ever see this summary. */
function snapshotActor(actor, old = {}) {
  const skills = {};
  const add = (slug, label, mod) => { if (mod !== undefined && mod !== null && Number.isFinite(Number(mod))) skills[slug] = { label: String(label || slug), mod: Number(mod) }; };
  add("perception", "Perception", actor.perception?.mod ?? actor.system?.perception?.mod);
  const stats = actor.skills;
  if (stats && typeof stats === "object" && Object.keys(stats).length) {
    for (const [slug, st] of Object.entries(stats)) add(slug, st?.label ?? slug, st?.mod ?? st?.check?.mod ?? st?.base);
  } else {
    for (const [slug, sk] of Object.entries(actor.system?.skills || {})) add(slug, sk?.label ?? slug, sk?.mod ?? sk?.total ?? sk?.value ?? sk?.base);
  }
  const alias = old.alias || "";
  return {
    id: actor.id, actorUuid: actor.uuid, alias,
    name: alias ? "" : actor.name,                       // an alias keeps the real name off players' clients
    img: setting("showPortraits") && !alias ? (actor.img || "") : "",
    level: Number(actor.system?.details?.level?.value ?? actor.level ?? 0) || 0, skills
  };
}
const actorOf = member => { try { return member?.actorUuid ? fromUuidSync(member.actorUuid) : null; } catch { return null; } };
const displayName = member => {
  if (!member) return "—";
  if (gm()) { const a = actorOf(member); const real = a?.name || member.name; return member.alias ? `${real} (${member.alias})` : real; }
  return member.alias || member.name;
};

/* ------------------------------------------------------------------ */
/* State changes. Only the hosting GM writes; everyone else asks over the socket. */
let queue = Promise.resolve();
const pending = new Map();

function mutate(task) {
  const job = queue.then(async () => {
    if (!host()) throw Error("An active GM must be online to change teams");
    const state = getState();
    const result = await task(state);
    state.revision++;
    await game.settings.set(ID, "state", C.validateState(state));
    return result;
  });
  queue = job.catch(() => {});
  return job;
}

async function perform(action, a = {}, sender = game.user) {
  if (!sender.isGM) {
    const key = PLAYER_ACTIONS[action];
    if (!key || !setting(key)) throw Error("Only the GM can do that");
  }
  switch (action) {
    case "addTeam": return mutate(s => C.addTeam(s, a.name));
    case "removeTeam": return mutate(s => C.removeTeam(s, a.teamId));
    case "renameTeam": return mutate(s => C.renameTeam(s, a.teamId, a.name));
    case "moveMember": return mutate(s => C.moveMember(s, a.memberId, a.teamId || null));
    case "removeMember": return mutate(s => C.removeMember(s, a.memberId));
    case "setLeader": return mutate(s => C.setLeaderFlag(s, a.memberId, a.leader));
    case "setAlias": return mutate(s => {
      const m = s.members[a.memberId]; if (!m) throw Error("Unknown member");
      m.alias = String(a.alias || "").slice(0, 80);
      const actor = actorOf(m); if (actor) Object.assign(m, snapshotActor(actor, m));
    });
    case "addActors": return mutate(async s => {
      let n = 0;
      for (const uuid of a.uuids || []) {
        const actor = await fromUuid(uuid); if (!actor || actor.documentName !== "Actor") continue;
        C.upsertMember(s, snapshotActor(actor, s.members[actor.id])); n++;
        if (a.teamId && s.teams[a.teamId] && !C.teamOf(s, actor.id)) C.moveMember(s, actor.id, a.teamId);
      }
      return n;
    });
    case "refresh": return mutate(s => {
      for (const m of Object.values(s.members)) { const actor = actorOf(m); if (actor) Object.assign(m, snapshotActor(actor, m)); }
    });
    case "setInjuries": return mutate(s => C.setInjuries(s, a.teamId, a.injuries));
    case "adjustInjuries": return mutate(s => C.setInjuries(s, a.teamId, (s.teams[a.teamId]?.injuries || 0) + Number(a.delta || 0)));
    case "setNearSecure": return mutate(s => { if (!s.teams[a.teamId]) throw Error("Unknown team"); s.teams[a.teamId].nearSecure = !!a.value; });
    case "setPcLed": return mutate(s => { if (!s.teams[a.teamId]) throw Error("Unknown team"); s.teams[a.teamId].pcLed = !!a.value; });
    case "setLocation": return mutate(s => { if (!s.teams[a.teamId]) throw Error("Unknown team"); s.teams[a.teamId].location = { sceneId: a.sceneId || "", hexKey: a.hexKey || "" }; });
    case "setNotes": return mutate(s => { if (!s.teams[a.teamId]) throw Error("Unknown team"); s.teams[a.teamId].notes = String(a.notes || ""); });
    case "assign": return mutate(s => C.assign(s, a.teamId, a.activity, a.note));
    case "unassign": return mutate(s => C.unassign(s, a.teamId, a.assignmentId));
    case "resetWeek": return mutate(s => C.resetWeek(s));
    case "applyRecovery": return mutate(s => C.applyRecovery(s, a.teamId, a.rolls || []));
    case "stashAdd": return mutate(s => C.stashAdd(s, a.teamId, a.item));
    case "stashUpdate": return mutate(s => C.stashUpdate(s, a.teamId, a.itemId, a.patch || {}));
    case "stashRemove": return mutate(s => C.stashRemove(s, a.teamId, a.itemId));
    case "stashMove": return mutate(s => C.stashMove(s, a.teamId, a.itemId, a.toTeamId));
    case "useToolkit": return mutate(s => {
      const bonus = C.useToolkit(s, a.teamId, a.itemId);
      const team = s.teams[a.teamId], item = team.stash.find(i => i.id === a.itemId);
      ChatMessage.create({ speaker: { alias: team.name }, content: `<p><strong>${esc(team.name)}</strong> uses <strong>${esc(item.name)}</strong>: ${sign(bonus)} item bonus. ${item.uses} Use(s) left.</p>` });
      return bonus;
    });
    default: throw Error(`Unknown action ${action}`);
  }
}

function request(action, args = {}) {
  if (host()) return perform(action, args, game.user);
  return new Promise((resolve, reject) => {
    const target = authority();
    if (!target) return reject(Error("A GM must be online to change teams"));
    const requestId = C.uid();
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error("The GM's client did not answer")); }, 15000);
    pending.set(requestId, { resolve, reject, timer });
    game.socket.emit(CHANNEL, { type: "request", action, args, requestId, target, sender: game.user.id });
  });
}
function onSocket(m) {
  if (m?.type === "request" && host() && m.target === game.user.id) {
    const sender = game.users.get(m.sender); if (!sender) return;
    Promise.resolve().then(() => perform(m.action, m.args || {}, sender)).then(
      value => game.socket.emit(CHANNEL, { type: "reply", to: sender.id, requestId: m.requestId, ok: true, value }),
      e => game.socket.emit(CHANNEL, { type: "reply", to: sender.id, requestId: m.requestId, ok: false, error: e.message }));
  } else if (m?.type === "reply" && m.to === game.user.id) {
    const p = pending.get(m.requestId); if (!p) return;
    clearTimeout(p.timer); pending.delete(m.requestId);
    m.ok ? p.resolve(m.value) : p.reject(Error(m.error));
  }
}
const act = (action, args) => request(action, args).catch(e => { notify(e.message, "warn"); });

/* ------------------------------------------------------------------ */
/* Rolls */
async function rollSkill(memberId, slug, event) {
  const state = getState(), m = state.members[memberId], sk = m?.skills?.[slug];
  if (!sk) return;
  if (gm()) {
    const actor = actorOf(m), stat = slug === "perception" ? actor?.perception : actor?.skills?.[slug];
    if (typeof stat?.roll === "function") { try { await stat.roll({ event }); return; } catch (e) { console.warn(`${ID} system roll failed, using a plain roll`, e); } }
  }
  const roll = await new Roll("1d20 + @mod", { mod: sk.mod }).evaluate();
  await roll.toMessage({ speaker: { alias: displayName(m) }, flavor: `${esc(sk.label)} check (${sign(sk.mod)})` });
}
function passiveFor(state, teamId, slug, toolkit = 0) {
  return C.passiveScore(state, teamId, slug, { method: setting("teamSkillMethod"), leaderMode: setting("leaderMode"), toolkit });
}
async function postPassive(teamId, slug, dc) {
  const state = getState(), team = state.teams[teamId]; if (!team) return;
  const label = C.skillSlugs(state).find(s => s.slug === slug)?.label || slug;
  const p = passiveFor(state, teamId, slug);
  const parts = [`10`, `skill ${sign(p.parts.skill)}`];
  if (p.parts.leader) parts.push(`leader ${sign(p.parts.leader)}`);
  if (p.parts.injuries) parts.push(`injuries ${p.parts.injuries}`);
  let result = "";
  if (Number.isFinite(dc) && dc > 0) {
    const d = C.degree(p.total, dc, { canCrit: team.pcLed });
    result = `<p>vs DC ${dc}: <strong>${DEGREE_LABEL[d]}</strong>${!team.pcLed && p.total >= dc + 10 ? " (no critical success without a PC leading)" : ""}</p>`;
  }
  await ChatMessage.create({ speaker: { alias: team.name }, content: `<p><strong>${esc(team.name)}</strong> Passive ${esc(label)}: <strong>${p.total}</strong> <small>(${parts.join(", ")})</small></p>${result}<p><small>Toolkit and other bonuses not included.</small></p>` });
}
async function weeklyRecovery() {
  const state = getState();
  const hurt = Object.values(state.teams).filter(t => t.injuries > 0);
  if (!hurt.length) return notify("No Team has Injuries.");
  const lines = [];
  for (const team of hurt) {
    const roll = await new Roll(`${team.injuries}d20`).evaluate();
    const rolls = roll.dice[0].results.map(r => r.result);
    const healed = await request("applyRecovery", { teamId: team.id, rolls });
    lines.push(`<li><strong>${esc(team.name)}</strong>: rolled ${rolls.join(", ")} vs DC 15. Healed ${healed}, ${team.injuries - healed} left.</li>`);
  }
  await ChatMessage.create({ whisper: [game.user.id], content: `<p><strong>Weekly Injury recovery</strong> (flat DC 15 per Injury; a natural 20 heals 2)</p><ul>${lines.join("")}</ul>` });
}
async function confirm(title, text) {
  try { return !!(await foundry.applications.api.DialogV2.confirm({ window: { title }, content: `<p>${esc(text)}</p>` })); }
  catch { return globalThis.confirm ? globalThis.confirm(text) : true; }
}

/* ------------------------------------------------------------------ */
/* The Teams window */
const { ApplicationV2 } = foundry.applications.api;
class TeamsApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: `${ID}-app`, classes: ["settlement-teams"], tag: "section",
    window: { title: "Teams", icon: "fa-solid fa-people-group", resizable: true },
    position: { width: 980, height: 720 },
    actions: {
      addTeam() { const i = this.element.querySelector('[name="new-team"]'); act("addTeam", { name: i?.value || "New Team" }); },
      addFolder() {
        const id = this.element.querySelector('[name="folder"]')?.value; const folder = game.folders.get(id);
        if (!folder) return notify("Pick an Actor folder first.", "warn");
        const actors = folder.contents ?? game.actors.filter(a => a.folder?.id === id);
        request("addActors", { uuids: actors.map(a => a.uuid) }).then(n => notify(`Added or refreshed ${n} roster entries.`), e => notify(e.message, "warn"));
      },
      refresh() { request("refresh").then(() => notify("Roster refreshed from the actor sheets."), e => notify(e.message, "warn")); },
      recovery() { weeklyRecovery().catch(e => notify(e.message, "warn")); },
      async resetWeek() { if (await confirm("New week", "Clear every Team's assigned activities and PC-led flags for a new week?")) act("resetWeek"); },
      async removeTeam(_e, t) { if (await confirm("Delete Team", "Delete this Team? Its people go back to Unassigned and its Stash is lost.")) act("removeTeam", { teamId: t.dataset.team }); },
      async removeMember(_e, t) { if (await confirm("Remove from roster", "Remove this person from the roster? The actor itself is not touched.")) act("removeMember", { memberId: t.dataset.member }); },
      injuries(_e, t) { const team = getState().teams[t.dataset.team]; const n = Number(t.dataset.n); act("setInjuries", { teamId: t.dataset.team, injuries: team?.injuries === n ? n - 1 : n }); },
      unassign(_e, t) { act("unassign", { teamId: t.dataset.team, assignmentId: t.dataset.id }); },
      roll(e, t) { rollSkill(t.dataset.member, t.dataset.skill, e).catch(err => notify(err.message, "warn")); },
      passive(_e, t) { const dc = Number(this.element.querySelector(`[name="dc-${t.dataset.team}"]`)?.value); postPassive(t.dataset.team, t.dataset.skill, dc).catch(err => notify(err.message, "warn")); },
      openSheet(_e, t) { if (gm()) actorOf(getState().members[t.dataset.member])?.sheet?.render(true); },
      stashAdd(_e, t) { const i = this.element.querySelector(`[name="stash-new-${t.dataset.team}"]`); if (i?.value) act("stashAdd", { teamId: t.dataset.team, item: { name: i.value, qty: 1 } }); },
      stashRemove(_e, t) { act("stashRemove", { teamId: t.dataset.team, itemId: t.dataset.id }); },
      useToolkit(_e, t) { act("useToolkit", { teamId: t.dataset.team, itemId: t.dataset.id }); }
    }
  };
  openKeys = new Set();

  async _renderHTML() { return renderApp(this); }
  _replaceHTML(result, content) {
    const body = content.querySelector(".st-body"), top = body?.scrollTop || 0;
    content.innerHTML = result;
    const next = content.querySelector(".st-body"); if (next) next.scrollTop = top;
  }
  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const el = this.element;
    el.addEventListener("change", e => this.#onChange(e));
    el.addEventListener("toggle", e => { const k = e.target?.dataset?.open; if (!k) return; e.target.open ? this.openKeys.add(k) : this.openKeys.delete(k); }, true);
    el.addEventListener("dragstart", e => {
      const chip = e.target.closest?.("[data-drag-member]"); if (!chip) return;
      e.dataTransfer.setData("text/plain", JSON.stringify({ type: "st-member", id: chip.dataset.dragMember }));
    });
    el.addEventListener("dragover", e => { if (e.target.closest?.("[data-drop-team]")) e.preventDefault(); });
    el.addEventListener("drop", e => this.#onDrop(e));
  }
  #onChange(e) {
    const t = e.target, d = t.dataset, kind = d.change; if (!kind) return;
    const teamId = d.team;
    switch (kind) {
      case "move": return act("moveMember", { memberId: d.member, teamId: t.value });
      case "rename": return act("renameTeam", { teamId, name: t.value });
      case "assign": if (t.value) act("assign", { teamId, activity: t.value }); return;
      case "nearSecure": return act("setNearSecure", { teamId, value: t.checked });
      case "pcLed": return act("setPcLed", { teamId, value: t.checked });
      case "notes": return act("setNotes", { teamId, notes: t.value });
      case "alias": return act("setAlias", { memberId: d.member, alias: t.value });
      case "leader": return act("setLeader", { memberId: d.member, leader: t.checked });
      case "stashQty": return act("stashUpdate", { teamId, itemId: d.id, patch: { qty: Number(t.value) } });
      case "stashUses": return act("stashUpdate", { teamId, itemId: d.id, patch: { uses: Number(t.value) } });
      case "stashToolkit": return act("stashUpdate", { teamId, itemId: d.id, patch: { toolkit: t.checked } });
      case "stashMove": if (t.value) act("stashMove", { teamId, itemId: d.id, toTeamId: t.value }); return;
    }
  }
  async #onDrop(e) {
    const zone = e.target.closest?.("[data-drop-team]"); if (!zone) return;
    e.preventDefault();
    let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
    const teamId = zone.dataset.dropTeam || "";
    if (data?.type === "st-member") return act("moveMember", { memberId: data.id, teamId });
    if (data?.type === "Actor" && data.uuid) {
      if (!gm()) return notify("Only the GM can add people to the roster.", "warn");
      return act("addActors", { uuids: [data.uuid], teamId });
    }
    if (data?.type === "Item" && data.uuid && teamId) {
      let item = null; try { item = await fromUuid(data.uuid); } catch { /* not visible to this user */ }
      return act("stashAdd", { teamId, item: { name: item?.name || "Item", img: item?.img || "", qty: Number(item?.system?.quantity) || 1 } });
    }
  }
}

function topSkills(member, n = 3) {
  return Object.values(member.skills || {}).sort((a, b) => b.mod - a.mod).slice(0, n).map(s => `${esc(s.label)} ${sign(s.mod)}`).join(" · ");
}
function chip(state, member, teamId) {
  const manage = can("moveMember");
  const options = [`<option value="">Unassigned</option>`, ...state.order.map(id => `<option value="${esc(id)}" ${id === teamId ? "selected" : ""}>${esc(state.teams[id].name)}</option>`)].join("");
  const img = member.img ? `<img src="${esc(member.img)}" alt="">` : `<span class="st-noimg"><i class="fa-solid fa-user"></i></span>`;
  return `<div class="st-chip ${member.leader ? "st-leader" : ""}" ${manage ? `draggable="true" data-drag-member="${esc(member.id)}"` : ""}>
    ${img}
    <div class="st-chip-text"><strong ${gm() ? `data-action="openSheet" data-member="${esc(member.id)}" class="st-link"` : ""}>${member.leader ? `<i class="fa-solid fa-star" title="Leader"></i> ` : ""}${esc(displayName(member))}</strong>
      <small>Lvl ${member.level}${topSkills(member) ? ` · ${topSkills(member)}` : ""}</small></div>
    ${manage ? `<select data-change="move" data-member="${esc(member.id)}" title="Move to a Team">${options}</select>` : ""}
  </div>`;
}
function skillTable(state, team) {
  const people = [team.leaderId, ...team.memberIds].map(id => state.members[id]).filter(Boolean);
  if (!people.length) return `<p class="st-muted">Nobody on this Team yet.</p>`;
  const slugs = C.skillSlugs({ members: Object.fromEntries(people.map(p => [p.id, p])) });
  const best = Object.fromEntries(slugs.map(s => [s.slug, Math.max(...people.map(p => p.skills?.[s.slug]?.mod ?? -Infinity))]));
  const head = slugs.map(s => `<th title="${esc(s.label)}">${esc(s.label.slice(0, 4))}</th>`).join("");
  const rows = people.map(p => `<tr><th>${p.leader ? `<i class="fa-solid fa-star"></i> ` : ""}${esc(displayName(p))}</th>${slugs.map(s => {
    const sk = p.skills?.[s.slug];
    return sk ? `<td class="st-roll ${sk.mod === best[s.slug] ? "st-best" : ""}" data-action="roll" data-member="${esc(p.id)}" data-skill="${esc(s.slug)}" title="Roll ${esc(s.label)}">${sign(sk.mod)}</td>` : `<td class="st-muted">—</td>`;
  }).join("")}</tr>`).join("");
  const passive = slugs.map(s => `<td class="st-roll st-passive" data-action="passive" data-team="${esc(team.id)}" data-skill="${esc(s.slug)}" title="Post Passive ${esc(s.label)} to chat">${passiveFor(state, team.id, s.slug).total}</td>`).join("");
  return `<div class="st-row"><label>DC to compare against <input type="number" name="dc-${esc(team.id)}" min="0" max="60" placeholder="e.g. 19"></label><span class="st-muted">Click a modifier to roll for that person. Click a Passive Score to post it (and the result against the DC) to chat.</span></div>
    <div class="st-scroll"><table class="st-skills"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody><tfoot><tr><th>Passive Score</th>${passive}</tr></tfoot></table></div>`;
}
function stashBlock(state, team) {
  const edit = can("stashUpdate"), dis = edit ? "" : "disabled";
  const others = state.order.filter(id => id !== team.id).map(id => `<option value="${esc(id)}">${esc(state.teams[id].name)}</option>`).join("");
  const rows = team.stash.map(i => `<tr>
    <td>${i.img ? `<img src="${esc(i.img)}" alt="">` : ""}${esc(i.name)}</td>
    <td><input type="number" min="0" value="${i.qty}" data-change="stashQty" data-team="${esc(team.id)}" data-id="${esc(i.id)}" ${dis}></td>
    <td><input type="checkbox" ${i.toolkit ? "checked" : ""} data-change="stashToolkit" data-team="${esc(team.id)}" data-id="${esc(i.id)}" ${dis} title="Toolkit: item bonus equals its Uses"></td>
    <td>${i.toolkit ? `<input type="number" min="0" max="99" value="${i.uses}" data-change="stashUses" data-team="${esc(team.id)}" data-id="${esc(i.id)}" ${dis}>` : ""}</td>
    <td>${i.toolkit && edit ? `<button type="button" data-action="useToolkit" data-team="${esc(team.id)}" data-id="${esc(i.id)}" ${i.uses > 0 ? "" : "disabled"}>Use (${sign(i.uses)})</button>` : ""}</td>
    <td>${edit && others ? `<select data-change="stashMove" data-team="${esc(team.id)}" data-id="${esc(i.id)}"><option value="">Give to…</option>${others}</select>` : ""}</td>
    <td>${edit ? `<button type="button" class="st-x" data-action="stashRemove" data-team="${esc(team.id)}" data-id="${esc(i.id)}" title="Remove"><i class="fa-solid fa-xmark"></i></button>` : ""}</td></tr>`).join("");
  return `${team.stash.length ? `<table class="st-stash"><thead><tr><th>Item</th><th>Qty</th><th>Toolkit</th><th>Uses</th><th></th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="st-muted">Empty.</p>`}
    ${edit ? `<div class="st-row"><input type="text" name="stash-new-${esc(team.id)}" placeholder="Item name"><button type="button" data-action="stashAdd" data-team="${esc(team.id)}">Add item</button><span class="st-muted">or drag an Item onto this Team</span></div>` : ""}`;
}
function teamCard(app, state, team) {
  const leader = state.members[team.leaderId];
  const budget = C.actionBudget(team), spent = C.actionsSpent(team), manage = can("assign");
  const pips = Array.from({ length: C.MAX_INJURIES }, (_, i) => `<span class="st-pip ${i < team.injuries ? "on" : ""}" ${gm() ? `data-action="injuries" data-team="${esc(team.id)}" data-n="${i + 1}"` : ""} title="Injury ${i + 1}"></span>`).join("");
  const assignments = team.assignments.map(a => { const x = C.ACTIVITIES.find(y => y.id === a.activity); return `<span class="st-tag">${esc(x.name)} (${x.cost})${manage ? ` <a data-action="unassign" data-team="${esc(team.id)}" data-id="${esc(a.id)}" title="Remove"><i class="fa-solid fa-xmark"></i></a>` : ""}</span>`; }).join("");
  const choices = C.ACTIVITIES.filter(a => a.teams).map(a => `<option value="${a.id}" ${spent + a.cost > budget ? "disabled" : ""}>${a.name} (${a.cost})</option>`).join("");
  const det = (key, label, body) => `<details data-open="${esc(team.id)}:${key}" ${app.openKeys.has(`${team.id}:${key}`) ? "open" : ""}><summary>${label}</summary>${body}</details>`;
  return `<article class="st-team" data-drop-team="${esc(team.id)}">
    <header>${gm() ? `<input class="st-name" type="text" value="${esc(team.name)}" data-change="rename" data-team="${esc(team.id)}">` : `<h3>${esc(team.name)}</h3>`}
      <span class="st-pips" title="Injuries: each is -1 to every Passive Score">${pips}</span>
      ${gm() ? `<button type="button" class="st-x" data-action="removeTeam" data-team="${esc(team.id)}" title="Delete Team"><i class="fa-solid fa-trash"></i></button>` : ""}</header>
    <div class="st-row st-actions"><strong>Actions ${spent}/${budget}</strong>
      <label title="Starts the week on or next to a Secure tile: +1 free action"><input type="checkbox" ${team.nearSecure ? "checked" : ""} data-change="nearSecure" data-team="${esc(team.id)}" ${gm() ? "" : "disabled"}> Near Secure</label>
      <label title="A PC is leading this Team this week: it can critically succeed"><input type="checkbox" ${team.pcLed ? "checked" : ""} data-change="pcLed" data-team="${esc(team.id)}" ${can("setPcLed") ? "" : "disabled"}> PC-led</label></div>
    <div class="st-row">${assignments || `<span class="st-muted">No activity assigned.</span>`}
      ${manage ? `<select data-change="assign" data-team="${esc(team.id)}"><option value="">Assign activity…</option>${choices}</select>` : ""}</div>
    <div class="st-leaderslot">${leader ? chip(state, leader, team.id) : `<span class="st-muted"><i class="fa-regular fa-star"></i> No Leader. Move a Leader here.</span>`}</div>
    <div class="st-members">${team.memberIds.map(id => chip(state, state.members[id], team.id)).join("") || `<span class="st-muted">Drag people here.</span>`}</div>
    ${det("skills", `Skills and Passive Scores`, skillTable(state, team))}
    ${det("stash", `Stash (${team.stash.length})`, stashBlock(state, team))}
    ${det("notes", `Notes`, `<textarea data-change="notes" data-team="${esc(team.id)}" ${gm() ? "" : "disabled"} rows="3">${esc(team.notes)}</textarea>`)}
  </article>`;
}
function rosterAdmin(app, state) {
  const rows = Object.values(state.members).sort((a, b) => displayName(a).localeCompare(displayName(b))).map(m => `<tr>
    <td>${esc(actorOf(m)?.name || m.name)}</td>
    <td><input type="text" value="${esc(m.alias)}" placeholder="shown to players instead of the name" data-change="alias" data-member="${esc(m.id)}"></td>
    <td><input type="checkbox" ${m.leader ? "checked" : ""} data-change="leader" data-member="${esc(m.id)}"></td>
    <td>${esc(C.teamOf(state, m.id)?.name || "—")}</td>
    <td><button type="button" class="st-x" data-action="removeMember" data-member="${esc(m.id)}" title="Remove from roster"><i class="fa-solid fa-xmark"></i></button></td></tr>`).join("");
  const folders = game.folders.filter(f => f.type === "Actor").map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join("");
  return `<details class="st-admin" data-open="admin" ${app.openKeys.has("admin") ? "open" : ""}><summary>GM: roster and week tools</summary>
    <div class="st-row"><input type="text" name="new-team" placeholder="Team name"><button type="button" data-action="addTeam">Add Team</button>
      <select name="folder"><option value="">Actor folder…</option>${folders}</select><button type="button" data-action="addFolder">Add folder to roster</button></div>
    <div class="st-row"><button type="button" data-action="refresh" title="Re-read names, levels and skills from the actor sheets">Refresh from sheets</button>
      <button type="button" data-action="recovery">Weekly Injury recovery</button><button type="button" data-action="resetWeek">Start new week</button>
      <span class="st-muted">Week ${state.week}. Drag actors from the sidebar onto a Team or the Unassigned list to add them.</span></div>
    ${rows ? `<table class="st-roster"><thead><tr><th>Actor</th><th>Alias</th><th>Leader</th><th>Team</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : ""}
  </details>`;
}
function renderApp(app) {
  const state = getState();
  const pool = C.unassigned(state).sort((a, b) => Number(b.leader) - Number(a.leader) || displayName(a).localeCompare(displayName(b)));
  const offline = authority() ? "" : `<p class="st-warn">No GM is online. Teams can be viewed but not changed.</p>`;
  return `<div class="st-body">${offline}${gm() ? rosterAdmin(app, state) : ""}
    <div class="st-layout">
      <aside class="st-pool" data-drop-team=""><h3>Unassigned (${pool.length})</h3>${pool.map(m => chip(state, m, "")).join("") || `<span class="st-muted">Everyone has a Team.</span>`}</aside>
      <div class="st-teams">${state.order.map(id => teamCard(app, state, state.teams[id])).join("") || `<p class="st-muted">No Teams yet.${gm() ? " Open the GM tools above to add one." : ""}</p>`}</div>
    </div></div>`;
}

let app = null;
function openApp() { app ??= new TeamsApp(); app.render(true); return app; }
const rerender = () => { if (app?.rendered) app.render(); Hooks.callAll("settlementTeams.changed", getState()); };

/* ------------------------------------------------------------------ */
Hooks.once("init", () => {
  game.settings.register(ID, "state", { scope: "world", config: false, type: Object, default: C.blankState(), onChange: rerender });
  game.settings.register(ID, "teamSkillMethod", { name: "Team skill modifier", hint: "How a Team's own modifier in a skill is taken from its members.", scope: "world", config: true, type: String, default: "highest", choices: { highest: "Highest member", average: "Average of members", lowest: "Lowest member" }, onChange: rerender });
  game.settings.register(ID, "leaderMode", { name: "Leader's contribution", hint: "How an attached Leader changes the Team's Passive Score.", scope: "world", config: true, type: String, default: "add", choices: { add: "Add the Leader's modifier to the Team's", higher: "Use whichever is higher", none: "No change" }, onChange: rerender });
  game.settings.register(ID, "playersCanManage", { name: "Players can manage Teams", hint: "Players may move people between Teams and assign weekly activities.", scope: "world", config: true, type: Boolean, default: true, onChange: rerender });
  game.settings.register(ID, "playersCanEditStash", { name: "Players can edit Stashes", scope: "world", config: true, type: Boolean, default: true, onChange: rerender });
  game.settings.register(ID, "showPortraits", { name: "Show portraits to players", hint: "Applies the next time the roster is refreshed.", scope: "world", config: true, type: Boolean, default: true });
  game.modules.get(ID).api = {
    open: openApp, getState,
    getTeams: () => { const s = getState(); return s.order.map(id => s.teams[id]); },
    getTeam: id => getState().teams[id] || null,
    getMembers: teamId => { const s = getState(), t = s.teams[teamId]; return t ? [t.leaderId, ...t.memberIds].map(id => s.members[id]).filter(Boolean) : []; },
    getPassiveScore: (teamId, slug, toolkit = 0) => passiveFor(getState(), teamId, slug, toolkit),
    degree: C.degree, ACTIVITIES: C.ACTIVITIES,
    actionBudget: teamId => { const t = getState().teams[teamId]; return t ? { budget: C.actionBudget(t), spent: C.actionsSpent(t) } : null; },
    moveMember: (memberId, teamId) => request("moveMember", { memberId, teamId }),
    assign: (teamId, activity, note) => request("assign", { teamId, activity, note }),
    setInjuries: (teamId, injuries) => request("setInjuries", { teamId, injuries }),
    adjustInjuries: (teamId, delta) => request("adjustInjuries", { teamId, delta }),
    setNearSecure: (teamId, value) => request("setNearSecure", { teamId, value }),
    setLocation: (teamId, sceneId, hexKey) => request("setLocation", { teamId, sceneId, hexKey }),
    useToolkit: (teamId, itemId) => request("useToolkit", { teamId, itemId }),
    resetWeek: () => request("resetWeek"), refresh: () => request("refresh")
  };
});
Hooks.once("ready", () => {
  game.socket.on(CHANNEL, onSocket);
  if (!gm()) return;
  // Keep the published summaries in step with the actor sheets.
  let timer = null;
  Hooks.on("updateActor", actor => {
    if (!host() || !getState().members[actor.id]) return;
    clearTimeout(timer); timer = setTimeout(() => request("refresh").catch(() => {}), 1500);
  });
});
Hooks.on("getSceneControlButtons", controls => {
  const control = controls.tokens || controls.token || Object.values(controls).find(c => c?.tools);
  if (!control?.tools) return;
  const tool = { name: "settlementTeams", title: "Teams", icon: "fa-solid fa-people-group", button: true, visible: true, onChange: () => openApp(), onClick: () => openApp() };
  if (Array.isArray(control.tools)) control.tools.push(tool);
  else { tool.order = Object.keys(control.tools).length; control.tools.settlementTeams = tool; }
});
