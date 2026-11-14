package com.wimotek.edgenode

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ArrowForward
import androidx.compose.material.icons.rounded.CleaningServices
import androidx.compose.material.icons.rounded.CloudDone
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.Language
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.PhoneAndroid
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Security
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.Terminal
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.wimotek.edgenode.agent.EdgeAgentService
import com.wimotek.edgenode.browser.WebViewCookieBridge
import com.wimotek.edgenode.data.AgentStateBus
import com.wimotek.edgenode.data.HubSettings
import com.wimotek.edgenode.data.NodeConfigStore
import com.wimotek.edgenode.guard.CookieGuard
import com.wimotek.edgenode.guard.CookieGuardConfig

private val EdgeDarkColorScheme = darkColorScheme(
    primary = Color(0xFF38BDF8),
    onPrimary = Color(0xFF082F49),
    secondary = Color(0xFF2DD4BF),
    background = Color(0xFF0F172A),
    surface = Color(0xFF1E293B),
    surfaceVariant = Color(0xFF09122A),
    onBackground = Color(0xFFF8FAFC),
    onSurface = Color(0xFFE2E8F0)
)

class MainActivity : ComponentActivity() {

    private lateinit var store: NodeConfigStore

    private val notifPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = NodeConfigStore(this)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        setContent {
            MaterialTheme(colorScheme = EdgeDarkColorScheme) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    WimotekAndroidApp(store = store)
                }
            }
        }
    }
}

