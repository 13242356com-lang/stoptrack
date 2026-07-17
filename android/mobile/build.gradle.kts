import java.io.File

// :mobile — the phone companion. Bridges the watch (Wear Data Layer) to the web
// app (local HTTP sync server on 127.0.0.1) and, optionally, to a remote server.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing uses a PRIVATE key provided by CI (env vars from GitHub
// secrets) or gradle properties — never committed. If none is present the build
// falls back to the auto-generated debug key so plain `./gradlew` still works;
// those APKs are NOT authenticity-guaranteed. :mobile and :wear must resolve the
// SAME key so the Wear Data Layer (same-cert requirement) still pairs. See
// android/SIGNING.md.
val releaseKeystore: String? = System.getenv("STOPTRACK_KEYSTORE")
    ?: (findProperty("stoptrack.keystore") as String?)
val hasReleaseKey: Boolean = releaseKeystore != null && file(releaseKeystore).exists()

android {
    namespace = "com.stoptrack.mobile"
    compileSdk = 35

    defaultConfig {
        // MUST match the :wear applicationId — the Wear Data Layer only exchanges
        // messages/data items between a phone app and watch app with the SAME
        // applicationId. (Namespaces stay distinct so the R classes don't clash.)
        applicationId = "com.stoptrack"
        minSdk = 26
        targetSdk = 34
        versionCode = 4
        versionName = "0.4"
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = file(releaseKeystore!!)
                storePassword = System.getenv("STOPTRACK_STORE_PASSWORD") ?: (findProperty("stoptrack.storePassword") as String?)
                keyAlias = System.getenv("STOPTRACK_KEY_ALIAS") ?: (findProperty("stoptrack.keyAlias") as String?)
                keyPassword = System.getenv("STOPTRACK_KEY_PASSWORD") ?: (findProperty("stoptrack.keyPassword") as String?)
            }
        }
    }

    buildTypes {
        // debug uses the default per-machine debug key.
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (hasReleaseKey) "release" else "debug")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":shared"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)

    // Wear Data Layer — receive stops from the watch, publish config to it.
    implementation(libs.play.services.wearable)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play.services)

    implementation(libs.androidx.datastore.preferences)

    // Local sync server (the seam the web app points at).
    implementation(libs.nanohttpd)

    debugImplementation(libs.androidx.compose.ui.tooling)
}

// ---------------------------------------------------------------------------
// Bundle the web app (../../index.html) into the APK's assets so the phone app
// shows the full StopTrack UI in a WebView. build-web-asset.mjs inlines React +
// Tailwind for offline use when Node + network are available (CI); otherwise we
// fall back to a plain copy that fetches those from CDNs on first launch.
// ---------------------------------------------------------------------------
val prepareWebAsset by tasks.registering {
    val repoRoot = rootProject.projectDir.parentFile          // android/.. = repo root
    val sourceHtml = File(repoRoot, "index.html")
    val assetsDir = layout.projectDirectory.dir("src/main/assets").asFile
    val assetHtml = File(assetsDir, "index.html")
    inputs.file(sourceHtml)
    inputs.file(File(projectDir, "build-web-asset.mjs"))
    outputs.file(assetHtml)
    doLast {
        assetsDir.mkdirs()
        val ranNode = try {
            val proc = ProcessBuilder("node", "android/mobile/build-web-asset.mjs")
                .directory(repoRoot).inheritIO().start()
            proc.waitFor() == 0
        } catch (e: Exception) {
            logger.warn("prepareWebAsset: node unavailable (${e.message}); using plain copy (needs internet on first launch).")
            false
        }
        if (!ranNode || !assetHtml.exists()) {
            sourceHtml.copyTo(assetHtml, overwrite = true)
        }
    }
}

// Make sure the asset exists before Android merges/packages assets (covers both
// the preBuild anchor and the variant-specific mergeAssets tasks).
tasks.named("preBuild") { dependsOn(prepareWebAsset) }
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }
    .configureEach { dependsOn(prepareWebAsset) }
