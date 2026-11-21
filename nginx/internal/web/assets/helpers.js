/**
 * Pure domain, Nginx config, SSL injection, and Docker build helpers.
 * Shared by the Web Console (browser ESM) and Node.js unit tests (node:test).
 */

const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const FQDN_REGEX = new RegExp(`^${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+$`);
const WILDCARD_FQDN_REGEX = new RegExp(`^\\*\\.${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+$`);

/**
 * Validates a domain name (or optional wildcard domain) for safe Nginx filenames & ACME calls.
 * @param {string} raw
 * @param {{ allowWildcard?: boolean }} [opts]
 * @returns {{ valid: boolean, normalized: string, error?: string }}
 */
export function validateDomain(raw, opts = {}) {
  const normalized = String(raw ?? '').trim().toLowerCase();
  if (!normalized) {
    return { valid: false, normalized: '', error: '请输入域名' };
  }
  if (normalized.length > 253) {
    return { valid: false, normalized, error: '域名长度不能超过 253 个字符' };
  }
  if (normalized.includes('..') || normalized.includes('/') || normalized.includes('\\') || /\s/.test(normalized)) {
    return { valid: false, normalized, error: '域名包含非法路径或空白字符' };
  }
  if (opts.allowWildcard && WILDCARD_FQDN_REGEX.test(normalized)) {
    return { valid: true, normalized };
  }
  if (FQDN_REGEX.test(normalized)) {
    return { valid: true, normalized };
  }
  return {
    valid: false,
    normalized,
    error: opts.allowWildcard
      ? '域名格式无效（示例：example.com 或 *.example.com）'
      : '域名格式无效（示例：app.example.com）',
  };
}

