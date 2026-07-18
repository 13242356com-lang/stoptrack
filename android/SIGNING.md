# App signing (release key)

The Android apps used to ship with a signing key **committed in this public
repo** — which meant anyone could build an app pretending to be StopTrack
(`com.stoptrack`), install it *over* the real one, or pair with your watches.
That key is now removed and considered **compromised**. Release APKs are signed
with a **private key you hold**, provided to CI via encrypted secrets.

Until you add the secrets below, CI still builds — but the release APKs fall back
to a throwaway debug key (a warning is printed) and are **not authenticity-
guaranteed**, and won't reliably install over each other. So do this once.

## 1. Make a private key (keep it safe — losing it means you can't update the apps)

On any machine with Java installed (`keytool` ships with the JDK):

```bash
keytool -genkeypair -v \
  -keystore stoptrack-release.jks \
  -alias stoptrack -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "CHOOSE-A-STORE-PASSWORD" \
  -keypass  "CHOOSE-A-KEY-PASSWORD" \
  -dname "CN=StopTrack, O=Your Company, C=US"
```

Back up `stoptrack-release.jks` somewhere safe (a password manager / private
drive). **Do not commit it.**

## 2. Turn the key into text for the secret

- **macOS/Linux:** `base64 -w0 stoptrack-release.jks > keystore.b64`
  (on macOS use `base64 -i stoptrack-release.jks -o keystore.b64`)
- **Windows PowerShell:**
  `[Convert]::ToBase64String([IO.File]::ReadAllBytes("stoptrack-release.jks")) | Out-File -NoNewline keystore.b64`

## 3. Add 4 repository secrets

GitHub → your repo → **Settings → Secrets and variables → Actions → New
repository secret**. Add these four:

| Secret name | Value |
|-------------|-------|
| `SIGNING_KEYSTORE_B64` | the entire contents of `keystore.b64` |
| `SIGNING_STORE_PASSWORD` | the store password you chose |
| `SIGNING_KEY_ALIAS` | `stoptrack` |
| `SIGNING_KEY_PASSWORD` | the key password you chose |

That's it. The next release build signs both apps with your private key. Verify:
download a release APK and run `apksigner verify --print-certs StopTrack-phone.apk`
— it should show **your** certificate (CN=StopTrack, O=Your Company), not the old
`CN=StopTrack Debug`.

## One-time consequence for installed apps

Because the signing key changed, the new build **won't install over** the old
v0.1–v0.3 apps (Android refuses an update signed by a different key). Once:
**uninstall** StopTrack on the phone and watch, then install the new v0.4 APKs.
After that, future updates install over the top normally (the key stays stable).

## Local builds

`./gradlew :mobile:assembleDebug` etc. still work with no secret — they use the
standard per-machine debug key. Only the CI **release** build uses the private
key. To build a signed release locally, pass the same values as gradle
properties (`-Pstoptrack.keystore=… -Pstoptrack.storePassword=… …`) or set the
`STOPTRACK_*` env vars.
