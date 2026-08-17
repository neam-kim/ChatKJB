# Mail feature

Mail is provided by the `mail-host` module from an external KJBMail checkout. The
composite build path is selected by `-Pkjbmail.dir=/path/to/KJBMail/repo`, the
`KJBMAIL_DIR` environment variable, or the sibling `../KJBMail/repo` when present.
The Android build reports the required setting if none is available.

The host app starts `net.thunderbird.android.MailEntryActivity` through
`core/navigation/EmailRoute.kt`. The dependency is declared in
`app/settings.gradle.kts` and `app/app/build.gradle.kts`.
