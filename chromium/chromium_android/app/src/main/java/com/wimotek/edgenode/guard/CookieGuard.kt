package com.wimotek.edgenode.guard

import org.json.JSONObject
import java.util.Locale

data class CookieItem(
    val name: String,
    val value: String,
    val domain: String,
    val path: String = "/",
    val secure: Boolean = true,
    val httpOnly: Boolean = false,
    val expires: Double? = null
) {
    fun toCdpJson(): JSONObject {
        val obj = JSONObject()
        obj.put("name", name)
        obj.put("value", value)
        obj.put("domain", domain)
        obj.put("path", path.ifBlank { "/" })
        obj.put("secure", secure)
        obj.put("httpOnly", httpOnly)
        if (expires != null && expires > 0) {
            obj.put("expires", expires)
        }
        return obj
    }

    companion object {
        fun fromJson(obj: JSONObject): CookieItem? {
            val n = obj.optString("name", "").trim()
            if (n.isEmpty()) return null
            val v = obj.optString("value", "")
            val dom = obj.optString("domain", "").trim()
            val p = obj.optString("path", "/").ifBlank { "/" }
            val sec = obj.optBoolean("secure", false)
            val ho = obj.optBoolean("httpOnly", false)
            val exp = if (obj.has("expires") && !obj.isNull("expires")) {
                obj.optDouble("expires", -1.0).takeIf { !it.isNaN() && it > 0 }
            } else {
                null
            }
            return CookieItem(
                name = n,
                value = v,
                domain = dom,
                path = p,
                secure = sec,
                httpOnly = ho,
                expires = exp
            )
        }
    }
}

data class CookieGuardConfig(
    val mode: String = "whitelist", // whitelist | blacklist | all | block_export
    val whitelistDomains: List<String> = emptyList(),
    val blacklistDomains: List<String> = DEFAULT_SENSITIVE_BLACKLIST,
    val blockedCookieNames: List<String> = emptyList(),
    val excludeExpired: Boolean = true,
    val protectInject: Boolean = false
) {
    companion object {
        val DEFAULT_SENSITIVE_BLACKLIST = listOf(
            "localhost",
            "127.0.0.1",
            "alipay.com",
            "paypal.com",
            "stripe.com",
            "mail.google.com",
            "mail.qq.com",
            "mail.163.com",
            "icbc.com.cn",
            "cmbchina.com",
            "ccb.com",
            "boc.cn",
            "abchina.com",
            "doubleclick.net",
            "google-analytics.com"
        )

        fun parseRuleList(raw: String): List<String> {
            val seen = LinkedHashSet<String>()
            raw.replace("\r", "\n")
                .replace(";", "\n")
                .replace(",", "\n")
                .split("\n")
                .forEach { line ->
                    val clean = line.trim().lowercase(Locale.ROOT)
                    if (clean.isNotEmpty() && !clean.startsWith("#")) {
                        seen.add(clean)
                    }
                }
            return seen.toList()
        }
    }
}

data class FilterStats(
    val total: Int,
    val allowed: Int,
    val blockedByPolicy: Int,
    val expiredDropped: Int,
    val allowedDomains: Map<String, Int>,
    val blockedDomains: Map<String, Int>
)

class CookieGuard(val config: CookieGuardConfig) {

    fun filterForExport(cookies: List<CookieItem>): Pair<List<CookieItem>, FilterStats> {
        return applyRules(cookies)
    }

    fun filterForInject(cookies: List<CookieItem>): Pair<List<CookieItem>, FilterStats> {
        if (!config.protectInject) {
            val domCounts = LinkedHashMap<String, Int>()
            cookies.forEach { c ->
                val d = c.domain.trim().lowercase(Locale.ROOT).trimStart('.').ifEmpty { "unknown" }
                domCounts[d] = (domCounts[d] ?: 0) + 1
            }
            return cookies to FilterStats(
                total = cookies.size,
                allowed = cookies.size,
                blockedByPolicy = 0,
                expiredDropped = 0,
                allowedDomains = domCounts,
                blockedDomains = emptyMap()
            )
        }
        return applyRules(cookies)
    }

