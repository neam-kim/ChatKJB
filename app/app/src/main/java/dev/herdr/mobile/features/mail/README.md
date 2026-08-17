# Mail feature

Mail is provided by the `mail-host` module from the public KJBMail submodule at
`KJBMail/`, pinned by the root repository. The composite build path can be
overridden with `-Pkjbmail.dir=/path/to/KJBMail` or the `KJBMAIL_DIR` environment
variable; an older sibling `../KJBMail/repo` checkout remains a fallback.

The host app starts `net.thunderbird.android.MailEntryActivity` through
`core/navigation/EmailRoute.kt`. The dependency is declared in
`app/settings.gradle.kts` and `app/app/build.gradle.kts`.
