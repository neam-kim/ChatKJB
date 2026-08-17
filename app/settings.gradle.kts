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

rootProject.name = "ChatKJB"

val kjbmailDir = sequenceOf(
    providers.gradleProperty("kjbmail.dir").orNull,
    System.getenv("KJBMAIL_DIR"),
    file("../KJBMail").takeIf { it.isDirectory }?.absolutePath,
    file("../../KJBMail/repo").takeIf { it.isDirectory }?.absolutePath,
).filterNotNull().map(::File).firstOrNull { it.resolve("settings.gradle.kts").isFile }
    ?: error("KJBMail source is required. Set -Pkjbmail.dir=/path/to/KJBMail, KJBMAIL_DIR, or initialize the KJBMail submodule.")

includeBuild(kjbmailDir) {
    dependencySubstitution {
        substitute(module("dev.herdr.kjbmail:mail-host")).using(project(":mail-host"))
    }
}


include(":app")
include(":terminal-emulator")
include(":terminal-view")
