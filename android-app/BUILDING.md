# BZEAD India Android build guide

This folder builds the India-only Capacitor app:

- **Application ID:** `com.bzead.india`
- **App name:** `BZEAD: Shop Online`
- **Payments:** Razorpay for INR
- **Firebase project:** `bzead-58220`

The Android wrapper packages the India buyer web build from `../dist-buyer-in`.
The website's normal build and deployment are separate.

## Requirements

- Node.js and npm
- JDK 21
- Android SDK platform 36 and build-tools 36.0.0
- Android platform-tools
- The upload keystore and its password file, stored locally under
  `secure-downloads/`

Do not commit the upload keystore, its password, or a generated APK/AAB. Local
signing files and output packages are Git-ignored.

## Build the web app and synchronize Capacitor

From `android-app/`, provide the public Supabase URL and anon key in the shell
environment. Use the current project's anon key; it is a public client key, not
the service-role key.

```bash
export VITE_SUPABASE_URL='https://aiiefgjfftmerayihpbv.supabase.co'
export VITE_SUPABASE_ANON_KEY='<Supabase anon key>'
npm ci
npm run release:prepare
```

`release:prepare` builds the India storefront and runs `cap sync android`.
Re-run it after web source changes before creating a new Android package.

## Configure release signing

From `android-app/`, set these variables in the same terminal used for Gradle.
The password is read from the local ignored file without printing it:

```bash
export BZEAD_UPLOAD_STORE_FILE="$PWD/secure-downloads/bzead-india-upload-key.jks"
export BZEAD_UPLOAD_STORE_PASSWORD="$(cat secure-downloads/bzead-india-upload-key-password.txt)"
export BZEAD_UPLOAD_KEY_ALIAS='bzead-india-upload'
export BZEAD_UPLOAD_KEY_PASSWORD="$BZEAD_UPLOAD_STORE_PASSWORD"
```

The release build fails rather than producing an unsigned package if any signing
variable is missing or the keystore path does not exist. Do not put these values
in a committed Gradle file, shell script, or CI log.

## Build packages

Create a debug APK for local/device testing:

```bash
npm run build:debug
```

Create a signed release APK and Play Store AAB:

```bash
npm run build:release
```

Release outputs are copied to:

- `build-output/BZEAD-India.apk`
- `build-output/BZEAD-India.aab`

Gradle's original outputs remain under `android/app/build/outputs/`.
The APK can be installed directly for testing. Upload the AAB to Google Play
Console; do not distribute the upload keystore with either package.

## Firebase Cloud Messaging

The checked-in `android/app/google-services.json` is scoped to the Firebase app
whose package is `com.bzead.india`. Supabase's deployed push functions use the
`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`
secrets. Do not download or commit the service-account private key.

If Google Play App Signing is enabled, add the Play Console **app signing**
certificate fingerprints to Firebase as well as the upload-key fingerprints.
They are different certificates. FCM delivery should be verified on a real
device after login and FCM token registration.

## Troubleshooting

- Check `java -version`; use JDK 21 for this project.
- Check that Android SDK platform 36 and build-tools 36.0.0 are installed.
- If the build reports missing Capacitor plugin Gradle files, run
  `npm run sync`, then retry the build.
- Verify the selected Firebase config has only package `com.bzead.india`.
- Never share the upload keystore password in logs or source control.
