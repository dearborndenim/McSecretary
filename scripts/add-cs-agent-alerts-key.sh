#!/bin/zsh
# Gives the customer-service bot's outage alerts (dearborn-ai-agents src/services/health-monitor.ts)
# their own McSecretary key, agent cs-agent-alerts, kept apart from the CS bot's cs-agent key on
# purpose: that key's cards stay off. Policy: file cs_agent_alert on the email hand only (code also
# limits it to @dearborndenim.com recipients, src/spine/cs-agent-alerts.ts) and post grok_task_*
# events only; nothing else. Adds the key to AGENT_KEYS and the entry to AGENT_POLICY on Railway in
# one deploy, validated with McSecretary's own parsers first (a bad AGENT_POLICY stops the boot).
# The key is made in ~/.foreman/cs-agent-alerts-key.txt (mode 600) if it is not there, and never
# printed. Run from the Railway-linked McSecretary checkout. Modelled on add-assistant-key.sh.
# Usage: add-cs-agent-alerts-key.sh
set -euo pipefail
cd "$(dirname "$0")/.."
KEYFILE=~/.foreman/cs-agent-alerts-key.txt
if [[ ! -s $KEYFILE ]]; then (umask 077; openssl rand -hex 32 | tr -d '\n' > $KEYFILE); echo "made $KEYFILE"; fi
chmod 600 $KEYFILE
TMP=$(mktemp -d); chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
NEW_KEY="$(cat $KEYFILE)" OUT="$TMP" railway run -- node --import tsx -e '
const fs = require("fs");
(async () => {
  const { parseAgentPolicy } = await import("./src/spine/agent-policy.ts");
  const { parseAgentKeys } = await import("./src/spine/agent-keys.ts");
  const agent = "cs-agent-alerts";
  const keys = process.env.AGENT_KEYS || "";
  if (new RegExp("(^|,)\\s*" + agent + ":").test(keys)) throw new Error(agent + " is already in AGENT_KEYS");
  const newKeys = (keys ? keys + "," : "") + agent + ":" + process.env.NEW_KEY;
  const p = process.env.AGENT_POLICY ? JSON.parse(process.env.AGENT_POLICY) : {};
  if (p[agent]) throw new Error(agent + " already has an AGENT_POLICY entry");
  p[agent] = { propose: { hands: ["email"], action_types: ["cs_agent_alert"] },
    events: { post_types: ["grok_task_*"], drain_types: [], source_hand: "self" },
    hands_proxy: false, outcomes: false, brands: false, runs: false, files: false,
    rate: { events_per_hour: 30, proposals_per_hour: 10 } };
  const raw = JSON.stringify(p);
  parseAgentPolicy(raw, parseAgentKeys(newKeys, { minLength: 16 }).values());
  fs.writeFileSync(process.env.OUT + "/keys", newKeys, { mode: 0o600 });
  fs.writeFileSync(process.env.OUT + "/policy", raw, { mode: 0o600 });
  console.log("validated: " + agent + " may file cs_agent_alert on the email hand and post grok_task_* events only");
})().catch((e) => { console.error("STOPPED, nothing changed: " + e.message); process.exit(1); });'
railway variables --set "AGENT_KEYS=$(cat $TMP/keys)" --set "AGENT_POLICY=$(cat $TMP/policy)" >/dev/null
echo "Set on Railway; McSecretary is redeploying (its boot seeds cs_agent_alert at trust level 2)."
echo "Next, from the Railway-linked dearborn-ai-agents checkout:"
echo "  railway variables --service dda_cs_agent --set \"ALERTS_MCSECRETARY_KEY=\$(cat $KEYFILE)\" --set ALERTS_MCSECRETARY_URL=<McSecretary public URL> >/dev/null"
