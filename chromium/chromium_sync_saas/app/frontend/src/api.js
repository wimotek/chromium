export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('saas_token') || ''
  const headers = {
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    ...(options.headers || {}),
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }

  const timeoutMs = Number(options.timeoutMs ?? 15000)
  const controller = new AbortController()
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
  const fetchOptions = { ...options }
  delete fetchOptions.timeoutMs

  let res
  let text = ''
  try {
    res = await fetch(path, {
      cache: 'no-store',
      ...fetchOptions,
      headers,
      signal: options.signal || controller.signal,
    })
    text = await res.text()
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('请求超时，请检查网络连接或服务端状态后重试')
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }

  let data = null
  const trimmed = (text || '').trim()
  const isHtmlResponse = /^<!doctype\s+html|^<html[\s>]/i.test(trimmed) || /<body[\s>]/i.test(trimmed)
  if (!isHtmlResponse) {
    try {
      data = trimmed ? JSON.parse(trimmed) : {}
    } catch {
      data = { detail: trimmed }
    }
  } else {
    const titleMatch = trimmed.match(/<title[^>]*>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : ''
    let friendly = `网关返回异常页面 (HTTP ${res.status})`
    if (res.status === 502) {
      friendly = `网关连接异常 (HTTP 502${title ? ` · ${title}` : ''})，请检查后端服务状态或网关配置后重试`
    } else if (res.status === 503) {
      friendly = '服务暂时不可用 (HTTP 503)，请稍后重试'
    } else if (res.status === 504 || res.status === 524) {
      friendly = `上游网关响应超时 (HTTP ${res.status})，请检查服务器网络或稍后重试`
    } else if (title) {
      friendly = `请求失败 (HTTP ${res.status} · ${title})`
    }
    data = { detail: friendly }
  }
  if (!res.ok) {
    if (res.status === 401 && !path.includes('/login') && !path.includes('/register')) {
      localStorage.removeItem('saas_token')
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('saas:unauthorized'))
      }
    }
    let detailMsg = ''
    if (Array.isArray(data?.detail)) {
      detailMsg = data.detail
        .map((item) => {
          if (typeof item === 'string') return item
          const loc = Array.isArray(item?.loc) ? item.loc.slice(1).join('.') : ''
          return loc ? `${loc}: ${item?.msg || '参数无效'}` : item?.msg || JSON.stringify(item)
        })
        .join('；')
    } else if (typeof data?.detail === 'string') {
      detailMsg = data.detail
    } else if (data?.detail && typeof data.detail === 'object') {
      detailMsg = data.detail.message || JSON.stringify(data.detail)
    }
    throw new Error(detailMsg || data?.message || `请求失败 (HTTP ${res.status})`)
  }
  return data
}

export function fmtBytes(bytes) {
  const n = Number(bytes || 0)
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function fmtDuration(sec) {
  const s = Number(sec || 0)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
