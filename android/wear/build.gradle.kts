// :wear — the Wear OS operator app (the timer loop on the watch).
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.kotlin.serialization)
}

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
        versionCode = 2
        versionName = "0.2"
    }

    // A committed, stable signing key shared with :mobile. The Wear Data Layer only
    // connects a phone and watch app signed with the SAME certificate, and a fixed
    // key also lets new builds install over old ones. This is a sideload/debug key,
    // not a Play production key.
    signingConfigs {
        create("shared") {
            storeFile = file("${rootDir}/keystore/stoptrack-debug.jks")
            storePassword = "stoptrack"
            keyAlias = "stoptrack"
            keyPassword = "stoptrack"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("shared")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shared")
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
