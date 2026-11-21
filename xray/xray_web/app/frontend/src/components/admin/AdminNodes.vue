<template>
  <div class="cyber-card tab-content-card">
    <!-- ========================================================================= -->
    <!-- 1. 顶栏：集群引导令牌与 TOFU 总开关 + 免审核子开关 (严格还原图二层级) -->
    <!-- ========================================================================= -->
    <div class="cluster-security-banner">
      <!-- 左侧：集群引导令牌 (Cluster Token) -->
      <div class="banner-left">
        <div class="token-title-row">
          <span class="shield-icon">🛡️</span>
          <b style="color: #f8fafc; font-size: 13px;">集群引导令牌 (Cluster Token):</b>
          <span class="cluster-token-code">{{ !nodesLoaded && !clusterInfo.cluster_token ? '加载中...' : maskedClusterToken }}</span>
          <button class="btn-banner-action" title="一键复制集群通信令牌" @click="copyText(clusterInfo.cluster_token, '集群通信令牌')">
            📋 复制令牌
          </button>
          <button class="btn-banner-reset" title="轮换重置令牌 (已在线节点不受影响)" @click="handleRegenerateClusterToken">
            🔄 轮换重置
          </button>
        </div>
        <div class="banner-hint">
          新节点首次握手入网凭证。支持 Ed25519 双向公私钥锁定，私钥本地就地生成永不离机。
        </div>
      </div>

      <!-- 右侧：TOFU 首次信任总开关 + 免审核准入子开关 + 部署脚本入口 -->
      <div class="banner-right">
        <div class="tofu-switches-card">
          <!-- 主开关：TOFU 首次信任接入 -->
          <div class="switch-row main-switch-row">
            <div class="switch-info">
              <span class="lightning-icon">⚡</span>
              <span class="switch-label-text">TOFU 首次信任接入:</span>
              <span class="switch-status-pill" :class="clusterInfo.tofu_enabled ? 'pill-active' : 'pill-disabled'">
                {{ clusterInfo.tofu_enabled ? '🟢 总开关已开启' : '🔴 总开关已关闭' }}
              </span>
            </div>
            <label class="switch-btn-wrap">
              <input type="checkbox" v-model="clusterInfo.tofu_enabled" @change="handleToggleTofuEnabled" />
              <span class="switch-btn-text" :class="{ active: clusterInfo.tofu_enabled }">
                <span class="check-icon">{{ clusterInfo.tofu_enabled ? '✓' : '' }}</span>
                {{ clusterInfo.tofu_enabled ? '启用中' : '已停用' }}
              </span>
            </label>
          </div>

          <!-- 子开关：新节点免审核准入 (依赖主开关) -->
          <div class="switch-row sub-switch-row">
            <div class="switch-info">
              <span class="sub-tree-prefix">└─</span>
              <span class="switch-label-text">新节点免审核准入:</span>
              <span v-if="!clusterInfo.tofu_enabled" class="switch-status-pill pill-warning">
                ⚠️ 需先开启 TOFU
              </span>
              <span v-else class="switch-status-pill" :class="clusterInfo.auto_approve ? 'pill-active' : 'pill-amber'">
                {{ clusterInfo.auto_approve ? '🟢 免审核直连' : '🔒 待审隔离' }}
              </span>
            </div>
            <label class="switch-btn-wrap" :class="{ disabled: !clusterInfo.tofu_enabled }">
              <input
                type="checkbox"
                v-model="clusterInfo.auto_approve"
                :disabled="!clusterInfo.tofu_enabled"
                @change="handleToggleAutoApprove"
              />
              <span class="switch-btn-text" :class="{ active: clusterInfo.auto_approve && clusterInfo.tofu_enabled }">
                <span class="check-icon">{{ clusterInfo.auto_approve && clusterInfo.tofu_enabled ? '✓' : '' }}</span>
                {{ clusterInfo.auto_approve && clusterInfo.tofu_enabled ? '免审上线' : '待审隔离' }}
              </span>
            </label>
          </div>
        </div>

        <button class="btn-banner-deploy" @click="currentSubTab = 'deploy'" title="跳转到 Docker 部署脚本与参数">
          💻 Docker 部署脚本与参数 →
        </button>
      </div>
    </div>

    <!-- ========================================================================= -->
    <!-- 2. 二级选项卡导航 (严格还原图二样式与徽章) -->
    <!-- ========================================================================= -->
    <div class="sub-nav-tabs">
      <button
        class="sub-tab-btn"
        :class="{ active: currentSubTab === 'approved' }"
        @click="currentSubTab = 'approved'"
      >
        🌐 已准入节点集群{{ showInitialNodesLoading ? '' : ` (${approvedNodes.length})` }}
      </button>
      <button
        class="sub-tab-btn"
        :class="{ active: currentSubTab === 'pending' }"
        @click="currentSubTab = 'pending'"
      >
        🟡 待审批节点隔离区
        <span v-if="pendingNodes.length > 0" class="sub-count-badge badge-amber">
          {{ pendingNodes.length }}
        </span>
      </button>
      <button
        class="sub-tab-btn"
        :class="{ active: currentSubTab === 'audit' }"
        @click="currentSubTab = 'audit'"
      >
        📜 节点安全审计流水
        <span v-if="auditLogsList.length > 0" class="sub-count-badge badge-slate">
          {{ auditLogsList.length }}
        </span>
      </button>
      <button
        class="sub-tab-btn"
        :class="{ active: currentSubTab === 'deploy' }"
        @click="currentSubTab = 'deploy'"
      >
        💻 Docker 部署脚本与参数
      </button>
    </div>

    <!-- ========================================================================= -->
    <!-- 子卡 1：已准入节点集群列表 -->
    <!-- ========================================================================= -->
    <div v-if="currentSubTab === 'approved'">
      <div class="card-header" style="margin-top: 15px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <h3>🌐 已准入节点集群治理与多端调度</h3>
          <span class="badge badge-ready">
            {{ showInitialNodesLoading ? '⏳ 加载节点中...' : `${approvedNodes.length} 个节点运行中` }}
          </span>
        </div>
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 11px; color: #34d399; font-weight: 600;">🟢 自动轮询中 (每10秒更新)</span>
          <button class="btn-sm btn-action" :disabled="pingingAll" @click="handlePingAllNodes">
            {{ pingingAll ? '⏳ 正在测活...' : '⚡ 立即检测全部节点心跳' }}
          </button>
        </div>
      </div>

      <div class="table-container">
        <table class="cyber-table">
          <thead>
            <tr>
              <th>节点名称 / 连接地址</th>
              <th>准入状态</th>
              <th>SNI 伪装域名</th>
              <th>开放授权策略</th>
              <th>公钥 (PublicKey)</th>
              <th>健康与心跳 (点击测活)</th>
              <th style="width: 250px; text-align: right;">治理操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="node in approvedNodes" :key="node.id" :class="{ 'node-disabled-row': node.status === 0 }">
              <td>
                <div style="font-weight: 700; color: #f8fafc; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                  <span>{{ node.name }}</span>
                  <span v-if="node.core_type === 'singbox'" class="net-mode-pill pill-singbox" title="Sing-box 双协议内核 (VLESS-REALITY + Hysteria2)">
                    ⚡ Sing-box
                  </span>
                  <span v-if="node.net_mode === 'reverse_wss'" class="net-mode-pill pill-wss">
                    🔀 WSS反穿
                  </span>
                  <span v-else class="net-mode-pill pill-direct">
                    🌐 公网直连
                  </span>
                  <span
                    v-if="node.core_type === 'singbox' && node.hy2_enabled === 1 && node.hy2_port > 0 && node.net_mode !== 'reverse_wss'"
                    class="net-mode-pill pill-hy2"
                    :title="`Hysteria2 UDP 已启用 (端口: ${node.hy2_port}${node.hy2_mport ? `, 跳跃: ${node.hy2_mport}` : ''}, SNI: ${node.hy2_sni || node.sni})`"
                  >
                    🌀 Hy2:{{ node.hy2_port }}{{ node.hy2_mport ? ` · 跳:${node.hy2_mport}` : '' }}
                  </span>
                  <span
                    v-if="node.block_cn === undefined || Number(node.block_cn) !== 0"
                    class="net-mode-pill pill-block-cn"
                    title="已拦截回国流量 (geosite:cn / geoip:cn)，可在「配置」中修改"
                  >
                    🚫 禁回国
                  </span>
                  <span
                    v-else
                    class="net-mode-pill pill-allow-cn"
                    title="已允许回国流量，可在「配置」中关闭"
                  >
                    🔓 允许回国
                  </span>
                </div>
                <div style="font-size: 11px; color: #38bdf8; font-family: var(--font-mono);">{{ node.ip }}:{{ node.port }}</div>
              </td>

              <!-- 准入状态 -->
              <td>
                <span class="badge badge-approved" title="节点已通过身份认证并锁定">
                  🛡️ 已准入
                </span>
              </td>

              <!-- SNI 伪装域名 (恢复展示主 SNI 与多 SNI 数量，端口已在第一列地址中展示) -->
              <td>
                <div style="font-family: var(--font-mono); font-size: 12px; color: #38bdf8; font-weight: 600;">
                  {{ node.sni || 'www.amd.com' }}
                </div>
                <div v-if="getServerNamesCount(node) > 1" style="font-size: 10px; color: #64748b; margin-top: 2px;">
                  多SNI: {{ getServerNamesCount(node) }} 个
                </div>
              </td>

              <!-- 开放范围策略 -->
              <td>
                <span v-if="node.status === 0" class="badge badge-disabled">
                  🚫 服务已停
                </span>
                <span v-else-if="node.allow_all === 1" class="badge badge-public">
                  🌐 全体公开
                </span>
                <span v-else class="badge badge-restricted" :title="`组: ${node.allowed_groups || '无'} | 人: ${node.allowed_users || '无'}`">
                  🎯 定向授权 ({{ getScopeSummary(node) }})
                </span>
              </td>

              <!-- 公钥纯文本 + 复制按钮 -->
              <td>
                <div v-if="node.pbk && node.pbk.length === 43" class="pbk-box">
                  <span class="pbk-clean-text" :title="`完整公钥: ${node.pbk}`">{{ formatPbk(node.pbk) }}</span>
                  <button type="button" class="btn-copy-icon" title="点击复制完整公钥" @click.stop.prevent="copyText(node.pbk, '节点公钥')">
                    📋
                  </button>
                </div>
                <div v-else>
                  <span class="text-muted" style="font-size: 11px;">⚠️ 待回传</span>
                </div>
              </td>

              <!-- 健康与心跳 (单行徽章，鼠标移入展示心跳时间，点击直接发起测活) -->
              <td>
                <div
                  class="heartbeat-badge clickable-heartbeat"
                  :class="[
                    getNodeHealthBadge(node).cls,
                    { 'is-pinging': pingingNodeId === node.node_id }
                  ]"
                  :title="getHeartbeatTooltip(node)"
                  @click.stop="node.status !== 0 && handlePingNode(node.node_id)"
                >
                  <span class="status-dot"></span>
                  <span>{{ getNodeHealthBadge(node).text }}</span>
                </div>
                <div
                  v-if="node.status !== 0 && node.sub_eligible === false"
                  style="font-size: 10px; color: #f87171; margin-top: 3px;"
                  :title="node.sub_exclude_reason || '异常节点已自动从订阅剔除'"
                >
                  已从订阅剔除
                </div>
              </td>

              <td style="text-align: right;">
                <div class="action-btn-row" style="justify-content: flex-end;">
                  <button class="btn-sm btn-edit" @click="openConfigModal(node)">⚙️ 配置</button>
                  <button class="btn-sm btn-perm" @click="openPermModal(node)">🔐 权限</button>
                  <button class="btn-sm btn-reset" @click="handleForceResync(node.node_id)" title="清空公钥让节点重新上报">🔄 接纳</button>
                  <button class="btn-sm btn-del" @click="handleRevokeDelete(node.node_id)" title="从集群中删除该节点">🗑️</button>
                </div>
              </td>
            </tr>
            <tr v-if="showInitialNodesLoading">
              <td colspan="7" style="text-align: center; color: #38bdf8; padding: 28px;">
                ⏳ 正在加载已准入节点集群数据，请稍候...
              </td>
            </tr>
            <tr v-else-if="nodesLoadError && approvedNodes.length === 0">
              <td colspan="7" style="text-align: center; color: #f59e0b; padding: 24px;">
                ⚠️ 节点集群数据加载失败，请稍后重试或刷新页面。
              </td>
            </tr>
            <tr v-else-if="approvedNodes.length === 0">
              <td colspan="7" style="text-align: center; color: #64748b; padding: 24px;">
                暂无已准入的在线节点，请在上方复制部署命令并在海外服务器或内网主机启动节点。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========================================================================= -->
    <!-- 子卡 2：待审批节点隔离区 (独立子卡) -->
    <!-- ========================================================================= -->
    <div v-else-if="currentSubTab === 'pending'">
      <div class="quarantine-alert-box">
        <div class="quarantine-alert-top">
          <div class="alert-title-row">
            <span class="text-lg">🟡</span>
            <strong style="color: #fcd34d; font-size: 14px;">零信任待审批隔离区 (Zero-Trust Quarantine Pool)</strong>
            <span class="badge badge-quarantine">{{ pendingNodes.length }} 个节点待审查</span>
          </div>
          <button
            v-if="pendingNodes.length > 0"
            class="btn-cyber-success"
            style="font-size: 11px; padding: 4px 12px;"
            @click="pendingNodes.forEach(n => handleApproveNode(n))"
          >
            ✅ 全部一键批准上线
          </button>
        </div>
        <p class="quarantine-desc">
          当关闭免审核或节点首次接入时强制隔离于此。<strong>隔离期间绝不向下发真实用户订阅</strong>，彻底杜绝探针探测。审查无误后点击“批准上线”即可接入业务。
        </p>
      </div>

      <div class="table-container">
        <table class="cyber-table">
          <thead>
            <tr>
              <th>节点名称 / 上报 IP</th>
              <th>网络模式</th>
              <th>公钥指纹 (Ed25519)</th>
              <th>最后心跳时间</th>
              <th>心跳探测</th>
              <th style="width: 220px;">审查与准入操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="node in pendingNodes" :key="node.id" class="node-quarantine-row">
              <td>
                <div style="font-weight: 700; color: #f8fafc; display: flex; align-items: center; gap: 6px;">
                  <span>{{ node.name }}</span>
                  <span v-if="node.core_type === 'singbox'" class="net-mode-pill pill-singbox">⚡ Sing-box</span>
                </div>
                <div style="font-size: 11px; color: #f59e0b; font-family: var(--font-mono);">{{ node.ip }}:{{ node.port }}</div>
              </td>
              <td>
                <span v-if="node.net_mode === 'reverse_wss'" class="net-mode-pill pill-wss">
                  🔀 WSS反穿
                </span>
                <span v-else class="net-mode-pill pill-direct">
                  🌐 公网直连
                </span>
              </td>
              <td>
                <div class="pbk-box">
                  <span class="pbk-clean-text">{{ formatPbk(node.pbk) }}</span>
                  <button type="button" class="btn-copy-icon" title="点击复制完整公钥" @click.stop.prevent="copyText(node.pbk, '节点公钥')">📋</button>
                </div>
              </td>
              <td style="font-size: 12px; color: #94a3b8; font-family: var(--font-mono);">
                {{ node.last_heartbeat || '刚刚' }}
              </td>
              <td>
                <span class="heartbeat-badge" :class="getHeartbeatInfo(node).cls">
                  <span class="status-dot"></span>
                  <span>{{ getHeartbeatInfo(node).label }}</span>
                </span>
              </td>
              <td>
                <div class="action-btn-row">
                  <button class="btn-sm btn-approve" @click="handleApproveNode(node)">
                    ✅ 批准上线
                  </button>
                  <button class="btn-sm btn-del" @click="handleRevokeDelete(node.node_id)">
                    ❌ 拒绝移除
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="showInitialNodesLoading">
              <td colspan="6" style="text-align: center; color: #38bdf8; padding: 36px;">
                ⏳ 正在加载待审批节点隔离区，请稍候...
              </td>
            </tr>
            <tr v-else-if="pendingNodes.length === 0">
              <td colspan="6" style="text-align: center; color: #64748b; padding: 36px;">
                🎉 隔离区当前为空，所有已知节点均已审核上线。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========================================================================= -->
    <!-- 子卡 3：节点安全审计流水 (独立子卡) -->
    <!-- ========================================================================= -->
    <div v-else-if="currentSubTab === 'audit'">
      <div class="card-header" style="margin-top: 15px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <h3>📜 节点通信与准入安全审计流水</h3>
          <span class="badge badge-ready">{{ auditLogsList.length }} 条记录</span>
        </div>
        <button class="btn-cyber-refresh" @click="fetchNodes">🔄 刷新流水</button>
      </div>

      <div class="table-container">
        <table class="cyber-table">
          <thead>
            <tr>
              <th style="width: 160px;">时间</th>
              <th style="width: 90px;">级别</th>
              <th style="width: 170px;">事件类型</th>
              <th style="width: 140px;">节点 ID / IP</th>
              <th>审计详情说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in auditLogsList" :key="log.id">
              <td style="font-size: 11px; font-family: var(--font-mono); color: #94a3b8;">
                {{ log.created_at }}
              </td>
              <td>
                <span class="badge" :class="log.level === 'warn' || log.level === 'security' ? 'badge-quarantine' : 'badge-ready'">
                  {{ log.level }}
                </span>
              </td>
              <td style="font-size: 11px; font-family: var(--font-mono); color: #38bdf8;">
                {{ log.event_type }}
              </td>
              <td style="font-size: 11px; font-family: var(--font-mono); color: #cbd5e1;">
                {{ log.node_id || log.ip || '-' }}
              </td>
              <td style="font-size: 12px; color: #e2e8f0;">
                {{ log.message }}
              </td>
            </tr>
            <tr v-if="!nodesLoaded && auditLogsList.length === 0">
              <td colspan="5" style="text-align: center; color: #38bdf8; padding: 24px;">
                ⏳ 正在加载节点安全审计流水，请稍候...
              </td>
            </tr>
            <tr v-else-if="auditLogsList.length === 0">
              <td colspan="5" style="text-align: center; color: #64748b; padding: 24px;">
                暂无审计流水记录。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========================================================================= -->
    <!-- 子卡 4：Docker 部署脚本与参数 -->
    <!-- ========================================================================= -->
    <div v-else-if="currentSubTab === 'deploy'">
      <div class="deploy-tab-container">
        <!-- 内核镜像切换条 -->
        <div class="deploy-core-switcher">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span style="font-size: 12px; font-weight: 600; color: #cbd5e1;">选择节点内核镜像：</span>
            <button
              type="button"
              class="core-switch-btn"
              :class="{ active: deployCoreType === 'xray' }"
              @click="deployCoreType = 'xray'"
            >
              🚀 Xray-Core (VLESS-REALITY)
            </button>
            <button
              type="button"
              class="core-switch-btn core-switch-singbox"
              :class="{ active: deployCoreType === 'singbox' }"
              @click="deployCoreType = 'singbox'"
            >
              ⚡ Sing-box (VLESS-REALITY + Hysteria2 UDP)
            </button>
          </div>
          <span v-if="deployCoreType === 'singbox'" class="deploy-core-hint">
            支持 TCP + UDP 双协议（含游戏/视频/QUIC 弱网加速），宿主机需同时放行 443/TCP 与 443/UDP，并执行 <code>chown -R 10001:10001 ./data</code>
          </span>
          <span v-else class="deploy-core-hint">
            经典 Xray-Core 极简镜像，原生支持 VLESS-REALITY-Vision 与 WSS 反向穿透
          </span>
        </div>

        <!-- 1. Docker 极简单行命令秒级部署 -->
        <div class="docker-minimal-section">
          <div class="docker-minimal-header">
            <div>
              <h4 style="color: #f8fafc; margin: 0; display: flex; align-items: center; gap: 8px;">
                <span style="color: #fbbf24;">⚡</span> Docker 极简最小命令秒级部署 ({{ deployCoreType === 'singbox' ? 'wimotek/sing-box' : 'ghcr.io/wimotek/xray' }})
              </h4>
              <p class="modal-tip" style="margin: 4px 0 0 0;">
                无需创建 docker-compose.yml 文件，在海外 VPS 终端粘贴下方单行指令回车即可完成节点自动握手与上线：
              </p>
            </div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <button class="btn-cyber-primary" @click="copyText(generatedDockerPureMinimal, '极简单行命令')">
                ⚡ 一键复制极简单行命令
              </button>
              <button class="btn-cyber-action" @click="copyText(generatedDockerOneLiner, '带注释部署命令模板')">
                📋 复制带注释命令模板
              </button>
              <button
                class="btn-cyber-action"
                @click="copyText(deployCoreType === 'singbox' ? 'docker logs -f singbox-node' : 'docker logs -f xray-node', '容器日志命令')"
              >
                📋 复制日志监控命令
              </button>
            </div>
          </div>
          <div class="docker-oneliner-code">
            {{ generatedDockerOneLiner }}
          </div>
          <div class="docker-args-grid">
            <div class="docker-arg-card">
              <div class="docker-arg-name">--network=host</div>
              <div class="docker-arg-desc">直通网卡绑定物理 443 TCP/UDP 端口，性能无损耗</div>
            </div>
            <div class="docker-arg-card">
              <div class="docker-arg-name">CLUSTER_TOKEN</div>
              <div class="docker-arg-desc">集群引导凭据，已自动填充当前活跃令牌</div>
            </div>
            <div class="docker-arg-card">
              <div class="docker-arg-name">-v ./data:/data</div>
              <div class="docker-arg-desc">非 Root (UID 10001) 持久化密钥、证书与节点 ID</div>
            </div>
            <div class="docker-arg-card" v-if="deployCoreType === 'singbox'">
              <div class="docker-arg-name">HY2_ENABLED=true</div>
              <div class="docker-arg-desc">同端口并行开启 Hysteria2 UDP，订阅自动双协议下发</div>
            </div>
            <div class="docker-arg-card" v-else>
              <div class="docker-arg-name">AUTO_UPDATE=true</div>
              <div class="docker-arg-desc">支持守护进程热重载与看门狗崩溃秒级自愈</div>
            </div>
          </div>
        </div>

        <!-- 2. Docker Compose 编排标准文件 -->
        <div class="deploy-tab-box">
          <h4 style="color: #38bdf8; margin-top: 0;">💻 边缘节点 Docker Compose 生产编排部署文件 ({{ deployCoreType === 'singbox' ? 'Sing-box 双协议' : 'Xray-Core' }})</h4>
          <p class="modal-tip">
            在需要接入的海外 VPS 或内网主机上新建 <code>docker-compose.yml</code> 并粘贴如下配置，执行 <code>docker compose up -d</code>：
          </p>
          <div class="code-editor-box">
            <pre class="yaml-code-view">{{ generatedDockerComposeYaml }}</pre>
          </div>
          <div style="margin-top: 14px;">
            <button class="btn-cyber-primary" @click="copyText(generatedDockerComposeYaml, 'Docker Compose 配置')">
              📋 复制完整 YAML 配置
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 弹窗 1：部署指引弹窗 (保留备用) -->
    <div v-if="showDeployModal" class="modal-backdrop">
      <div class="cyber-modal" style="max-width: 620px; text-align: left;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <h3 style="margin: 0;">🚀 海外节点 Docker 部署配置</h3>
          <button class="modal-close-btn" @click="showDeployModal = false">✕</button>
        </div>
        <p class="modal-tip">
          在海外 VPS 上创建 <code>docker-compose.yml</code> 并粘贴如下内容，执行 <code>docker compose up -d</code> 即可自动建立 TOFU 信任上线：
        </p>
        <div class="code-editor-box">
          <pre class="yaml-code-view">{{ generatedDockerComposeYaml }}</pre>
        </div>
        <div class="btn-group" style="justify-content: space-between; margin-top: 18px;">
          <button class="btn-cyber-primary" @click="copyText(generatedDockerComposeYaml, 'Docker Compose 部署配置')">
            📋 复制完整 YAML 配置
          </button>
          <button class="btn-cyber-action" @click="showDeployModal = false">关闭窗口</button>
        </div>
      </div>
    </div>

    <!-- 弹窗 2：⚙️ 节点网络配置 [精确对应图二样式，点外部空白不关闭] -->
    <div v-if="showConfigModal" class="modal-backdrop">
      <div class="cyber-modal" style="max-width: 580px; max-height: 88vh; overflow-y: auto; text-align: left;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h3 style="margin: 0;">⚙️ 节点网络配置 [{{ configForm.name }}]</h3>
          <button class="modal-close-btn" @click="showConfigModal = false" title="关闭窗口">✕</button>
        </div>
        <div class="form-item" style="margin-top: 14px;">
          <label>节点对外展示名称</label>
          <input v-model="configForm.name" type="text" class="cyber-input modal-input" placeholder="例如: 节点-韩国1" />
        </div>
        <div style="display: flex; gap: 10px;">
          <div class="form-item" style="flex: 1;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <label>节点连接地址 (支持 IP 或 域名)</label>
              <button type="button" class="btn-copy-tag" @click="copyText(configForm.ip, '连接地址')">📋 复制</button>
            </div>
            <input v-model="configForm.ip" type="text" class="cyber-input modal-input" placeholder="例如: 140.238.19.231" />
          </div>
          <div class="form-item" style="width: 110px;">
            <label>监听端口</label>
            <input v-model.number="configForm.port" type="number" class="cyber-input modal-input" />
          </div>
        </div>

        <!-- 多 SNI 伪装目标列表框（紧凑布局：下拉切换多 SNI 组 + 增删 + 实时 TLS 1.3/H2 批量验证） -->
        <div class="reality-preset-box">
          <div class="sni-header-row">
            <span style="font-size: 12px; font-weight: 700; color: #38bdf8;">🎯 REALITY 多 SNI 预设列表（{{ realityPresets.length }} 组）</span>
            <div style="display: flex; align-items: center; gap: 6px;">
              <button
                type="button"
                class="btn-sni-mini"
                :class="{ active: showAddSniBar }"
                @click="toggleAddSniBar"
              >
                {{ showAddSniBar ? '✕ 收起' : '➕ 新增组' }}
              </button>
              <button
                type="button"
                class="btn-sni-mini"
                title="随机切换列表中的另一组多 SNI 预设"
                @click="pickRandomRealityPreset"
              >
                🎲 随机
              </button>
            </div>
          </div>

          <!-- 主操作行：下拉列表框 + 批量验证 + 删除 -->
          <div class="sni-select-row">
            <select
              v-model="selectedPresetKey"
              class="sni-select-box"
              @change="onSelectRealityPreset"
            >
              <option
                v-if="!isPresetKeyInList(selectedPresetKey)"
                :value="selectedPresetKey"
              >
                {{ currentSniList.length ? `${currentSniList[0]}${currentSniList.length > 1 ? ` (+${currentSniList.length - 1} SNI)` : ''}（当前自定义 · 未加入列表）` : '自定义配置' }}
              </option>
              <option
                v-for="preset in realityPresets"
                :key="getPresetKey(preset)"
                :value="getPresetKey(preset)"
              >
                {{ formatPresetOptionLabel(preset) }}
              </option>
            </select>
            <button
              type="button"
              class="btn-sni-verify"
              :disabled="verifyingSni || currentSniList.length === 0"
              title="并发探测当前所有 SNI 是否在目标 dest 上支持 TLS 1.3 + HTTP/2 且证书有效"
              @click="handleVerifySni(configForm.server_names, configForm.dest, 'form')"
            >
              {{ verifyingSni ? '⏳ 检测中' : '🔍 验证' }}
            </button>
            <button
              type="button"
              class="btn-sni-del"
              :disabled="!isPresetKeyInList(selectedPresetKey) || realityPresets.length <= 1 || savingSniPreset"
              :title="isPresetKeyInList(selectedPresetKey) ? '从全局预设列表中删除当前选中组' : '当前为未保存的自定义配置'"
              @click="handleDeleteSniPreset(selectedPresetKey)"
            >
              🗑️
            </button>
          </div>

          <!-- 可折叠新增多 SNI 预设紧凑行 -->
          <div v-if="showAddSniBar" class="sni-add-bar">
            <div class="sni-add-inputs">
              <input
                v-model="newSniForm.server_names"
                type="text"
                class="cyber-input sni-add-input font-mono"
                placeholder="输入多 SNI（逗号分隔），如 www.apple.com,apple.com"
                @keyup.enter="handleAddSniPreset"
              />
            </div>
            <div class="sni-add-inputs">
              <input
                v-model="newSniForm.dest"
                type="text"
                class="cyber-input sni-add-note font-mono"
                placeholder="dest 回落目标（留空默认 首个SNI:443）"
                @keyup.enter="handleAddSniPreset"
              />
              <input
                v-model="newSniForm.label"
                type="text"
                class="cyber-input sni-add-note"
                placeholder="备注(可选，如 Apple 官网)"
                @keyup.enter="handleAddSniPreset"
              />
            </div>
            <div class="sni-add-actions">
              <button
                type="button"
                class="btn-sni-verify"
                :disabled="verifyingSni || !newSniForm.server_names.trim()"
                @click="handleVerifySni(newSniForm.server_names, newSniForm.dest, 'add')"
              >
                {{ verifyingSni ? '⏳' : '🔍 先验证' }}
              </button>
              <button
                type="button"
                class="btn-sni-add-confirm"
                :disabled="savingSniPreset || !newSniForm.server_names.trim()"
                @click="handleAddSniPreset"
              >
                {{ savingSniPreset ? '保存中...' : '✅ 添加并选用' }}
              </button>
              <button
                type="button"
                class="btn-sni-mini"
                :disabled="savingSniPreset"
                title="恢复内置安全默认多 SNI 预设列表"
                @click="handleResetSniPresets"
              >
                ↺ 恢复默认
              </button>
            </div>
          </div>

          <!-- 有效性验证结果条（支持多 SNI 逐项展示与一键剔除失效项） -->
          <div
            v-if="sniVerifyResult"
            class="sni-verify-banner"
            :class="`verify-${sniVerifyResult.grade || 'invalid'}`"
          >
            <div class="verify-top-line">
              <span>
                <strong>{{ sniVerifyResult.valid ? (sniVerifyResult.grade === 'warn' ? '⚠️' : '✅') : (sniVerifyResult.grade === 'local' ? '🏠' : '❌') }}</strong>
                <span style="margin-left: 4px;">{{ sniVerifyResult.summary }}</span>
              </span>
              <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                <button
                  v-if="sniVerifyResult.passed_snis && sniVerifyResult.passed_snis.length > 0 && sniVerifyResult.failed_snis && sniVerifyResult.failed_snis.length > 0"
                  type="button"
                  class="btn-sni-prune"
                  @click="keepOnlyPassedSnis"
                >
                  ✂️ 仅保留通过的 {{ sniVerifyResult.passed_snis.length }} 个
                </button>
                <button type="button" class="verify-close-btn" @click="sniVerifyResult = null">✕</button>
              </div>
            </div>

            <!-- 逐项 SNI 探测明细 -->
            <div v-if="sniVerifyResult.items && sniVerifyResult.items.length > 0" class="verify-item-list">
              <div
                v-for="item in sniVerifyResult.items"
                :key="item.sni"
                class="verify-item-row"
                :class="`item-${item.grade || 'invalid'}`"
              >
                <span class="font-mono">
                  {{ item.valid ? (item.grade === 'warn' ? '⚠️' : '✅') : '❌' }} {{ item.sni }}
                </span>
                <span class="verify-item-detail">
                  <template v-if="item.valid">
                    {{ item.tls_version }} / {{ item.alpn || '无H2' }} · {{ item.rtt_ms }}ms<template v-if="item.is_cloudflare"> · CF证书</template>
                  </template>
                  <template v-else>
                    {{ item.summary }}
                  </template>
                </span>
              </div>
            </div>
            <div v-else-if="sniVerifyResult.warnings && sniVerifyResult.warnings.length" class="verify-warn-list">
              <div v-for="(w, idx) in sniVerifyResult.warnings" :key="idx">• {{ w }}</div>
            </div>
          </div>

          <!-- 多 SNI 域名池与回落目标 (dest) 双列紧凑输入框 -->
          <div class="sni-dest-row">
            <div class="form-item" style="flex: 1.45; margin-bottom: 0;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <label style="margin: 0;">多 SNI 域名池（逗号分隔）</label>
                <span class="sni-count-tag">
                  {{ currentSniList.length }} 个 SNI · {{ configForm.core_type === 'singbox' ? 'Sing-box 取首个' : '订阅随机分配' }}
                </span>
              </div>
              <input
                :value="configForm.server_names"
                type="text"
                class="cyber-input modal-input font-mono"
                placeholder="例如: www.amd.com,amd.com"
                @input="onManualSniInput($event.target.value)"
              />
            </div>
            <div class="form-item" style="flex: 1; margin-bottom: 0;">
              <label>回落目标 (dest)</label>
              <input
                v-model="configForm.dest"
                type="text"
                class="cyber-input modal-input font-mono"
                placeholder="例如: www.amd.com:443 或 127.0.0.1:8443"
                @input="syncSelectedPresetKey"
              />
            </div>
          </div>
          <div class="preset-hint">
            Xray 节点支持多 SNI，每次拉取订阅会从域名池中<strong>随机下发</strong>一个 SNI（需确保所填域名均在同一 <code>dest</code> 证书/服务下有效，可点右侧「🔍 验证」批量核验）。
          </div>
        </div>

        <!-- 回国流量管控策略 -->
        <div class="cn-policy-box">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 12px; font-weight: 700; color: #34d399;">🛡️ 回国流量管控（防滥用 / 节点安全）</span>
            <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #e2e8f0; cursor: pointer;">
              <input type="checkbox" v-model="configForm.block_cn" />
              <span>禁止回国流量 (默认开启)</span>
            </label>
          </div>
          <div style="font-size: 11px; color: #94a3b8; margin-top: 6px; line-height: 1.45;">
            开启后节点将在内核路由层直接拦截中国大陆域名与 IP（geosite-cn / geoip-cn）；关闭则允许经由本节点回访国内站点。保存后约 60 秒内自动同步生效。
          </div>
        </div>

        <!-- Sing-box 专属：Hysteria2 UDP 双协议配置区 -->
        <div v-if="configForm.core_type === 'singbox'" class="hy2-config-box">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-size: 12px; font-weight: 700; color: #c084fc;">🌀 Sing-box Hysteria2 UDP 策略</span>
            <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #e2e8f0; cursor: pointer;">
              <input type="checkbox" v-model="configForm.hy2_enabled" />
              <span>启用 Hysteria2 (UDP)</span>
            </label>
          </div>
          <div v-if="configForm.hy2_enabled" style="display: flex; gap: 10px; align-items: flex-end;">
            <div class="form-item" style="width: 110px; margin-bottom: 0;">
              <label>UDP 端口</label>
              <input v-model.number="configForm.hy2_port" type="number" class="cyber-input modal-input" placeholder="443" />
            </div>
            <div class="form-item" style="flex: 1; margin-bottom: 0;">
              <label>TLS SNI 域名</label>
              <input v-model="configForm.hy2_sni" type="text" class="cyber-input modal-input" placeholder="www.bing.com" />
            </div>
          </div>
          <div v-if="configForm.hy2_enabled" style="margin-top: 10px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <label style="font-size: 12px; color: #cbd5e1; margin: 0;">UDP 跳跃端口范围 (mport，可选，自动写入订阅链接)</label>
              <div style="display: flex; gap: 6px;">
                <button
                  type="button"
                  class="btn-copy-tag"
                  @click="configForm.hy2_mport = '20000-30000'"
                >
                  ⚡ 填入 20000-30000
                </button>
                <button
                  v-if="configForm.hy2_mport"
                  type="button"
                  class="btn-copy-tag"
                  @click="configForm.hy2_mport = ''"
                >
                  清空
                </button>
              </div>
            </div>
            <input
              v-model="configForm.hy2_mport"
              type="text"
              class="cyber-input modal-input font-mono"
              placeholder="例如: 20000-30000 或 20000-25000,30000-35000（留空关闭）"
            />
            <div style="font-size: 11px; color: #94a3b8; margin-top: 4px; line-height: 1.45;">
              填写后，所有订阅链接将自动附加 <code>&amp;mport=...</code>（兼容 v2rayNG / v2rayN / Shadowrocket / Mihomo）。请确保 VPS 宿主机已配置 iptables / nftables 将该 UDP 端口段 DNAT/REDIRECT 转发至主端口 <code>{{ configForm.hy2_port || 443 }}/udp</code>。
            </div>
          </div>
          <div v-if="configForm.hy2_enabled" style="margin-top: 8px; display: flex; justify-content: space-between; align-items: center;">
            <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #94a3b8; cursor: pointer;">
              <input type="checkbox" v-model="configForm.hy2_insecure" />
              <span>自签证书模式（自动下发 pinSHA256 指纹固定；挂载 CA 正式证书时请取消勾选）</span>
            </label>
          </div>
        </div>
        <div class="form-item">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <label>ShortId 认证标识 <span class="badge-locked">🔒 节点固化</span></label>
            <button type="button" class="btn-copy-tag" @click="copyText(configForm.sid, 'ShortId')">📋 复制</button>
          </div>
          <input v-model="configForm.sid" type="text" class="cyber-input modal-input font-mono input-readonly" readonly disabled />
        </div>
        <div class="form-item">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <label>专属通信密钥 (Node Key - TOFU 已固化) <span class="badge-locked">🔒 不可篡改</span></label>
            <button type="button" class="btn-copy-tag" @click="copyText(configForm.node_key, '专属通信密钥')">📋 复制</button>
          </div>
          <input v-model="configForm.node_key" type="text" class="cyber-input modal-input font-mono input-readonly" readonly disabled />
          <div class="modal-readonly-hint">
            此密钥为 TOFU 首次握手后节点与控制中心唯一信任凭据，已固化禁止随意修改，保障节点永不失联。
          </div>
        </div>
        <div class="btn-group" style="justify-content: flex-end; margin-top: 20px; gap: 10px;">
          <button class="btn-cyber-action" @click="showConfigModal = false">取消</button>
          <button class="btn-cyber-primary" @click="submitNodeConfig">保存网络配置</button>
        </div>
      </div>
    </div>

    <!-- 弹窗 3：🔐 节点启停与权限策略 -->
    <div v-if="showPermModal" class="modal-backdrop">
      <div class="cyber-modal" style="max-width: 520px; text-align: left;">
        <h3>🔐 节点启停与权限策略 [{{ permForm.name }}]</h3>
        <div class="form-item" style="margin-top: 14px;">
          <label>节点运行状态 (单选启停)</label>
          <div class="radio-group">
            <label class="radio-label">
              <input type="radio" :value="1" v-model.number="permForm.status" /> 🟢 启用节点
            </label>
            <label class="radio-label">
              <input type="radio" :value="0" v-model.number="permForm.status" /> 🛑 停止节点
            </label>
          </div>
        </div>
        <div class="form-item" style="border-top: 1px dashed rgba(255,255,255,0.08); padding-top: 12px;">
          <label>授权开放范围 (单选，默认全体公开)</label>
          <div class="radio-group">
            <label class="radio-label">
              <input type="radio" :value="1" v-model.number="permForm.allow_all" /> 🌐 全部用户可用 (公开节点)
            </label>
            <label class="radio-label">
              <input type="radio" :value="0" v-model.number="permForm.allow_all" /> 🎯 定向授权 (指定组或特定用户)
            </label>
          </div>
        </div>
        <div v-if="permForm.allow_all === 0" class="permission-sub-box">
          <div class="form-item">
            <label>允许访问的用户组 (如: vip, pro)</label>
            <input v-model="permForm.allowed_groups" type="text" class="cyber-input modal-input" />
          </div>
          <div class="form-item" style="margin-top: 8px;">
            <label>允许访问的特定用户 (用户名或邮箱)</label>
            <input v-model="permForm.allowed_users" type="text" class="cyber-input modal-input" />
          </div>
        </div>
        <div class="btn-group" style="justify-content: flex-end; margin-top: 20px;">
          <button class="btn-cyber-action" @click="showPermModal = false">取消</button>
          <button class="btn-cyber-success" @click="submitNodePermission">保存权限策略</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const props = defineProps({
  adminNodes: { type: Array, default: () => [] },
  adminDataLoading: { type: Boolean, default: false },
  adminDataLoaded: { type: Boolean, default: false },
  currentUser: { type: Object, required: true },
  adminPassword: { type: String, required: true }
})

