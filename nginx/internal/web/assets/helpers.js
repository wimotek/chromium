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