export const SITE_TEMPLATES = [
  {
    id: 'wordpress',
    name: 'WordPress 站点 (PHP-FPM + 安全加固)',
    shortName: 'WordPress',
    description: '伪静态路由、禁止 uploads 执行 PHP、屏蔽 xmlrpc 与静态长缓存',
    render: (domain) => `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    root /data/www/${domain};
    index index.php index.html;

    client_max_body_size 64m;

    # ACME HTTP-01 验证通道
    location ^~ /.well-known/acme-challenge/ {
        root /data/www/acme;
        default_type "text/plain";
        try_files $uri =404;
    }

    # WordPress 安全加固：屏蔽敏感文件与 xmlrpc 暴力攻击
    location = /xmlrpc.php {
        deny all;
        access_log off;
        log_not_found off;
    }

    location ~* /(?:wp-config\\.php|readme\\.html|license\\.txt)$ {
        deny all;
    }

    # 禁止媒体上传目录执行任意 PHP 脚本
    location ~* /(?:uploads|files)/.*\\.php$ {
        deny all;
    }

    # 静态资源长缓存（若自定义开启 ENABLE_GZIP_STATIC=true，可取消 gzip_static 注释）
    location ~* \\.(?:js|css|svg|woff2?|png|jpg|jpeg|gif|webp|avif|ico)$ {
        # gzip_static on;
        expires 30d;
        add_header Cache-Control "public, immutable";
        log_not_found off;
        access_log off;
        try_files $uri =404;
    }

    # WordPress 固定链接伪静态
    location / {
        try_files $uri $uri/ /index.php?$args;
    }

    location ~ \\.php$ {
        try_files $uri =404;
        include fastcgi.conf;
        fastcgi_pass php83:9000;
        fastcgi_index index.php;
        fastcgi_intercept_errors on;
    }

    location ~ /\\.(?!well-known).* {
        deny all;
    }
}
`,
  },
  {
    id: 'proxy',
    name: '反向代理 (WebSocket + Real-IP)',
    shortName: '反向代理',
    description: '适用于 Node.js / Go / Python / Docker 后端服务与长连接代理',
    render: (domain, opts = {}) => {
      const upstream = opts.upstream || 'http://127.0.0.1:8080';
      return `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    client_max_body_size 64m;

    # ACME HTTP-01 验证通道
    location ^~ /.well-known/acme-challenge/ {
        root /data/www/acme;
        default_type "text/plain";
        try_files $uri =404;
    }

    location / {
        proxy_pass ${upstream};
        proxy_http_version 1.1;

        # WebSocket / SSE 支持（依赖 nginx.conf 中 map $http_upgrade $connection_upgrade）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # 真实客户端链路透传
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 15s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
`;
    },
  },
  {
    id: 'static_spa',
    name: '静态站点 / SPA (标准兼容)',
    shortName: '静态 / SPA',
    description: 'React / Vue 前端路由回退与长缓存（兼容默认构建与自定义 gzip_static）',
    render: (domain) => `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    root /data/www/${domain}/dist;
    index index.html;

    # ACME HTTP-01 验证通道
    location ^~ /.well-known/acme-challenge/ {
        root /data/www/acme;
        default_type "text/plain";
        try_files $uri =404;
    }

    # 若构建时通过 --build-arg ENABLE_GZIP_STATIC=true 开启了预压缩模块，可取消注释：
    # gzip_static on;

    # 静态资源长缓存
    location ~* \\.(?:js|css|mjs|svg|woff2?|png|jpg|jpeg|webp|avif|ico)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        access_log off;
        try_files $uri =404;
    }

    # SPA 前端路由回退
    location / {
        try_files $uri $uri/ /index.html;
    }
}
`,
  },
  {
    id: 'php83',
    name: 'PHP-FPM 应用 (Laravel / Typecho)',
    shortName: 'Laravel / PHP',
    description: '现代 PHP 8.3 框架通用安全 FastCGI 配置',
    render: (domain) => `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    root /data/www/${domain}/public;
    index index.php index.html;

    location ^~ /.well-known/acme-challenge/ {
        root /data/www/acme;
        default_type "text/plain";
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        try_files $uri =404;
        include fastcgi.conf;
        fastcgi_pass php83:9000;
        fastcgi_index index.php;
    }

    location ~ /\\.(?!well-known).* {
        deny all;
    }
}
`,
  },
  {
    id: 'redirect_https',
    name: '全站 HTTPS 强制跳转',
    shortName: 'HTTPS 跳转',
    description: '保留 ACME 验证路径，其余 HTTP 请求 301 重定向至 HTTPS',
    render: (domain) => `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location ^~ /.well-known/acme-challenge/ {
        root /data/www/acme;
        default_type "text/plain";
        try_files $uri =404;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
`,
  },
];

/**
 * Renders a built-in Nginx site template by ID.
 * @param {string} templateId
 * @param {string} domain
 * @param {Record<string, string>} [opts]
 */
export function renderTemplate(templateId, domain, opts = {}) {
  const tpl = SITE_TEMPLATES.find((t) => t.id === templateId) || SITE_TEMPLATES[0];
  return tpl.render(domain || 'example.com', opts);
}

/**
 * Strips Nginx `#` comments from a single line while preserving `#` inside quotes.
 * @param {string} line
 */
function stripLineComment(line) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Finds the start/end character offsets of top-level `server { ... }` blocks in Nginx config text.
 * Correctly skips comments and quoted strings.
 * @param {string} content
 * @returns {Array<{ start: number, openBrace: number, closeBrace: number, body: string }>}
 */
