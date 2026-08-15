package dev.herdr.mobile.features.homepage

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.herdr.mobile.R

internal val KimJbBackground = Color(0xFFF7F7F7)
private val KimJbInk = Color(0xFF111111)
private val KimJbMuted = Color(0xFF555555)
private val KimJbBorder = Color(0xFFDDDDDD)

private val KimJbColorScheme = lightColorScheme(
    background = KimJbBackground,
    onBackground = KimJbInk,
    surface = Color.White,
    onSurface = KimJbInk,
    surfaceVariant = Color.White,
    onSurfaceVariant = KimJbMuted,
    primary = KimJbInk,
    onPrimary = Color.White,
    outline = KimJbBorder,
    error = Color(0xFFB3261E),
)

/**
 * Native launcher styled after kimjb.com's current homepage: light canvas,
 * centered monogram, restrained typography, and bordered white link rows.
 * ChatKJB's terminal surface keeps its own terminal-first theme after entry.
 */
@Composable
fun KimJbLauncher(
    emailError: Boolean,
    onHomepage: () -> Unit,
    onEmail: () -> Unit,
    onChat: () -> Unit,
) {
    MaterialTheme(colorScheme = KimJbColorScheme) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = KimJbBackground,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp, vertical = 28.dp),
                horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Image(
                    painter = painterResource(R.drawable.kimjb_logo),
                    contentDescription = "Kim JongBeom logo",
                    modifier = Modifier.height(72.dp),
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    "Kim JongBeom",
                    color = KimJbInk,
                    fontSize = 28.sp,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(20.dp))
                Column(modifier = Modifier.fillMaxWidth()) {
                    KimJbLink(title = "Homepage", onClick = onHomepage, description = "Open Homepage")
                    Spacer(Modifier.height(12.dp))
                    KimJbLink(title = "Email", onClick = onEmail, description = "Open Email")
                    if (emailError) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "KJB Mail 앱을 찾을 수 없습니다. 통합 메일 이전이 끝날 때까지 기존 앱을 유지해 주세요.",
                            color = KimJbColorScheme.error,
                            fontSize = 13.sp,
                            lineHeight = 19.sp,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                    KimJbLink(title = "ChatKJB", onClick = onChat, description = "Open ChatKJB")
                }
            }
        }
    }
}

@Composable
private fun KimJbLink(
    title: String,
    description: String,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .height(64.dp)
            .semantics { contentDescription = description },
        shape = RoundedCornerShape(8.dp),
        color = Color.White,
        contentColor = KimJbInk,
        border = BorderStroke(1.dp, KimJbBorder),
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 18.dp),
            contentAlignment = androidx.compose.ui.Alignment.Center,
        ) {
            Text(
                title,
                color = KimJbInk,
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
            )
        }
    }
}
