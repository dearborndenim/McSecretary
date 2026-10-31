#!/bin/zsh
# Legal agent (claude_code plan docs/superpowers/plans/2026-10-31-legal-phase-1.md Task 5, spec
# docs/superpowers/specs/2026-10-30-legal-plan.md): a `legal` key in AGENT_KEYS and a notes-only AGENT_POLICY entry
#   propose: hands [notes], action_types legal_deadline_90d/30d/7d/overdue, legal_weekly_docket
#   events.drain_types [run_request_legal]; runs true; hands_proxy, outcomes, brands, files false; 40 proposals/hour
# 1. The key: reuses the `legal=` line of $KEYS_FILE (default ~/.foreman/agent-keys, what the kit reads), or generates
#    one with `openssl rand -hex 24` and appends it (file kept mode 600). The key is never printed.
# 2. Reads the live AGENT_KEYS and AGENT_POLICY through `railway run`, adds `legal:<key>` and the `legal` entry only when
#    absent (idempotent; an existing entry is left as is and reported; a live legal key that differs from the local one
#    stops the script), validates both with McSecretary's own parseAgentKeys and parseAgentPolicy (a bad value stops
#    the boot), and writes them to $KEYS_OUT (default ~/.foreman/agent-keys.legal.csv) and $OUT (default
#    ~/.foreman/agent-policy.legal.json), mode 600, outside the repo.
# 3. Sets nothing unless --set is given; with --set it sets AGENT_KEYS and AGENT_POLICY in ONE railway call (one deploy;
#    a policy entry naming an agent with no key fails McSecretary's boot, so the two must land together).
# Run from the McSecretary checkout (Railway-linked).
# Usage: scripts/policy-legal.sh [--set]
# Dry run on local values (no Railway; the sample is reconstructed, NOT the live value; use a scratch key file):
#   KEYS_FILE=/tmp/agent-keys LOCAL_POLICY=scripts/policy-legal.sample-before.json LOCAL_KEYS=finance:x,kanban-purchaser:y \
#     OUT=/tmp/legal-policy.json KEYS_OUT=/tmp/legal-keys.csv scripts/policy-legal.sh
set -euo pipefail
cd "$(dirname "$0")/.."
KEYS_FILE=${KEYS_FILE:-$HOME/.foreman/agent-keys}
OUT=${OUT:-$HOME/.foreman/agent-policy.legal.json}          # outside the repo: never commit the live policy
KEYS_OUT=${KEYS_OUT:-$HOME/.foreman/agent-keys.legal.csv}   # holds every live key: never commit, never print

# 1. The local key.
umask 077
mkdir -p "$(dirname $KEYS_FILE)"
touch $KEYS_FILE
chmod 600 $KEYS_FILE
if grep -q '^legal=' $KEYS_FILE; then
  echo "legal key: reused from $KEYS_FILE"
else
  [[ -s $KEYS_FILE && $(tail -c1 $KEYS_FILE | od -An -c | tr -d ' ') != '\n' ]] && printf '\n' >> $KEYS_FILE
  printf 'legal=%s\n' "$(openssl rand -hex 24)" >> $KEYS_FILE
  echo "legal key: generated and appended to $KEYS_FILE"
fi
LEGAL_NEW_KEY=$(grep '^legal=' $KEYS_FILE | head -1 | cut -d= -f2-)
[[ ${#LEGAL_NEW_KEY} -ge 16 ]] || { echo "STOPPED, nothing changed: the legal= line in $KEYS_FILE is shorter than 16 chars"; exit 1; }

# 2. Read, add, validate, write.
if [[ -n ${LOCAL_POLICY:-} ]]; then
  RUN=(env "AGENT_POLICY=$(cat $LOCAL_POLICY)" "AGENT_KEYS=${LOCAL_KEYS:?LOCAL_KEYS is required with LOCAL_POLICY}" LEGAL_LOCAL=1)
else
  RUN=(railway run --)
fi
export OUT KEYS_OUT LEGAL_NEW_KEY
RESULT=$("${RUN[@]}" node --import tsx -e '
const fs = require("fs");
(async () => {
  const { parseAgentPolicy } = await import("./src/spine/agent-policy.ts");
  const { parseAgentKeys } = await import("./src/spine/agent-keys.ts");
  const minLength = process.env.LEGAL_LOCAL ? undefined : 16;
  const key = process.env.LEGAL_NEW_KEY;
  const rawKeys = process.env.AGENT_KEYS || "";
  const names = [...parseAgentKeys(rawKeys, { minLength }).values()];
  const parts = rawKeys.split(",").map((s) => s.trim()).filter(Boolean);
  const live = parts.find((s) => s.slice(0, s.indexOf(":")).trim() === "legal");
  let keyChange = "already present";
  if (live) {
    if (live.slice(live.indexOf(":") + 1).trim() !== key) throw new Error("AGENT_KEYS already has a legal key that differs from the local one; fix by hand, the kit would get 401");
  } else {
    parts.push("legal:" + key);
    keyChange = "added";
  }
  const newKeys = parts.join(",");
  const p = process.env.AGENT_POLICY ? JSON.parse(process.env.AGENT_POLICY) : {};
  let policyChange = "already present (left as is)";
  if (!p.legal) {
    p.legal = {
      propose: { hands: ["notes"], action_types: ["legal_deadline_90d", "legal_deadline_30d", "legal_deadline_7d", "legal_deadline_overdue", "legal_weekly_docket"] },
      events: { drain_types: ["run_request_legal"] },
      hands_proxy: false, outcomes: false, brands: false, runs: true, files: false,
      rate: { proposals_per_hour: 40 },
    };
    policyChange = "added";
  }
  const raw = JSON.stringify(p);
  const known = [...parseAgentKeys(newKeys, { minLength }).values()];
  parseAgentPolicy(raw, known);
  fs.writeFileSync(process.env.OUT, raw, { mode: 0o600 });
  fs.writeFileSync(process.env.KEYS_OUT, newKeys, { mode: 0o600 });
  console.log("validated with parseAgentKeys + parseAgentPolicy; agents with keys: " + known.length + " (was " + names.length + ")");
  console.log("AGENT_KEYS legal: " + keyChange);
  console.log("AGENT_POLICY legal: " + policyChange);
  console.log("legal now: " + JSON.stringify(p.legal));
  console.log(keyChange === "added" || policyChange === "added" ? "changes: yes" : "changes: none");
})().catch((err) => { console.error("STOPPED, nothing changed: " + err.message); process.exit(1); });')
print -r -- "$RESULT"

# 3. Apply, only on --set, only when something changed.
SET_CMD='cd ~/Documents/Claude/claude_code/McSecretary && scripts/policy-legal.sh --set'
if [[ ${1:-} == --set && -z ${LOCAL_POLICY:-} ]]; then
  if [[ $RESULT == *"changes: none"* ]]; then
    echo "Nothing to set: Railway already has the legal key and policy."
  else
    railway variables --set "AGENT_KEYS=$(cat $KEYS_OUT)" --set "AGENT_POLICY=$(cat $OUT)" >/dev/null
    echo "AGENT_KEYS and AGENT_POLICY set on Railway in one change; McSecretary is redeploying. Check GET /spine/policy/self with the legal key (restricted: true)."
  fi
else
  echo "Wrote $OUT and $KEYS_OUT. Not set."
  echo "To apply (Rob runs this if the classifier blocks Claude): $SET_CMD"
fi