export function findServerBlocks(content) {
  const blocks = [];
  const len = content.length;
  let i = 0;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inComment = false;
  let currentServer = null;

  while (i < len) {
    const ch = content[i];

    if (inComment) {
      if (ch === '\n') inComment = false;
      i++;
      continue;
    }
    if (ch === '\\' && (inSingle || inDouble)) {
      i += 2;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
      continue;
    }
    if (ch === '#' && !inSingle && !inDouble) {
      inComment = true;
      i++;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (depth === 0 && !currentServer) {
        // Check for top-level `server` keyword followed by optional whitespace and `{`
        if (content.startsWith('server', i)) {
          const prev = i > 0 ? content[i - 1] : '\n';
          const after = content[i + 6] || '';
          if (/[\s;}]/.test(prev) && /[\s{]/.test(after)) {
            let j = i + 6;
            while (j < len && /\s/.test(content[j])) j++;
            if (content[j] === '{') {
              currentServer = { start: i, openBrace: j, closeBrace: -1 };
              depth = 1;
              i = j + 1;
              continue;
            }
          }
        }
      }

      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && currentServer) {
          currentServer.closeBrace = i;
          currentServer.body = content.slice(currentServer.openBrace + 1, i);
          blocks.push(currentServer);
          currentServer = null;
        } else if (depth < 0) {
          depth = 0;
        }
      }
    }

    i++;
  }

  return blocks;
}

/**
 * Safely injects modern TLS 1.2/1.3 & HTTP/2 HTTPS directives INSIDE the matching `server { ... }` block.
 * Never appends outside the closing brace and avoids duplicate injection.
 * @param {string} configText
 * @param {string} domain
 * @returns {{ updated: boolean, alreadyConfigured?: boolean, content: string, error?: string }}
 */
