package dev.herdr.mobile.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import dev.herdr.mobile.AppDestination
import dev.herdr.mobile.HomepageRoute
import dev.herdr.mobile.parseDestinationUri

/**
 * kimjb.com rendered inside the app.
 *
 * Custom Tabs always draws its own origin bar, so the homepage is hosted in a
 * plain WebView instead. Only the canonical origin ever loads here; the app's own
 * deep links are routed natively and everything else is handed to the system.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun HomepageWebScreen(
    onExit: () -> Unit,
    onDestination: (AppDestination) -> Unit,
) {
    var webView by remember { mutableStateOf<WebView?>(null) }

    BackHandler {
        val view = webView
        if (view != null && view.canGoBack()) view.goBack() else onExit()
    }

    // The page is a light canvas, so keep dark status bar icons while it is up
    // even when the system is in dark mode.
    val hostView = LocalView.current
    DisposableEffect(hostView) {
        val window = hostView.context.findActivity()?.window
        val controller = window?.let { WindowCompat.getInsetsController(it, hostView) }
        val previous = controller?.isAppearanceLightStatusBars
        controller?.isAppearanceLightStatusBars = true
        onDispose {
            if (controller != null && previous != null) {
                controller.isAppearanceLightStatusBars = previous
            }
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = KimJbBackground) {
        AndroidView(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding(),
            factory = { ctx ->
                WebView(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                    setBackgroundColor(android.graphics.Color.TRANSPARENT)
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.useWideViewPort = true
                    settings.loadWithOverviewMode = true
                    webViewClient = HomepageWebViewClient(ctx, onDestination)
                    loadUrl(HomepageRoute.canonicalUrl)
                    webView = this
                }
            },
            onRelease = { view ->
                webView = null
                view.destroy()
            },
        )
    }
}

private class HomepageWebViewClient(
    private val context: Context,
    private val onDestination: (AppDestination) -> Unit,
) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url
        if (HomepageRoute.isAllowed(uri)) return false

        val destination = parseDestinationUri(uri.toString())
        if (destination != null) {
            onDestination(destination)
            return true
        }

        // mailto:, tel:, other origins: never load them in this WebView.
        runCatching {
            context.startActivity(
                Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
        return true
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