@Composable
fun WimotekAndroidApp(store: NodeConfigStore) {
    var selectedTab by remember { mutableIntStateOf(0) }
    val hubStatus by AgentStateBus.hubStatus.collectAsState()
    val serviceRunning by AgentStateBus.serviceRunning.collectAsState()

    Scaffold(
        bottomBar = {
            NavigationBar(containerColor = Color(0xFF1E293B)) {
                NavigationBarItem(
                    selected = selectedTab == 0,
                    onClick = { selectedTab = 0 },
                    icon = { Icon(Icons.Rounded.Language, contentDescription = null) },
                    label = { Text("工作浏览器", fontSize = 11.sp) }
                )
                NavigationBarItem(
                    selected = selectedTab == 1,
                    onClick = { selectedTab = 1 },
                    icon = { Icon(Icons.Rounded.CloudDone, contentDescription = null) },
                    label = { Text("Hub 接入", fontSize = 11.sp) }
                )
                NavigationBarItem(
                    selected = selectedTab == 2,
                    onClick = { selectedTab = 2 },
                    icon = { Icon(Icons.Rounded.Security, contentDescription = null) },
                    label = { Text("Cookie 防火墙", fontSize = 11.sp) }
                )
                NavigationBarItem(
                    selected = selectedTab == 3,
                    onClick = { selectedTab = 3 },
                    icon = { Icon(Icons.Rounded.Terminal, contentDescription = null) },
                    label = { Text("日志", fontSize = 11.sp) }
                )
            }
        }
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            // 始终挂载 BrowserScreen 以保持页面登录态不因切换 Tab 而销毁
            Box(modifier = Modifier.fillMaxSize()) {
                BrowserTab(store = store, visible = (selectedTab == 0))
            }
            if (selectedTab == 1) {
                HubConfigTab(
                    store = store,
                    hubStatus = hubStatus,
                    serviceRunning = serviceRunning
                )
            } else if (selectedTab == 2) {
                CookieGuardTab(store = store, serviceRunning = serviceRunning)
            } else if (selectedTab == 3) {
                LogsTab()
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun BrowserTab(store: NodeConfigStore, visible: Boolean) {
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val initialHub = remember { store.loadHubSettings() }
    var desktopUa by remember { mutableStateOf(initialHub.desktopUaMode) }
    var urlInput by remember { mutableStateOf(store.getLastHomepage()) }
    var progress by remember { mutableIntStateOf(100) }
    var canGoBack by remember { mutableStateOf(false) }
    var canGoForward by remember { mutableStateOf(false) }
    var webViewRef by remember { mutableStateOf<WebView?>(null) }

    val desktopUserAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

    fun normalizeAndLoad(raw: String) {
        val trimmed = raw.trim()
        val target = when {
            trimmed.startsWith("http://") || trimmed.startsWith("https://") -> trimmed
            trimmed.contains(".") && !trimmed.contains(" ") -> "https://$trimmed"
            else -> "https://www.bing.com/search?q=${Uri.encode(trimmed)}"
        }
        urlInput = target
        store.saveLastHomepage(target)
        webViewRef?.loadUrl(target)
        focusManager.clearFocus()
    }

    BackHandler(enabled = visible && canGoBack) {
        webViewRef?.goBack()
    }

    Column(
        modifier = if (visible) Modifier.fillMaxSize() else Modifier
            .size(0.dp)
    ) {
        // 顶部浏览器工具栏
        Surface(color = Color(0xFF1E293B), tonalElevation = 4.dp) {
            Column(modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    IconButton(onClick = { webViewRef?.goBack() }, enabled = canGoBack, modifier = Modifier.size(36.dp)) {
                        Icon(Icons.Rounded.ArrowBack, contentDescription = "后退")
                    }
                    IconButton(onClick = { webViewRef?.goForward() }, enabled = canGoForward, modifier = Modifier.size(36.dp)) {
                        Icon(Icons.Rounded.ArrowForward, contentDescription = "前进")
                    }
                    OutlinedTextField(
                        value = urlInput,
                        onValueChange = { urlInput = it },
                        singleLine = true,
                        placeholder = { Text("输入网址（支持扫码/App跳转登录）", fontSize = 12.sp) },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                        keyboardActions = KeyboardActions(onGo = { normalizeAndLoad(urlInput) }),
                        modifier = Modifier
                            .weight(1f)
                            .padding(horizontal = 4.dp)
                    )
                    IconButton(onClick = { webViewRef?.reload() }, modifier = Modifier.size(36.dp)) {
                        Icon(Icons.Rounded.Refresh, contentDescription = "刷新")
                    }
                    IconButton(
                        onClick = {
                            desktopUa = !desktopUa
                            val cur = store.loadHubSettings()
                            store.saveHubSettings(cur.copy(desktopUaMode = desktopUa))
                            webViewRef?.let { wv ->
                                wv.settings.userAgentString = if (desktopUa) desktopUserAgent else null
                                wv.settings.useWideViewPort = true
                                wv.settings.loadWithOverviewMode = desktopUa
                                wv.reload()
                            }
                            Toast.makeText(
                                context,
                                if (desktopUa) "已切换桌面版 UA（适合 PC 扫码页面）" else "已切换手机版 UA",
                                Toast.LENGTH_SHORT
                            ).show()
                        },
                        modifier = Modifier.size(36.dp)
                    ) {
                        Icon(
                            imageVector = if (desktopUa) Icons.Rounded.Computer else Icons.Rounded.PhoneAndroid,
                            contentDescription = "切换 UA",
                            tint = if (desktopUa) Color(0xFF38BDF8) else Color(0xFF94A3B8)
                        )
                    }
                }

                // 快捷站点导航条
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(top = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    listOf(
                        "GitHub" to "https://github.com/login",
                        "X / Twitter" to "https://x.com",
                        "淘宝" to "https://login.taobao.com",
                        "京东" to "https://plogin.m.jd.com",
                        "B站" to "https://passport.bilibili.com/login",
                        "百度" to "https://www.baidu.com"
                    ).forEach { (label, siteUrl) ->
                        AssistChip(
                            onClick = { normalizeAndLoad(siteUrl) },
                            label = { Text(label, fontSize = 11.sp) }
                        )
                    }
                }
            }
        }

        if (progress in 1..99) {
            LinearProgressIndicator(
                progress = { progress / 100f },
                modifier = Modifier.fillMaxWidth()
            )
        }

        AndroidView(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            factory = { ctx ->
                WebView(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                    val cm = CookieManager.getInstance()
                    cm.setAcceptCookie(true)
                    cm.setAcceptThirdPartyCookies(this, true)

                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.databaseEnabled = true
                    settings.useWideViewPort = true
                    settings.loadWithOverviewMode = desktopUa
                    settings.setSupportZoom(true)
                    settings.builtInZoomControls = true
                    settings.displayZoomControls = false
                    settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                    if (desktopUa) {
                        settings.userAgentString = desktopUserAgent
                    }

                    webChromeClient = object : WebChromeClient() {
                        override fun onProgressChanged(view: WebView?, newProgress: Int) {
                            progress = newProgress
                        }
                    }

                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                            val reqUrl = request?.url?.toString() ?: return false
                            if (reqUrl.startsWith("http://") || reqUrl.startsWith("https://")) {
                                store.recordVisitedUrl(reqUrl)
                                return false
                            }
                            // 支持微信/支付宝/淘宝等 App 跳转授权或扫码拉起
                            runCatching {
                                val intent = if (reqUrl.startsWith("intent://")) {
                                    Intent.parseUri(reqUrl, Intent.URI_INTENT_SCHEME)
                                } else {
                                    Intent(Intent.ACTION_VIEW, Uri.parse(reqUrl))
                                }
                                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                ctx.startActivity(intent)
                            }.onFailure {
                                Toast.makeText(ctx, "未找到可处理该跳转协议的应用", Toast.LENGTH_SHORT).show()
                            }
                            return true
                        }

                        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                            request?.url?.toString()?.let { u ->
                                if (u.startsWith("http")) store.recordVisitedUrl(u)
                            }
                            return super.shouldInterceptRequest(view, request)
                        }

                        override fun onPageFinished(view: WebView?, url: String?) {
                            super.onPageFinished(view, url)
                            url?.let {
                                urlInput = it
                                store.recordVisitedUrl(it)
                                store.saveLastHomepage(it)
                            }
                            canGoBack = view?.canGoBack() ?: false
                            canGoForward = view?.canGoForward() ?: false
                            runCatching { CookieManager.getInstance().flush() }
                        }
                    }

                    loadUrl(urlInput)
                    webViewRef = this
                }
            },
            update = { wv ->
                wv.visibility = if (visible) View.VISIBLE else View.GONE
            }
        )
    }
}

