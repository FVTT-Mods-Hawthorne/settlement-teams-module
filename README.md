# Settlement Teams — v0.1.0

Teams and Leaders for a weekly settlement game on Foundry VTT (v13/v14, built for PF2e NPCs but not tied to it). One of three planned modules: **Teams** (this one), **Tiles** (settlement-hex-manager) and **Settlement**.

> **Untested in Foundry.** The rules code and the window's HTML are covered by Node tests (`node --test tests/core.test.mjs tests/ui.smoke.mjs`), but nothing here has run in a live world yet. Back up the world before enabling it and report console errors (F12).

## Install

Unzip into `Data/modules/settlement-teams/` (so that `module.json` is directly inside that folder), restart Foundry, enable **Settlement Teams**.

Open the window from the **Teams** button in the token scene controls, or with a macro: `game.modules.get("settlement-teams").api.open()`.

## What it does

- **Roster from real NPC actors.** The GM adds actors (a whole Actor folder at once, or by dragging actors onto the window). Each Team member stays a full NPC.
- **Players never need access to the NPCs.** The GM's client publishes a summary of each person (name or alias, portrait, level, skill modifiers). Players work only from that summary, so no Limited/Observer/Owner permission is needed and they cannot open the sheets. Give someone an **alias** and their real name and portrait are not sent to players at all.
- **Players manage who is on which Team** by dragging people between Teams or using the dropdown on each person. Changes go to the GM's client, which applies them. (Setting: *Players can manage Teams*.)
- **Leaders** are roster entries flagged as Leader. A Leader takes a Team's leader slot instead of a member slot.
- **Skill breakdown per Team:** a table of every member's modifiers. Click a modifier to roll that skill (the GM gets the system's own roll; players get a plain d20 + modifier). The bottom row is the Team's **Passive Score** per skill; click it to post it to chat, with the degree of success against the DC you typed. Teams cannot critically succeed unless **PC-led** is ticked.
- **Passive Score** = 10 + Team skill modifier + Leader - Injuries. Two settings decide the parts: *Team skill modifier* (highest member, average, or lowest) and *Leader's contribution* (add, use the higher, or none).
- **Injuries:** four slots per Team, each -1 to every Passive Score. The GM clicks the pips. **Weekly Injury recovery** rolls a flat DC 15 check per Injury (natural 20 heals 2) and applies it.
- **Weekly actions:** 2 per Team, +1 when **Near Secure** is ticked. Assign Travel, Explore, Forage, Work, Improve, Craft, Research or Recover; the budget is enforced. **Start new week** clears assignments.
- **Stash per Team:** items with quantities, by typing a name or dragging an Item on. Mark an item as a **Toolkit** and give it Uses: *Use* posts the item bonus (equal to its Uses) to chat and takes 1 Use off. Items can be handed to another Team.

## For the Tiles and Settlement modules

`game.modules.get("settlement-teams").api`:

| Call | Returns / does |
|---|---|
| `getTeams()`, `getTeam(id)`, `getMembers(teamId)`, `getState()` | Read-only copies |
| `getPassiveScore(teamId, skillSlug, toolkitBonus?)` | `{ total, parts }` |
| `degree(score, dc, { canCrit })` | PF2e degree of success |
| `actionBudget(teamId)` | `{ budget, spent }` |
| `assign(teamId, activityId, note?)` | Adds an activity, rejects if over budget |
| `setInjuries(teamId, n)`, `adjustInjuries(teamId, delta)` | For mishaps and events |
| `setNearSecure(teamId, bool)`, `setLocation(teamId, sceneId, hexKey)` | For the Tiles module to drive |
| `useToolkit(teamId, itemId)`, `resetWeek()`, `refresh()` | |

The hook `settlementTeams.changed` fires with the new state after every change. State lives in one world setting (`settlement-teams.state`); only the hosting GM's client writes it.

## Known gaps

- PCs are not tracked as units (their 3 actions, Aid).
- Activities are assigned and budgeted but not resolved here; resolution needs tile DCs from the Tiles module.
- Leader Feats, Fortune rerolls and Team training are not modelled yet.
- Team members' skill numbers update when the GM is online (on sheet changes, or *Refresh from sheets*).
