#!/usr/bin/env bash
# Deploys the Scrubber Duckies notification sender (the Cloud Function in /functions).
# Run from Google Cloud Shell:  bash scripts/deploy-push.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT=scrubber-duckies
FB="npx --yes firebase-tools@latest"

echo "🦆 Getting things ready (about a minute)…"
npm install --prefix functions --no-audit --no-fund --loglevel=error

deploy() { $FB deploy --only functions --project "$PROJECT" --force; }

echo "🦆 Sending it to Firebase (a few minutes the first time)…"
if ! deploy; then
  echo
  echo "🦆 Firebase needs you to sign in. Open the link below, sign in with the same Google account,"
  echo "   then copy the code it gives you and paste it here."
  $FB login --no-localhost
  deploy
fi
echo
echo "✅ All done! Notifications are switched on. Turn them on in the app: Pond → Notifications."
