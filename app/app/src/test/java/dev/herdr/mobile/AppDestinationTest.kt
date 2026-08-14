package dev.herdr.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppDestinationTest {
    @Test fun homepageRouteOnlyAllowsCanonicalHttpsOrigin() {
        assertTrue(HomepageRoute.isAllowed("https://kimjb.com/"))
        assertTrue(HomepageRoute.isAllowed("https://KIMJB.COM/path"))
        assertFalse(HomepageRoute.isAllowed("http://kimjb.com/"))
        assertFalse(HomepageRoute.isAllowed("https://evil.example/"))
        assertFalse(HomepageRoute.isAllowed("https://kimjb.com.evil.example/"))
    }

    @Test fun signInHostsAreLimitedToGoogleAccountsOverHttps() {
        assertTrue(HomepageRoute.isSignInHost("https://accounts.google.com/o/oauth2/v2/auth"))
        assertTrue(HomepageRoute.isSignInHost("https://ACCOUNTS.GOOGLE.COM/signin"))
        assertTrue(HomepageRoute.isSignInHost("https://accounts.youtube.com/accounts/SetSID"))
        assertFalse(HomepageRoute.isSignInHost("http://accounts.google.com/"))
        assertFalse(HomepageRoute.isSignInHost("https://accounts.google.com.evil.example/"))
        assertFalse(HomepageRoute.isSignInHost("https://evil.example/accounts.google.com"))
        assertFalse(HomepageRoute.isSignInHost("https://mail.google.com/"))
        assertFalse(HomepageRoute.isSignInHost("https://kimjb.com/"))
    }

    @Test fun inAppNavigationCoversSiteAndSignInOnly() {
        assertTrue(HomepageRoute.isInAppNavigation("https://kimjb.com/members"))
        assertTrue(HomepageRoute.isInAppNavigation("https://accounts.google.com/o/oauth2/v2/auth"))
        assertFalse(HomepageRoute.isInAppNavigation("https://evil.example/"))
        assertFalse(HomepageRoute.isInAppNavigation("mailto:contact@kimjb.com"))
        assertFalse(HomepageRoute.isInAppNavigation("kimjb://open/email"))
    }

    @Test fun parsesOnlyKnownDestinationLinks() {
        assertEquals(AppDestination.HOME, parseDestinationUri("kimjb://open/home"))
        assertEquals(AppDestination.EMAIL, parseDestinationUri("kimjb://open/email"))
        assertEquals(AppDestination.CHAT_KJB, parseDestinationUri("kimjb://open/chat"))
        assertEquals(null, parseDestinationUri("kimjb://open/other"))
        assertEquals(null, parseDestinationUri("https://kimjb.com/"))
        assertEquals(null, parseDestinationUri(null))


    }

    @Test fun homepageWebSurfaceIsNotReachableByDeepLink() {
        assertEquals(null, parseDestinationUri("kimjb://open/homepage"))
        assertEquals(null, parseDestinationUri("kimjb://open/web"))
    }

    @Test fun legacyKjbmailSchemeOpensEmail() {
        assertEquals(AppDestination.EMAIL, parseDestinationUri("kjbmail://open"))
        assertEquals(AppDestination.EMAIL, parseDestinationUri("kjbmail://open/"))
        assertEquals(null, parseDestinationUri("kjbmail://elsewhere"))
    }
}