    private fun applyRules(cookies: List<CookieItem>): Pair<List<CookieItem>, FilterStats> {
        val allowedMap = LinkedHashMap<String, Int>()
        val blockedMap = LinkedHashMap<String, Int>()

        if (config.mode == "block_export") {
            cookies.forEach { c ->
                val d = c.domain.trim().lowercase(Locale.ROOT).trimStart('.').ifEmpty { "unknown" }
                blockedMap[d] = (blockedMap[d] ?: 0) + 1
            }
            return emptyList<CookieItem>() to FilterStats(
                total = cookies.size,
                allowed = 0,
                blockedByPolicy = cookies.size,
                expiredDropped = 0,
                allowedDomains = emptyMap(),
                blockedDomains = blockedMap
            )
        }

        val nowSec = System.currentTimeMillis() / 1000.0
        var blockedCount = 0
        var expiredCount = 0
        val out = ArrayList<CookieItem>()

        for (c in cookies) {
            val dom = c.domain.trim().lowercase(Locale.ROOT).trimStart('.')
            val name = c.name.trim()

            if (config.excludeExpired && c.expires != null && c.expires > 0 && c.expires <= nowSec) {
                expiredCount++
                continue
            }

            if (config.blockedCookieNames.isNotEmpty() && config.blockedCookieNames.any { matchWildcard(name.lowercase(Locale.ROOT), it) }) {
                blockedCount++
                val key = dom.ifEmpty { "unknown" }
                blockedMap[key] = (blockedMap[key] ?: 0) + 1
                continue
            }

            when (config.mode) {
                "whitelist" -> {
                    val ok = config.whitelistDomains.isNotEmpty() &&
                        config.whitelistDomains.any { matchDomainRule(dom, it) }
                    if (!ok) {
                        blockedCount++
                        val key = dom.ifEmpty { "unknown" }
                        blockedMap[key] = (blockedMap[key] ?: 0) + 1
                        continue
                    }
                }
                "blacklist" -> {
                    val hit = config.blacklistDomains.isNotEmpty() &&
                        config.blacklistDomains.any { matchDomainRule(dom, it) }
                    if (hit) {
                        blockedCount++
                        val key = dom.ifEmpty { "unknown" }
                        blockedMap[key] = (blockedMap[key] ?: 0) + 1
                        continue
                    }
                }
            }

            out.add(c)
            val key = dom.ifEmpty { "unknown" }
            allowedMap[key] = (allowedMap[key] ?: 0) + 1
        }

        return out to FilterStats(
            total = cookies.size,
            allowed = out.size,
            blockedByPolicy = blockedCount,
            expiredDropped = expiredCount,
            allowedDomains = allowedMap,
            blockedDomains = blockedMap
        )
    }

    companion object {
        fun matchDomainRule(cookieDomain: String, rule: String): Boolean {
            val dom = cookieDomain.trim().lowercase(Locale.ROOT).trimStart('.')
            val r = rule.trim().lowercase(Locale.ROOT)
            if (dom.isEmpty() || r.isEmpty()) return false

            if (r.startsWith("*.")) {
                val base = r.substring(2).trimStart('.')
                return dom == base || dom.endsWith(".$base")
            }
            if (r.contains("*")) {
                return matchWildcard(dom, r)
            }
            val clean = r.trimStart('.')
            return dom == clean || dom.endsWith(".$clean")
        }

        private fun matchWildcard(text: String, pattern: String): Boolean {
            val regexStr = buildString {
                append("^")
                for (ch in pattern) {
                    when (ch) {
                        '*' -> append(".*")
                        '?' -> append(".")
                        '.', '+', '(', ')', '[', ']', '{', '}', '^', '$', '|', '\\' -> {
                            append("\\")
                            append(ch)
                        }
                        else -> append(ch)
                    }
                }
                append("$")
            }
            return Regex(regexStr).matches(text)
        }
    }
}