export function injectHttpsBlock(configText, domain) {
  const safeDomain = String(domain || '').trim().toLowerCase();
  if (!safeDomain) {
    return { updated: false, content: configText, error: '缺少有效域名' };
  }

  const blocks = findServerBlocks(configText);
  if (blocks.length === 0) {
    return {
      updated: false,
      content: configText,
      error: '当前配置中未找到有效的 server { ... } 配置块',
    };
  }

  // Prefer the server block whose server_name mentions domain; otherwise first server block.
  let target = blocks.find((b) => {
    const clean = b.body
      .split('\n')
      .map(stripLineComment)
      .join('\n');
    return new RegExp(`server_name\\s+[^;]*\\b${safeDomain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(clean);
  });
  if (!target) {
    target = blocks[0];
  }

  const cleanBody = target.body
    .split('\n')
    .map(stripLineComment)
    .join('\n');

  if (/\blisten\s+[^;]*443\b/.test(cleanBody) || /\bssl_certificate\s+/.test(cleanBody)) {
    return { updated: false, alreadyConfigured: true, content: configText };
  }

  const snippet = [
    '',
    '    # HTTPS / TLS 配置 (由 Wimotek Nginx Console 自动注入)',
    '    listen 443 ssl;',
    '    listen [::]:443 ssl;',
    '    http2 on;',
    `    ssl_certificate     /data/ssl/${safeDomain}.crt;`,
    `    ssl_certificate_key /data/ssl/${safeDomain}.key;`,
    '    ssl_protocols TLSv1.2 TLSv1.3;',
    '    ssl_prefer_server_ciphers off;',
    '    ssl_session_timeout 1d;',
    '    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
    '',
  ].join('\n');

  const before = configText.slice(0, target.closeBrace).replace(/[ \t]*$/, '');
  const after = configText.slice(target.closeBrace);
  const needsNewline = before.length > 0 && !before.endsWith('\n');
  const nextContent = `${before}${needsNewline ? '\n' : ''}${snippet}${after}`;

  return { updated: true, alreadyConfigured: false, content: nextContent };
}

/**
 * Extracts site metadata from an Nginx server config (mirrors Go ParseSiteMeta).
 * @param {string} domain
 * @param {boolean} enabled
 * @param {string} content
 */
export function parseSiteMeta(domain, enabled, content) {
  const lines = String(content || '').split('\n');
  let hasSSL = false;
  let hasProxy = false;
  let hasPHP = false;
  let hasRoot = false;
  let gzipStatic = false;
  let brotliStatic = false;
  const ports = new Set();

  for (const rawLine of lines) {
    const clean = stripLineComment(rawLine).trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();

    if (lower.startsWith('listen ')) {
      const m = lower.match(/^listen\s+(?:\[::\]:)?(\d+)/);
      if (m) ports.add(m[1]);
      if (/\bssl\b/.test(lower) || /\b443\b/.test(lower)) {
        hasSSL = true;
      }
    }
    if (lower.startsWith('ssl_certificate ')) hasSSL = true;
    if (lower.startsWith('proxy_pass ')) hasProxy = true;
    if (lower.startsWith('fastcgi_pass ')) hasPHP = true;
    if (lower.startsWith('root ') || lower.startsWith('alias ')) hasRoot = true;
    if (/^gzip_static\s+(on|always)\b/.test(lower)) gzipStatic = true;
    if (/^brotli_static\s+(on|always)\b/.test(lower)) brotliStatic = true;
  }

  let mode = 'custom';
  if (hasPHP) mode = 'php';
  else if (hasProxy) mode = 'proxy';
  else if (hasRoot) mode = 'static';

  return {
    domain,
    enabled: Boolean(enabled),
    has_ssl: hasSSL,
    mode,
    gzip_static: gzipStatic,
    brotli_static: brotliStatic,
    listen_ports: Array.from(ports).sort((a, b) => Number(a) - Number(b)),
  };
}

/**
 * Lightweight static syntax checker for Nginx configs (balanced braces, quotes, basic directive check).
 * Basic structural pre-flight syntax validator for editor feedback before nginx -t.
 * @param {string} content
 * @returns {{ ok: boolean, message: string }}
 */
export function validateNginxSyntaxBasic(content) {
  const text = String(content ?? '');
  if (!text.trim()) {
    return { ok: false, message: 'nginx: [emerg] configuration content is empty' };
  }

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  const lines = text.split('\n');

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const line = lines[idx];
    let escaped = false;
    let codePart = '';

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (escaped) {
        escaped = false;
        codePart += ch;
        continue;
      }
      if (ch === '\\' && (inSingle || inDouble)) {
        escaped = true;
        codePart += ch;
        continue;
      }
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        codePart += ch;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        codePart += ch;
        continue;
      }
      if (ch === '#' && !inSingle && !inDouble) {
        break;
      }
      if (!inSingle && !inDouble) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth < 0) {
            return {
              ok: false,
              message: `nginx: [emerg] unexpected "}" at line ${lineNum}`,
            };
          }
        }
      }
      codePart += ch;
    }

    const trimmed = codePart.trim();
    if (trimmed && !inSingle && !inDouble) {
      // Split by `{` and `}` to inspect inline directives such as `server { listen 80 }`
      const segments = trimmed.split(/[{}]/);
      const simpleDirectives = new Set([
        'listen',
        'server_name',
        'root',
        'index',
        'gzip',
        'gzip_static',
        'brotli',
        'brotli_static',
        'proxy_pass',
        'fastcgi_pass',
        'ssl_certificate',
        'ssl_certificate_key',
        'return',
        'try_files',
        'client_max_body_size',
        'include',
        'http2',
        'worker_processes',
      ]);
      for (const rawSeg of segments) {
        const seg = rawSeg.trim();
        if (!seg || seg.endsWith(';') || seg.endsWith('\\')) continue;
        const firstWord = seg.split(/\s+/)[0];
        if (simpleDirectives.has(firstWord)) {
          return {
            ok: false,
            message: `nginx: [emerg] directive "${firstWord}" is not terminated by ";" at line ${lineNum}`,
          };
        }
      }
    }
  }

  if (inSingle || inDouble) {
    return { ok: false, message: 'nginx: [emerg] unterminated quoted string in configuration' };
  }
  if (depth !== 0) {
    return { ok: false, message: 'nginx: [emerg] unexpected end of file, expecting "}"' };
  }

  return {
    ok: true,
    message: 'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful',
  };
}

/**
 * Generates a reproducible multi-stage `docker build` command for custom Nginx compilation.
 * Supports `latest`, `stable`, or pinned semver; defaults align with official nginx:alpine,
 * while `gzip_static`, `brotli`, `headers-more`, `zstd`, and extra args are opt-in build args.
 * @param {{
 *   nginxVersion?: string,
 *   enableGzipStatic?: boolean,
 *   enableBrotli?: boolean,
 *   enableHeadersMore?: boolean,
 *   enableZstd?: boolean,
 *   extraConfigureArgs?: string | string[],
 *   extraCflags?: string,
 *   imageTag?: string,
 * }} opts
 */
export function buildDockerCommand(opts = {}) {
  const rawVer = String(opts.nginxVersion || 'latest').trim().toLowerCase();
  const version =
    rawVer === 'latest' || rawVer === 'stable'
      ? rawVer
      : rawVer.replace(/[^0-9.]/g, '') || 'latest';

  const tag = String(opts.imageTag || 'wimotek/nginx:custom').replace(/[^a-zA-Z0-9._:/-]/g, '') || 'wimotek/nginx:custom';
  const enableGzipStatic = Boolean(opts.enableGzipStatic);
  const enableBrotli = Boolean(opts.enableBrotli);
  const enableHeadersMore = Boolean(opts.enableHeadersMore);
  const enableZstd = Boolean(opts.enableZstd);

  const rawExtra = Array.isArray(opts.extraConfigureArgs)
    ? opts.extraConfigureArgs.join(' ')
    : String(opts.extraConfigureArgs || '');

  // Keep only safe Nginx configure tokens (--with-..., --without-..., --add-module=...)
  const cleanExtraTokens = rawExtra
    .trim()
    .split(/\s+/)
    .filter((token) => /^--[a-zA-Z0-9_./=-]+$/.test(token));

  const cleanCflags = String(opts.extraCflags || '-O2 -pipe')
    .replace(/[^a-zA-Z0-9_=.\-\s]/g, '')
    .trim();

  const lines = [
    `docker build -t ${tag} \\`,
    `  --build-arg NGINX_VERSION=${version} \\`,
  ];

  if (enableGzipStatic) lines.push('  --build-arg ENABLE_GZIP_STATIC=true \\');
  if (enableBrotli) lines.push('  --build-arg ENABLE_BROTLI=true \\');
  if (enableHeadersMore) lines.push('  --build-arg ENABLE_HEADERS_MORE=true \\');
  if (enableZstd) lines.push('  --build-arg ENABLE_ZSTD=true \\');

  if (cleanExtraTokens.length > 0) {
    lines.push(`  --build-arg NGINX_EXTRA_CONFIGURE_ARGS="${cleanExtraTokens.join(' ')}" \\`);
  }
  if (cleanCflags && cleanCflags !== '-O2 -pipe') {
    lines.push(`  --build-arg NGINX_EXTRA_CFLAGS="${cleanCflags}" \\`);
  }
  lines.push('  ./nginx');

  return lines.join('\n');
}

/**
 * Formats byte size concisely.
 * @param {number} bytes
 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Formats days remaining until TLS certificate expiry.
 * @param {number} days
 */
export function formatCertCountdown(days) {
  const d = Number(days);
  if (!Number.isFinite(d)) return '未知';
  if (d < 0) return `已过期 ${Math.abs(d)} 天`;
  if (d === 0) return '今日到期';
  return `剩余 ${d} 天`;
}

// ==================== AUTH SECURITY HELPERS (SHA-256 PoW + CREDENTIAL VALIDATION) ====================
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Pure-JS FIPS 180-4 SHA-256 returning a 32-byte Uint8Array.
 * Works on both HTTPS and plain LAN HTTP (where WebCrypto crypto.subtle is unavailable).
 * @param {string} message
 * @returns {Uint8Array}
 */
export function sha256Bytes(message) {
  const bytes = new TextEncoder().encode(String(message));
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

/**
 * Checks whether a digest has at least `bits` leading zero bits.
 * @param {Uint8Array} digest
 * @param {number} bits
 */
export function hasLeadingZeroBits(digest, bits) {
  const fullBytes = Math.floor(bits / 8);
  const remBits = bits % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (digest[i] !== 0) return false;
  }
  if (remBits > 0) {
    const mask = (0xff << (8 - remBits)) & 0xff;
    if ((digest[fullBytes] & mask) !== 0) return false;
  }
  return true;
}

/**
 * Solves a server-issued SHA-256 Proof-of-Work challenge asynchronously without blocking UI rendering.
 * @param {string} challengeId
 * @param {string} salt
 * @param {number} difficulty
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ nonce: string, iterations: number, elapsedMs: number }>}
 */
export async function solvePowChallenge(challengeId, salt, difficulty, signal) {
  const prefix = `${challengeId}:${salt}:`;
  const start = Date.now();
  const batchSize = 2048;

  for (let nonce = 0; nonce < 50_000_000; nonce++) {
    if (nonce > 0 && nonce % batchSize === 0) {
      if (signal && signal.aborted) {
        throw new Error('PoW aborted');
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const digest = sha256Bytes(prefix + String(nonce));
    if (hasLeadingZeroBits(digest, difficulty)) {
      return {
        nonce: String(nonce),
        iterations: nonce + 1,
        elapsedMs: Date.now() - start,
      };
    }
  }
  throw new Error('PoW challenge search exhausted');
}

const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/;

/**
 * Validates admin username format (3-32 chars, starts with alphanumeric).
 * @param {string} username
 * @returns {{ valid: boolean, normalized: string, error?: string }}
 */
export function validateUsername(username) {
  const normalized = String(username || '').trim();
  if (!USERNAME_PATTERN.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: '用户名需为 3~32 位，仅支持字母、数字、点(.)、下划线(_)和连字符(-)，且需以字母或数字开头',
    };
  }
  return { valid: true, normalized };
}

/**
 * Evaluates password strength against the backend strong password policy.
 * @param {string} password
 * @returns {{ valid: boolean, score: number, label: string, checks: { length: boolean, upper: boolean, lower: boolean, digit: boolean, symbol: boolean }, error?: string }}
 */
export function evaluatePasswordStrength(password) {
  const p = String(password || '');
  const checks = {
    length: p.length >= 8 && p.length <= 128,
    upper: /[A-Z]/.test(p),
    lower: /[a-z]/.test(p),
    digit: /[0-9]/.test(p),
    symbol: /[^A-Za-z0-9]/.test(p),
  };
  const hasControl = /[\x00-\x1f\x7f]/.test(p);
  const classes = [checks.upper, checks.lower, checks.digit, checks.symbol].filter(Boolean).length;

  let score = 0;
  if (p.length >= 8) score++;
  if (p.length >= 12) score++;
  if (classes >= 3) score++;
  if (classes >= 4 || p.length >= 16) score++;

  let valid = checks.length && !hasControl && classes >= 2;
  let error = '';
  if (!checks.length) {
    valid = false;
    error = '新密码长度需为 8~128 位';
  } else if (hasControl) {
    valid = false;
    error = '密码不能包含控制字符';
  } else if (p.length < 12 && !(checks.upper && checks.lower && checks.digit)) {
    valid = false;
    error = '12 位以下需同时包含大写字母、小写字母和数字';
  } else if (classes < 2) {
    valid = false;
    error = '请至少混合两类字符（字母/数字/符号）';
  }

  const label = !p ? '未填写' : !valid ? '弱' : score >= 4 ? '极强' : score >= 3 ? '强' : '中';
  return { valid, score: valid ? Math.max(2, score) : Math.min(1, score), label, checks, error };
}

