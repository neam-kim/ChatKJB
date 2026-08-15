package dev.herdr.mobile.core.navigation

import android.content.Intent
import android.net.Uri

/**
 * Top-level destinations owned by the unified ChatKJB app.
 *
 * [HOMEPAGE] is reachable only from the launcher, never from the deep-link contract.
 */
enum class AppDestination {
    HOME,
    HOMEPAGE,
    EMAIL,
    CHAT_KJB,
}

/** Fixed web surface; never accept an arbitrary URL from an intent or UI. */
object HomepageRoute {
    /** Materialized only on Android; pure policy tests use [canonicalUrl]. */
    val uri: Uri by lazy { Uri.parse(canonicalUrl) }
    const val canonicalUrl = "https://kimjb.com/"

    fun isAllowed(candidate: Uri): Boolean =
        isAllowed(candidate.toString())

    /** Pure validation helper so URL policy can be tested without Android shadows. */
    fun isAllowed(candidate: String): Boolean = runCatching {
        val parsed = java.net.URI(candidate)
        parsed.scheme.equals("https", ignoreCase = true) &&
            parsed.host.equals("kimjb.com", ignoreCase = true) &&
            (parsed.port == -1 || parsed.port == 443)
    }.getOrDefault(false)

    /**
     * Hosts the Google sign-in leg navigates through.
     *
     * These must stay inside this WebView. Handing them to the system browser
     * completes the OAuth round trip in *that* browser's cookie jar, so the session
     * cookie never reaches the app and the user appears logged out on every visit.
     * Worse, a leg that starts here and finishes there arrives without the matching
     * cookies and Google answers 400.
     *
     * Google redirects the sign-in leg to a country-local domain part way through
     * (observed: accounts.google.co.jp), so the accounts host is matched by pattern
     * rather than by a fixed list. The TLD shape is deliberately narrow — a bare
     * two-letter ccTLD, or co./com. plus one — because those are registry-controlled
     * and cannot be bought out from under Google the way a vanity gTLD could.
     */
    private val accountsHost =
        Regex("""^accounts\.google\.(com|[a-z]{2}|(co|com)\.[a-z]{2})$""")

    private val signInHosts = setOf("accounts.youtube.com")

    fun isSignInHost(candidate: Uri): Boolean = isSignInHost(candidate.toString())

    fun isSignInHost(candidate: String): Boolean = runCatching {
        val parsed = java.net.URI(candidate)
        val host = parsed.host?.lowercase() ?: return@runCatching false
        parsed.scheme.equals("https", ignoreCase = true) &&
            (host in signInHosts || accountsHost.matches(host)) &&
            (parsed.port == -1 || parsed.port == 443)
    }.getOrDefault(false)

    /** Everything this WebView may load: the site itself plus the sign-in round trip. */
    fun isInAppNavigation(candidate: Uri): Boolean = isInAppNavigation(candidate.toString())

    fun isInAppNavigation(candidate: String): Boolean =
        isAllowed(candidate) || isSignInHost(candidate)
}

/**
 * Mail is hosted in this process by the `mail-host` module, so it is reached by
 * starting the embedded entry point directly rather than resolving another package.
 */
object EmailRoute {
    fun nativeLaunchIntent(): Intent = Intent(Intent.ACTION_MAIN).apply {
        setClassName("dev.herdr.mobile", "net.thunderbird.android.MailEntryActivity")
    }
}

/**
 * Resolve the app's own deep-link contract.
 *
 * `kimjb://open/{home,email,chat}` is the current contract. `kjbmail://open` is the legacy
 * entry point kimjb.com still emits; it predates this app and always meant "open mail".
 */
private fun resolveDestination(scheme: String?, host: String?, path: String?): AppDestination? {
    if (!host.equals("open", ignoreCase = true)) return null

    if (scheme.equals("kjbmail", ignoreCase = true)) return AppDestination.EMAIL
    if (!scheme.equals("kimjb", ignoreCase = true)) return null

    return when (path?.trim('/')?.lowercase()) {
        "home" -> AppDestination.HOME
        "email" -> AppDestination.EMAIL
        "chat" -> AppDestination.CHAT_KJB
        else -> null
    }
}

/** Parse only the app's own optional deep-link contract. */
fun parseDestinationIntent(intent: Intent?): AppDestination? {
    val data = intent?.data ?: return null
    return resolveDestination(data.scheme, data.host, data.path)
}

/** Pure URI parser for routing tests and other non-Android callers. */
fun parseDestinationUri(uri: String?): AppDestination? = runCatching {
    val data = java.net.URI(uri ?: return null)
    resolveDestination(data.scheme, data.host, data.path)
}.getOrNull()
