package com.wimotek.edgenode.data

import android.content.Context
import android.net.Uri
import android.os.Build
import com.wimotek.edgenode.guard.CookieGuardConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

data class HubSettings(
    val hubUrl: String = "https://hub.yourdomain.com:8443",
    val joinToken: String = "",
    val nodeName: String = "",
    val groupName: String = "Android节点",
    val desktopUaMode: Boolean = false
)

data class LogEntry(
    val time: String,
    val level: String,
    val message: String
)

data class BookmarkItem(
    val title: String,
    val url: String,
    val folder: String = "常用站点",
    val pinned: Boolean = true,
    val sortOrder: Int = 0
)

object AgentStateBus {
    private val _hubStatus = MutableStateFlow("未接入")
    val hubStatus: StateFlow<String> = _hubStatus.asStateFlow()

    private val _serviceRunning = MutableStateFlow(false)
    val serviceRunning: StateFlow<Boolean> = _serviceRunning.asStateFlow()

    private val _apiLockedDisabled = MutableStateFlow(true)
    val apiLockedDisabled: StateFlow<Boolean> = _apiLockedDisabled.asStateFlow()

    private val _logs = MutableStateFlow<List<LogEntry>>(emptyList())
    val logs: StateFlow<List<LogEntry>> = _logs.asStateFlow()

    private val _bookmarks = MutableStateFlow<List<BookmarkItem>>(emptyList())
    val bookmarks: StateFlow<List<BookmarkItem>> = _bookmarks.asStateFlow()

    private val timeFmt = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    fun setServiceRunning(running: Boolean) {
        _serviceRunning.value = running
        if (!running) {
            _hubStatus.value = "已停止"
        }
    }

    fun setHubStatus(status: String) {
        _hubStatus.value = status
    }

    fun setApiLocked(locked: Boolean) {
        _apiLockedDisabled.value = locked
    }

    fun setBookmarks(list: List<BookmarkItem>) {
        _bookmarks.value = list
    }

    fun log(level: String, message: String) {
        val entry = LogEntry(
            time = timeFmt.format(Date()),
            level = level.uppercase(Locale.ROOT),
            message = message
        )
        val next = (_logs.value + entry).let { list ->
            if (list.size > 400) list.takeLast(300) else list
        }
        _logs.value = next
    }

    fun clearLogs() {
        _logs.value = emptyList()
    }
}

class NodeConfigStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("wimotek_android_edge", Context.MODE_PRIVATE)

    fun loadHubSettings(): HubSettings {
        return HubSettings(
            hubUrl = prefs.getString("hub_url", "https://hub.yourdomain.com:8443") ?: "https://hub.yourdomain.com:8443",
            joinToken = prefs.getString("join_token", "") ?: "",
            nodeName = prefs.getString("node_name", "") ?: "",
            groupName = prefs.getString("group_name", "Android节点") ?: "Android节点",
            desktopUaMode = prefs.getBoolean("desktop_ua", false)
        )
    }

    fun saveHubSettings(settings: HubSettings) {
        prefs.edit()
            .putString("hub_url", settings.hubUrl.trim().trimEnd('/'))
            .putString("join_token", settings.joinToken.trim())
            .putString("node_name", settings.nodeName.trim())
            .putString("group_name", settings.groupName.trim().ifEmpty { "Android节点" })
            .putBoolean("desktop_ua", settings.desktopUaMode)
            .apply()
    }

    fun loadCookieGuardConfig(): CookieGuardConfig {
        val mode = prefs.getString("guard_mode", "whitelist") ?: "whitelist"
        val wlRaw = prefs.getString("guard_whitelist", "") ?: ""
        val hasBlSaved = prefs.contains("guard_blacklist")
        val blRaw = if (hasBlSaved) {
            prefs.getString("guard_blacklist", "") ?: ""
        } else {
            CookieGuardConfig.DEFAULT_SENSITIVE_BLACKLIST.joinToString("\n")
        }
        val namesRaw = prefs.getString("guard_blocked_names", "") ?: ""
        return CookieGuardConfig(
            mode = mode,
            whitelistDomains = CookieGuardConfig.parseRuleList(wlRaw),
            blacklistDomains = CookieGuardConfig.parseRuleList(blRaw),
            blockedCookieNames = CookieGuardConfig.parseRuleList(namesRaw),
            excludeExpired = prefs.getBoolean("guard_exclude_expired", true),
            protectInject = prefs.getBoolean("guard_protect_inject", false)
        )
    }

    fun saveCookieGuardConfig(
        mode: String,
        whitelistRaw: String,
        blacklistRaw: String,
        blockedNamesRaw: String,
        excludeExpired: Boolean,
        protectInject: Boolean
    ) {
        prefs.edit()
            .putString("guard_mode", mode)
            .putString("guard_whitelist", whitelistRaw)
            .putString("guard_blacklist", blacklistRaw)
            .putString("guard_blocked_names", blockedNamesRaw)
            .putBoolean("guard_exclude_expired", excludeExpired)
            .putBoolean("guard_protect_inject", protectInject)
            .apply()
    }

    fun getRawWhitelist(): String = prefs.getString("guard_whitelist", "") ?: ""

    fun getRawBlacklist(): String {
        return if (prefs.contains("guard_blacklist")) {
            prefs.getString("guard_blacklist", "") ?: ""
        } else {
            CookieGuardConfig.DEFAULT_SENSITIVE_BLACKLIST.joinToString("\n")
        }
    }

    fun getRawBlockedNames(): String = prefs.getString("guard_blocked_names", "") ?: ""

    fun ensureIdentity(configuredName: String): Pair<String, String> {
        val cleanCfg = configuredName.trim()
        val savedUuid = prefs.getString("node_uuid", "") ?: ""
        val savedFp = prefs.getString("node_fp", "") ?: ""
        if (savedUuid.isNotEmpty() && savedFp.isNotEmpty() && (cleanCfg.isEmpty() || cleanCfg == savedUuid)) {
            return savedUuid to savedFp
        }
        val defaultHost = (Build.MODEL ?: "Device").replace(Regex("[^A-Za-z0-9_-]"), "")
        val uuid = cleanCfg.ifEmpty { "Android-${defaultHost.ifEmpty { UUID.randomUUID().toString().take(8) }}" }
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("$uuid-${UUID.randomUUID()}".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
            .take(32)
        val fp = "sha256:$digest"
        prefs.edit()
            .putString("node_uuid", uuid)
            .putString("node_fp", fp)
            .apply()
        return uuid to fp
    }

    fun getSessionTicket(): String? = prefs.getString("session_ticket", null)?.takeIf { it.isNotBlank() }

    fun saveSessionTicket(ticket: String?) {
        if (!ticket.isNullOrBlank()) {
            prefs.edit().putString("session_ticket", ticket.trim()).apply()
        }
    }

    fun getLastHomepage(): String = prefs.getString("last_url", "https://github.com/login") ?: "https://github.com/login"

    fun saveLastHomepage(url: String) {
        if (url.startsWith("http://") || url.startsWith("https://")) {
            prefs.edit().putString("last_url", url).apply()
        }
    }

    @Synchronized
    fun recordVisitedUrl(url: String?) {
        if (url.isNullOrBlank()) return
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
        val host = uri.host?.lowercase(Locale.ROOT)?.trim() ?: return
        if (host.isEmpty()) return

        val current = getTrackedHosts().toMutableSet()
        var changed = current.add(host)
        val parts = host.split(".")
        if (parts.size >= 2) {
            val root = "${parts[parts.size - 2]}.${parts[parts.size - 1]}"
            if (current.add(root)) {
                changed = true
            }
        }
        if (changed) {
            val arr = JSONArray()
            current.take(300).forEach { arr.put(it) }
            prefs.edit().putString("tracked_hosts", arr.toString()).apply()
        }
    }

    fun getTrackedHosts(): List<String> {
        val raw = prefs.getString("tracked_hosts", "[]") ?: "[]"
        val out = LinkedHashSet<String>()
        runCatching {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val h = arr.optString(i).trim().lowercase(Locale.ROOT)
                if (h.isNotEmpty()) out.add(h)
            }
        }
        return out.toList()
    }

    fun normalizeBookmarkUrl(rawUrl: String): String {
        val trimmed = rawUrl.trim()
        if (trimmed.isEmpty()) return ""
        return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            trimmed
        } else {
            "https://$trimmed"
        }
    }

    @Synchronized
    fun loadBookmarks(): List<BookmarkItem> {
        if (!prefs.getBoolean("bookmarks_initialized", false)) {
            val defaults = listOf(
                BookmarkItem("GitHub", "https://github.com/login", "开发工具", true, 1),
                BookmarkItem("X / Twitter", "https://x.com", "常用站点", true, 2),
                BookmarkItem("淘宝", "https://login.taobao.com", "购物生活", true, 3),
                BookmarkItem("京东", "https://plogin.m.jd.com", "购物生活", true, 4),
                BookmarkItem("B站", "https://passport.bilibili.com/login", "常用站点", true, 5),
                BookmarkItem("百度", "https://www.baidu.com", "常用站点", true, 6)
            )
            saveBookmarks(defaults, syncBus = false)
            prefs.edit().putBoolean("bookmarks_initialized", true).apply()
            AgentStateBus.setBookmarks(defaults)
            return defaults
        }

        val raw = prefs.getString("bookmarks_json", "[]") ?: "[]"
        val out = ArrayList<BookmarkItem>()
        runCatching {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                val url = normalizeBookmarkUrl(obj.optString("url", ""))
                if (url.isEmpty()) continue
                val title = obj.optString("title", url).ifBlank { url }
                val folder = obj.optString("folder", "常用站点").ifBlank { "常用站点" }
                val pinned = obj.optBoolean("pinned", obj.optInt("pinned", 1) != 0)
                out.add(
                    BookmarkItem(
                        title = title,
                        url = url,
                        folder = folder,
                        pinned = pinned,
                        sortOrder = obj.optInt("sort_order", i)
                    )
                )
            }
        }
        AgentStateBus.setBookmarks(out)
        return out
    }

    @Synchronized
    fun saveBookmarks(items: List<BookmarkItem>, syncBus: Boolean = true) {
        val sorted = items.sortedWith(compareByDescending<BookmarkItem> { it.pinned }.thenBy { it.sortOrder })
        val arr = JSONArray()
        sorted.forEachIndexed { idx, b ->
            arr.put(
                JSONObject().apply {
                    put("title", b.title)
                    put("url", b.url)
                    put("folder", b.folder)
                    put("pinned", b.pinned)
                    put("sort_order", if (b.sortOrder > 0) b.sortOrder else idx + 1)
                }
            )
        }
        prefs.edit()
            .putString("bookmarks_json", arr.toString())
            .putBoolean("bookmarks_initialized", true)
            .apply()
        if (syncBus) {
            AgentStateBus.setBookmarks(sorted)
        }
    }

    @Synchronized
    fun upsertLocalBookmark(item: BookmarkItem): BookmarkItem {
        val normUrl = normalizeBookmarkUrl(item.url)
        val clean = item.copy(
            title = item.title.trim().ifBlank { normUrl },
            url = normUrl,
            folder = item.folder.trim().ifBlank { "常用站点" }
        )
        val current = loadBookmarks().filterNot { it.url.equals(normUrl, ignoreCase = true) }.toMutableList()
        current.add(0, clean)
        saveBookmarks(current, syncBus = true)
        return clean
    }

    @Synchronized
    fun deleteLocalBookmark(url: String) {
        val normUrl = normalizeBookmarkUrl(url)
        val next = loadBookmarks().filterNot { it.url.equals(normUrl, ignoreCase = true) }
        saveBookmarks(next, syncBus = true)
    }
}
