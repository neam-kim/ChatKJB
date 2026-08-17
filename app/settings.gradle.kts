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
    file("../KJBMail/repo").takeIf { it.isDirectory }?.absolutePath,
).filterNotNull().map(::File).firstOrNull { it.isDirectory }
    ?: error("KJBMail source is required. Set -Pkjbmail.dir=/path/to/KJBMail/repo or KJBMAIL_DIR.")

includeBuild(kjbmailDir) {
    dependencySubstitution {
        substitute(module("dev.herdr.kjbmail:mail-host")).using(project(":mail-host"))
    }
}


include(":app")
include(":terminal-emulator")
include(":terminal-view")