const emit = defineEmits(['reload-all', 'copy', 'open-qr'])

const currentSubTab = ref('approved')
const deployCoreType = ref('xray')
const localNodes = ref(Array.isArray(props.adminNodes) ? [...props.adminNodes] : [])
const auditLogsList = ref([])
const nodesLoading = ref(true)
const nodesLoaded = ref(false)
const nodesLoadError = ref(false)

watch(
  () => props.adminNodes,
  (val) => {
    if (!nodesLoaded.value && Array.isArray(val) && val.length > 0 && localNodes.value.length === 0) {
      localNodes.value = [...val]
    }
  }
)

const showInitialNodesLoading = computed(
  () => localNodes.value.length === 0 && (nodesLoading.value || !nodesLoaded.value || props.adminDataLoading)
)

const pingResults = reactive({})
const pingingNodeId = ref('')
const pingingAll = ref(false)
const serverOffsetMs = ref(0)
const lastFetchMs = ref(Date.now())
let pollTimer = null
let isFetchingNodes = false
let isTabActive = true

const clusterInfo = reactive({
  cluster_token: '',
  tofu_enabled: true,
  auto_approve: true,
  panel_url: ''
})

const approvedNodes = computed(() => localNodes.value.filter(n => n.is_approved === undefined || n.is_approved === 1))
const pendingNodes = computed(() => localNodes.value.filter(n => n.is_approved === 0))

