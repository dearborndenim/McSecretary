#!/bin/zsh
# Gives Frank (Merab's Grok assistant) his own McSecretary key, limited to his own task queue.
# Adds grok-frank to AGENT_KEYS and AGENT_POLICY on Railway in one deploy, after validating
# the policy with McSecretary's own parser (a bad AGENT_POLICY stops the boot).
# The key is read from ~/.foreman/frank-key.txt and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
KEYFILE=~/.foreman/frank-key.txt
[[ -s $KEYFILE ]] || { echo "missing $KEYFILE"; exit 1; }
TMP=$(mktemp -d); chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
FRANK_KEY="$(cat $KEYFILE)" OUT="$TMP" railway run -- node --import tsx -e '
const fs = require("fs");
(async () => {
  const { parseAgentPolicy } = await import("./src/spine/agent-policy.ts");
  const keys = process.env.AGENT_KEYS;
  if (/(^|,)grok-frank:/.test(keys)) throw new Error("grok-frank is already in AGENT_KEYS");
  const newKeys = keys + ",grok-frank:" + process.env.FRANK_KEY;
  const p = JSON.parse(process.env.AGENT_POLICY);
  p["grok-frank"] = { propose: null,
    events: { post_types: ["grok_result", "grok_report", "grok_profile", "grok_daily"], drain_types: ["grok_task_frank"], source_hand: "self" },
    hands_proxy: false, outcomes: false, brands: false, runs: false, rate: { events_per_hour: 300 } };
  const raw = JSON.stringify(p);
  parseAgentPolicy(raw, newKeys.split(",").map((s) => s.split(":")[0]));
  fs.writeFileSync(process.env.OUT + "/keys", newKeys, { mode: 0o600 });
  fs.writeFileSync(process.env.OUT + "/policy", raw, { mode: 0o600 });
  console.log("validated: grok-frank may drain grok_task_frank and post grok_result/report/profile/daily only");
})().catch((e) => { console.error("STOPPED, nothing changed: " + e.message); process.exit(1); });'
railway variables --set "AGENT_KEYS=$(cat $TMP/keys)" --set "AGENT_POLICY=$(cat $TMP/policy)" >/dev/null
echo "Set on Railway; McSecretary is redeploying. Next: pbcopy < $KEYFILE, then paste into Frank's MCSECRETARY_FRANK_KEY secret."
