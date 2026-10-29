#!/bin/zsh
# Gives a staff Grok assistant its own McSecretary key (agent grok-<bot>), limited to its own
# task queue grok_task_<bot>, its replies and instant actions (grok_action). Generalises
# add-frank-key.sh. Adds the key to AGENT_KEYS and the policy to AGENT_POLICY on Railway in one
# deploy, validated with McSecretary's own parser first (a bad AGENT_POLICY stops the boot).
# The key is made in ~/.foreman/<bot>-key.txt (mode 600) if it is not there, and never printed.
# Usage: add-assistant-key.sh <bot>     e.g. add-assistant-key.sh kristina
set -euo pipefail
cd "$(dirname "$0")/.."
BOT=${1:?usage: add-assistant-key.sh <bot>}
[[ $BOT =~ '^[a-z][a-z0-9-]{1,30}$' ]] || { echo "bot must be a lowercase slug"; exit 1; }
case $BOT in bots|operator|chief|inbox|task) echo "$BOT is reserved"; exit 1;; esac
KEYFILE=~/.foreman/$BOT-key.txt
if [[ ! -s $KEYFILE ]]; then (umask 077; openssl rand -hex 32 | tr -d '\n' > $KEYFILE); echo "made $KEYFILE"; fi
TMP=$(mktemp -d); chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
BOT="$BOT" NEW_KEY="$(cat $KEYFILE)" OUT="$TMP" railway run -- node --import tsx -e '
const fs = require("fs");
(async () => {
  const { parseAgentPolicy } = await import("./src/spine/agent-policy.ts");
  const bot = process.env.BOT, agent = "grok-" + bot;
  const keys = process.env.AGENT_KEYS;
  if (new RegExp("(^|,)" + agent + ":").test(keys)) throw new Error(agent + " is already in AGENT_KEYS");
  const newKeys = keys + "," + agent + ":" + process.env.NEW_KEY;
  const p = JSON.parse(process.env.AGENT_POLICY);
  p[agent] = { propose: null,
    events: { post_types: ["grok_result", "grok_report", "grok_profile", "grok_daily", "grok_action"], drain_types: ["grok_task_" + bot], source_hand: "self" },
    hands_proxy: false, outcomes: false, brands: false, runs: false, rate: { events_per_hour: 300 } };
  const raw = JSON.stringify(p);
  parseAgentPolicy(raw, newKeys.split(",").map((s) => s.split(":")[0]));
  fs.writeFileSync(process.env.OUT + "/keys", newKeys, { mode: 0o600 });
  fs.writeFileSync(process.env.OUT + "/policy", raw, { mode: 0o600 });
  console.log("validated: " + agent + " may drain grok_task_" + bot + " and post grok_result/report/profile/daily/action only");
})().catch((e) => { console.error("STOPPED, nothing changed: " + e.message); process.exit(1); });'
railway variables --set "AGENT_KEYS=$(cat $TMP/keys)" --set "AGENT_POLICY=$(cat $TMP/policy)" >/dev/null
echo "Set on Railway; McSecretary is redeploying. Next: pbcopy < $KEYFILE, then paste it into the assistant's MCSECRETARY_${(U)BOT//-/_}_KEY secret form."
