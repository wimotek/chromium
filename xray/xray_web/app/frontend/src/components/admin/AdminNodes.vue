<template>
  <div class="cyber-card tab-content-card">
    <div class="card-header">
      <h3>🌐 已接入的远程 xray_core 节点集群</h3>
      <button class="btn-cyber-refresh" @click="$emit('reload-all')">🔄 刷新节点</button>
    </div>

    <div class="table-container">
      <table class="cyber-table">
        <thead>
          <tr>
            <th>节点别名</th>
            <th>连接地址与端口</th>
            <th>伪装域名列表 (ServerNames)</th>
            <th>通信凭证 (NODE_KEY)</th>
            <th>REALITY 公钥 (PBK)</th>
            <th style="white-space: nowrap;">心跳在线状态</th>
            <th>集群操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="n in adminNodes" :key="n.id">
            <td><b>{{ n.name }}</b></td>
            <td style="white-space: nowrap; font-family: monospace;">{{ n.ip }}:{{ n.port }}</td>
            <td style="font-size: 11px; color: #94a3b8; max-width: 220px; word-break: break-all;">
              {{ n.server_names || n.sni }}
            </td>
            <td class="font-mono text-cyan" style="font-size: 11px; white-space: nowrap;">
              {{ n.node_key ? n.node_key.substring(0, 8) + '...' : '未设置' }}
              <button class="btn-link-action" style="margin-left: 4px;" @click="$emit('copy', n.node_key)">复制</button>
            </td>
            <td class="font-mono text-green" style="font-size: 11px; white-space: nowrap;">
              {{ n.pbk ? n.pbk.substring(0, 10) + '...' : '等待回传' }}
              <button v-if="n.pbk" class="btn-link-action" style="margin-left: 4px;" @click="$emit('copy', n.pbk)">复制</button>
            </td>

            <!-- 核心优化：动态智能状态灯系统 -->
            <td class="status-cell-nowrap">
              <span v-if="n.status === 0 || (n.last_heartbeat && n.last_heartbeat.includes('下线'))" class="badge badge-used">
                🔴 已下线
              </span>
              <span v-else-if="!n.pbk || (n.last_heartbeat && n.last_heartbeat.includes('等待'))" class="badge badge-monthly">
                🟡 等待回传
              </span>
              <span v-else-if="isHeartbeatExpired(n.last_heartbeat)" class="badge badge-used">
                🔴 离线 (心跳超时)
              </span>
              <span v-else class="badge badge-ready">
                🟢 在线
              </span>
              <div class="time-sub-text">{{ n.last_heartbeat }}</div>
            </td>

            <td>
              <div class="action-btn-row">
                <button class="btn-sm btn-edit" @click="openNodeConfig(n)">✏️ 配置</button>
                <button class="btn-sm btn-action" @click="forceResyncNode(n.node_id)">🔄 重置上报</button>
                <button class="btn-sm btn-del" @click="revokeDeleteNode(n.node_id)">🗑️ 吊销删除</button>
              </div>
            </td>
          </tr>
          <tr v-if="adminNodes.length === 0">
            <td colspan="7" style="text-align: center; color: #64748b; padding: 25px;">
              暂无远程节点接入，请在任意海外服务器执行下方指令拉起 xray_core 节点容器。
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 远程海外 VPS 接入指令 (纯净无引号) -->
    <div class="panel-card" style="margin-top: 25px;">
      <h4 style="margin: 0 0 10px 0; color: #38bdf8;">🖥️ 远程海外 VPS 一键接入指令 (HTTPS 模式)</h4>
      <p class="card-desc">节点秒级上线，自动推导并向本面板回传真实公钥与网络参数：</p>
      <div class="node-field">
        <div class="code-display text-cyan">
          docker run -d --name xray-node --network host --restart always -e PANEL_URL=https://{{ publicMasterHost }}:3000 -v $(pwd)/data:/data wimotek/xray:core
        </div>
      </div>
      <button class="btn-sm btn-action" @click="$emit('copy', `docker run -d --name xray-node --network host --restart always -e PANEL_URL=https://${publicMasterHost}:3000 -v $(pwd)/data:/data wimotek/xray:core`)">
        📋 复制接入命令
      </button>
    </div>

    <!-- 弹窗：管理员在线配置节点全部参数 -->
    <div v-if="showNodeConfigModal" class="modal-backdrop" @click="showNodeConfigModal = false">
      <div class="cyber-modal" style="max-width: 520px; text-align: left;" @click.stop>
        <h3>✏️ 调整节点配置 (双向自动同步)</h3>
        <p class="modal-tip">修改后，用户订阅与海外节点将在下次轮询时自动同步热更：</p>

        <div class="form-item">
          <label>节点别名 (Name)</label>
          <input v-model="nodeEditForm.name" class="cyber-input modal-input" placeholder="例如: 🇭🇰 香港 01 - 极速专线" />
        </div>

        <div class="form-row-2">
          <div class="form-item">
            <label>连接地址 (IP 或专属解析域名)</label>
            <input v-model="nodeEditForm.ip" class="cyber-input modal-input" placeholder="例如: 140.x.x.x 或 hk.node.com" />
          </div>
          <div class="form-item">
            <label>监听端口 (Port)</label>
            <input v-model.number="nodeEditForm.port" type="number" class="cyber-input modal-input" placeholder="443" />
          </div>
        </div>

        <div class="form-item">
          <label>伪装回落目标 (Dest)</label>
          <input v-model="nodeEditForm.dest" class="cyber-input modal-input" placeholder="itunes.apple.com:443" />
        </div>

        <div class="form-item">
          <label>伪装域名列表 (ServerNames / 逗号分隔多域名)：</label>
          <input v-model="nodeEditForm.server_names" class="cyber-input modal-input font-mono" placeholder="itunes.apple.com,swdist.apple.com,apps.apple.com" />
          <span class="input-hint">可配置多个备选伪装域名（逗号分隔）。前台用户可自由下拉切换，默认随机分配</span>
        </div>

        <div class="form-row-2">
          <div class="form-item">
            <label>ShortId (sid)</label>
            <input v-model="nodeEditForm.sid" class="cyber-input modal-input" placeholder="8位16进制" />
          </div>
          <div class="form-item">
            <label>节点状态</label>
            <label class="radio-label" style="margin-top: 10px;">
              <input type="checkbox" v-model="nodeEditForm.status" /> 节点对全站公开发布
            </label>
          </div>
        </div>

        <div class="form-item">
          <label>节点通信密钥 (NODE_KEY)</label>
          <div style="display: flex; gap: 8px;">
            <input v-model="nodeEditForm.node_key" class="cyber-input modal-input font-mono" placeholder="集群通信密钥" />
            <button class="btn-sm btn-action" style="white-space: nowrap;" @click="generateNewNodeKey">🎲 随机生成</button>
          </div>
          <span class="input-hint">点击保存后新密钥将自动下发给远程节点并热更本地文件</span>
        </div>

        <div class="btn-group" style="justify-content: flex-end; margin-top: 15px;">
          <button class="btn-cyber-action" @click="showNodeConfigModal = false">取消</button>
          <button class="btn-cyber-success" @click="saveNodeFullConfig">保存并同步</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const props = defineProps({
  adminNodes: { type: Array, default: () => [] },
  currentUser: { type: Object, required: true },
  adminPassword: { type: String, required: true }
})