const showDeployModal = ref(false)
const showConfigModal = ref(false)
const showPermModal = ref(false)

const realityPresets = ref([
  { dest: 'www.amd.com:443', sni: 'www.amd.com', server_names: ['www.amd.com', 'amd.com'], label: 'AMD 官网', region: '全球 Akamai' },
  { dest: 'www.nvidia.com:443', sni: 'www.nvidia.com', server_names: ['www.nvidia.com', 'nvidia.com', 'developer.nvidia.com'], label: 'NVIDIA 官网', region: '全球低噪' },
  { dest: 'www.intel.com:443', sni: 'www.intel.com', server_names: ['www.intel.com', 'intel.com'], label: 'Intel 官网', region: '欧美/全球' },
  { dest: 'www.logitech.com:443', sni: 'www.logitech.com', server_names: ['www.logitech.com', 'logitech.com'], label: 'Logitech 罗技', region: '欧美/亚太' },
  { dest: 'www.samsung.com:443', sni: 'www.samsung.com', server_names: ['www.samsung.com', 'samsung.com'], label: 'Samsung 三星', region: '日韩/亚太优' },
  { dest: 'www.sony.com:443', sni: 'www.sony.com', server_names: ['www.sony.com', 'sony.com'], label: 'Sony 索尼', region: '日韩/美西优' },
  { dest: 'www.asus.com:443', sni: 'www.asus.com', server_names: ['www.asus.com', 'asus.com'], label: 'ASUS 华硕', region: '亚太/新加坡优' },
  { dest: 'www.dell.com:443', sni: 'www.dell.com', server_names: ['www.dell.com', 'dell.com'], label: 'Dell 戴尔', region: '北美/欧洲' },
  { dest: 'www.cisco.com:443', sni: 'www.cisco.com', server_names: ['www.cisco.com', 'cisco.com'], label: 'Cisco 思科', region: '企业网络' },
  { dest: 'www.oracle.com:443', sni: 'www.oracle.com', server_names: ['www.oracle.com', 'oracle.com'], label: 'Oracle 甲骨文', region: '全球云商' },
  { dest: 'www.siemens.com:443', sni: 'www.siemens.com', server_names: ['www.siemens.com', 'siemens.com'], label: 'Siemens 西门子', region: '欧洲节点优' },
  { dest: 'www.mozilla.org:443', sni: 'www.mozilla.org', server_names: ['www.mozilla.org', 'addons.mozilla.org', 'developer.mozilla.org'], label: 'Mozilla 官网', region: '全球开源' }
])

