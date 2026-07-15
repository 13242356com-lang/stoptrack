// :shared — pure Kotlin/JVM. No Android APIs here so both the watch and the phone
// companion can depend on it. It holds the ONE thing the Kotlin apps and the web
// app must agree on: the StopTrack record shape + sync API contract.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    // Android Studio's bundled JDK satisfies this without a download.
    jvmToolchain(17)
}

dependencies {
    // `api` so the Android modules get kotlinx-serialization transitively when
    // they build/parse records.
    api(libs.kotlinx.serialization.json)
}