const emit = defineEmits(['copy', 'reload-all'])

const showNodeConfigModal = ref(false)
const nodeEditForm = reactive({ node_id: '', name: '', ip: '', port: 443, dest: '', sni: '', server_names: '', sid: '', node_key: '', status: true })

const publicMasterHost = computed(() => window.location.hostname)

// 智能判定心跳是否超时 (超过 120 秒未上报)
const isHeartbeatExpired = (hbStr) => {
  if (!hbStr || hbStr.includes('等待') || hbStr.includes('下线')) return false
  try {
    const hbTime = new Date(hbStr.replace(/-/g, '/')).getTime()
    const now = new Date().getTime()
    return (now - hbTime) > 120 * 1000
  } catch (_) {
    return false
  }
}

const openNodeConfig = (node) => {
  nodeEditForm.node_id = node.node_id
  nodeEditForm.name = node.name
  nodeEditForm.ip = node.ip
  nodeEditForm.port = node.port
  nodeEditForm.dest = node.dest || 'itunes.apple.com:443'
  nodeEditForm.sni = node.sni || 'itunes.apple.com'
  nodeEditForm.server_names = node.server_names || node.sni || ''
  nodeEditForm.sid = node.sid
  nodeEditForm.node_key = node.node_key
  nodeEditForm.status = node.status === 1
  showNodeConfigModal.value = true
}

const generateNewNodeKey = () => {
  const chars = '0123456789abcdef'
  let key = ''
  for (let i = 0; i < 32; i++) key += chars.charAt(Math.floor(Math.random() * chars.length))
  nodeEditForm.node_key = key
  ElMessage.success('已随机生成新密钥，点击【保存并同步】后生效')
}

const saveNodeFullConfig = async () => {
  try {
    const res = await axios.post('/api/admin/nodes/save_config', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      ...nodeEditForm,
      status: nodeEditForm.status ? 1 : 0
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      showNodeConfigModal.value = false
      emit('reload-all')
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('保存节点配置失败')
  }
}

const forceResyncNode = async (nodeId) => {
  try {
    const res = await axios.post('/api/admin/nodes/force_resync', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      node_id: nodeId
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('重置上报失败')
  }
}

const revokeDeleteNode = async (nodeId) => {
  const tip =
    `⚠️ 确定要彻底吊销并删除该节点吗？\n\n` +
    `【生效后果】主控将彻底注销该节点并拒绝其后续心跳，该节点不会再自动冒出。\n\n` +
    `【远程 VPS 重新接入方法】\n` +
    `若日后需要让该 VPS 重新接入，只需在远程机执行：\n` +
    `rm -f data/node_id.txt data/node_key.txt && docker restart xray-node\n\n` +
    `是否确认吊销？`

  if (!confirm(tip)) return
  try {
    const res = await axios.post('/api/admin/nodes/revoke_delete', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      node_id: nodeId
    })
    if (res.data.code === 200) {
      ElMessage.success('节点已成功吊销并移除！')
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('吊销删除失败')
  }
}
</script>