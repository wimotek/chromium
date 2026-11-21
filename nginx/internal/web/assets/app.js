/**
 * Wimotek Nginx 控制台核心前端驱动
 * 支持 HTTP/DNS-01 验证、凭证本地持久化、Tab缩进、Ctrl+S保存
 */
(function () {
    const STATE = {
        token: localStorage.getItem('nano_token') || '',
        currentDomain: ''
    };

    // DNS 厂商输入表单定义
    const DNS_PROVIDER_CONFIG = {
        dns_cf: [
            { key: 'CF_Token', label: 'Cloudflare API Token', placeholder: '具备 Zone.DNS 编辑权限的 Token' }
        ],
        dns_ali: [
            { key: 'Ali_Key', label: 'AccessKey ID', placeholder: 'LTAI5t...' },
            { key: 'Ali_Secret', label: 'AccessKey Secret', placeholder: '你的 AccessKey Secret' }
        ],
        dns_dp: [
            { key: 'DP_Id', label: 'DNSPod ID', placeholder: '如: 123456' },
            { key: 'DP_Key', label: 'DNSPod Token', placeholder: '如: a1b2c3d4...' }
        ]
    };

    const PRESETS = {
        php83: `# [PHP 8.3 FPM 生产模板]
server {
    listen 80;
    server_name {{DOMAIN}};
    root /var/www/html/{{DOMAIN}};
    index index.php index.html;

    access_log /var/log/nginx/{{DOMAIN}}.access.log;
    error_log  /var/log/nginx/{{DOMAIN}}.error.log;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
    }

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        fastcgi_pass   php83:9000;
        fastcgi_index  index.php;
        fastcgi_param  SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include        fastcgi_params;
    }
}`,
        proxy: `# [现代反向代理模板]
server {
    listen 80;
    server_name {{DOMAIN}};

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
    }

    location / {
        proxy_pass http://host.docker.internal:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}`,
        static: `# [极速静态 SPA 模板]
server {
    listen 80;
    server_name {{DOMAIN}};
    root /var/www/html/{{DOMAIN}};
    index index.html;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \\.(css|js|png|jpg|jpeg|gif|ico|svg|woff2)$ {
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }
}`
    };

    async function apiRequest(endpoint, method = 'GET', body = null) {
        if (!STATE.token) {
            promptAuth();
            return null;
        }
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Token': STATE.token
            }
        };
        if (body) options.body = JSON.stringify(body);
        try {
            const res = await fetch(endpoint, options);
            if (res.status === 401) {
                log('认证已过期，请重新输入 Token', 'danger');
                localStorage.removeItem('nano_token');
                STATE.token = '';
                promptAuth();
                return null;
            }
            return await res.json();
        } catch (err) {
            log(`底层通信失败: ${err.message}`, 'danger');
            return null;
        }
    }

    function promptAuth() {
        const input = prompt("请输入系统授权 Token:");
        if (input && input.trim()) {
            STATE.token = input.trim();
            localStorage.setItem('nano_token', STATE.token);
            fetchSiteList();
        }
    }

    async function fetchSiteList() {
        const res = await apiRequest('/api/sites');
        if (!res || !res.data) return;
        const list = document.getElementById('siteList');
        if (!list) return;
        list.innerHTML = '';
        if (res.data.length === 0) {
            list.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:8px;">暂无托管站点</div>';
            return;
        }
        res.data.forEach(domain => {
            const item = document.createElement('div');
            item.className = `site-item ${domain === STATE.currentDomain ? 'active' : ''}`;
            item.innerHTML = `<span>${domain}</span><span style="color:var(--text-muted);font-size:0.75rem;">.conf</span>`;
            item.onclick = () => loadSite(domain);
            list.appendChild(item);
        });
    }

    async function loadSite(domain) {
        STATE.currentDomain = domain;
        document.getElementById('domainInput').value = domain;
        const res = await apiRequest(`/api/site?domain=${encodeURIComponent(domain)}`);
        if (res && res.content) {
            document.getElementById('editor').value = res.content;
            log(`成功载入站点: ${domain}.conf`);
        }
        fetchSiteList();
    }

    window.applyTemplate = function (type) {
        const domain = (document.getElementById('domainInput').value || '').trim() || 'example.com';
        const tpl = PRESETS[type] || PRESETS.php83;
        document.getElementById('editor').value = tpl.replace(/{{DOMAIN}}/g, domain);
        log(`已应用 [${type}] 模板`);
    };

    window.createNewSite = function () {
        STATE.currentDomain = '';
        document.getElementById('domainInput').value = '';
        document.getElementById('domainInput').focus();
        window.applyTemplate('php83');
        log('准备创建新站点，请输入域名');
    };

    window.saveCurrentSite = async function () {
        const domain = document.getElementById('domainInput').value.trim();
        const content = document.getElementById('editor').value;
        if (!domain) { log('错误：域名不能为空！', 'danger'); return; }

        log('正在由 Nginx 核心执行原子语法校验 (nginx -t)...');
        const res = await apiRequest('/api/site', 'POST', { domain, content });
        if (res && res.code === 200) {
            log(`✔ [语法通过] 站点 ${domain}.conf 保存成功！`);
            STATE.currentDomain = domain;
            fetchSiteList();
        } else {
            log(`✖ [校验失败] 保存被拒绝: ${res ? res.error : '未知错误'}`, 'danger');
        }
    };

    window.reloadNginx = async function () {
        log('正在向 Master 发送 SIGHUP 信号...');
        const res = await apiRequest('/api/reload', 'POST');
        if (res && res.code === 200) log('✔ ' + res.msg);
        else log('✖ 重载失败: ' + (res ? res.error : '未知错误'), 'danger');
    };

    window.deleteCurrentSite = async function () {
        const domain = document.getElementById('domainInput').value.trim();
        if (!domain) return;
        if (!confirm(`确认永久删除 ${domain}.conf 吗？`)) return;
        const res = await apiRequest(`/api/site?domain=${encodeURIComponent(domain)}`, 'DELETE');
        if (res && res.code === 200) {
            log(`✔ 站点 ${domain} 配置已从系统彻底清除`);
            window.createNewSite();
            fetchSiteList();
        }
    };

    // ================== ACME SSL 设置弹窗逻辑 ==================

    window.openSSLModal = function () {
        const domain = document.getElementById('domainInput').value.trim();
        if (!domain) {
            log('请先在上方输入需要配置 SSL 的域名！', 'danger');
            document.getElementById('domainInput').focus();
            return;
        }
        document.getElementById('sslTargetDomain').value = domain;
        document.getElementById('sslModal').style.display = 'flex';
        window.onSSLTypeChange();
    };

    window.closeSSLModal = function () {
        document.getElementById('sslModal').style.display = 'none';
    };

    window.onSSLTypeChange = function () {
        const type = document.getElementById('sslTypeSelect').value;
        const dnsArea = document.getElementById('dnsConfigArea');
        if (type === 'dns') {
            dnsArea.style.display = 'block';
            window.onDNSProviderChange();
        } else {
            dnsArea.style.display = 'none';
        }
    };

    window.onDNSProviderChange = function () {
        const provider = document.getElementById('dnsProviderSelect').value;
        const fields = DNS_PROVIDER_CONFIG[provider] || [];
        const container = document.getElementById('dynamicApiFields');
        container.innerHTML = '';

        fields.forEach(f => {
            const savedVal = localStorage.getItem(`cred_${f.key}`) || '';
            const div = document.createElement('div');
            div.innerHTML = `
                <label class="form-label">${f.label}</label>
                <input type="password" id="field_${f.key}" value="${savedVal}" placeholder="${f.placeholder}" />
            `;
            container.appendChild(div);
        });
    };

    window.submitSSLIssue = async function () {
        const domain = document.getElementById('sslTargetDomain').value.trim();
        const type = document.getElementById('sslTypeSelect').value;
        const btn = document.getElementById('btnSubmitSSL');

        const payload = { domain, type };

        if (type === 'dns') {
            const provider = document.getElementById('dnsProviderSelect').value;
            const isWildcard = document.getElementById('sslWildcardCheck').checked;
            const envParams = {};

            (DNS_PROVIDER_CONFIG[provider] || []).forEach(f => {
                const el = document.getElementById(`field_${f.key}`);
                const val = el ? el.value.trim() : '';
                envParams[f.key] = val;
                if (val) localStorage.setItem(`cred_${f.key}`, val); // 浏览器本地安全记忆
            });

            payload.provider = provider;
            payload.is_wildcard = isWildcard;
            payload.env_params = envParams;
        }

        btn.innerText = '正在校验签发中...';
        btn.disabled = true;
        log(`正在调用 ACME 引擎为 ${domain} 签发证书（耗时约 20~60 秒，请稍候）...`, 'warn');

        const res = await apiRequest('/api/ssl/issue', 'POST', payload);
        btn.innerText = '立即签发部署';
        btn.disabled = false;

        if (res && res.code === 200) {
            log(`✔ [签发成功] 证书已存入 /etc/nginx/ssl/${domain}.crt`);
            window.closeSSLModal();

            // 自动在 Nginx 配置中补充标准 HTTPS 443 监听块
            const editor = document.getElementById('editor');
            if (editor && !editor.value.includes('listen 443')) {
                const sslBlock = `\n    # ---- HTTPS 自动生成配置 (Let's Encrypt) ----\n    listen 443 ssl http2;\n    ssl_certificate /etc/nginx/ssl/${domain}.crt;\n    ssl_certificate_key /etc/nginx/ssl/${domain}.key;\n    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_ciphers HIGH:!aNULL:!MD5;\n`;
                editor.value += sslBlock;
                log('已自动将 SSL 监听指令追加至配置下方，请点击【保存并校验配置】即可正式生效！');
            }
        } else {
            log(`✖ [签发失败] ${res ? res.error : '未知错误'}`, 'danger');
        }
    };

    function setupEditorShortcuts() {
        const editor = document.getElementById('editor');
        if (!editor) return;

        editor.addEventListener('keydown', function (e) {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = this.selectionStart;
                const end = this.selectionEnd;
                this.value = this.value.substring(0, start) + "    " + this.value.substring(end);
                this.selectionStart = this.selectionEnd = start + 4;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                window.saveCurrentSite();
            }
        });
    }

    function log(msg, type = 'info') {
        const box = document.getElementById('terminalLog');
        if (!box) return;
        const colors = { info: '#4ade80', warn: '#facc15', danger: '#f87171' };
        const time = new Date().toLocaleTimeString();
        box.innerHTML = `<span style="color:#64748b;">[${time}]</span> <span style="color:${colors[type] || colors.info};">${msg}</span>`;
        box.scrollTop = box.scrollHeight;
    }

    document.addEventListener('DOMContentLoaded', () => {
        setupEditorShortcuts();
        if (STATE.token) fetchSiteList(); else promptAuth();
    });
})();