// StopTrack Wear OS companion — Gradle project settings.
//
// This project lives ALONGSIDE the web app (../StopTrack.tsx / ../index.html); it
// is not generated from it. The single source of truth the two share is the
// StopTrack sync API contract (see ../server/README.md). Keep the Kotlin record
// shape in :shared in step with the web app's stop record.
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "StopTrackWear"

include(":shared")   // pure-Kotlin/Android: record model + sync contract + local store helpers
include(":wear")     // Wear OS app — the operator timer loop on the watch
include(":mobile")   // Phone companion — Data Layer bridge + local sync server + optional forwarder
