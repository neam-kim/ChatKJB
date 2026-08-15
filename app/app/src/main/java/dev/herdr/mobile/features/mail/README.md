# Mail feature

Mail is provided by the `mail-host` module from the KJBMail composite build:

```text
/Volumes/NEAM_SSD/Opencodex/KJBMail/repo
```

The host app starts `net.thunderbird.android.MailEntryActivity` through
`core/navigation/EmailRoute.kt`. The dependency is declared in
`app/settings.gradle.kts` and `app/app/build.gradle.kts`.
