#!/usr/bin/env bash
# Make StopTrack's app signing key — run this ONCE, on your own machine.
#
# Why: without a fixed signing key, GitHub Actions generates a throwaway
# certificate on every build, and Android refuses to install an update signed by a
# different certificate. That is why each new release currently forces an
# uninstall (which wipes local data). With this key in place, updates install over
# each other normally, forever.
#
# The key never leaves your machine — this prints the four values to paste into
# GitHub, and you keep the .jks file.
#
# Usage:  bash android/make-signing-key.sh
set -euo pipefail

OUT="${1:-stoptrack-release.jks}"
ALIAS="stoptrack"

command -v keytool >/dev/null 2>&1 || {
  echo "keytool not found. Install a JDK (e.g. 'sudo apt install default-jdk',"
  echo "'brew install openjdk', or Android Studio which bundles one) and re-run."
  exit 1
}

if [ -e "$OUT" ]; then
  echo "$OUT already exists. Refusing to overwrite — if you replace your key you"
  echo "can never update the currently-installed apps again. Move it aside first."
  exit 1
fi

# Random passwords: nothing to invent, nothing to forget — they're printed below.
rand() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32; }
STORE_PW="$(rand)"
KEY_PW="$(rand)"

keytool -genkeypair -v \
  -keystore "$OUT" \
  -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$STORE_PW" -keypass "$KEY_PW" \
  -dname "CN=StopTrack, O=StopTrack, C=US" >/dev/null

B64="$(base64 -w0 "$OUT" 2>/dev/null || base64 -i "$OUT" | tr -d '\n')"

cat <<EOF

================================================================
  Done. Key written to: $OUT

  BACK THIS FILE UP (password manager / private drive). If you lose
  it you can never update the installed apps again — only uninstall
  and reinstall, which is the exact problem this fixes.

  Now add FOUR repository secrets on GitHub:
    Settings -> Secrets and variables -> Actions -> New repository secret

  1) SIGNING_KEYSTORE_B64
$B64

  2) SIGNING_STORE_PASSWORD
$STORE_PW

  3) SIGNING_KEY_ALIAS
$ALIAS

  4) SIGNING_KEY_PASSWORD
$KEY_PW

  Then cut one more release. That build is signed with this key.
  ONE last uninstall+install is needed to switch onto it (take a
  backup first: Supervisor -> Settings -> Backup & Restore).
  Every release after that installs as a normal update.
================================================================

EOF
