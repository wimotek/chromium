package com.wimotek.edgenode.browser

import android.webkit.CookieManager
import com.wimotek.edgenode.data.NodeConfigStore
import com.wimotek.edgenode.guard.CookieGuardConfig
import com.wimotek.edgenode.guard.CookieItem
import java.util.Locale

object WebViewCookieBridge {

    /**
     * 通过 Android WebView CookieManager 读取所有已访问站点与白名单站点的 Cookie（含 HttpOnly）
     */
    fun extractAllLocalCookies(store: NodeConfigStore, guardCfg: CookieGuardConfig): List<CookieItem> {
        val cm = CookieManager.getInstance()
        val candidateHosts = LinkedHashSet<String>()
        candidateHosts.addAll(store.getTrackedHosts())
        guardCfg.whitelistDomains.forEach { rule ->
            val cleaned = rule.removePrefix("*.").trimStart('.').trim()
            if (cleaned.isNotEmpty() && !cleaned.contains("*")) {
                candidateHosts.add(cleaned)
            }
        }

        val dedup = LinkedHashMap<String, CookieItem>()
        for (host in candidateHosts) {
            for (scheme in listOf("https", "http")) {
                val rawHeader = runCatching { cm.getCookie("$scheme://$host") }.getOrNull() ?: continue
                if (rawHeader.isBlank()) continue
                val pairs = rawHeader.split(";")
                for (pair in pairs) {
                    val idx = pair.indexOf('=')
                    if (idx <= 0) continue
                    val name = pair.substring(0, idx).trim()
                    val value = pair.substring(idx + 1).trim()
                    if (name.isEmpty()) continue
                    val key = "$name@$host"
                    if (!dedup.containsKey(key)) {
                        dedup[key] = CookieItem(
                            name = name,
                            value = value,
                            domain = ".$host",
                            path = "/",
                            secure = (scheme == "https"),
                            httpOnly = false,
                            expires = null
                        )
                    }
                }
            }
        }
        return dedup.values.toList()
    }

    /**
     * 将 Hub 下发的 Cookies 写入 Android WebView CookieManager 并刷盘，浏览器立即生效登录态
     */
    fun injectCookies(cookies: List<CookieItem>, store: NodeConfigStore): Int {
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        var injected = 0

        for (c in cookies) {
            val cleanDom = c.domain.trim().trimStart('.').lowercase(Locale.ROOT)
            if (cleanDom.isEmpty()) continue
            val scheme = if (c.secure) "https" else "http"
            val path = c.path.ifBlank { "/" }
            val url = "$scheme://$cleanDom$path"

            val sb = StringBuilder()
            sb.append(c.name).append("=").append(c.value)
            sb.append("; Domain=").append(if (c.domain.startsWith(".")) c.domain else cleanDom)
            sb.append("; Path=").append(path)
            if (c.secure) sb.append("; Secure")
            if (c.httpOnly) sb.append("; HttpOnly")

            runCatching {
                cm.setCookie(url, sb.toString())
                store.recordVisitedUrl(url)
                injected++
            }
        }
        runCatching { cm.flush() }
        return injected
    }
}
