#!/bin/zsh
# Legal agent (claude_code plan docs/superpowers/plans/2026-10-31-legal-phase-1.md Task 5, spec
# docs/superpowers/specs/2026-10-30-legal-plan.md): a `legal` key in AGENT_KEYS and a notes-only AGENT_POLICY entry
#   propose: hands [notes], action_types legal_deadline_90d/30d/7d/overdue, legal_weekly_docket
#   events.drain_types [run_request_legal]; runs true; hands_proxy, outcomes, brands, files false; 40 proposals/hour
# 1. Reads the live AGENT_KEYS and AGENT_POLICY through `railway run` FIRST, and the `legal=` line of $KEYS_FILE
#    (default ~/.foreman/agent-keys, what the kit reads). The key:
#      live and local both have one  -> they must match, else STOP (the kit would get 401);
#      live has one, local does not  -> STOP without writing anything: copy the key from the machine that created it;
#      local has one, live does not  -> use the local key;
#      neither has one               -> generate one (24 random bytes, hex) and append `legal=<key>` to $KEYS_FILE (600)
#                                       only after everything else has validated.
#    The key, and any malformed AGENT_KEYS entry, is never printed.
# 2. Adds `legal:<key>` to AGENT_KEYS and the `legal` entry to AGENT_POLICY only when absent (idempotent; an existing
#    entry is left as is and reported), validates both with McSecretary's own parseAgentKeys and parseAgentPolicy (a
#    bad value stops the boot), and writes them to $KEYS_OUT (default ~/.foreman/agent-keys.legal.csv) and $OUT
#    (default ~/.foreman/agent-policy.legal.json), mode 600, outside the repo.
# 3. Sets nothing unless --set is given; with --set it sets AGENT_KEYS and AGENT_POLICY in ONE railway call (one deploy;
#    a policy entry naming an agent with no key fails McSecretary's boot, so the two must land together).
# Run from the McSecretary checkout (Railway-linked), on the Mac mini that holds ~/.foreman/agent-keys.
# Usage: scripts/policy-legal.sh [--set]
# Dry run on local values (no Railway; the sample is reconstructed, NOT the live value; use a scratch key file):
#   KEYS_FILE=/tmp/agent-keys LOCAL_POLICY=scripts/policy-legal.sample-before.json LOCAL_KEYS=finance:x,kanban-purchaser:y \
#     OUT=/tmp/legal-policy.json KEYS_OUT=/tmp/legal-keys.csv scripts/policy-legal.sh
set -euo pipefail
cd "$(dirname "$0")/.."
KEYS_FILE=${KEYS_FILE:-$HOME/.foreman/agent-keys}
OUT=${OUT:-$HOME/.foreman/agent-policy.legal.json}          # outside the repo: never commit the live policy
KEYS_OUT=${KEYS_OUT:-$HOME/.foreman/agent-keys.legal.csv}   # holds every live key: never commit, never print

if [[ -n ${LOCAL_POLICY:-} ]]; then
  RUN=(env "AGENT_POLICY=$(cat $LOCAL_POLICY)" "AGENT_KEYS=${LOCAL_KEYS:?LOCAL_KEYS is required with LOCAL_POLICY}" LEGAL_LOCAL=1)
else
  RUN=(railway run --)
fi
export OUT KEYS_OUT KEYS_FILE
RESULT=$("${RUN[@]}" node --import tsx -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
(async () => {
  const { parseAgentPolicy } = await import("./src/spine/agent-policy.ts");
  const { parseAgentKeys } = await import("./src/spine/agent-keys.ts");
  const minLength = process.env.LEGAL_LOCAL ? undefined : 16;
  // parseAgentKeys names a bad entry in its message; that entry may hold a key, so say only this.
  const names = (csv) => {
    try { return [...parseAgentKeys(csv, { minLength }).values()]; }
    catch { throw new Error("malformed AGENT_KEYS entry"); }
  };

  // 1. The live side first; nothing is written until every check below has passed.
  const rawKeys = process.env.AGENT_KEYS || "";
  const before = names(rawKeys);
  const parts = rawKeys.split(",").map((s) => s.trim()).filter(Boolean);
  const livePart = parts.find((s) => s.slice(0, s.indexOf(":")).trim() === "legal");
  const liveKey = livePart ? livePart.slice(livePart.indexOf(":") + 1).trim() : null;

  const kf = process.env.KEYS_FILE;
  const keysText = fs.existsSync(kf) ? fs.readFileSync(kf, "utf8") : "";
  const localLine = keysText.split("\n").find((l) => l.startsWith("legal="));
  const localKey = localLine ? localLine.slice("legal=".length).trim() : null;
  if (localKey !== null && localKey.length < 16) throw new Error("the legal= line in " + kf + " is shorter than 16 characters");

  let key, keySource, keyChange;
  if (liveKey && localKey) {
    if (liveKey !== localKey) throw new Error("AGENT_KEYS has a legal key that differs from the one in " + kf + "; fix by hand, the kit would get 401");
    key = localKey; keySource = "reused from " + kf; keyChange = "already present";
  } else if (liveKey) {
    throw new Error("AGENT_KEYS already has a legal key but " + kf + " has no legal= line; copy the key from the machine that created it (nothing written)");
  } else if (localKey) {
    key = localKey; keySource = "reused from " + kf; keyChange = "added";
  } else {
    key = crypto.randomBytes(24).toString("hex"); keySource = "generated, appended to " + kf; keyChange = "added";
  }
  const newKeys = liveKey ? parts.join(",") : [...parts, "legal:" + key].join(",");

  // 2. The policy entry.
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
  const known = names(newKeys);
  parseAgentPolicy(raw, known);

  // 3. Every check passed: write.
  if (!localKey) {
    fs.mkdirSync(path.dirname(kf), { recursive: true });
    const sep = keysText && !keysText.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(kf, sep + "legal=" + key + "\n", { mode: 0o600 });
    fs.chmodSync(kf, 0o600);
  }
  fs.writeFileSync(process.env.OUT, raw, { mode: 0o600 });
  fs.writeFileSync(process.env.KEYS_OUT, newKeys, { mode: 0o600 });
  console.log("legal key: " + keySource);
  console.log("validated with parseAgentKeys + parseAgentPolicy; agents with keys: " + known.length + " (was " + before.length + ")");
  console.log("AGENT_KEYS legal: " + keyChange);
  console.log("AGENT_POLICY legal: " + policyChange);
  console.log("legal now: " + JSON.stringify(p.legal));
  console.log(keyChange === "added" || policyChange === "added" ? "changes: yes" : "changes: none");
})().catch((err) => { console.error("STOPPED, nothing changed: " + err.message); process.exit(1); });')
print -r -- "$RESULT"

# Apply, only on --set, only when something changed.
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