@Composable
fun HubConfigTab(
    store: NodeConfigStore,
    hubStatus: String,
    serviceRunning: Boolean
) {
    val context = LocalContext.current
    val initial = remember { store.loadHubSettings() }
    var hubUrl by remember { mutableStateOf(initial.hubUrl) }
    var joinToken by remember { mutableStateOf(initial.joinToken) }
    var nodeName by remember { mutableStateOf(initial.nodeName) }
    var groupName by remember { mutableStateOf(initial.groupName) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Android 边缘节点接入 Hub", fontSize = 20.sp, fontWeight = FontWeight.Bold)

        // 状态与安全锁提示卡片
        Card(
            colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("当前状态：", color = Color(0xFF94A3B8), fontSize = 13.sp)
                    Text(
                        hubStatus,
                        color = if (hubStatus.startsWith("已接入")) Color(0xFF34D399) else Color(0xFF38BDF8),
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp
                    )
                }

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0xFF09122A), RoundedCornerShape(8.dp))
                        .padding(10.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(Icons.Rounded.Lock, contentDescription = null, tint = Color(0xFFFBBF24), modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Android 安全策略：接入 Hub 时自动上报设备标识，Hub 将默认禁用本节点第三方 API 接入且不可修改（不在 /api/v1/nodes 对外列表展示，仅用于安全同步 Cookie）。",
                        fontSize = 12.sp,
                        color = Color(0xFFFDE68A),
                        lineHeight = 17.sp
                    )
                }

                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        onClick = {
                            store.saveHubSettings(
                                store.loadHubSettings().copy(
                                    hubUrl = hubUrl,
                                    joinToken = joinToken,
                                    nodeName = nodeName,
                                    groupName = groupName
                                )
                            )
                            val intent = Intent(context, EdgeAgentService::class.java).apply {
                                action = EdgeAgentService.ACTION_START
                            }
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                context.startForegroundService(intent)
                            } else {
                                context.startService(intent)
                            }
                        },
                        enabled = !serviceRunning,
                        modifier = Modifier.weight(1f)
                    ) {
                        Icon(Icons.Rounded.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("启动后台接入")
                    }

                    OutlinedButton(
                        onClick = {
                            val intent = Intent(context, EdgeAgentService::class.java).apply {
                                action = EdgeAgentService.ACTION_STOP
                            }
                            context.startService(intent)
                        },
                        enabled = serviceRunning,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFF87171)),
                        modifier = Modifier.weight(1f)
                    ) {
                        Icon(Icons.Rounded.Stop, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("停止接入")
                    }
                }
            }
        }

        Card(
            colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Hub 连接参数（WSS 反向长连）", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)

                OutlinedTextField(
                    value = hubUrl,
                    onValueChange = { hubUrl = it },
                    label = { Text("Hub 地址 (HUB_URL)") },
                    placeholder = { Text("https://hub.yourdomain.com:8443") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = joinToken,
                    onValueChange = { joinToken = it },
                    label = { Text("入网通行码 (JOIN_TOKEN，留空走 TOFU 审批)") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = nodeName,
                    onValueChange = { nodeName = it },
                    label = { Text("节点名称（留空自动生成 Android-型号）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = groupName,
                    onValueChange = { groupName = it },
                    label = { Text("所属分组") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )

                Button(
                    onClick = {
                        store.saveHubSettings(
                            store.loadHubSettings().copy(
                                hubUrl = hubUrl,
                                joinToken = joinToken,
                                nodeName = nodeName,
                                groupName = groupName
                            )
                        )
                        Toast.makeText(context, "Hub 配置已保存", Toast.LENGTH_SHORT).show()
                    },
                    modifier = Modifier.align(Alignment.End)
                ) {
                    Text("保存 Hub 配置")
                }
            }
        }
    }
}

@Composable
fun CookieGuardTab(store: NodeConfigStore, serviceRunning: Boolean) {
    val context = LocalContext.current
    val initialCfg = remember { store.loadCookieGuardConfig() }
    var mode by remember { mutableStateOf(initialCfg.mode) }
    var whitelistRaw by remember { mutableStateOf(store.getRawWhitelist()) }
    var blacklistRaw by remember { mutableStateOf(store.getRawBlacklist()) }
    var blockedNamesRaw by remember { mutableStateOf(store.getRawBlockedNames()) }
    var excludeExpired by remember { mutableStateOf(initialCfg.excludeExpired) }
    var protectInject by remember { mutableStateOf(initialCfg.protectInject) }
    var previewText by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("本地边缘 Cookie 隐私防火墙", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text(
            "所有过滤均在手机本机内存立即拦截，未放行的 Cookie 绝不会上传至 Hub。",
            fontSize = 12.sp,
            color = Color(0xFF94A3B8)
        )

        Card(
            colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val modes = listOf(
                    "whitelist" to "严格白名单（推荐）：仅放行白名单域名，其余全部本机拦截",
                    "blacklist" to "黑名单排除：放行除黑名单/敏感名以外的域名",
                    "all" to "本地全量放行：允许内置工作浏览器全部 Cookie 同步",
                    "block_export" to "禁止导出：不向 Hub 上传任何本地 Cookie"
                )
                modes.forEach { (valKey, desc) ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = (mode == valKey), onClick = { mode = valKey })
                        Text(desc, fontSize = 13.sp)
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("自动剔除已过期 Cookie", fontSize = 13.sp)
                    Switch(checked = excludeExpired, onCheckedChange = { excludeExpired = it })
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("Hub 下发写入本机时同样校验保护规则", fontSize = 13.sp)
                    Switch(checked = protectInject, onCheckedChange = { protectInject = it })
                }
            }
        }

        OutlinedTextField(
            value = whitelistRaw,
            onValueChange = { whitelistRaw = it },
            label = { Text("白名单域名（每行或逗号分隔，支持 *.domain.com）") },
            minLines = 3,
            maxLines = 6,
            modifier = Modifier.fillMaxWidth()
        )

        OutlinedTextField(
            value = blacklistRaw,
            onValueChange = { blacklistRaw = it },
            label = { Text("黑名单域名（支持 *bank* 通配）") },
            minLines = 3,
            maxLines = 6,
            modifier = Modifier.fillMaxWidth()
        )

        OutlinedTextField(
            value = blockedNamesRaw,
            onValueChange = { blockedNamesRaw = it },
            label = { Text("屏蔽 Cookie 名称关键字（可选，逗号分隔）") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = {
                    val cfg = CookieGuardConfig(
                        mode = mode,
                        whitelistDomains = CookieGuardConfig.parseRuleList(whitelistRaw),
                        blacklistDomains = CookieGuardConfig.parseRuleList(blacklistRaw),
                        blockedCookieNames = CookieGuardConfig.parseRuleList(blockedNamesRaw),
                        excludeExpired = excludeExpired,
                        protectInject = protectInject
                    )
                    val raw = WebViewCookieBridge.extractAllLocalCookies(store, cfg)
                    val (_, stats) = CookieGuard(cfg).filterForExport(raw)
                    val topAllow = stats.allowedDomains.entries.sortedByDescending { it.value }.take(5)
                        .joinToString(", ") { "${it.key}(${it.value})" }.ifEmpty { "无" }
                    previewText = "试算完成：总计 ${stats.total} 条 | 将放行 ${stats.allowed} 条 | 本地拦截 ${stats.blockedByPolicy} 条 | 放行域=[$topAllow]"
                    AgentStateBus.log("GUARD", previewText)
                },
                modifier = Modifier.weight(1f)
            ) {
                Text("🔍 试算过滤结果", fontSize = 13.sp)
            }

            Button(
                onClick = {
                    store.saveCookieGuardConfig(mode, whitelistRaw, blacklistRaw, blockedNamesRaw, excludeExpired, protectInject)
                    if (serviceRunning) {
                        context.startService(
                            Intent(context, EdgeAgentService::class.java).apply {
                                action = EdgeAgentService.ACTION_RELOAD_GUARD
                            }
                        )
                    }
                    Toast.makeText(context, "Cookie 防火墙策略已保存生效", Toast.LENGTH_SHORT).show()
                },
                modifier = Modifier.weight(1f)
            ) {
                Text("保存并热更新", fontSize = 13.sp)
            }
        }

        if (previewText.isNotEmpty()) {
            Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF09122A))) {
                Text(
                    previewText,
                    color = Color(0xFF2DD4BF),
                    fontSize = 12.sp,
                    modifier = Modifier.padding(12.dp)
                )
            }
        }
    }
}

