#!/bin/zsh
# Accounting document feed (spec docs/superpowers/specs/2026-11-19-accounting-document-feed-design.md, Piece S,
# in the claude_code repo): quickbooks-sync must be allowed to drain `accounting_document`, the event the Inbox Sweep
# posts (INBOX_SWEEP_ACCOUNTING=on), and to file its daily "needs attention" note (quickbooks-sync PR 21,
# src/ap/documents.py: action_type ap_documents_attention on the built-in notes hand, level_required 2).
#   - The quickbooks-sync AGENT_POLICY entry gains events.drain_types += accounting_document,
#     propose.action_types += ap_documents_attention and propose.hands += notes (each only if missing; an entry with
#     propose null gets propose {hands:[notes], action_types:[ap_documents_attention]}). An agent with no entry is
#     unrestricted (it may already drain and file anything), so then nothing is added and no entry is created.
#   - Delivery is the trust ledger, not this policy: with no ledger row at level >= 2 for
#     (<agent>, dearborn-denim, ap_documents_attention) the note arrives as an Approve/Edit/Reject card. The script
#     prints the promote command for that; it runs nothing.
#   - Post: the sweep inserts the event in-process (insertEvent, source_hand inbox-sweep); AGENT_POLICY only governs
#     HTTP keys, so there is nothing to grant. If an `inbox-sweep` entry ever exists, its post_types gain the type.
# Reads the live AGENT_POLICY and AGENT_KEYS through `railway run` (read only), adds only what is missing (idempotent),
# validates the result with McSecretary's own parseAgentPolicy against the AGENT_KEYS names (a bad AGENT_POLICY stops
# the boot) and writes it to $OUT (default ~/.foreman/agent-policy.accounting-documents.json, mode 600). It never sets
# anything: it prints the Railway command to apply it. Run from the McSecretary checkout (Railway-linked).
# Order: apply before turning INBOX_SWEEP_ACCOUNTING=on, or quickbooks-sync's drain of the type is refused (403).
# QBS_AGENT (default quickbooks-sync) is the AGENT_KEYS name of the key quickbooks-sync's SPINE_EVENT_KEY belongs to.
# Usage: scripts/policy-accounting-documents.sh
# Dry run on a local file (no Railway; the sample is reconstructed from the payables plan, NOT the live value):
#   LOCAL_POLICY=scripts/policy-accounting-documents.sample-before.json OUT=/tmp/x.json scripts/policy-accounting-documents.sh
#   (the result equals scripts/policy-accounting-documents.sample-after.json; a second run on it adds nothing)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${OUT:-$HOME/.foreman/agent-policy.accounting-documents.json}  # outside the repo: never commit the live policy
QBS_AGENT=${QBS_AGENT:-quickbooks-sync}
if [[ -n ${LOCAL_POLICY:-} ]]; then
  RUN=(env "AGENT_POLICY=$(cat $LOCAL_POLICY)" "AGENT_KEYS=${LOCAL_KEYS:-${QBS_AGENT}:local}")
else
  RUN=(railway run --)
fi
export OUT QBS_AGENT; "${RUN[@]}" node --import tsx -e '
const fs = require("fs");
(async () => {
  const { parseAgentPolicy, matchesType } = await import("./src/spine/agent-policy.ts");
  const TYPE = "accounting_document";
  const NOTE = "ap_documents_attention";
  const agent = process.env.QBS_AGENT;
  const names = (process.env.AGENT_KEYS ?? "").split(",").map((s) => s.split(":")[0].trim()).filter(Boolean);
  if (!names.includes(agent)) throw new Error("AGENT_KEYS has no key named " + agent + "; set QBS_AGENT to the name quickbooks-sync drains with");
  const p = process.env.AGENT_POLICY ? JSON.parse(process.env.AGENT_POLICY) : {};
  const added = [];
  const e = p[agent];
  if (!e) {
    console.log(agent + " has no AGENT_POLICY entry: unrestricted, it may already drain " + TYPE + " and file " + NOTE + " on notes; no entry created");
  } else {
    e.events ??= {};
    e.events.drain_types ??= [];
    if (!matchesType(e.events.drain_types, TYPE)) { e.events.drain_types.push(TYPE); added.push(agent + ".events.drain_types += " + TYPE); }
    e.propose ??= { hands: [], action_types: [] };
    e.propose.hands ??= [];
    e.propose.action_types ??= [];
    if (!e.propose.action_types.includes(NOTE)) { e.propose.action_types.push(NOTE); added.push(agent + ".propose.action_types += " + NOTE); }
    if (!e.propose.hands.includes("notes")) { e.propose.hands.push("notes"); added.push(agent + ".propose.hands += notes"); }
  }
  const sweep = p["inbox-sweep"];
  if (sweep) {
    sweep.events ??= {};
    sweep.events.post_types ??= [];
    if (!matchesType(sweep.events.post_types, TYPE)) { sweep.events.post_types.push(TYPE); added.push("inbox-sweep.events.post_types += " + TYPE); }
  } else {
    console.log("the sweep posts " + TYPE + " in-process (no HTTP key): nothing to grant for the post");
  }
  const raw = JSON.stringify(p);
  parseAgentPolicy(raw, names);
  fs.writeFileSync(process.env.OUT, raw, { mode: 0o600 });
  console.log("validated; added: " + (added.join(", ") || "nothing (already allowed)"));
  if (e) console.log(agent + " now: " + JSON.stringify(e));
  process.exit(added.length > 0 ? 0 : 3);
})().catch((err) => { console.error("STOPPED, nothing written: " + err.message); process.exit(1); });' && CHANGED=1 || { rc=$?; [[ $rc == 3 ]] || exit $rc; CHANGED=0; }
if [[ $CHANGED == 1 ]]; then
  echo "Wrote $OUT. Nothing was set. To apply (one McSecretary redeploy), from the Railway-linked checkout:"
  echo "  railway variables --set \"AGENT_POLICY=\$(cat $OUT)\""
else
  echo "Wrote $OUT (unchanged policy). No Railway change is needed."
fi
echo "Note delivery: ap_documents_attention files at level_required 2; until the trust ledger has it at level 2 it is a card."
echo "  To deliver it as a plain note (executed + one Telegram line, no buttons), Robert promotes it once, e.g. on Telegram:"
echo "  promote $QBS_AGENT ap_documents_attention 2   (or: npx tsx src/admin.ts promote --agent $QBS_AGENT --action ap_documents_attention --level 2)"