const configForm = reactive({
  node_id: '',
  name: '',
  ip: '',
  port: 443,
  dest: '',
  server_names: '',
  sid: '',
  node_key: '',
  core_type: 'xray',
  block_cn: true,
  hy2_enabled: false,
  hy2_port: 443,
  hy2_sni: '',
  hy2_mport: '',
  hy2_insecure: true
})

const selectedPresetKey = ref('')
const showAddSniBar = ref(false)
const savingSniPreset = ref(false)
const verifyingSni = ref(false)
const verifySource = ref('form')
const sniVerifyResult = ref(null)
const newSniForm = reactive({
  server_names: '',
  dest: '',
  label: ''
})

const cleanSingleSni = (raw) => {
  return String(raw || '')
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split('?')[0]
    .split('#')[0]
    .split(':')[0]
    .replace(/\.+$/, '')
    .trim()
    .toLowerCase()
}

const parseSniList = (raw) => {
  const parts = Array.isArray(raw) ? raw : String(raw || '').split(/[,;\s]+/)
  const seen = new Set()
  const list = []
  for (const part of parts) {
    const cleaned = cleanSingleSni(part)
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned)
      list.push(cleaned)
    }
  }
  return list
}

const getPresetSnis = (preset) => {
  if (!preset) return []
  return parseSniList(preset.server_names && preset.server_names.length ? preset.server_names : preset.sni)
}

const getPresetKey = (preset) => {
  const snis = getPresetSnis(preset)
  const dest = String(preset?.dest || (snis[0] ? `${snis[0]}:443` : '')).trim().toLowerCase()
  return `${dest}|${snis.join(',')}`
}

const currentSniList = computed(() => parseSniList(configForm.server_names))

const buildCurrentFormKey = () => {
  const snis = parseSniList(configForm.server_names)
  const dest = String(configForm.dest || (snis[0] ? `${snis[0]}:443` : '')).trim().toLowerCase()
  return `${dest}|${snis.join(',')}`
}

const syncSelectedPresetKey = () => {
  selectedPresetKey.value = buildCurrentFormKey()
}

const isPresetKeyInList = (key) => {
  if (!key) return false
  return realityPresets.value.some(p => getPresetKey(p) === key)
}

const formatPresetOptionLabel = (preset) => {
  if (!preset) return ''
  const snis = getPresetSnis(preset)
  const head = snis[0] || preset.sni || ''
  const extraCount = snis.length > 1 ? ` (+${snis.length - 1} SNI)` : ''
  const meta = [preset.label, preset.region].filter(Boolean).join(' · ')
  return meta ? `${head}${extraCount} — ${meta}` : `${head}${extraCount}`
}

const applyRealityPreset = (preset) => {
  if (!preset) return
  const snis = getPresetSnis(preset)
  if (!snis.length) return
  configForm.server_names = snis.join(',')
  configForm.dest = preset.dest || `${snis[0]}:443`
  selectedPresetKey.value = getPresetKey(preset)
  sniVerifyResult.value = null
}

const onSelectRealityPreset = () => {
  const found = realityPresets.value.find(p => getPresetKey(p) === selectedPresetKey.value)
  if (found) {
    applyRealityPreset(found)
  }
}

const onManualSniInput = (val) => {
  const prevFirst = currentSniList.value[0] || ''
  const prevDest = String(configForm.dest || '').trim().toLowerCase()
  configForm.server_names = String(val || '')
  const nextList = parseSniList(val)
  const nextFirst = nextList[0] || ''
  sniVerifyResult.value = null
  // 若当前 dest 为空或与旧主 SNI 处于默认 :443 绑定状态，则自动跟随新的主 SNI 更新
  if (nextFirst && (!prevDest || prevDest === `${prevFirst}:443` || prevDest === prevFirst)) {
    configForm.dest = `${nextFirst}:443`
  }
  syncSelectedPresetKey()
}

