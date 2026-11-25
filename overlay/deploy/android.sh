#!/usr/bin/env bash
# GitHub Actions ichida: Android APK yig'adi va GitHub Releases'ga qo'yadi.
# Imzo kaliti mobile/release.keystore (parol bilan himoyalangan); parol — ANDROID_KEYSTORE_PASSWORD maxfiy qiymati.
set -euo pipefail
cd "$(dirname "$0")/../mobile"
OWNER=$(echo "${GITHUB_REPOSITORY%%/*}" | tr '[:upper:]' '[:lower:]')
REPO="${GITHUB_REPOSITORY##*/}"
export APP_URL="https://$OWNER.github.io/$REPO/"
export VERSION_CODE="$GITHUB_RUN_NUMBER" VERSION_NAME="1.0.$GITHUB_RUN_NUMBER"
export JAVA_HOME="${JAVA_HOME_21_X64:-$JAVA_HOME}"
npm ci --no-audit --no-fund
npm i --no-save --no-audit --no-fund typescript@5
npx cap sync android
cd android
chmod +x gradlew
if [ -n "${ANDROID_KEYSTORE_PASSWORD:-}" ]; then
  export ANDROID_KEYSTORE_PATH="$PWD/../release.keystore" ANDROID_KEY_ALIAS="${ANDROID_KEY_ALIAS:-kiddytoys}"
  export ANDROID_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}"
  ./gradlew --no-daemon -q assembleRelease
  APK=app/build/outputs/apk/release/app-release.apk
else
  echo "::warning::ANDROID_KEYSTORE_PASSWORD yo'q — sinov (debug) APK yig'ildi; keyingi yangilanishlar o'rnatilmasligi mumkin."
  ./gradlew --no-daemon -q assembleDebug
  APK=app/build/outputs/apk/debug/app-debug.apk
fi
cp "$APK" "$GITHUB_WORKSPACE/kiddy-toys.apk"
TAG="android-v$VERSION_NAME"
gh release create "$TAG" "$GITHUB_WORKSPACE/kiddy-toys.apk" -R "$GITHUB_REPOSITORY" \
  --title "Kiddy Toys Android $VERSION_NAME" --latest \
  --notes "Mijozlar uchun Android ilova. Telefonga yuklab olib o'rnating. Ilova ochadigan sayt: $APP_URL"
echo "APK: https://github.com/$GITHUB_REPOSITORY/releases/latest/download/kiddy-toys.apk"
