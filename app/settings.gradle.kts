pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven(url = "https://jitpack.io") {
            mavenContent {
                includeGroup("com.github.ByteHamster")
                includeGroup("com.github.cketti")
            }
        }
    }
}

rootProject.name = "herdr-mobile"

includeBuild("/Volumes/NEAM_SSD/Opencodex/KJBMail/repo") {
    dependencySubstitution {
        substitute(module("dev.herdr.kjbmail:mail-host")).using(project(":mail-host"))
    }
}

include(":app")
include(":terminal-emulator")
include(":terminal-view")