const pickRandomRealityPreset = () => {
  const list = realityPresets.value
  if (!list.length) return
  const curKey = selectedPresetKey.value
  const candidates = list.filter(p => getPresetKey(p) !== curKey)
  const pool = candidates.length ? candidates : list
  const picked = pool[Math.floor(Math.random() * pool.length)]
  applyRealityPreset(picked)
  const snis = getPresetSnis(picked)
  ElMessage.success(`已切换多 SNI 预设（${snis.length} 个）：${snis.join(', ')}`)
}

const toggleAddSniBar = () => {
  showAddSniBar.value = !showAddSniBar.value
  if (showAddSniBar.value) {
    newSniForm.server_names = ''
    newSniForm.dest = ''
    newSniForm.label = ''
  }
}

const handleVerifySni = async (rawSnis, rawDest = '', source = 'form') => {
  const snis = parseSniList(rawSnis)
  if (!snis.length) {
    ElMessage.warning('请先输入或选择有效的 SNI 域名（多 SNI 用逗号分隔）')
    return
  }
  verifySource.value = source
  verifyingSni.value = true
  try {
    const res = await axios.post('/api/admin/sni/verify', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      sni: snis[0],
      server_names: snis.join(','),
      dest: String(rawDest || '').trim()
    }, { timeout: 15000 })
    if (res.data.code === 200 && res.data.data) {
      sniVerifyResult.value = res.data.data
      if (res.data.data.valid && res.data.data.grade === 'excellent') {
        ElMessage.success(res.data.data.summary)
      } else if (res.data.data.valid) {
        ElMessage.warning(res.data.data.summary)
      } else {
        ElMessage.error(res.data.data.summary || 'SNI 验证未通过')
      }
    } else {
      ElMessage.error(res.data.msg || '验证失败')
    }
  } catch (_) {
    ElMessage.error('SNI 有效性探测请求失败')
  } finally {
    verifyingSni.value = false
  }
}

const keepOnlyPassedSnis = () => {
  const passed = sniVerifyResult.value?.passed_snis || []
  if (!passed.length) return
  if (verifySource.value === 'add') {
    newSniForm.server_names = passed.join(',')
  } else {
    configForm.server_names = passed.join(',')
    syncSelectedPresetKey()
  }
  ElMessage.success(`已仅保留通过验证的 ${passed.length} 个 SNI：${passed.join(', ')}`)
}

const handleAddSniPreset = async () => {
  const snis = parseSniList(newSniForm.server_names)
  if (!snis.length) {
    ElMessage.warning('请输入合法的 SNI 域名（多 SNI 用逗号分隔，如 www.apple.com,apple.com）')
    return
  }
  const dest = newSniForm.dest.trim() || `${snis[0]}:443`
  savingSniPreset.value = true
  try {
    const res = await axios.post('/api/admin/sni/presets', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      action: 'add',
      sni: snis[0],
      server_names: snis,
      dest,
      label: newSniForm.label.trim()
    }, { timeout: 10000 })
    if (res.data.code === 200 && Array.isArray(res.data.data)) {
      realityPresets.value = res.data.data
      const targetKey = `${dest.toLowerCase()}|${snis.join(',')}`
      const added = res.data.data.find(p => getPresetKey(p) === targetKey) || res.data.data[res.data.data.length - 1]
      if (added) {
        applyRealityPreset(added)
      }
      newSniForm.server_names = ''
      newSniForm.dest = ''
      newSniForm.label = ''
      showAddSniBar.value = false
      ElMessage.success(res.data.msg || `已新增 SNI 组：${snis.join(', ')}`)
    } else {
      ElMessage.error(res.data.msg || '新增 SNI 组失败')
    }
  } catch (_) {
    ElMessage.error('新增 SNI 组请求失败')
  } finally {
    savingSniPreset.value = false
  }
}

const handleDeleteSniPreset = async (targetKey) => {
  const found = realityPresets.value.find(p => getPresetKey(p) === targetKey)
  if (!found) return
  if (realityPresets.value.length <= 1) {
    ElMessage.warning('至少保留 1 组可用 SNI 预设')
    return
  }
  const snis = getPresetSnis(found)
  if (!confirm(`确定从全局列表中删除 SNI 组 [${snis.join(', ')}] 吗？`)) return
  savingSniPreset.value = true
  try {
    const res = await axios.post('/api/admin/sni/presets', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      action: 'delete',
      key: targetKey,
      sni: found.sni,
      dest: found.dest
    }, { timeout: 10000 })
    if (res.data.code === 200 && Array.isArray(res.data.data)) {
      realityPresets.value = res.data.data
      if (selectedPresetKey.value === targetKey && res.data.data.length > 0) {
        applyRealityPreset(res.data.data[0])
      }
      ElMessage.success(res.data.msg || '已删除该 SNI 预设')
    } else {
      ElMessage.error(res.data.msg || '删除 SNI 预设失败')
    }
  } catch (_) {
    ElMessage.error('删除 SNI 预设请求失败')
  } finally {
    savingSniPreset.value = false
  }
}

const handleResetSniPresets = async () => {
  if (!confirm('确定恢复为内置默认安全多 SNI 预设列表吗？（自定义新增项将被覆盖）')) return
  savingSniPreset.value = true
  try {
    const res = await axios.post('/api/admin/sni/presets', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      action: 'reset'
    }, { timeout: 10000 })
    if (res.data.code === 200 && Array.isArray(res.data.data)) {
      realityPresets.value = res.data.data
      ElMessage.success(res.data.msg || '已恢复默认多 SNI 列表')
    } else {
      ElMessage.error(res.data.msg || '恢复失败')
    }
  } catch (_) {
    ElMessage.error('恢复默认列表失败')
  } finally {
    savingSniPreset.value = false
  }
}

const permForm = reactive({
  node_id: '',
  name: '',
  status: 1,
  allow_all: 1,
  allowed_groups: '',
  allowed_users: ''
})

const maskedClusterToken = computed(() => {
  const t = clusterInfo.cluster_token || ''
  if (t.length <= 12) return t
  return `${t.slice(0, 8)}...${t.slice(-6)}`
})

const generatedDockerComposeYaml = computed(() => {
  const panelUrl = clusterInfo.panel_url || (typeof window !== 'undefined' ? window.location.origin : '')
  const token = clusterInfo.cluster_token || 'your_cluster_token'
  if (deployCoreType.value === 'singbox') {
    return [
      'services:',
      '  singbox-node:',
      '    image: wimotek/sing-box:latest',
      '    container_name: singbox-node',
      '    restart: always',
      '    network_mode: host',
      '    environment:',
      `      - PANEL_URL=${panelUrl}`,
      `      # - CLUSTER_TOKEN=${token} # 选填: 主控已开启免审核可省略`,
      '      - PORT=443',
      '      - HY2_ENABLED=true',
      '      - HY2_PORT=443',
      '      - HY2_SNI=www.bing.com',
      '      # - HY2_MPORT=20000-30000 # 选填: UDP 跳跃端口段(需配合宿主机 iptables/nftables 转发，Hub 后台也可随时修改)',
      '      # - BLOCK_CN=true # 默认关闭回国流量 (Hub 后台可修改)',
      '      # - DEST=www.amd.com:443 # 留空首次启动自动随机分配安全伪装目标',
      '      # - SERVER_NAMES=www.amd.com # 留空与 DEST 自动配对',
      '      # - HY2_UP_MBPS=200 # 选填: 宿主机上行带宽上限 (Mbps)',
      '      # - HY2_DOWN_MBPS=500 # 选填: 宿主机下行带宽上限 (Mbps)',
      '    volumes:',
      '      - ./data:/data'
    ].join('\n')
  }
  return [
    'services:',
    '  xray-node:',
    '    image: ghcr.io/wimotek/xray:latest',
    '    container_name: xray-node',
    '    restart: always',
    '    network_mode: host',
    '    environment:',
    `      - PANEL_URL=${panelUrl}`,
    `      # - CLUSTER_TOKEN=${token} # 选填: 主控已开启免审核可省略`,
    '      # - PORT=443 # 选填: 默认443',
    '      # - BLOCK_CN=true # 默认关闭回国流量 (Hub 后台可修改)',
    '      # - DEST=www.amd.com:443 # 留空首次启动自动随机分配安全伪装目标',
    '      # - SERVER_NAMES=www.amd.com # 留空与 DEST 自动配对',
    '    volumes:',
    '      - ./data:/data'
  ].join('\n')
})

const generatedDockerPureMinimal = computed(() => {
  const panelUrl = clusterInfo.panel_url || (typeof window !== 'undefined' ? window.location.origin : '')
  if (deployCoreType.value === 'singbox') {
    return `mkdir -p ./data && chown -R 10001:10001 ./data && docker run -d --name singbox-node --restart=always --network=host -e PANEL_URL="${panelUrl}" -e HY2_ENABLED=true -e HY2_PORT=443 -v ./data:/data wimotek/sing-box:latest`
  }
  return `docker run -d --name xray-node --restart=always --network=host -e PANEL_URL="${panelUrl}" -v ./data:/data ghcr.io/wimotek/xray:latest`
})

const generatedDockerOneLiner = computed(() => {
  const panelUrl = clusterInfo.panel_url || (typeof window !== 'undefined' ? window.location.origin : '')
  const token = clusterInfo.cluster_token || 'ctk_aebaa4b470ee12c6b5d97e23da17d9f1'
  if (deployCoreType.value === 'singbox') {
    return [
      'mkdir -p ./data && chown -R 10001:10001 ./data',
      'docker run -d \\',
      '  --name singbox-node \\',
      '  --restart=always \\',
      '  --network=host \\',
      `  -e PANEL_URL="${panelUrl}" \\`,
      `  # -e CLUSTER_TOKEN="${token}" \\`,
      '  -e PORT=443 \\',
      '  -e HY2_ENABLED=true \\',
      '  -e HY2_PORT=443 \\',
      '  -e HY2_SNI=www.bing.com \\',
      '  # -e BLOCK_CN=true \\',
      '  # -e DEST=www.amd.com:443 \\',
      '  # -e SERVER_NAMES=www.amd.com \\',
      '  -v ./data:/data \\',
      '  wimotek/sing-box:latest'
    ].join('\n')
  }
  return [
    'docker run -d \\',
    '  --name xray-node \\',
    '  --restart=always \\',
    '  --network=host \\',
    `  -e PANEL_URL="${panelUrl}" \\`,
    `  # -e CLUSTER_TOKEN="${token}" \\`,
    '  # -e PORT=443 \\',
    '  # -e BLOCK_CN=true \\',
    '  # -e DEST=www.amd.com:443 \\',
    '  # -e SERVER_NAMES=www.amd.com \\',
    '  -v ./data:/data \\',
    '  ghcr.io/wimotek/xray:latest'
  ].join('\n')
})

const formatPbk = (pbk) => {
  if (!pbk || pbk.length < 14) return pbk || ''
  return `${pbk.slice(0, 7)}...${pbk.slice(-6)}`
}

const copyText = (val, label = '内容') => {
  if (val === undefined || val === null) return
  // 严格拦截任何原生事件对象
  if (val instanceof Event || (typeof val === 'object' && (val.type || val.target || val.clipboardData || val.srcElement))) {
    return
  }
  // 提取纯文本
  let text = typeof val === 'object' && val.value !== undefined ? val.value : val
  if (typeof text !== 'string' && typeof text !== 'number') return
  text = String(text).trim()
  if (!text || text === '[object ClipboardEvent]' || text === '[object Object]') {
    ElMessage.warning(`${label}内容为空`)
    return
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      ElMessage.success(`${label}已复制到剪贴板！`)
    }).catch(() => {
      fallbackCopy(text, label)
    })
  } else {
    fallbackCopy(text, label)
  }
}

