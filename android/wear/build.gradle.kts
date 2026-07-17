// :wear — the Wear OS operator app (the timer loop on the watch).
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing uses a PRIVATE key from CI (env / GitHub secrets) or gradle
// properties — never committed. Falls back to the default debug key when unset
// (those APKs are NOT authenticity-guaranteed). Must resolve the SAME key as
// :mobile so the Wear Data Layer (same-cert requirement) still pairs. See
// android/SIGNING.md.
val releaseKeystore: String? = System.getenv("STOPTRACK_KEYSTORE")
    ?: (findProperty("stoptrack.keystore") as String?)
val hasReleaseKey: Boolean = releaseKeystore != null && file(releaseKeystore).exists()

android {
    namespace = "com.stoptrack.wear"
    compileSdk = 35

    defaultConfig {
        // MUST match the :mobile applicationId — the Wear Data Layer only exchanges
        // messages/data items between a phone app and watch app with the SAME
        // applicationId. (Namespaces stay distinct so the R classes don't clash.)
        applicationId = "com.stoptrack"
        // Wear OS 3 (Galaxy Watch 4 and newer) = API 30.
        minSdk = 30
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
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.wear.compose.material)
    implementation(libs.androidx.wear.compose.foundation)
    implementation(libs.androidx.wear.tooling.preview)
    // Wear text input (voice / keyboard) for the operator name.
    implementation(libs.androidx.wear.input)

    // Wear Data Layer — the offline watch<->phone link.
    implementation(libs.play.services.wearable)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play.services)

    // Local persistence for in-progress timer recovery + unsent-stop outbox.
    implementation(libs.androidx.datastore.preferences)

    debugImplementation(libs.androidx.compose.ui.tooling)
}
