package dev.herdr.mobile.integration

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import dev.herdr.mobile.features.chat.data.PaneRepository
import dev.herdr.mobile.core.navigation.AppDestination
import dev.herdr.mobile.core.navigation.EmailRoute
import dev.herdr.mobile.core.navigation.parseDestinationIntent
import dev.herdr.mobile.core.data.Settings
import dev.herdr.mobile.features.chat.net.CompanionClient
import dev.herdr.mobile.features.chat.ui.DashboardScreen
import dev.herdr.mobile.features.chat.ui.DashboardViewModel
import dev.herdr.mobile.features.homepage.HomepageWebScreen
import dev.herdr.mobile.features.homepage.KimJbLauncher
import dev.herdr.mobile.features.chat.ui.theme.HerdrTheme
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import org.unifiedpush.android.connector.UnifiedPush

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        if (Build.VERSION.SDK_INT >= 33) {
            registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
                .launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        // UnifiedPush connector 3.3.3 dropped the 2.x `registerAppWithDialog` helper.
        // Pick (or reuse) a distributor first, then register once one is confirmed.
        UnifiedPush.tryUseCurrentOrDefaultDistributor(this) { success ->
            if (success) UnifiedPush.register(this)
        }

        val settings = Settings(applicationContext)
        val vm = DashboardViewModel(
            CompanionClient(),
            PaneRepository(),
            fontSizeStore = settings.terminalFontSize,
            persistFontSize = { px -> lifecycleScope.launch { settings.setTerminalFontSize(px) } },
            recentAgentsStore = settings.recentAgents,
            persistRecentAgent = { name -> lifecycleScope.launch { settings.addRecentAgent(name) } },
        )
        val initialPane = intent.getStringExtra("paneId")
        val requestedDestination = parseDestinationIntent(intent)

        setContent {
            var destination by remember { mutableStateOf(requestedDestination) }
            var url by remember { mutableStateOf<String?>(null) }
            var loaded by remember { mutableStateOf(false) }
            var chatStarted by remember { mutableStateOf(false) }
            var emailError by remember { mutableStateOf(false) }

            LaunchedEffect(Unit) {
                val stored = settings.companionUrl.first()
                url = stored
                loaded = true
                if (stored != null && requestedDestination == AppDestination.CHAT_KJB) {
                    chatStarted = true
                    vm.start(stored)
                }
            }

            // Forward whatever push endpoint the UnifiedPush receiver saves to the
            // companion, so it knows where to deliver notifications for this device.
            LaunchedEffect(Unit) {
                settings.pushEndpoint.filterNotNull().collect { endpoint -> vm.registerPush(endpoint) }
            }

            // A validated ChatKJB deep link may arrive before DataStore finishes loading.
            LaunchedEffect(destination, url, loaded) {
                if (loaded && destination == AppDestination.CHAT_KJB && url != null && !chatStarted) {
                    chatStarted = true
                    vm.start(url!!)
                }
            }

            // An email deep link (kimjb://open/email, or legacy kjbmail://open) should land in mail
            // rather than on the launcher. Clear the destination so Back still returns here.
            var emailLinkHandled by remember { mutableStateOf(false) }
            LaunchedEffect(destination) {
                if (destination == AppDestination.EMAIL && !emailLinkHandled) {
                    emailLinkHandled = true
                    destination = null
                    emailError = !openEmail()
                }
            }

            HerdrTheme {
                if (!loaded) {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {}
                } else if (destination == AppDestination.CHAT_KJB && url == null) {
                    OnboardUrl { entered ->
                        lifecycleScope.launch { settings.setCompanionUrl(entered) }
                        url = entered
                        chatStarted = true
                        vm.start(entered)
                    }
                } else if (destination == AppDestination.CHAT_KJB) {
                    DashboardScreen(vm, initialPane) { destination = null }
                } else if (destination == AppDestination.HOMEPAGE) {
                    HomepageWebScreen(
                        onExit = { destination = null },
                        onDestination = { target ->
                            when (target) {
                                AppDestination.EMAIL -> {
                                    destination = null
                                    emailError = !openEmail()
                                }
                                AppDestination.CHAT_KJB -> {
                                    emailError = false
                                    destination = AppDestination.CHAT_KJB
                                }
                                AppDestination.HOME -> destination = null
                                AppDestination.HOMEPAGE -> Unit
                            }
                        },
                    )
                } else {
                    KimJbLauncher(
                        emailError = emailError,
                        onHomepage = { destination = AppDestination.HOMEPAGE },
                        onEmail = { emailError = !openEmail() },
                        onChat = {
                            emailError = false
                            destination = AppDestination.CHAT_KJB
                        },
                    )
                    BackHandler { finish() }
                }
            }
        }
    }

    private fun openEmail(): Boolean {
        val nativeIntent = EmailRoute.nativeLaunchIntent()
        return runCatching { startActivity(nativeIntent) }.isSuccess
    }
}

@Composable
private fun OnboardUrl(onConnect: (String) -> Unit) {
    var text by remember { mutableStateOf("ws://") }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier.fillMaxSize().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("ChatKJB", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text("  ❯", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
            }
            Spacer(Modifier.height(4.dp))
            Text(
                "one command center for every agent",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(32.dp))
            Text(
                "connect to ChatKJB",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium,
                prefix = { Text("❯ ", color = MaterialTheme.colorScheme.primary) },
                placeholder = { Text("ws://host:8787") },
                shape = MaterialTheme.shapes.small,
                modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
            )
            Button(
                onClick = { if (text.isNotBlank()) onConnect(text) },
                shape = MaterialTheme.shapes.small,
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color.Black,
                    contentColor = Color.White,
                ),
                modifier = Modifier.padding(top = 16.dp),
            ) { Text("connect") }
        }
    }
}