const fallbackCopy = (text, label = '内容') => {
  if (!text || typeof text !== 'string' || text === '[object ClipboardEvent]') return
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.top = '-9999px'
    ta.setAttribute('readonly', '')
    document.body.appendChild(ta)
    ta.focus()
    ta.select()

    // 捕获阶段拦截：防止任何上层 Vue 组件或根容器接收到原生 copy 事件冒泡
    const stopCopyBubble = (e) => {
      e.stopPropagation()
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', text)
      }
    }
    document.addEventListener('copy', stopCopyBubble, true)
    const successful = document.execCommand('copy')
    document.removeEventListener('copy', stopCopyBubble, true)

    document.body.removeChild(ta)
    if (successful) {
      ElMessage.success(`${label}已复制到剪贴板！`)
    } else {
      ElMessage.warning('未能自动复制，请手动复制')
    }
  } catch (_) {
    ElMessage.error('复制失败，请手动选中文本复制')
  }
}

const parseAgentHealth = (node) => {
  if (!node) return null
  if (node.agent_health_info && typeof node.agent_health_info === 'object') {
    return node.agent_health_info
  }
  if (typeof node.agent_health === 'string' && node.agent_health.trim()) {
    try {
      const obj = JSON.parse(node.agent_health)
      return obj && typeof obj === 'object' ? obj : null
    } catch (_) {
      return null
    }
  }
  return null
}

const getHeartbeatInfo = (nodeOrStr) => {
  const isObj = nodeOrStr && typeof nodeOrStr === 'object'
  const lastHeartbeat = isObj ? nodeOrStr.last_heartbeat : nodeOrStr

  if (!lastHeartbeat || String(lastHeartbeat).includes('等待') || String(lastHeartbeat).includes('下线')) {
    return { label: lastHeartbeat || '未上线', diff: '无心跳', diffSec: null, cls: 'badge-disabled' }
  }

  let diffSec = null
  if (isObj && typeof nodeOrStr.last_heartbeat_ts === 'number' && nodeOrStr.last_heartbeat_ts > 0) {
    const serverNowSec = (Date.now() - serverOffsetMs.value) / 1000
    diffSec = Math.max(0, Math.floor(serverNowSec - nodeOrStr.last_heartbeat_ts))
  } else if (isObj && typeof nodeOrStr.heartbeat_age_sec === 'number' && nodeOrStr.heartbeat_age_sec >= 0) {
    const elapsed = Math.max(0, Math.floor((Date.now() - lastFetchMs.value) / 1000))
    diffSec = nodeOrStr.heartbeat_age_sec + elapsed
  } else {
    const t = new Date(String(lastHeartbeat).replace(/-/g, '/')).getTime()
    if (isNaN(t)) {
      return { label: '未知', diff: String(lastHeartbeat), diffSec: null, cls: 'badge-disabled' }
    }
    const rawDiff = Math.floor((Date.now() - t) / 1000)
    // 防止跨时区/时钟偏差导致负数永久显示在线
    if (rawDiff < -30) {
      return { label: '时间未同步', diff: '请点击测活校准', diffSec: null, cls: 'badge-restricted' }
    }
    diffSec = Math.max(0, rawDiff)
  }

  if (diffSec <= 135) {
    const diffText = diffSec <= 10 ? '刚刚' : `${diffSec}秒前`
    return { label: '在线 (活跃)', diff: diffText, diffSec, cls: 'badge-ready' }
  } else if (diffSec <= 300) {
    const diffText = `${Math.floor(diffSec / 60)}分钟前`
    return { label: '延迟预警', diff: diffText, diffSec, cls: 'badge-restricted' }
  } else {
    const diffText = `${Math.floor(diffSec / 60)}分钟前`
    return { label: '离线失联', diff: diffText, diffSec, cls: 'badge-disabled' }
  }
}

const getEffectiveProbe = (node) => {
  const memPing = pingResults[node.node_id]
  if (memPing) return memPing
  const persisted = node.last_probe_info
  if (!persisted || typeof persisted !== 'object') return null
  // 若持久化测活记录是心跳/自检/隧道异常，且节点之后已恢复并收到更新的健康心跳，则忽略旧异常
  const recoverable = ['offline', 'heartbeat_lost', 'xray_unhealthy', 'tunnel_disconnected']
  if (
    persisted.healthy === false &&
    recoverable.includes(persisted.status_code) &&
    Number(node.last_heartbeat_ts || 0) > Number(persisted.ts || 0)
  ) {
    return null
  }
  return persisted
}

const getNodeHealthBadge = (node) => {
  if (node.status === 0) {
    return { label: '管理停用', text: '管理停用', cls: 'badge-disabled' }
  }
  const hb = getHeartbeatInfo(node)
  const agentHealth = parseAgentHealth(node)
  if (pingingNodeId.value === node.node_id) {
    return { text: '深度测活中...', cls: hb.cls }
  }
  const ping = getEffectiveProbe(node)
  if (ping) {
    // 若节点心跳已断连或超阈值，绝不因历史 ping 结果残留假绿灯
    if (hb.cls !== 'badge-ready' && ping.status_code === 'online') {
      return { text: hb.label, cls: hb.cls }
    }
    // 若当前心跳自检已暴露 Xray / 隧道异常，优先级高于历史在线 ping
    if (ping.status_code === 'online' && agentHealth) {
      if (agentHealth.xray_alive === false || agentHealth.port_ready === false) {
        return { text: 'Xray 进程异常', cls: 'badge-disabled' }
      }
      if (node.net_mode === 'reverse_wss' && agentHealth.tunnel_connected === false) {
        return { text: 'WSS 隧道断开', cls: 'badge-restricted' }
      }
    }

    if (ping.status_code === 'online') {
      if (ping.net_mode === 'reverse_wss') {
        return { text: '在线 (WSS反穿)', cls: 'badge-ready' }
      }
      const rttLabel = ping.tls_rtt_ms != null ? `TLS ${ping.tls_rtt_ms}ms` : `${ping.rtt_ms}ms`
      return { text: `在线 (${rttLabel})`, cls: 'badge-ready' }
    }
    if (ping.status_code === 'xray_unhealthy') {
      return { text: 'Xray 进程异常', cls: 'badge-disabled' }
    }
    if (ping.status_code === 'tls_failed') {
      return { text: 'TLS握手失败', cls: 'badge-disabled' }
    }
    if (ping.status_code === 'heartbeat_lost') {
      return { text: '心跳断连 · 端口有响应', cls: 'badge-restricted' }
    }
    if (ping.status_code === 'tunnel_disconnected') {
      return { text: 'WSS 隧道断开', cls: 'badge-restricted' }
    }
    if (ping.status_code === 'port_unreachable') {
      return { text: '心跳正常 · 端口不通', cls: 'badge-restricted' }
    }
    return { text: '离线失联', cls: 'badge-disabled' }
  }

  // 未点击测活时，也立即暴露节点心跳携带的本地 Xray / 隧道异常
  if (hb.cls === 'badge-ready' && agentHealth) {
    if (agentHealth.xray_alive === false || agentHealth.port_ready === false) {
      return { text: 'Xray 进程异常', cls: 'badge-disabled' }
    }
    if (node.net_mode === 'reverse_wss' && agentHealth.tunnel_connected === false) {
      return { text: 'WSS 隧道断开', cls: 'badge-restricted' }
    }
  }
  return { text: hb.label, cls: hb.cls }
}

const getServerNamesCount = (node) => {
  if (Array.isArray(node.server_names)) return node.server_names.length
  if (typeof node.server_names === 'string' && node.server_names.trim()) {
    return node.server_names.split(',').filter(Boolean).length
  }
  return 1
}

const getHeartbeatTooltip = (node) => {
  if (node.status === 0) return '管理已停用'
  const info = getHeartbeatInfo(node)
  const agentHealth = parseAgentHealth(node)
  const ping = getEffectiveProbe(node)

  const lines = [`最后心跳: ${node.last_heartbeat || '无记录'} (${info.diff})`]
  if (node.sub_eligible === false) {
    lines.push(`订阅状态: 已自动剔除（${node.sub_exclude_reason || '节点异常'}）`)
  } else if (node.sub_eligible === true) {
    lines.push('订阅状态: 正常收录下发')
  }
  if (agentHealth) {
    const coreLabel = node.core_type === 'singbox' ? 'Sing-box' : 'Xray'
    const xrayTxt = agentHealth.xray_alive === false ? '异常' : '正常'
    const portTxt = agentHealth.port_ready === false ? '未监听' : '正常'
    const statsTxt = agentHealth.stats_ready === false ? '异常' : '正常'
    let selfCheck = `节点自检: ${coreLabel}进程[${xrayTxt}] · 业务端口[${portTxt}] · Stats[${statsTxt}]`
    if (agentHealth.hy2_ready !== undefined && agentHealth.hy2_ready !== null) {
      selfCheck += ` · Hysteria2 UDP[${agentHealth.hy2_ready ? '正常' : '未监听'}]`
    }
    lines.push(selfCheck)
  }
  if (ping) {
    if (ping.reason) {
      lines.push(`测活结论: ${ping.reason}`)
    }
    if (ping.net_mode === 'reverse_wss') {
      lines.push(`WSS隧道: ${ping.healthy ? '在线健康' : '异常/断开'}`)
    } else if (ping.tcp_ok !== undefined && ping.tcp_ok !== null) {
      const stack = ping.network_mode ? ` [${ping.network_mode}]` : ''
      const tcpPart = ping.tcp_ok ? `TCP通(${ping.tcp_rtt_ms}ms)` : 'TCP不可达'
      const tlsPart = ping.tls_ok ? `TLS/REALITY握手正常(${ping.tls_rtt_ms}ms)` : `TLS握手失败(${ping.tls_error || '超时'})`
      lines.push(`Hub探测${stack}: ${tcpPart} | ${tlsPart}`)
    }
  }
  lines.push('提示: 点击徽标执行深度测活（端口/TLS异常修复后，再次测活通过将自动恢复订阅收录）')
  return lines.join('\n')
}

const getScopeSummary = (node) => {
  const parts = []
  if (node.allowed_groups) parts.push(`${node.allowed_groups.split(',').length}个组`)
  if (node.allowed_users) parts.push(`${node.allowed_users.split(',').length}人`)
  return parts.length ? parts.join('+') : '未指派'
}

const syncServerClock = (serverTs) => {
  lastFetchMs.value = Date.now()
  if (typeof serverTs === 'number' && serverTs > 0) {
    serverOffsetMs.value = Date.now() - serverTs * 1000
  }
}

const fetchNodes = async (silent = false) => {
  if (isFetchingNodes) return
  isFetchingNodes = true
  if (!silent) {
    nodesLoading.value = true
  }
  try {
    const res = await axios.post('/api/admin/data', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      scope: 'nodes'
    }, { timeout: 15000 })
    if (res.data.code === 200) {
      nodesLoadError.value = false
      syncServerClock(res.data.server_ts)
      localNodes.value = res.data.nodes || []
      auditLogsList.value = res.data.audit_logs || []
      if (Array.isArray(res.data.reality_presets) && res.data.reality_presets.length > 0) {
        realityPresets.value = res.data.reality_presets
      }
      if (res.data.cluster_info) {
        clusterInfo.cluster_token = res.data.cluster_info.cluster_token
        clusterInfo.tofu_enabled = res.data.cluster_info.tofu_enabled !== undefined ? res.data.cluster_info.tofu_enabled : true
        clusterInfo.auto_approve = res.data.cluster_info.auto_approve !== undefined ? res.data.cluster_info.auto_approve : true
        clusterInfo.panel_url = res.data.cluster_info.panel_url
      }
    } else if (!nodesLoaded.value) {
      nodesLoadError.value = true
    }
  } catch (_) {
    if (!nodesLoaded.value) {
      nodesLoadError.value = true
    }
    if (!silent) {
      ElMessage.error('拉取集群数据失败')
    }
  } finally {
    isFetchingNodes = false
    nodesLoading.value = false
    nodesLoaded.value = true
  }
}

