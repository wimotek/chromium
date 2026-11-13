/**
 * Wimotek Nginx 控制台核心前端驱动
 * 完整特性：Zero-DB API 驱动、Tab缩进拦截、Ctrl+S快捷保存、多预设模板、ACME 证书流式联动
 */
(function () {
    // 1. 全局状态存储
    const STATE = {
        token: localStorage.getItem('nano_token') || '',
        currentDomain: '',
        isLoading: false
    };

    // 2. 预设 Nginx 生产级配置模板（包含 ACME 验证路径）
    const PRESETS = {
        php83: `# [PHP 8.3 FPM 生产模板]
server {
    listen 80;
    server_name {{DOMAIN}};
    root /var/www/html/{{DOMAIN}};
    index index.php index.html;

    access_log /var/log/nginx/{{DOMAIN}}.access.log;
    error_log  /var/log/nginx/{{DOMAIN}}.error.log;

    # ACME 证书 HTTP-01 验证路由 (由系统自动管理，请勿删除)
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
    }

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    # 毫秒级对齐容器化 PHP-FPM
    location ~ \\.php$ {
        fastcgi_pass   php83:9000;
        fastcgi_index  index.php;
        fastcgi_param  SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include        fastcgi_params;
    }

    location ~ /\\.(?!well-known).* {
        deny all;
    }
}`,

        proxy: `# [现代反向代理模板 (含 WebSocket 支持)]
server {
    listen 80;
    server_name {{DOMAIN}};

    access_log /var/log/nginx/{{DOMAIN}}.access.log;
    error_log  /var/log/nginx/{{DOMAIN}}.error.log;

    # ACME 验证专属路径
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
    }

    location / {
        proxy_pass http://host.docker.internal:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # 针对 WebSocket 长链接支持
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}`,

        static: `# [极速前端单页应用 SPA 模板]
server {
    listen 80;
    server_name {{DOMAIN}};
    root /var/www/html/{{DOMAIN}};
    index index.html;

    # ACME 验证专属路径
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    # 静态静态资源长缓存
    location ~* \\.(css|js|png|jpg|jpeg|gif|ico|svg|woff2)$ {
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }
}`
    };

    // 3. 通用 API 请求处理
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
        if (body) {
            options.body = JSON.stringify(body);
        }

        try {
            const res = await fetch(endpoint, options);
            if (res.status === 401) {
                log('认证凭证已过期或错误，请重新输入 Token', 'danger');
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

    // 4. Token 授权校验弹窗
    function promptAuth() {
        const input = prompt("请输入系统授权 Token (可通过 Docker 环境变量 AUTH_TOKEN 定义):");
        if (input && input.trim()) {
            STATE.token = input.trim();
            localStorage.setItem('nano_token', STATE.token);
            fetchSiteList();
        }
    }

    // 5. 获取托管站点列表
    async function fetchSiteList() {
        const res = await apiRequest('/api/sites');
        if (!res || !res.data) return;

        const listContainer = document.getElementById('siteList');
        if (!listContainer) return;
        listContainer.innerHTML = '';

        if (res.data.length === 0) {
            listContainer.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:8px;">暂无托管站点</div>';
            return;
        }

        res.data.forEach(domain => {
            const item = document.createElement('div');
            item.className = `site-item ${domain === STATE.currentDomain ? 'active' : ''}`;
            item.innerHTML = `
                <span style="font-weight:500;">${domain}</span>
                <span style="color:var(--text-muted);font-size:0.75rem;">.conf</span>
            `;
            item.onclick = () => loadSite(domain);
            listContainer.appendChild(item);
        });
    }

    // 6. 读取特定站点内容
    async function loadSite(domain) {
        STATE.currentDomain = domain;
        const domainInput = document.getElementById('domainInput');
        const editor = document.getElementById('editor');
        if (domainInput) domainInput.value = domain;
        
        const res = await apiRequest(`/api/site?domain=${encodeURIComponent(domain)}`);
        if (res && res.content) {
            if (editor) editor.value = res.content;
            log(`成功载入站点配置: ${domain}.conf`);
        }
        fetchSiteList(); // 更新高亮激活态
    }

    // 7. 模板应用
    window.applyTemplate = function (type) {
        const domain = (document.getElementById('domainInput').value || '').trim() || 'example.com';
        const tpl = PRESETS[type] || PRESETS.php83;
        const editor = document.getElementById('editor');
        if (editor) {
            editor.value = tpl.replace(/{{DOMAIN}}/g, domain);
            log(`已应用 [${type}] 配置预设，请点击保存校验`);
        }
    };

    // 8. 新建空白站点流程
    window.createNewSite = function () {
        STATE.currentDomain = '';
        const domainInput = document.getElementById('domainInput');
        if (domainInput) {
            domainInput.value = '';
            domainInput.focus();
        }
        window.applyTemplate('php83');
        log('准备创建新站点，请输入域名');
    };

    // 9. 保存站点（先验原子检查）
    window.saveCurrentSite = async function () {
        const domainInput = document.getElementById('domainInput');
        const editor = document.getElementById('editor');
        if (!domainInput || !editor) return;

        const domain = domainInput.value.trim();
        const content = editor.value;

        if (!domain) {
            log('错误：域名不能为空！', 'danger');
            domainInput.focus();
            return;
        }

        log('正在由 Nginx 核心执行原子语法校验 (nginx -t)...');
        const res = await apiRequest('/api/site', 'POST', { domain, content });
        if (res && res.code === 200) {
            log(`✔ [语法通过] 站点 ${domain}.conf 已安全持久化落盘！`);
            STATE.currentDomain = domain;
            fetchSiteList();
        } else {
            log(`✖ [校验失败] 保存被拒绝: ${res ? res.error : '未知错误'}`, 'danger');
        }
    };

    // 10. 平滑热重载 Nginx
    window.reloadNginx = async function () {
        log('正在向 Master 进程发送 SIGHUP 平滑重载信号...');
        const res = await apiRequest('/api/reload', 'POST');
        if (res && res.code === 200) {
            log('✔ ' + res.msg);
        } else {
            log('✖ 重载失败: ' + (res ? res.error : '未知错误'), 'danger');
        }
    };

    // 11. ACME SSL 证书一键申请与自动追加绑定
    window.issueSSL = async function () {
        const domainInput = document.getElementById('domainInput');
        const editor = document.getElementById('editor');
        if (!domainInput || !editor) return;

        const domain = domainInput.value.trim();
        if (!domain) {
            log('请先输入要签发证书的域名！', 'danger');
            domainInput.focus();
            return;
        }

        log(`正在向 Let's Encrypt 申请 ${domain} 证书（通常耗时约 15~30 秒，请稍候）...`, 'warn');
        const res = await apiRequest(`/api/ssl/issue?domain=${encodeURIComponent(domain)}`, 'POST');
        if (res && res.code === 200) {
            log(`✔ 证书签发成功！已存入 /etc/nginx/ssl/${domain}.crt`);
            
            // 自动解析并在末尾优雅注入 SSL 端口配置
            const sslConfigBlock = `\n    # ---- HTTPS 自动生成配置 (Let's Encrypt) ----\n    listen 443 ssl http2;\n    ssl_certificate /etc/nginx/ssl/${domain}.crt;\n    ssl_certificate_key /etc/nginx/ssl/${domain}.key;\n    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_ciphers HIGH:!aNULL:!MD5;\n`;
            
            // 检查如果尚未配置 443，则自动追加
            if (!editor.value.includes('listen 443')) {
                editor.value += sslConfigBlock;
                log('已自动将 SSL 监听指令追加至配置末尾，请点击【保存并校验配置】使其生效！');
            }
        } else {
            log(`✖ 证书签发失败: ${res ? res.error : '请确认 80 端口放行且公网 DNS 已解析到本机'}`, 'danger');
        }
    };

    // 12. 删除站点
    window.deleteCurrentSite = async function () {
        const domainInput = document.getElementById('domainInput');
        if (!domainInput) return;
        const domain = domainInput.value.trim();
        if (!domain) return;

        if (!confirm(`警告：该操作将永久删除 ${domain}.conf 配置文件，线上访问将立即失效，是否确认？`)) {
            return;
        }

        const res = await apiRequest(`/api/site?domain=${encodeURIComponent(domain)}`, 'DELETE');
        if (res && res.code === 200) {
            log(`✔ 站点 ${domain} 配置已从系统彻底清除`);
            window.createNewSite();
            fetchSiteList();
        }
    };

    // 13. 编辑器手感优化：Tab 缩进与快捷键监听
    function setupEditorShortcuts() {
        const editor = document.getElementById('editor');
        if (!editor) return;

        editor.addEventListener('keydown', function (e) {
            // (a) 按 Tab 键插入 4 个空格缩进，而不是失焦
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = this.selectionStart;
                const end = this.selectionEnd;
                this.value = this.value.substring(0, start) + "    " + this.value.substring(end);
                this.selectionStart = this.selectionEnd = start + 4;
            }

            // (b) Ctrl + S / Cmd + S 快捷保存
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                window.saveCurrentSite();
            }
        });
    }

    // 14. 统一日志控制台输出 (含自动滚屏)
    function log(msg, type = 'info') {
        const box = document.getElementById('terminalLog');
        if (!box) return;

        const colors = {
            info: '#4ade80',    // 亮绿
            warn: '#facc15',    // 警示黄
            danger: '#f87171',  // 错误红
            primary: '#38bdf8'  // 青蓝
        };
        const color = colors[type] || colors.info;
        const time = new Date().toLocaleTimeString();

        box.innerHTML = `<span style="color:#64748b;">[${time}]</span> <span style="color:${color};">${msg}</span>`;
        box.scrollTop = box.scrollHeight; // 保证日志始终展示最新一行
    }

    // 页面就绪后启动挂载
    document.addEventListener('DOMContentLoaded', () => {
        setupEditorShortcuts();
        if (STATE.token) {
            fetchSiteList();
        } else {
            promptAuth();
        }
    });
})();