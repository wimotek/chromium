/**
 * Wimotek Nginx 控制台核心前端驱动
 * 采用原生 ES6+ 编写，无第三方打包依赖，零运行时网络请求
 */
(function () {
    // 1. 全局状态
    const STATE = {
        token: localStorage.getItem('nano_token') || '',
        currentDomain: '',
        isMobileDrawerOpen: false
    };

    // 2. 常用 Nginx 生产级模板预设
    const PRESETS = {
        php83: `# [PHP 8.3 FPM 模板]
server {
    listen 80;
    server_name {{DOMAIN}};
    root /var/www/html/{{DOMAIN}};
    index index.php index.html;

    access_log /var/log/nginx/{{DOMAIN}}.access.log;
    error_log  /var/log/nginx/{{DOMAIN}}.error.log;

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
        proxy: `# [现代反向代理模板]
server {
    listen 80;
    server_name {{DOMAIN}};

    location / {
        proxy_pass http://host.docker.internal:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # 支持 WebSocket
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}`,
        static: `# [极速静态单页应用模板]
server {
    listen 80;
    server_name {{DOMAIN}};
    root /var/www/html/{{DOMAIN}};
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \\.(css|js|png|jpg|jpeg|gif|ico|svg|woff2)$ {
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }
}`
    };

    // 3. 通用 API 请求封装
    async function apiRequest(endpoint, method = 'GET', body = null) {
        if (!STATE.token) {
            promptAuth();
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
                log('认证失败或 Token 已过期，请重新登录', 'danger');
                localStorage.removeItem('nano_token');
                STATE.token = '';
                promptAuth();
                return null;
            }
            return await res.json();
        } catch (err) {
            log(`网络通信异常: ${err.message}`, 'danger');
            return null;
        }
    }

    // 4. Token 登录提示弹窗
    function promptAuth() {
        const input = prompt("请输入系统授权 Token (可通过 Docker 环境变量 AUTH_TOKEN 配置):");
        if (input && input.trim()) {
            STATE.token = input.trim();
            localStorage.setItem('nano_token', STATE.token);
            fetchSiteList();
        }
    }

    // 5. 站点列表获取与渲染
    async function fetchSiteList() {
        const res = await apiRequest('/api/sites');
        if (!res || !res.data) return;

        const listContainer = document.getElementById('siteList');
        listContainer.innerHTML = '';

        if (res.data.length === 0) {
            listContainer.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:8px;">暂无任何托管站点</div>';
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

    // 6. 读取单个站点配置
    async function loadSite(domain) {
        STATE.currentDomain = domain;
        document.getElementById('domainInput').value = domain;
        
        const res = await apiRequest(`/api/site?domain=${encodeURIComponent(domain)}`);
        if (res && res.content) {
            document.getElementById('editor').value = res.content;
            log(`成功加载站点配置: ${domain}.conf`);
        }
        fetchSiteList(); // 刷新选中态高亮
    }

    // 7. 新增站点并填入模板
    window.applyTemplate = function (type) {
        const domain = document.getElementById('domainInput').value.trim() || 'example.com';
        const tpl = PRESETS[type] || PRESETS.php83;
        document.getElementById('editor').value = tpl.replace(/{{DOMAIN}}/g, domain);
        log(`已应用 [${type}] 配置预设，请保存以校验生效`);
    };

    window.createNewSite = function () {
        STATE.currentDomain = '';
        document.getElementById('domainInput').value = '';
        window.applyTemplate('php83');
        document.getElementById('domainInput').focus();
    };

    // 8. 保存与先验检测
    window.saveCurrentSite = async function () {
        const domain = document.getElementById('domainInput').value.trim();
        const content = document.getElementById('editor').value;

        if (!domain) {
            log('域名不能为空！', 'danger');
            return;
        }

        log('正在由 Nginx 核心执行原子语法检查 (nginx -t)...');
        const res = await apiRequest('/api/site', 'POST', { domain, content });
        if (res && res.code === 200) {
            log(`✔ [语法通过] 站点 ${domain}.conf 已安全持久化！`);
            STATE.currentDomain = domain;
            fetchSiteList();
        } else {
            log(`✖ [语法拦截] 保存失败: ${res ? res.error : '未知错误'}`, 'danger');
        }
    };

    // 9. 热重载 Nginx
    window.reloadNginx = async function () {
        log('正在向 Master 进程发送 SIGHUP 信号...');
        const res = await apiRequest('/api/reload', 'POST');
        if (res && res.code === 200) {
            log('✔ ' + res.msg);
        } else {
            log('✖ 重载失败: ' + (res ? res.error : '未知错误'), 'danger');
        }
    };

    // 10. 删除站点
    window.deleteCurrentSite = async function () {
        const domain = document.getElementById('domainInput').value.trim();
        if (!domain) return;

        if (!confirm(`警告：该操作将永久删除 ${domain}.conf，是否继续？`)) return;

        const res = await apiRequest(`/api/site?domain=${encodeURIComponent(domain)}`, 'DELETE');
        if (res && res.code === 200) {
            log(`✔ 站点 ${domain} 已彻底清理`);
            window.createNewSite();
            fetchSiteList();
        }
    };

    // 11. 代码编辑器 Tab 缩进支持 (提升手感)
    function setupEditor() {
        const editor = document.getElementById('editor');
        editor.addEventListener('keydown', function (e) {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = this.selectionStart;
                const end = this.selectionEnd;
                this.value = this.value.substring(0, start) + "    " + this.value.substring(end);
                this.selectionStart = this.selectionEnd = start + 4;
            }
        });
    }

    // 12. 统一日志控制台输出
    function log(msg, type = 'info') {
        const box = document.getElementById('terminalLog');
        if (!box) return;
        const color = type === 'danger' ? '#f87171' : (type === 'warn' ? '#facc15' : '#4ade80');
        const time = new Date().toLocaleTimeString();
        box.innerHTML = `<span style="color:#64748b;">[${time}]</span> <span style="color:${color};">${msg}</span>`;
    }

    // 初始化运行
    document.addEventListener('DOMContentLoaded', () => {
        setupEditor();
        if (STATE.token) {
            fetchSiteList();
        } else {
            promptAuth();
        }
    });
})();