const handlePingNode = async (nodeId) => {
  if (!nodeId) return
  pingingNodeId.value = nodeId
  try {
    const res = await axios.post('/api/admin/nodes/ping', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      node_id: nodeId
    })
    if (res.data.code === 200) {
      syncServerClock(res.data.server_ts)
      if (res.data.data) {
        Object.assign(pingResults, res.data.data)
      }
      if (res.data.nodes) {
        const updated = res.data.nodes.find(n => n.node_id === nodeId)
        if (updated) {
          const idx = localNodes.value.findIndex(n => n.node_id === nodeId)
          if (idx !== -1) {
            localNodes.value[idx] = updated
          }
        }
      }
      const single = res.data.data?.[nodeId]
      if (single && !single.healthy) {
        ElMessage.warning(`节点检测异常：${single.reason || '连接失败'}`)
      } else {
        ElMessage.success('深度测活通过：心跳 + TCP/TLS REALITY 握手正常')
      }
    }
  } catch (_) {
    ElMessage.error('探测请求失败')
  } finally {
    pingingNodeId.value = ''
  }
}

const handlePingAllNodes = async () => {
  pingingAll.value = true
  try {
    const res = await axios.post('/api/admin/nodes/ping', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword
    })
    if (res.data.code === 200) {
      syncServerClock(res.data.server_ts)
      if (res.data.data) {
        Object.assign(pingResults, res.data.data)
      }
      if (res.data.nodes) {
        localNodes.value = res.data.nodes
      }
      const vals = Object.values(res.data.data || {})
      const badCount = vals.filter(v => !v.healthy).length
      if (badCount > 0) {
        ElMessage.warning(`全量深度测活完成：${vals.length - badCount} 个健康，${badCount} 个异常（悬停徽标查看详情）`)
      } else {
        ElMessage.success('全量节点深度测活完成：全部健康！')
      }
    }
  } catch (_) {
    ElMessage.error('批量测活失败')
  } finally {
    pingingAll.value = false
  }
}

const startPolling = () => {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (isTabActive && (typeof document === 'undefined' || !document.hidden)) {
      fetchNodes(true)
    }
  }, 10000)
}

const stopPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

const handleVisibilityChange = () => {
  if (typeof document !== 'undefined' && !document.hidden && isTabActive) {
    fetchNodes(true)
  }
}

onMounted(() => {
  isTabActive = true
  fetchNodes()
  startPolling()
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
})

onActivated(() => {
  isTabActive = true
  startPolling()
  if (nodesLoaded.value) {
    fetchNodes(true)
  }
})

onDeactivated(() => {
  isTabActive = false
  stopPolling()
})

onUnmounted(() => {
  isTabActive = false
  stopPolling()
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
})

