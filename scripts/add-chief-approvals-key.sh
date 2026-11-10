#!/bin/zsh
# Gives Chief a second McSecretary key, grok-chief-approvals, used ONLY to relay Robert's
# decisions on the Chief digest (event chief_draft_decision; spec 2026-11-10-chief-digest-design.md).
# Chief keeps the shared grok-bots key for everything else. McSecretary accepts
# chief_draft_decision from this key alone; the policy below lets it post nothing else and
# drain nothing. Adds the key to AGENT_KEYS and the entry to AGENT_POLICY on Railway in one
# deploy, validated with McSecretary's own parsers first (a bad AGENT_POLICY stops the boot).
# The key is made in ~/.foreman/chief-approvals-key.txt (mode 600) if it is not there, and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
KEYFILE=~/.foreman/chief-approvals-key.txt
if [[ ! -s $KEYFILE ]]; then (umask 077; openssl rand -hex 32 | tr -d '\n' > $KEYFILE); echo "made $KEYFILE"; fi
TMP=$(mktemp -d); chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
NEW_KEY="$(cat $KEYFILE)" OUT="$TMP" railway run -- node --import tsx -e '
const fs = require("fs");
(async () => {
  const { parseAgentPolicy } = await import("./src/spine/agent-policy.ts");
  const agent = "grok-chief-approvals";
  const keys = process.env.AGENT_KEYS;
  if (new RegExp("(^|,)" + agent + ":").test(keys)) throw new Error(agent + " is already in AGENT_KEYS");
  const newKeys = keys + "," + agent + ":" + process.env.NEW_KEY;
  const p = JSON.parse(process.env.AGENT_POLICY);
  p[agent] = { propose: null,
    events: { post_types: ["chief_draft_decision"], drain_types: [], source_hand: "self" },
    hands_proxy: false, outcomes: false, brands: false, runs: false, rate: { events_per_hour: 60 } };
  const raw = JSON.stringify(p);
  parseAgentPolicy(raw, newKeys.split(",").map((s) => s.split(":")[0]));
  fs.writeFileSync(process.env.OUT + "/keys", newKeys, { mode: 0o600 });
  fs.writeFileSync(process.env.OUT + "/policy", raw, { mode: 0o600 });
  console.log("validated: " + agent + " may post chief_draft_decision only (as source_hand " + agent + "), drains nothing");
})().catch((e) => { console.error("STOPPED, nothing changed: " + e.message); process.exit(1); });'
railway variables --set "AGENT_KEYS=$(cat $TMP/keys)" --set "AGENT_POLICY=$(cat $TMP/policy)" >/dev/null
echo "Set on Railway; McSecretary is redeploying. Next: pbcopy < $KEYFILE, then paste it into Chief's MCSECRETARY_CHIEF_APPROVALS_KEY secret form."
