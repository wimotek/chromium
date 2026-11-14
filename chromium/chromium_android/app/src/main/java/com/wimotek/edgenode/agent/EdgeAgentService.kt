package com.wimotek.edgenode.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.wimotek.edgenode.MainActivity
import com.wimotek.edgenode.R
import com.wimotek.edgenode.browser.WebViewCookieBridge
import com.wimotek.edgenode.data.AgentStateBus
import com.wimotek.edgenode.data.NodeConfigStore
import com.wimotek.edgenode.guard.CookieGuard
import com.wimotek.edgenode.guard.CookieItem
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class EdgeAgentService : Service() {

    companion object {
        const val ACTION_START = "com.wimotek.edgenode.START"
        const val ACTION_STOP = "com.wimotek.edgenode.STOP"
        const val ACTION_RELOAD_GUARD = "com.wimotek.edgenode.RELOAD_GUARD"
        private const val CHANNEL_ID = "wimotek_edge_channel"
        private const val NOTIF_ID = 1001
    }

    private lateinit var store: NodeConfigStore
    private lateinit var okClient: OkHttpClient
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val stopRequested = AtomicBoolean(false)
    private var activeWs: WebSocket? = null
    private var hbFuture: ScheduledFuture<*>? = null
    private var backoffSeconds = 2L

    override fun onCreate() {
        super.onCreate()
        store = NodeConfigStore(this)
        okClient = buildTrustAllOkHttpClient()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopRequested.set(true)
                hbFuture?.cancel(true)
                activeWs?.close(1000, "User Stopped")
                activeWs = null
                AgentStateBus.setServiceRunning(false)
                AgentStateBus.log("INFO", "已停止 Hub WSS 后台隧道服务")
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_RELOAD_GUARD -> {
                val guardCfg = store.loadCookieGuardConfig()
                AgentStateBus.log("GUARD", "Cookie 隐私防火墙已热更新: mode=${guardCfg.mode}, wl=${guardCfg.whitelistDomains.size}, bl=${guardCfg.blacklistDomains.size}")
                return START_STICKY
            }
            else -> {
                stopRequested.set(false)
                startForeground(NOTIF_ID, buildNotification("正在连接 Hub WSS 反向隧道..."))
                AgentStateBus.setServiceRunning(true)
                connectReverseTunnel()
                return START_STICKY
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopRequested.set(true)
        hbFuture?.cancel(true)
        activeWs?.close(1000, "Service Destroyed")
        AgentStateBus.setServiceRunning(false)
        scheduler.shutdownNow()
        super.onDestroy()
    }

    private fun connectReverseTunnel() {
        if (stopRequested.get()) return
        val hub = store.loadHubSettings()
        if (hub.hubUrl.isBlank()) {
            AgentStateBus.log("ERROR", "未配置 Hub 地址，无法建立连接")
            AgentStateBus.setHubStatus("配置缺失")
            return
        }

        val (nodeUuid, fingerprint) = store.ensureIdentity(hub.nodeName)
        val nodeName = hub.nodeName.ifBlank { nodeUuid }
        val rawHub = hub.hubUrl.trim().trimEnd('/')
        val normalizedHub = if (rawHub.startsWith("http://") || rawHub.startsWith("https://") ||
            rawHub.startsWith("ws://") || rawHub.startsWith("wss://")
        ) rawHub else "https://$rawHub"
        val wsBase = normalizedHub
            .replace("https://", "wss://")
            .replace("http://", "ws://")
        val tunnelUrl = "$wsBase/api/nodes/reverse-tunnel"

        AgentStateBus.setHubStatus("连接中...")
        AgentStateBus.log("INFO", "正在发起 Android WSS 反向长连 -> $tunnelUrl (UUID=$nodeUuid)")

        val reqBuilder = Request.Builder()
            .url(tunnelUrl)
            .header("X-Client-Type", "android")
            .header("X-Node-UUID", nodeUuid)
            .header("X-Node-Fingerprint", fingerprint)
            .header("X-Node-Name", URLEncoder.encode(nodeName, "UTF-8"))
            .header("X-Node-Group", URLEncoder.encode(hub.groupName, "UTF-8"))
            .header("X-CDP-Port", "0")
            .header("User-Agent", "WimotekAndroidEdge/1.0 (Android ${Build.VERSION.RELEASE}; ${Build.MODEL})")

        if (hub.joinToken.isNotBlank()) {
            reqBuilder.header("X-Join-Token", hub.joinToken)
        }

        activeWs?.cancel()
        activeWs = okClient.newWebSocket(reqBuilder.build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val handshake = JSONObject().apply {
                    put("node_uuid", nodeUuid)
                    put("public_key_fingerprint", fingerprint)
                    if (hub.joinToken.isNotBlank()) put("join_token", hub.joinToken)
                    store.getSessionTicket()?.let { put("session_ticket", it) }
                    put("name", nodeName)
                    put("group", hub.groupName)
                    put("port", 0)
                    put("reverse_tunnel", true)
                    put("client_type", "android")
                    put("os", "android")
                    put("device_model", Build.MODEL ?: "Android")
                }
                webSocket.send(handshake.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text == "pong" || text == "ping") return
                handleServerMessage(webSocket, text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== activeWs) return
                scheduleReconnect("连接关闭 ($code: $reason)")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (webSocket !== activeWs) return
                scheduleReconnect("${t.javaClass.simpleName}: ${t.message ?: "网络异常"}")
            }
        })
    }

    private fun handleServerMessage(ws: WebSocket, text: String) {
        val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
        val status = msg.optString("status", "")
        val msgType = msg.optString("type", "")
        val action = msg.optString("action", "")
        val reqId = msg.optString("req_id", "")

        if (msgType == "pong") return

        if (status == "denied") {
            val reason = msg.optString("reason", "unknown")
            AgentStateBus.log("ERROR", "Hub 拒绝接入: $reason")
            AgentStateBus.setHubStatus("被拒绝")
            stopRequested.set(true)
            hbFuture?.cancel(true)
            activeWs?.close(1000, "Denied")
            activeWs = null
            AgentStateBus.setServiceRunning(false)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }

        if (status == "pending_tofu") {
            AgentStateBus.setHubStatus("待审批 (TOFU)")
            AgentStateBus.setApiLocked(true)
            AgentStateBus.log("WARN", "已进入 Hub 待审批队列，请在 Hub 网页端点击【批准入网】（第三方 API 已自动锁定禁用）")
            updateNotification("已连接 Hub · 待管理员审批")
            return
        }

        if (status == "ok" || status == "approved") {
            val ticket = msg.optString("session_ticket", "")
            if (ticket.isNotEmpty()) store.saveSessionTicket(ticket)
            AgentStateBus.setHubStatus("已接入 (API已锁定禁用)")
            AgentStateBus.setApiLocked(!msg.optBoolean("api_enabled", false))
            backoffSeconds = 2L
            AgentStateBus.log("INFO", "Hub 认证放行成功（Android 节点默认禁止第三方 API，仅参与安全 Cookie 同步）")
            updateNotification("已接入 Hub · 安全 Cookie 同步中")
            startHeartbeat(ws)
            return
        }

        when (action) {
            "fetch_cookies" -> {
                val guardCfg = store.loadCookieGuardConfig()
                val guard = CookieGuard(guardCfg)
                val raw = WebViewCookieBridge.extractAllLocalCookies(store, guardCfg)
                val (allowed, stats) = guard.filterForExport(raw)

                val arr = JSONArray()
                allowed.forEach { arr.put(it.toCdpJson()) }
                val resp = JSONObject().apply {
                    put("req_id", reqId)
                    put("status", "ok")
                    put("cookies", arr)
                }
                ws.send(resp.toString())
                AgentStateBus.log(
                    "GUARD",
                    "fetch_cookies | 模式=${guardCfg.mode} | 本机=${stats.total} | 放行=${stats.allowed} | 拦截=${stats.blockedByPolicy}"
                )
            }

            "inject_cookies" -> {
                val payload = msg.optJSONObject("payload") ?: JSONObject()
                val rawArr = payload.optJSONArray("cookies") ?: JSONArray()
                val incoming = ArrayList<CookieItem>()
                for (i in 0 until rawArr.length()) {
                    rawArr.optJSONObject(i)?.let { CookieItem.fromJson(it)?.let(incoming::add) }
                }
                val guardCfg = store.loadCookieGuardConfig()
                val guard = CookieGuard(guardCfg)
                val (allowedInject, stats) = guard.filterForInject(incoming)
                val count = WebViewCookieBridge.injectCookies(allowedInject, store)
                val resp = JSONObject().apply {
                    put("req_id", reqId)
                    put("status", "ok")
                    put("injected_count", count)
                }
                ws.send(resp.toString())
                AgentStateBus.log(
                    "GUARD",
                    "inject_cookies | 收到=${stats.total} | 写入WebView=$count | 拒绝=${stats.blockedByPolicy}"
                )
            }

            "get_version" -> {
                val ver = JSONObject().apply {
                    put("Browser", "Android-WebView/${Build.VERSION.RELEASE}")
                    put("Protocol-Version", "1.3")
                    put("User-Agent", "Mozilla/5.0 (Linux; Android ${Build.VERSION.RELEASE}; ${Build.MODEL}) AppleWebKit/537.36 Mobile Safari/537.36")
                }
                val resp = JSONObject().apply {
                    put("req_id", reqId)
                    put("status", "ok")
                    put("version", ver)
                }
                ws.send(resp.toString())
            }

            "purge_cookies" -> {
                val payload = msg.optJSONObject("payload") ?: JSONObject()
                val targetsArr = payload.optJSONArray("targets") ?: JSONArray()
                val targets = ArrayList<CookieItem>()
                for (i in 0 until targetsArr.length()) {
                    val obj = targetsArr.optJSONObject(i) ?: continue
                    val name = obj.optString("name", "")
                    val dom = obj.optString("domain", "")
                    val path = obj.optString("path", "/")
                    if (name.isNotBlank() && dom.isNotBlank()) {
                        targets.add(CookieItem(name = name, value = "", domain = dom, path = path))
                    }
                }
                val excArr = payload.optJSONArray("exclude_domains") ?: JSONArray()
                val excludeDomains = ArrayList<String>()
                for (i in 0 until excArr.length()) {
                    excArr.optString(i)?.takeIf { it.isNotBlank() }?.let(excludeDomains::add)
                }
                val guardCfg = store.loadCookieGuardConfig()
                val purgedCount = if (guardCfg.mode == "block_export") {
                    0
                } else {
                    WebViewCookieBridge.purgeCookies(targets, excludeDomains, store, guardCfg)
                }
                val resp = JSONObject().apply {
                    put("req_id", reqId)
                    put("status", "ok")
                    put("purged_count", purgedCount)
                }
                ws.send(resp.toString())
                if (purgedCount > 0) {
                    AgentStateBus.log("GUARD", "purge_cookies | 已按 Hub 清理策略删除 $purgedCount 条 WebView Cookie")
                }
            }

            "ping" -> {
                ws.send(JSONObject().put("type", "pong").toString())
            }
        }
    }

    private fun startHeartbeat(ws: WebSocket) {
        hbFuture?.cancel(true)
        hbFuture = scheduler.scheduleAtFixedRate({
            runCatching { ws.send(JSONObject().put("action", "ping").toString()) }
        }, 5, 5, TimeUnit.SECONDS)
    }

    private fun scheduleReconnect(reason: String) {
        hbFuture?.cancel(true)
        if (stopRequested.get()) return
        val delay = backoffSeconds
        backoffSeconds = (backoffSeconds * 2).coerceAtMost(30L)
        AgentStateBus.setHubStatus("重连中 (${delay}s)")
        AgentStateBus.log("WARN", "WSS 隧道断开 ($reason)，${delay}s 后自动重连")
        updateNotification("WSS 断开，${delay}s 后重连...")
        scheduler.schedule({ connectReverseTunnel() }, delay, TimeUnit.SECONDS)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val ch = NotificationChannel(
                CHANNEL_ID,
                "Wimotek 边缘同步隧道",
                NotificationManager.IMPORTANCE_LOW
            )
            nm.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Wimotek Edge Android")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, buildNotification(text))
    }

    private fun buildTrustAllOkHttpClient(): OkHttpClient {
        val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        })
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, trustAll, SecureRandom())
        return OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustAll[0] as X509TrustManager)
            .hostnameVerifier { _, _ -> true }
            .pingInterval(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }
}