const handleToggleTofuEnabled = async () => {
  try {
    const res = await axios.post('/api/admin/cluster/token', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      tofu_enabled: clusterInfo.tofu_enabled
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('TOFU总开关切换失败')
  }
}

const handleToggleAutoApprove = async () => {
  try {
    const res = await axios.post('/api/admin/cluster/token', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      auto_approve: clusterInfo.auto_approve
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('准入模式切换失败')
  }
}

const handleRegenerateClusterToken = async () => {
  if (!confirm('确定轮换重置集群引导令牌吗？旧令牌将立即失效。')) return
  try {
    const res = await axios.post('/api/admin/cluster/token', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      action: 'regenerate'
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      clusterInfo.cluster_token = res.data.cluster_token
    }
  } catch (_) {
    ElMessage.error('令牌重置失败')
  }
}

const handleApproveNode = async (node) => {
  try {
    const res = await axios.post('/api/admin/nodes/approve', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      node_id: node.node_id
    })
    if (res.data.code === 200) {
      delete pingResults[node.node_id]
      ElMessage.success(res.data.msg)
      fetchNodes()
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('审批激活失败')
  }
}

const openConfigModal = (node) => {
  const sniList = parseSniList(
    Array.isArray(node.server_names) && node.server_names.length
      ? node.server_names
      : (node.server_names || node.sni || 'www.amd.com,amd.com')
  )
  const effectiveSnis = sniList.length ? sniList : ['www.amd.com', 'amd.com']
  configForm.node_id = node.node_id
  configForm.name = node.name
  configForm.ip = node.ip || ''
  configForm.port = node.port
  configForm.dest = node.dest || `${effectiveSnis[0]}:443`
  configForm.server_names = effectiveSnis.join(',')
  syncSelectedPresetKey()
  showAddSniBar.value = false
  sniVerifyResult.value = null
  configForm.sid = node.sid
  configForm.node_key = node.node_key
  configForm.core_type = node.core_type || 'xray'
  configForm.block_cn = node.block_cn === undefined ? true : Number(node.block_cn) !== 0
  configForm.hy2_enabled = Number(node.hy2_enabled || 0) === 1
  configForm.hy2_port = Number(node.hy2_port || 0) > 0 ? Number(node.hy2_port) : Number(node.port || 443)
  configForm.hy2_sni = node.hy2_sni || 'www.bing.com'
  configForm.hy2_mport = node.hy2_mport || ''
  configForm.hy2_insecure = node.hy2_insecure === undefined ? true : Number(node.hy2_insecure) !== 0
  showConfigModal.value = true
}

const submitNodeConfig = async () => {
  const snis = parseSniList(configForm.server_names)
  if (!snis.length) {
    ElMessage.warning('请填写至少一个合法的 SNI 域名（多 SNI 用逗号分隔）')
    return
  }
  configForm.server_names = snis.join(',')
  try {
    const res = await axios.post('/api/admin/nodes/save_config', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      ...configForm,
      sni: snis[0],
      server_names: snis.join(',')
    })
    if (res.data.code === 200) {
      delete pingResults[configForm.node_id]
      ElMessage.success(res.data.msg)
      showConfigModal.value = false
      fetchNodes()
      emit('reload-all')
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('保存网络配置失败')
  }
}

const openPermModal = (node) => {
  permForm.node_id = node.node_id
  permForm.name = node.name
  permForm.status = node.status !== undefined ? node.status : 1
  permForm.allow_all = node.allow_all !== undefined ? node.allow_all : 1
  permForm.allowed_groups = node.allowed_groups || ''
  permForm.allowed_users = node.allowed_users || ''
  showPermModal.value = true
}

const submitNodePermission = async () => {
  try {
    const res = await axios.post('/api/admin/nodes/save_permission', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      ...permForm
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      showPermModal.value = false
      fetchNodes()
      emit('reload-all')
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('保存权限策略失败')
  }
}

const handleForceResync = async (nodeId) => {
  if (!confirm(`确定开启对节点 [${nodeId}] 的重新接纳模式吗？`)) return
  try {
    const res = await axios.post('/api/admin/nodes/force_resync', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      node_id: nodeId
    })
    if (res.data.code === 200) {
      delete pingResults[nodeId]
      ElMessage.success(res.data.msg)
      fetchNodes()
    }
  } catch (_) {
    ElMessage.error('触发重新接纳失败')
  }
}

const handleRevokeDelete = async (nodeId) => {
  if (!confirm(`⚠️ 警告：确定要从集群中吊销并彻底删除该节点吗？`)) return
  try {
    const res = await axios.post('/api/admin/nodes/revoke_delete', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      node_id: nodeId
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      fetchNodes()
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('吊销节点失败')
  }
}
</script>

<style scoped>
/* 顶栏集群安全管理横幅 (严格还原图二) */
.cluster-security-banner {
  background: linear-gradient(145deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.8));
  border: 1px solid rgba(56, 189, 248, 0.25);
  border-radius: 8px;
  padding: 14px 18px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
}

.banner-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.token-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.cluster-token-code {
  font-family: var(--font-mono);
  font-size: 12px;
  color: #38bdf8;
  background: rgba(0, 0, 0, 0.4);
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px dashed rgba(56, 189, 248, 0.3);
}

.banner-hint {
  font-size: 11px;
  color: #94a3b8;
}

.banner-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

/* TOFU 双层开关组 (图二右侧看板) */
.tofu-switches-card {
  background: rgba(15, 23, 42, 0.8);
  border: 1px solid rgba(51, 65, 85, 0.8);
  border-radius: 6px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 320px;
}

.switch-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.sub-switch-row {
  border-top: 1px solid rgba(51, 65, 85, 0.4);
  padding-top: 6px;
}

.switch-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.lightning-icon {
  color: #fbbf24;
}

.sub-tree-prefix {
  color: #64748b;
  font-family: var(--font-mono);
}

.switch-label-text {
  color: #e2e8f0;
  font-weight: 600;
}

.switch-status-pill {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.pill-active {
  background: rgba(16, 185, 129, 0.15);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.pill-disabled {
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.pill-amber {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.pill-warning {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
}

.switch-btn-wrap {
  cursor: pointer;
}

.switch-btn-wrap input {
  display: none;
}

.switch-btn-wrap.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.switch-btn-text {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 4px;
  font-size: 11px;
  color: #94a3b8;
  transition: all 0.2s;
  user-select: none;
}

.switch-btn-text.active {
  background: rgba(16, 185, 129, 0.2);
  border-color: #10b981;
  color: #34d399;
  font-weight: 600;
}

.check-icon {
  font-weight: bold;
}

.btn-banner-action {
  appearance: none;
  -webkit-appearance: none;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 6px;
  border: 1px solid rgba(56, 189, 248, 0.4);
  background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
  color: #ffffff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  box-shadow: 0 2px 6px rgba(2, 132, 199, 0.3);
  transition: all 0.2s ease;
}
.btn-banner-action:hover {
  background: linear-gradient(135deg, #38bdf8 0%, #0284c7 100%);
  border-color: #38bdf8;
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(56, 189, 248, 0.4);
}

.btn-banner-reset {
  appearance: none;
  -webkit-appearance: none;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 6px;
  border: 1px solid rgba(245, 158, 11, 0.4);
  background: linear-gradient(135deg, #d97706 0%, #b45309 100%);
  color: #ffffff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  box-shadow: 0 2px 6px rgba(217, 119, 6, 0.3);
  transition: all 0.2s ease;
}
.btn-banner-reset:hover {
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  border-color: #f59e0b;
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(245, 158, 11, 0.4);
}

.btn-banner-deploy {
  appearance: none;
  -webkit-appearance: none;
  padding: 8px 16px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 6px;
  border: 1px solid rgba(56, 189, 248, 0.4);
  background: linear-gradient(135deg, #0284c7 0%, #1e40af 100%);
  color: #ffffff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all 0.2s ease;
  box-shadow: 0 2px 8px rgba(2, 132, 199, 0.3);
}
.btn-banner-deploy:hover {
  background: linear-gradient(135deg, #38bdf8 0%, #2563eb 100%);
  border-color: #38bdf8;
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(56, 189, 248, 0.45);
}

.btn-xs {
  appearance: none;
  -webkit-appearance: none;
  padding: 3px 8px;
  font-size: 11px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  cursor: pointer;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 600;
  transition: all 0.2s ease;
  user-select: none;
}
.btn-action {
  background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
  border-color: rgba(56, 189, 248, 0.4);
  color: #ffffff;
}
.btn-reset {
  background: linear-gradient(135deg, #d97706 0%, #b45309 100%);
  border-color: rgba(245, 158, 11, 0.4);
  color: #ffffff;
}

.modal-close-btn {
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  border: none;
  color: #94a3b8;
  font-size: 18px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: all 0.2s ease;
  line-height: 1;
}
.modal-close-btn:hover {
  color: #f87171;
  background: rgba(239, 68, 68, 0.15);
}

.btn-copy-tag {
  appearance: none;
  -webkit-appearance: none;
  background: rgba(30, 41, 59, 0.8);
  border: 1px solid rgba(56, 189, 248, 0.3);
  color: #38bdf8;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn-copy-tag:hover {
  background: rgba(56, 189, 248, 0.2);
  border-color: #38bdf8;
  color: #ffffff;
}

.badge-locked {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.3);
  font-weight: 600;
  margin-left: 6px;
}

.input-readonly {
  background: rgba(15, 23, 42, 0.7) !important;
  border-color: rgba(71, 85, 105, 0.4) !important;
  color: #94a3b8 !important;
  cursor: not-allowed !important;
  user-select: text !important;
}

.modal-readonly-hint {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 4px;
}

.docker-minimal-section {
  background: linear-gradient(135deg, rgba(15, 23, 42, 0.9) 0%, rgba(11, 17, 32, 0.95) 100%);
  border: 1px solid rgba(56, 189, 248, 0.35);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}
.docker-minimal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
  gap: 12px;
}
.docker-oneliner-code {
  background: #020617;
  border: 1px solid rgba(56, 189, 248, 0.25);
  border-radius: 8px;
  padding: 14px 16px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: #38bdf8;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}
.docker-args-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
  margin-top: 14px;
}
.docker-arg-card {
  background: rgba(30, 41, 59, 0.5);
  border: 1px solid rgba(51, 65, 85, 0.5);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 11px;
}
.docker-arg-name {
  color: #f1f5f9;
  font-weight: 600;
  font-family: var(--font-mono);
}
.docker-arg-desc {
  color: #94a3b8;
  margin-top: 2px;
}

.btn-deploy-snippet {
  padding: 8px 16px;
  font-size: 12px;
  background: #0284c7;
  color: #ffffff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 二级选项卡导航 (统一风格) */
.sub-nav-tabs {
  display: flex;
  gap: 10px;
  margin-top: 16px;
  margin-bottom: 20px;
  padding: 6px;
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(51, 65, 85, 0.5);
  border-radius: 10px;
  flex-wrap: wrap;
  align-items: center;
}

.sub-tab-btn {
  background: rgba(30, 41, 59, 0.5);
  border: 1px solid rgba(51, 65, 85, 0.6);
  color: #94a3b8;
  padding: 8px 18px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  transition: all 0.2s ease;
  line-height: 1.2;
}

.sub-tab-btn:hover {
  background: rgba(51, 65, 85, 0.6);
  border-color: rgba(148, 163, 184, 0.4);
  color: #f1f5f9;
}

.sub-tab-btn.active {
  background: linear-gradient(135deg, rgba(2, 132, 199, 0.3) 0%, rgba(14, 165, 233, 0.2) 100%);
  border-color: #38bdf8;
  color: #38bdf8;
  font-weight: 700;
  box-shadow: 0 0 12px rgba(56, 189, 248, 0.2);
}

.btn-ping-icon {
  background: rgba(14, 165, 233, 0.15);
  border: 1px solid rgba(56, 189, 248, 0.35);
  color: #38bdf8;
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}

.btn-ping-icon:hover:not(:disabled) {
  background: rgba(14, 165, 233, 0.35);
  border-color: #38bdf8;
  box-shadow: 0 0 8px rgba(56, 189, 248, 0.3);
  transform: translateY(-1px);
}

.btn-ping-icon:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 交互式心跳徽标 (点击立即测活，悬停发光) */
.clickable-heartbeat {
  cursor: pointer;
  user-select: none;
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 11px;
  border-radius: 9999px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid transparent;
}

.clickable-heartbeat:hover:not(.badge-disabled) {
  transform: translateY(-1px);
  box-shadow: 0 0 10px rgba(56, 189, 248, 0.35);
  border-color: #38bdf8;
  filter: brightness(1.15);
}

.clickable-heartbeat:active:not(.badge-disabled) {
  transform: translateY(0);
}

.clickable-heartbeat.is-pinging {
  opacity: 0.8;
  cursor: wait;
}

.sub-count-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: bold;
}

.badge-amber {
  background: #f59e0b;
  color: #0f172a;
}

.badge-slate {
  background: #334155;
  color: #f8fafc;
}

.header-right-note {
  font-size: 12px;
  color: #94a3b8;
}

/* 网络模式徽章 */
.net-mode-pill {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.pill-direct {
  background: rgba(14, 165, 233, 0.15);
  color: #38bdf8;
  border: 1px solid rgba(14, 165, 233, 0.3);
}

.pill-wss {
  background: rgba(168, 85, 247, 0.15);
  color: #c084fc;
  border: 1px solid rgba(168, 85, 247, 0.3);
}

/* 待审隔离区提示框 */
.quarantine-alert-box {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 8px;
  padding: 14px 18px;
  margin-top: 14px;
}

.quarantine-alert-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.alert-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quarantine-desc {
  font-size: 12px;
  color: #cbd5e1;
  margin: 8px 0 0 0;
  line-height: 1.6;
}

.deploy-tab-box {
  background: #0b1120;
  border: 1px solid #1e293b;
  border-radius: 8px;
  padding: 18px;
  margin-top: 14px;
}

/* 待审隔离区行高亮 */
.node-quarantine-row {
  background: rgba(245, 158, 11, 0.05);
  border-left: 3px solid #f59e0b;
}

.node-disabled-row {
  opacity: 0.6;
}

.badge-quarantine {
  background: rgba(245, 158, 11, 0.2);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.4);
}

.badge-approved {
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.btn-approve {
  background: linear-gradient(135deg, #10b981, #059669);
  color: white;
  border: none;
  font-weight: 700;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.4);
}

.code-editor-box {
  background: #090d16;
  border: 1px solid #1e293b;
  border-radius: 6px;
  padding: 12px;
  max-height: 280px;
  overflow-y: auto;
}

.yaml-code-view {
  font-family: var(--font-mono);
  font-size: 12px;
  color: #38bdf8;
  margin: 0;
  white-space: pre;
}

.badge-disabled {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.badge-public {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.badge-restricted {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.btn-perm {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.4);
}
.btn-perm:hover {
  background: rgba(245, 158, 11, 0.3);
}

.pbk-box {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.pbk-clean-text {
  font-family: var(--font-mono);
  font-size: 11px;
  color: #38bdf8;
  background: transparent !important;
  border: none !important;
  padding: 0;
}

.btn-copy-icon {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 13px;
  padding: 0 2px;
  opacity: 0.75;
  transition: opacity 0.2s, transform 0.2s;
}
.btn-copy-icon:hover {
  opacity: 1;
  transform: scale(1.2);
}

.heartbeat-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
  width: fit-content;
  cursor: pointer;
  white-space: nowrap;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}

.permission-sub-box {
  background: #090d16;
  border: 1px solid #1e293b;
  border-radius: 6px;
  padding: 12px;
  margin-top: 10px;
}

.pill-singbox {
  background: rgba(168, 85, 247, 0.16);
  color: #c084fc;
  border: 1px solid rgba(168, 85, 247, 0.35);
}

.pill-hy2 {
  background: rgba(6, 182, 212, 0.15);
  color: #22d3ee;
  border: 1px solid rgba(6, 182, 212, 0.35);
}

.deploy-core-switcher {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: rgba(15, 23, 42, 0.8);
  border: 1px solid rgba(56, 189, 248, 0.25);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
}

.core-switch-btn {
  background: rgba(30, 41, 59, 0.85);
  color: #94a3b8;
  border: 1px solid rgba(71, 85, 105, 0.6);
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.core-switch-btn.active {
  background: rgba(56, 189, 248, 0.2);
  color: #38bdf8;
  border-color: rgba(56, 189, 248, 0.65);
}

.core-switch-btn.core-switch-singbox.active {
  background: rgba(168, 85, 247, 0.22);
  color: #d8b4fe;
  border-color: rgba(168, 85, 247, 0.7);
}

.deploy-core-hint {
  font-size: 11px;
  color: #94a3b8;
}

.hy2-config-box {
  background: rgba(88, 28, 135, 0.14);
  border: 1px solid rgba(168, 85, 247, 0.3);
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 12px;
}

.cn-policy-box {
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.28);
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 12px;
}

.reality-preset-box {
  background: rgba(14, 116, 144, 0.1);
  border: 1px solid rgba(56, 189, 248, 0.25);
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 12px;
}

.sni-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.sni-select-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sni-select-box {
  flex: 1;
  min-width: 0;
  background: #0f172a;
  border: 1px solid rgba(56, 189, 248, 0.4);
  color: #f1f5f9;
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 12px;
  font-family: var(--font-mono);
  outline: none;
  cursor: pointer;
}
.sni-select-box:focus {
  border-color: #38bdf8;
  box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.18);
}

.btn-sni-mini,
.btn-sni-verify,
.btn-sni-del,
.btn-sni-add-confirm {
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}

.btn-sni-mini {
  background: rgba(56, 189, 248, 0.14);
  color: #7dd3fc;
  border: 1px solid rgba(56, 189, 248, 0.4);
  padding: 3px 9px;
}
.btn-sni-mini:hover:not(:disabled),
.btn-sni-mini.active {
  background: rgba(56, 189, 248, 0.28);
  color: #e0f2fe;
}

.btn-sni-verify {
  background: rgba(16, 185, 129, 0.16);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.45);
  padding: 6px 10px;
}
.btn-sni-verify:hover:not(:disabled) {
  background: rgba(16, 185, 129, 0.28);
  color: #ecfdf5;
}

.btn-sni-del {
  background: rgba(239, 68, 68, 0.14);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.4);
  padding: 6px 9px;
}
.btn-sni-del:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.28);
  color: #fef2f2;
}

.btn-sni-add-confirm {
  background: rgba(2, 132, 199, 0.85);
  color: #ffffff;
  border: 1px solid #38bdf8;
  padding: 5px 10px;
}
.btn-sni-add-confirm:hover:not(:disabled) {
  background: #0284c7;
}

.btn-sni-mini:disabled,
.btn-sni-verify:disabled,
.btn-sni-del:disabled,
.btn-sni-add-confirm:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.sni-add-bar {
  margin-top: 8px;
  padding: 8px;
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.72);
  border: 1px dashed rgba(56, 189, 248, 0.35);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sni-add-inputs {
  display: flex;
  gap: 6px;
}
.sni-add-input {
  flex: 1.5;
  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
  padding: 6px 10px !important;
  font-size: 12px !important;
}
.sni-add-note {
  flex: 1;
  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
  padding: 6px 10px !important;
  font-size: 12px !important;
}

.sni-add-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.sni-verify-banner {
  margin-top: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.5;
}
.sni-verify-banner.verify-excellent {
  background: rgba(16, 185, 129, 0.14);
  border: 1px solid rgba(16, 185, 129, 0.4);
  color: #a7f3d0;
}
.sni-verify-banner.verify-warn,
.sni-verify-banner.verify-local {
  background: rgba(245, 158, 11, 0.14);
  border: 1px solid rgba(245, 158, 11, 0.4);
  color: #fde68a;
}
.sni-verify-banner.verify-invalid {
  background: rgba(239, 68, 68, 0.14);
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: #fecaca;
}

.verify-top-line {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}
.verify-close-btn {
  background: transparent;
  border: none;
  color: inherit;
  opacity: 0.7;
  cursor: pointer;
  padding: 0 3px;
  font-size: 12px;
}
.verify-close-btn:hover {
  opacity: 1;
}
.verify-meta-line {
  margin-top: 2px;
  opacity: 0.85;
  font-family: var(--font-mono);
  font-size: 10px;
}
.verify-warn-list {
  margin-top: 3px;
  opacity: 0.92;
}

.verify-item-list {
  margin-top: 5px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 120px;
  overflow-y: auto;
}

.verify-item-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.45);
  font-size: 10.5px;
}
.verify-item-row.item-excellent {
  color: #a7f3d0;
}
.verify-item-row.item-warn {
  color: #fde68a;
}
.verify-item-row.item-invalid {
  color: #fca5a5;
}
.verify-item-detail {
  opacity: 0.88;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-sni-prune {
  background: rgba(245, 158, 11, 0.2);
  color: #fde68a;
  border: 1px solid rgba(245, 158, 11, 0.48);
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 10.5px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.btn-sni-prune:hover {
  background: rgba(245, 158, 11, 0.34);
}

.sni-count-tag {
  font-size: 10.5px;
  color: #7dd3fc;
  font-family: var(--font-mono);
}

.sni-dest-row {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}

.preset-hint {
  margin-top: 7px;
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.45;
}
.preset-hint code {
  color: #7dd3fc;
  background: rgba(15, 23, 42, 0.7);
  padding: 1px 4px;
  border-radius: 3px;
}

.pill-block-cn {
  background: rgba(16, 185, 129, 0.14);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.32);
}

.pill-allow-cn {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.35);
}
</style>