@Composable
fun LogsTab() {
    val logs by AgentStateBus.logs.collectAsState()
    var levelFilter by remember { mutableStateOf("ALL") }

    val filtered = remember(logs, levelFilter) {
        if (levelFilter == "ALL") logs else logs.filter { it.level == levelFilter }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(12.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("ALL", "GUARD", "INFO", "WARN", "ERROR").forEach { lv ->
                    FilterChip(
                        selected = (levelFilter == lv),
                        onClick = { levelFilter = lv },
                        label = { Text(lv, fontSize = 11.sp) }
                    )
                }
            }
            IconButton(onClick = { AgentStateBus.clearLogs() }) {
                Icon(Icons.Rounded.CleaningServices, contentDescription = "清空日志")
            }
        }

        Spacer(Modifier.height(6.dp))

        Card(
            colors = CardDefaults.cardColors(containerColor = Color(0xFF020617)),
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
        ) {
            if (filtered.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("暂无日志记录", color = Color(0xFF64748B), fontSize = 13.sp)
                }
            } else {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    items(filtered.asReversed()) { item ->
                        val color = when (item.level) {
                            "GUARD" -> Color(0xFF2DD4BF)
                            "WARN" -> Color(0xFFFBBF24)
                            "ERROR" -> Color(0xFFF87171)
                            else -> Color(0xFFCBD5E1)
                        }
                        Text(
                            text = "${item.time} [${item.level}] ${item.message}",
                            color = color,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 11.sp,
                            maxLines = 4,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }
            }
        }
    }
}
