#!/bin/zsh
# Lets a staff Grok assistant's own key send instant actions (grok_action), e.g. frank.
# Adds grok_action to grok-<bot>'s AGENT_POLICY post_types, validated with McSecretary's own
# parser first (a bad AGENT_POLICY stops the boot). No key values are read or printed.
# Usage: allow-assistant-actions.sh <bot>
set -euo pipefail
cd "$(dirname "$0")/.."
BOT=${1:?usage: allow-assistant-actions.sh <bot>}
TMP=$(mktemp -d); chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
AGENT="grok-$BOT" OUT="$TMP" railway run -- node --import tsx -e '
const fs = require("fs");
(async () => {
  const { parseAgentPolicy } = await import("./src/spine/agent-policy.ts");
  const agent = process.env.AGENT;
  const p = JSON.parse(process.env.AGENT_POLICY);
  const e = p[agent];
  if (!e || !e.events) throw new Error(agent + " has no AGENT_POLICY entry");
  if (e.events.post_types.includes("grok_action")) throw new Error(agent + " already has grok_action");
  e.events.post_types.push("grok_action");
  const raw = JSON.stringify(p);
  parseAgentPolicy(raw, process.env.AGENT_KEYS.split(",").map((s) => s.split(":")[0]));
  fs.writeFileSync(process.env.OUT + "/policy", raw, { mode: 0o600 });
  console.log("validated: " + agent + " may post " + e.events.post_types.join(", "));
})().catch((e) => { console.error("STOPPED, nothing changed: " + e.message); process.exit(1); });'
railway variables --set "AGENT_POLICY=$(cat $TMP/policy)" >/dev/null
echo "Set on Railway; McSecretary is redeploying."
