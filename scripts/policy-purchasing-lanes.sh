#!/bin/zsh
# Purchasing lanes (spec docs/superpowers/specs/2026-10-31-purchasing-approval-and-fast-lane.md §7, plan Build 4
# Task 4.3, in the claude_code repo): the kanban-purchaser AGENT_POLICY entry gains
#   propose.action_types += po_fast_lane
#   events.drain_types   += po_fast_lane_rejected, po_fast_lane_expired
# Reads the live AGENT_POLICY through `railway run`, adds only what is missing (idempotent), validates the result
# with McSecretary's own parseAgentPolicy against the live AGENT_KEYS names (a bad AGENT_POLICY stops the boot),
# and writes it to $OUT (default ~/.foreman/agent-policy.purchasing-lanes.json, mode 600). It sets nothing unless --set is
# given; with --set it sets AGENT_POLICY on Railway (one deploy). Run from the McSecretary checkout (Railway-linked).
# Order: set this BEFORE kanban Build 2 deploys, or kanban's filer is refused po_fast_lane and retries with backoff.
# Usage: scripts/policy-purchasing-lanes.sh [--set]
# Dry run on a local file (no Railway; the sample is reconstructed from the purchasing plans, NOT the live value): LOCAL_POLICY=scripts/policy-purchasing-lanes.sample-before.json OUT=/tmp/x.json scripts/policy-purchasing-lanes.sh
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${OUT:-$HOME/.foreman/agent-policy.purchasing-lanes.json}  # outside the repo: never commit the live policy
if [[ -n ${LOCAL_POLICY:-} ]]; then
  RUN=(env "AGENT_POLICY=$(cat $LOCAL_POLICY)" "AGENT_KEYS=kanban-purchaser:local")
else
  RUN=(railway run --)
fi
OUT="$OUT" $RUN node --import tsx -e '
const fs = require("fs");
(async () => {
  const { parseAgentPolicy } = await import("./src/spine/agent-policy.ts");
  const p = JSON.parse(process.env.AGENT_POLICY);
  const e = p["kanban-purchaser"];
  if (!e) throw new Error("AGENT_POLICY has no kanban-purchaser entry (it is unrestricted); nothing to add");
  if (!e.propose || !Array.isArray(e.propose.action_types)) throw new Error("kanban-purchaser has no propose.action_types list");
  e.events ??= {};
  e.events.drain_types ??= [];
  const add = (list, v) => { if (!list.includes(v)) { list.push(v); return [v]; } return []; };
  const added = [
    ...add(e.propose.action_types, "po_fast_lane"),
    ...add(e.events.drain_types, "po_fast_lane_rejected"),
    ...add(e.events.drain_types, "po_fast_lane_expired"),
  ];
  const raw = JSON.stringify(p);
  parseAgentPolicy(raw, process.env.AGENT_KEYS.split(",").map((s) => s.split(":")[0]));
  fs.writeFileSync(process.env.OUT, raw, { mode: 0o600 });
  console.log("validated; added: " + (added.join(", ") || "nothing (already present)"));
  console.log("kanban-purchaser now: " + JSON.stringify(e));
})().catch((err) => { console.error("STOPPED, nothing changed: " + err.message); process.exit(1); });'
if [[ ${1:-} == --set && -z ${LOCAL_POLICY:-} ]]; then
  railway variables --set "AGENT_POLICY=$(cat $OUT)" >/dev/null
  echo "AGENT_POLICY set on Railway; McSecretary is redeploying. Check GET /spine/policy/self with kanban's key."
else
  echo "Wrote $OUT. Not set. Re-run with --set to apply."
fi
