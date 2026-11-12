<template>
  <div class="cyber-card tab-content-card">
    <!-- 顶部操作条 -->
    <div class="card-header" style="margin-bottom: 16px;">
      <div>
        <h3>⚙️ 系统通告、推荐返利、数据库自动备份与全局运维</h3>
        <p class="card-desc">全站服务通告、新用户推荐奖励配置、自动化数据库热备份与灾难恢复、HTTPS 凭据状态中枢。</p>
      </div>
      <button class="btn-cyber-success" @click="saveAllSettings">💾 保存全局配置</button>
    </div>

    <!-- 子卡片选项卡导航 -->
    <div class="sub-tab-nav">
      <button
        class="sub-tab-btn"
        :class="{ active: settingsSubTab === 'backup' }"
        @click="settingsSubTab = 'backup'"
      >
        🗄️ 数据库自动备份与灾难恢复
        <span class="badge-count">{{ backupList.length }}份快照</span>
      </button>
      <button
        class="sub-tab-btn"
        :class="{ active: settingsSubTab === 'system' }"
        @click="settingsSubTab = 'system'"
      >
        📢 系统通告与新用户配额
      </button>
      <button
        class="sub-tab-btn"
        :class="{ active: settingsSubTab === 'referral' }"
        @click="settingsSubTab = 'referral'"
      >
        🎁 新用户注册推荐奖励
      </button>
      <button
        class="sub-tab-btn"
        :class="{ active: settingsSubTab === 'notify' }"
        @click="settingsSubTab = 'notify'"
      >
        📧 发信服务与通知推送中枢
      </button>
      <button
        class="sub-tab-btn"
        :class="{ active: settingsSubTab === 'cert' }"
        @click="settingsSubTab = 'cert'"
      >
        🔐 HTTPS 证书与安全凭据
      </button>
    </div>

    <!-- ==================== 子卡 1：数据库自动备份与灾难恢复 ==================== -->
    <div v-if="settingsSubTab === 'backup'" class="sub-tab-pane">
      <div class="space-y-4">
        <!-- 策略设置面板 -->
        <div class="panel-card">
          <div class="panel-card-header">
            <div class="panel-title-wrap">
              <span class="panel-icon">⚡</span>
              <div>
                <strong class="panel-title">SQLite 数据库自动化热备份策略与配额限制</strong>
                <div class="panel-sub">基于 SQLite 原生 WAL 联机热备份机制，零锁表、零卡顿、原子级防损</div>
              </div>
            </div>
            <label class="radio-label" style="margin: 0;">
              <input type="checkbox" v-model="settingsForm.auto_backup_enabled" @change="saveAllSettings" />
              <span :style="{ color: settingsForm.auto_backup_enabled ? '#10b981' : '#ef4444' }">
                {{ settingsForm.auto_backup_enabled ? '🟢 定期自动备份开启' : '🔴 自动备份已暂停' }}
              </span>
            </label>
          </div>

          <div class="strategy-grid">
            <div class="strategy-box">
              <label>⏱️ 定期自动备份频次周期：</label>
              <select v-model.number="settingsForm.backup_interval_hours" class="cyber-input" style="width: 100%;">
                <option :value="6">每 6 小时自动备份一次</option>
                <option :value="12">每 12 小时自动备份一次</option>
                <option :value="24">每 24 小时 (每天) 自动备份一次 (推荐)</option>
                <option :value="48">每 48 小时 (每两天) 自动备份一次</option>
                <option :value="168">每 7 天 (每周) 自动备份一次</option>
              </select>
              <span class="input-hint">由 Leader 进程全局定时器托管执行。</span>
            </div>

            <div class="strategy-box">
              <label>📦 备份数量限定 (保留最大份数)：</label>
              <div class="input-with-addon" style="width: 100%;">
                <input v-model.number="settingsForm.backup_max_count" type="number" min="1" max="50" class="cyber-input" />
                <span class="addon-text">份快照</span>
              </div>
              <span class="input-hint">超额将按时间先进先出自动轮替清理旧备份，避免撑爆磁盘。</span>
            </div>

            <div class="strategy-box">
              <label>📅 上次备份执行时间：</label>
              <div class="time-display font-mono">{{ settingsForm.last_backup_time || '尚未执行' }}</div>
              <span class="input-hint">存储目录: <code>/data/backups/</code></span>
            </div>
          </div>

          <div class="backup-actions-bar">
            <button class="btn-cyber-primary" @click="saveAllSettings">💾 保存备份策略</button>
            <div style="display: flex; gap: 10px;">
              <input type="file" ref="fileUploadRef" accept=".db,.sqlite" style="display: none;" @change="handleUploadDbFile" />
              <button class="btn-cyber-action" :disabled="uploadingBackup" @click="$refs.fileUploadRef.click()">
                {{ uploadingBackup ? '正在上传...' : '📤 上传外部 .db 文件导入' }}
              </button>
              <button class="btn-cyber-success" :disabled="creatingBackup" @click="handleCreateBackupNow">
                {{ creatingBackup ? '正在生成快照...' : '⚡ 立即创建热备份快照' }}
              </button>
            </div>
          </div>
        </div>

        <!-- 历史快照版本表格 -->
        <div class="panel-card">
          <div class="panel-card-header">
            <div class="panel-title-wrap">
              <span class="panel-icon">🗃️</span>
              <div>
                <strong class="panel-title">历史备份版本与灾难恢复控制台</strong>
                <div class="panel-sub">当前共 {{ backupList.length }} 份快照 (限定保留上限: {{ settingsForm.backup_max_count }} 份)</div>
              </div>
            </div>
            <button class="btn-sm btn-action" @click="loadBackups">🔄 刷新列表</button>
          </div>

          <div class="table-responsive" style="margin-top: 10px;">
            <table class="cyber-table">
              <thead>
                <tr>
                  <th>备份快照文件名</th>
                  <th>类型</th>
                  <th>大小</th>
                  <th>生成时间</th>
                  <th style="text-align: right; padding-right: 20px; width: 270px;">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="backupList.length === 0">
                  <td colSpan="5" style="text-align: center; padding: 30px; color: #64748b;">
                    暂无历史备份，请点击上方「立即创建热备份快照」
                  </td>
                </tr>
                <tr v-for="item in backupList" :key="item.filename">
                  <td>
                    <span style="font-family: monospace; font-size: 12px; font-weight: 600; color: #e2e8f0;">
                      {{ item.filename }}
                    </span>
                  </td>
                  <td>
                    <span v-if="item.filename.includes('_auto')" class="tag-badge tag-blue">🤖 定时自动</span>
                    <span v-else-if="item.filename.includes('_uploaded')" class="tag-badge tag-purple">📤 外部导入</span>
                    <span v-else class="tag-badge tag-green">👤 手动即时</span>
                  </td>
                  <td class="font-mono text-xs">{{ item.size_human }}</td>
                  <td class="font-mono text-xs text-muted">{{ item.created_at }}</td>
                  <td style="text-align: right; padding-right: 20px;">
                    <div class="backup-btn-group">
                      <button class="btn-backup-action btn-backup-download" title="下载备份快照到本地" @click="handleDownloadBackup(item.filename)">📥 下载</button>
                      <button class="btn-backup-action btn-backup-restore" title="一键安全恢复整个数据库" @click="openRestoreModal(item.filename)">🔄 一键恢复</button>
                      <button class="btn-backup-action btn-backup-delete" title="永久删除此备份快照" @click="handleDeleteBackup(item.filename)">🗑️ 删除</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="backup-tips-box">
            <strong style="color: #fbbf24; display: block; margin-bottom: 4px;">🛡️ 数据库安全恢复机制说明：</strong>
            <div>• <b>执行恢复前自动冷备：</b>系统在执行任何快照还原前，会自动将当前运行数据库备份为 <code>xray_web.db.pre_restore_safety_bak</code>，保障误操作可即刻回滚。</div>
            <div>• <b>临时碎片清理与完整性自检：</b>还原期间自动清理 <code>-wal</code> 与 <code>-shm</code> 缓存碎片，并在替换后自动执行 SQLite <code>PRAGMA integrity_check</code>，确保数据零损坏！</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 子卡 2：系统通告与新用户配额 ==================== -->
    <div v-else-if="settingsSubTab === 'system'" class="sub-tab-pane">
      <div class="settings-2col-layout">
        <div class="column-stack">
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">📢</span>
                <div>
                  <strong class="panel-title">前台登录页系统运行通告</strong>
                  <div class="panel-sub">登录/注册卡片顶部展示公告（留空则前台自动隐身）</div>
                </div>
              </div>
            </div>

            <!-- 推荐营销快速导入 -->
            <div class="referral-quick-bar">
              <div style="font-size: 12px; color: #c084fc;">
                <b>🎁 推荐营销快捷操作：</b> 可一键将新用户推荐送流量政策生成并填入公告。
              </div>
              <button class="btn-xs btn-action" style="background: linear-gradient(135deg, #9333ea 0%, #7e22ce 100%); border-color: #a855f7; white-space: nowrap;" @click="publishReferralNotice">
                📢 一键同步推荐奖励到公告
              </button>
            </div>

            <div class="form-item">
              <label>公告正文（支持多行换行）：</label>
              <textarea v-model="settingsForm.system_notice" rows="6" class="cyber-input cyber-textarea" placeholder="例如：欢迎加入！全节点已完成升级，高速晚高峰不卡顿..."></textarea>
              <span class="input-hint">保存后，前台用户打开登录卡片顶部将即时看到此公告。</span>
            </div>

            <div class="form-row-2" style="margin-top: 15px;">
              <div class="form-item">
                <label>新注册默认赠送流量 (MB)</label>
                <input v-model.number="settingsForm.reg_traffic_mb" type="number" class="cyber-input" placeholder="1024" />
                <span class="input-hint">填 0 为不赠送</span>
              </div>
              <div class="form-item">
                <label>新注册默认有效天数 (天)</label>
                <input v-model.number="settingsForm.reg_expire_days" type="number" class="cyber-input" placeholder="1" />
                <span class="input-hint">填 36500 为永久</span>
              </div>
            </div>

            <button class="btn-cyber-primary" style="margin-top: 10px;" @click="saveAllSettings">💾 保存公告与新用户配额</button>
          </div>
        </div>

        <div class="column-stack">
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">👁️</span>
                <div>
                  <strong class="panel-title">登录页前台公告实时预览效果</strong>
                  <div class="panel-sub">用户在访问登录认证页时的实际视觉呈现</div>
                </div>
              </div>
            </div>
            <div class="preview-box">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span class="tag-badge tag-blue">SYSTEM BROADCAST</span>
                <span style="font-size: 12px; font-weight: 600; color: #f1f5f9;">📢 全局服务运行通告</span>
              </div>
              <div class="preview-content font-mono">{{ settingsForm.system_notice || '（暂无公告，前台将仅展示登录凭据表单）' }}</div>
              <div style="font-size: 11px; color: #64748b;">⚡ 节点由自动化集群全天候巡检，若遇连接波动请关注此栏。</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 子卡 3：新用户注册推荐奖励体系 ==================== -->
    <div v-else-if="settingsSubTab === 'referral'" class="sub-tab-pane">
      <div class="settings-2col-layout">
        <div class="column-stack">
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">🎁</span>
                <div>
                  <strong class="panel-title">双向推荐返利参数配置</strong>
                  <div class="panel-sub">新老用户双向赠送高速流量与延长账号有效期</div>
                </div>
              </div>
              <label class="radio-label" style="margin: 0;">
                <input type="checkbox" v-model="settingsForm.referral_enabled" />
                <span :style="{ color: settingsForm.referral_enabled ? '#10b981' : '#ef4444' }">
                  {{ settingsForm.referral_enabled ? '🟢 奖励已启用' : '🔴 奖励已停用' }}
                </span>
              </label>
            </div>

            <div class="inner-divider">
              <div class="inner-divider-title">👤 老用户 (邀请人) 获赠奖励</div>
              <div class="form-row-2">
                <div class="form-item">
                  <label>每邀 1 人赠送流量 (GB)</label>
                  <input v-model.number="settingsForm.referral_inviter_traffic_gb" type="number" class="cyber-input" placeholder="10" />
                </div>
                <div class="form-item">
                  <label>账户有效期延长 (天)</label>
                  <input v-model.number="settingsForm.referral_inviter_days" type="number" class="cyber-input" placeholder="30" />
                </div>
              </div>
            </div>

            <div class="inner-divider">
              <div class="inner-divider-title">🎉 新用户 (被邀请人) 获赠奖励</div>
              <div class="form-row-2">
                <div class="form-item">
                  <label>额外加赠新人礼包流量 (GB)</label>
                  <input v-model.number="settingsForm.referral_invitee_traffic_gb" type="number" class="cyber-input" placeholder="5" />
                </div>
                <div class="form-item">
                  <label>额外加赠有效天数 (天)</label>
                  <input v-model.number="settingsForm.referral_invitee_days" type="number" class="cyber-input" placeholder="30" />
                </div>
              </div>
            </div>

            <div class="inner-divider">
              <div class="inner-divider-title">🛡️ 防刷风控与上限</div>
              <div class="form-item">
                <label>单用户最大邀请奖励次数上限</label>
                <input v-model.number="settingsForm.referral_max_per_user" type="number" class="cyber-input" placeholder="50" />
                <span class="input-hint">达到上限后，邀请新用户不再继续累积奖励，杜绝恶意注册滥用。</span>
              </div>
            </div>

            <div style="display: flex; gap: 10px; margin-top: 15px;">
              <button class="btn-cyber-primary" @click="saveAllSettings">💾 保存推荐奖励参数</button>
              <button class="btn-cyber-action" style="background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%); color: #fff; border-color: #8b5cf6;" @click="publishReferralNotice">
                📢 一键同步至系统公告
              </button>
            </div>
          </div>
        </div>

        <div class="column-stack">
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">📢</span>
                <div>
                  <strong class="panel-title">生成的营销公告效果与前台通知</strong>
                  <div class="panel-sub">根据当前设置格式化并即时发布至登录页及用户端公告</div>
                </div>
              </div>
            </div>

            <div class="form-item">
              <label>公告文案预览 (自动同步当前奖励数值)：</label>
              <textarea :value="generatedReferralNotice" rows="8" readonly class="cyber-input cyber-textarea font-mono" style="background: rgba(15, 23, 42, 0.6); color: #38bdf8;"></textarea>
            </div>

            <button class="btn-cyber-primary" style="width: 100%; padding: 10px 18px; margin-top: 10px;" @click="publishReferralNotice">
              🚀 确认并立即将上方内容发布到系统公告
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 子卡 4：发信服务与通知推送中枢 ==================== -->
    <div v-else-if="settingsSubTab === 'notify'" class="sub-tab-pane">
      <div class="settings-2col-layout">
        <!-- 左列：用户群发中枢 + 管理员自身告警 -->
        <div class="column-stack">
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">📢</span>
                <div>
                  <strong class="panel-title">用户通知与消息群发中枢</strong>
                  <div class="panel-sub">按用户个人偏好自动路由投递 (邮件 / 微信服务号)</div>
                </div>
              </div>
            </div>

            <div class="form-item">
              <label>推送范围选择：</label>
              <div class="radio-group" style="flex-direction: row; gap: 20px;">
                <label class="radio-label">
                  <input type="radio" value="all" v-model="notifyPushForm.target" /> 👥 广播给全站有效用户
                </label>
                <label class="radio-label">
                  <input type="radio" value="single" v-model="notifyPushForm.target" /> 👤 定向发送给指定用户
                </label>
              </div>
            </div>

            <div class="form-item" v-if="notifyPushForm.target === 'single'">
              <label>目标接收用户名：</label>
              <input v-model="notifyPushForm.target_user" type="text" class="cyber-input" placeholder="输入要接收通知的用户名" />
            </div>

            <div class="form-item">
              <label>通知标题 (Title)：</label>
              <input v-model="notifyPushForm.title" type="text" class="cyber-input" placeholder="例如: 节点紧急维护通知 / 优惠活动" />
            </div>

            <div class="form-item">
              <label>通知正文内容 (Content)：</label>
              <textarea v-model="notifyPushForm.content" rows="4" class="cyber-input cyber-textarea" placeholder="输入通知详细内容，支持多行换行..."></textarea>
            </div>

            <button class="btn-cyber-primary" :disabled="sendingPush" style="width: auto; padding: 9px 24px;" @click="sendUserPushNotification">
              {{ sendingPush ? '正在派发通知任务...' : '🚀 立即投递通知' }}
            </button>
          </div>

          <!-- 管理员安全认证与通道 -->
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">👤</span>
                <div>
                  <strong class="panel-title">管理员自身通知通道、换绑与改密</strong>
                  <div class="panel-sub">管理员接收系统告警通道与安全认证</div>
                </div>
              </div>
            </div>

            <div class="form-item">
              <label>告警通道选择</label>
              <div class="radio-group">
                <label class="radio-label"><input type="radio" value="email" v-model="notifyForm.notify_type" /> 📧 电子邮箱接收</label>
                <label class="radio-label"><input type="radio" value="serverchan" v-model="notifyForm.notify_type" /> 📲 Server酱 (微信推送)</label>
              </div>
            </div>
            <div class="form-item" v-if="notifyForm.notify_type === 'serverchan'">
              <label>Server酱 SendKey：</label>
              <input v-model="notifyForm.serverchan_key" type="text" class="cyber-input font-mono" placeholder="SCTxxxxxxxxxx" />
            </div>
            <div class="btn-group" style="margin-top: 14px;">
              <button class="btn-cyber-success" style="padding: 6px 14px; font-size: 12px;" @click="saveNotifySettings">保存通知偏好</button>
              <button class="btn-cyber-action" style="padding: 6px 14px; font-size: 12px;" @click="testUserNotify">测试通知</button>
            </div>
          </div>
        </div>

        <!-- 右列：SMTP 发信配置 + 定时巡检 -->
        <div class="column-stack">
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">📧</span>
                <div>
                  <strong class="panel-title">SMTP 发信服务器参数配置</strong>
                  <div class="panel-sub">用于发送验证码与到期告警邮件</div>
                </div>
              </div>
            </div>
            <div class="smtp-status-box" :class="settingsForm.is_smtp_configured ? 'smtp-ready' : 'smtp-empty'">
              <span>{{ settingsForm.is_smtp_configured ? '🟢 SMTP 状态：就绪 (发信正常)' : '⚪ SMTP 状态：未完整配置' }}</span>
            </div>
            <div class="form-item"><label>SMTP 服务器地址</label><input v-model="settingsForm.smtp_host" type="text" class="cyber-input" placeholder="smtp.qq.com" /></div>
            <div class="form-row-2">
              <div class="form-item"><label>端口</label><input v-model="settingsForm.smtp_port" type="text" class="cyber-input" placeholder="465" /></div>
              <div class="form-item"><label>发件人显示名称</label><input v-model="settingsForm.smtp_sender" type="text" class="cyber-input" placeholder="Xray 节点中心" /></div>
            </div>
            <div class="form-item"><label>发信邮箱账号</label><input v-model="settingsForm.smtp_user" type="text" class="cyber-input" placeholder="service@example.com" /></div>
            <div class="form-item"><label>邮箱授权码 / 密码</label><input v-model="settingsForm.smtp_pass" type="password" class="cyber-input" :placeholder="settingsForm.has_smtp_pass ? '●●●●●● (留空保持原密码)' : '输入授权码'" /></div>
            <div class="form-item"><label class="radio-label"><input type="checkbox" v-model="settingsForm.smtp_ssl" /> 启用 SSL 安全加密</label></div>
            <div class="inner-divider">
              <div style="display: flex; gap: 8px;">
                <input v-model="testEmailTo" type="email" class="cyber-input" placeholder="接收测试邮箱 (test@example.com)" />
                <button class="btn-cyber-action" :disabled="testingEmail" style="padding: 6px 14px; font-size: 12px; white-space: nowrap;" @click="sendTestEmail">{{ testingEmail ? '...' : '发信测试' }}</button>
              </div>
            </div>
          </div>

          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">⏰</span>
                <div>
                  <strong class="panel-title">定时巡检、预警与每月流量重置</strong>
                  <div class="panel-sub">后台自动轮询配额并执行每月重置</div>
                </div>
              </div>
              <label class="radio-label" style="margin: 0;">
                <input type="checkbox" v-model="settingsForm.task_notify_enable" />
                <span :style="{ color: settingsForm.task_notify_enable ? '#10b981' : '#ef4444' }">{{ settingsForm.task_notify_enable ? '🟢 巡检中' : '🔴 暂停' }}</span>
              </label>
            </div>
            <div class="form-item">
              <label>轮询检测周期 (小时)</label>
              <div class="input-with-addon"><input v-model.number="settingsForm.task_interval_hours" type="number" class="cyber-input" /><span class="addon-text">小时 / 次</span></div>
            </div>
            <div class="form-item">
              <label>流量不足告警阈值 (%)</label>
              <div class="input-with-addon"><input v-model.number="settingsForm.task_traffic_threshold" type="number" class="cyber-input" /><span class="addon-text">%</span></div>
            </div>
            <div class="form-item">
              <label>套餐到期告警阈值 (天)</label>
              <div class="input-with-addon"><input v-model.number="settingsForm.task_expire_days" type="number" class="cyber-input" /><span class="addon-text">天</span></div>
            </div>
            <div class="inner-divider">
              <div style="font-size: 12px; color: #94a3b8; margin-bottom: 10px;">最近扫描完成时间：<b class="text-cyan">{{ settingsForm.task_last_run }}</b></div>
              <button class="btn-cyber-primary" :disabled="triggeringTask" style="width: auto; padding: 7px 18px; font-size: 12px;" @click="triggerManualTask">
                {{ triggeringTask ? '扫描中...' : '⚡ 立即执行一次巡检与重置' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 子卡 5：HTTPS 证书与安全凭据 ==================== -->
    <div v-else-if="settingsSubTab === 'cert'" class="sub-tab-pane">
      <div class="settings-2col-layout">
        <div class="column-stack">
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">🔐</span>
                <div>
                  <strong class="panel-title">当前 TLS/HTTPS 证书凭据状态</strong>
                  <div class="panel-sub">运行期证书统一维护于 /app/certs，支持 Granian SIGHUP 平滑加载</div>
                </div>
              </div>
              <button class="btn-sm btn-action" @click="loadCertInfo">🔄 检查状态</button>
            </div>

            <!-- 证书状态横幅 -->
            <div class="smtp-status-box" :class="certInfo.is_self_signed ? 'smtp-empty' : 'smtp-ready'" style="margin-bottom: 14px;">
              <div v-if="certInfo.is_self_signed">
                🟢 <b>当前正在使用标准现代自签名证书 (10年期)</b>
                <div style="font-size: 11px; margin-top: 2px;">已预置 digitalSignature 密钥用途与通配符 SAN，开机即用，零配置免维护。</div>
              </div>
              <div v-else-if="certInfo.status === 'valid'">
                🟢 <b>当前证书工作正常 (受信任商业证书)</b>
                <div style="font-size: 11px; margin-top: 2px;">签发机构: {{ certInfo.issuer }} | 剩余天数: {{ certInfo.days_left }} 天</div>
              </div>
              <div v-else>
                ⚪ 证书就绪，开机自动生成自签名证书兜底。
              </div>
            </div>

            <div style="display: flex; flex-direction: column; gap: 8px; font-size: 12px; color: #cbd5e1; margin-bottom: 16px;">
              <div>• <b>公钥证书路径：</b><code>{{ certInfo.cert_path || '/app/certs/fullchain.pem' }}</code> (权限 0644)</div>
              <div>• <b>私钥文件路径：</b><code>{{ certInfo.key_path || '/app/certs/privkey.pem' }}</code> (权限 0600)</div>
              <div>• <b>剩余有效时长：</b><span class="text-emerald" style="font-weight: bold;">{{ certInfo.days_left }} 天</span></div>
            </div>

            <button class="btn-cyber-primary" :disabled="regeneratingCert" @click="handleRegenerateSelfSigned">
              {{ regeneratingCert ? '正在生成中...' : '🔄 重新生成 10 年期自签名证书' }}
            </button>
          </div>
        </div>

        <div class="column-stack">
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">🛡️</span>
                <div>
                  <strong class="panel-title">证书极简运行架构说明</strong>
                  <div class="panel-sub">无感自动加载与外部权威证书标准挂载</div>
                </div>
              </div>
            </div>

            <div class="preview-box" style="font-size: 12px; line-height: 1.6; color: #cbd5e1;">
              <div>
                <b class="text-cyan">1. 内置现代自签名证书（开机零配置）：</b>
                <p style="margin: 4px 0 10px 0; color: #94a3b8;">
                  系统默认预制具备 <code>digitalSignature</code> 与通配符 SAN 的自签证书，开机即刻监听 HTTPS，完美支持现代 Chrome / Edge 浏览器访问。
                </p>
              </div>

              <div>
                <b class="text-emerald">2. 自定义权威商业证书挂载（推荐）：</b>
                <p style="margin: 4px 0 10px 0; color: #94a3b8;">
                  如需使用已有域名证书（如腾讯云/阿里云/Cloudflare/宝塔证书），仅需在启动 Docker 容器时挂载只读目录：
                </p>
                <pre class="font-mono" style="padding: 10px; background: rgba(0,0,0,0.4); border-radius: 6px; font-size: 11px; color: #38bdf8; overflow-x: auto; margin-bottom: 10px;">
docker run -d -p 8443:8443 \
  -v /data/xray:/data \
  -v /etc/letsencrypt/live/example.com:/certs:ro \
  wimotek/xray-web
                </pre>
                <p style="color: #94a3b8; margin: 0;">
                  系统在启动时将全自动扫描匹配 <code>fullchain.pem</code> 与 <code>privkey.pem</code>，安全复制并设置最佳权限。
                </p>
              </div>

              <div style="font-size: 11px; color: #64748b; margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 8px;">
                ✨ 彻底移除不稳定且繁琐的在线 ACME 续订工具，系统体积减少 30MB+，运行环境更加纯粹健壮。
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 弹窗：数据库灾难恢复二次确认 -->
    <div v-if="showRestoreModal" class="modal-backdrop" @click="showRestoreModal = false">
      <div class="cyber-modal" style="max-width: 520px; text-align: left;" @click.stop>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
          <h3 style="margin: 0; font-size: 16px; font-weight: 700; color: #f8fafc; display: flex; align-items: center; gap: 8px;">
            <span style="color: #fbbf24;">⚠️</span> 数据库灾难恢复确认
          </h3>
          <button class="modal-close-btn" @click="showRestoreModal = false" title="关闭">✕</button>
        </div>

        <div style="padding: 12px; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 8px; font-size: 12px; color: #fde68a; margin-bottom: 14px; line-height: 1.5;">
          <strong>警告：您即将从以下快照还原整个系统数据库！</strong>
          <div style="margin-top: 8px; font-family: monospace; font-weight: bold; color: #38bdf8; padding: 6px; background: rgba(0,0,0,0.5); border-radius: 4px;">
            {{ restoreTargetFilename }}
          </div>
        </div>

        <div style="font-size: 12px; color: #cbd5e1; line-height: 1.6; margin-bottom: 16px;">
          <p>• 还原后，所有用户配额、节点网络拓扑及系统配置都将<b>精确回滚到该快照生成的时间点</b>。</p>
          <p>• <b>安全防护：</b>系统会在执行覆盖前自动创建一份当前状态冷备 (<code>.pre_restore_safety_bak</code>)，并自动清理 WAL 碎片。</p>
          <p>• 确认要继续执行恢复操作吗？</p>
        </div>

        <div class="btn-group" style="justify-content: flex-end; gap: 10px;">
          <button class="btn-cyber-action" :disabled="restoring" @click="showRestoreModal = false">取消</button>
          <button class="btn-cyber-primary" style="background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%); border-color: #ef4444;" :disabled="restoring" @click="executeRestore">
            {{ restoring ? '🔄 正在恢复数据库并校验完整性...' : '⚠️ 确认立即恢复数据库' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import axios from 'axios'
import { ElMessage, ElMessageBox } from 'element-plus'

const props = defineProps({
  currentUser: { type: Object, required: true },
  adminPassword: { type: String, required: true }
})

const emit = defineEmits(['copy', 'reload-all'])

const settingsSubTab = ref('backup')

const settingsForm = reactive({
  smtp_host: '',
  smtp_port: '465',
  smtp_user: '',
  smtp_pass: '',
  has_smtp_pass: false,
  is_smtp_configured: false,
  smtp_sender: '',
  smtp_ssl: true,
  task_notify_enable: true,
  task_interval_hours: 12,
  task_traffic_threshold: 80,
  task_expire_days: 3,
  task_last_run: '尚未执行',
  system_notice: '',
  reg_traffic_mb: 1024,
  reg_expire_days: 1,
  referral_enabled: true,
  referral_inviter_traffic_gb: 10,
  referral_inviter_days: 30,
  referral_invitee_traffic_gb: 5,
  referral_invitee_days: 30,
  referral_max_per_user: 50,
  // 数据库自动备份策略
  auto_backup_enabled: true,
  backup_interval_hours: 24,
  backup_max_count: 7,
  last_backup_time: '尚未执行'
})

const notifyForm = reactive({ notify_type: 'email', serverchan_key: '' })

// 消息群发表单
const notifyPushForm = reactive({
  target: 'all',
  target_user: '',
  title: '',
  content: ''
})
const sendingPush = ref(false)

// 数据库备份相关
const backupList = ref([])
const creatingBackup = ref(false)
const uploadingBackup = ref(false)
const fileUploadRef = ref(null)
const showRestoreModal = ref(false)
const restoreTargetFilename = ref('')
const restoring = ref(false)

// 证书相关
const certInfo = ref({ status: 'none', is_self_signed: true, issuer: '', days_left: 0, cert_path: '', key_path: '' })
const regeneratingCert = ref(false)

const testEmailTo = ref('')
const testingEmail = ref(false)
const triggeringTask = ref(false)

onMounted(async () => {
  notifyForm.notify_type = props.currentUser.notify_type || 'email'
  notifyForm.serverchan_key = props.currentUser.serverchan_key || ''

  try {
    const res = await axios.get(`/api/admin/settings?admin_user=${encodeURIComponent(props.currentUser.username)}&admin_pwd=${encodeURIComponent(props.adminPassword)}`)
    if (res.data.code === 200) {
      const d = res.data.data
      settingsForm.smtp_host = d.smtp_host || ''
      settingsForm.smtp_port = d.smtp_port || '465'
      settingsForm.smtp_user = d.smtp_user || ''
      settingsForm.smtp_pass = ''
      settingsForm.has_smtp_pass = d.has_smtp_pass || false
      settingsForm.is_smtp_configured = d.is_smtp_configured || false
      settingsForm.smtp_sender = d.smtp_sender || ''
      settingsForm.smtp_ssl = d.smtp_ssl === 'true'
      settingsForm.task_notify_enable = d.task_notify_enable === 'true'
      settingsForm.task_interval_hours = Number(d.task_interval_hours) || 12
      settingsForm.task_traffic_threshold = Number(d.task_traffic_threshold) || 80
      settingsForm.task_expire_days = Number(d.task_expire_days) || 3
      settingsForm.task_last_run = d.task_last_run || '尚未执行'
      settingsForm.system_notice = d.system_notice || ''
      settingsForm.reg_traffic_mb = Number(d.reg_traffic_mb) || 1024
      settingsForm.reg_expire_days = Number(d.reg_expire_days) || 1
      settingsForm.referral_enabled = d.referral_enabled !== 'false'
      settingsForm.referral_inviter_traffic_gb = Number(d.referral_inviter_traffic_gb) || 10
      settingsForm.referral_inviter_days = Number(d.referral_inviter_days) || 30
      settingsForm.referral_invitee_traffic_gb = Number(d.referral_invitee_traffic_gb) || 5
      settingsForm.referral_invitee_days = Number(d.referral_invitee_days) || 30
      settingsForm.referral_max_per_user = Number(d.referral_max_per_user) || 50
      settingsForm.auto_backup_enabled = d.auto_backup_enabled !== 'false'
      settingsForm.backup_interval_hours = Number(d.backup_interval_hours) || 24
      settingsForm.backup_max_count = Number(d.backup_max_count) || 7
      settingsForm.last_backup_time = d.last_backup_time || '尚未执行'
    }
  } catch (_) {}

  loadBackups()
  loadCertInfo()
})

// 加载备份文件列表
const loadBackups = async () => {
  try {
    const res = await axios.post('/api/admin/backup/list', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword
    })
    if (res.data.code === 200) {
      backupList.value = res.data.data.backups || []
      if (res.data.data.last_backup_time) {
        settingsForm.last_backup_time = res.data.data.last_backup_time
      }
    }
  } catch (_) {}
}

// 立即创建热备份
const handleCreateBackupNow = async () => {
  creatingBackup.value = true
  try {
    const res = await axios.post('/api/admin/backup/create', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      loadBackups()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.msg || '备份失败')
  } finally {
    creatingBackup.value = false
  }
}

// 下载备份文件
const handleDownloadBackup = (filename) => {
  const url = `/api/admin/backup/download?filename=${encodeURIComponent(filename)}&admin_user=${encodeURIComponent(props.currentUser.username)}&admin_pwd=${encodeURIComponent(props.adminPassword)}`
  window.open(url, '_blank')
}

// 删除备份文件
const handleDeleteBackup = async (filename) => {
  try {
    await ElMessageBox.confirm(`确定要永久删除备份快照 [${filename}] 吗？此操作不可逆。`, '删除确认', {
      confirmButtonText: '确定删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const res = await axios.post('/api/admin/backup/delete', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      filename
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      loadBackups()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {}
}

// 恢复备份确认
const openRestoreModal = (filename) => {
  restoreTargetFilename.value = filename
  showRestoreModal.value = true
}

const executeRestore = async () => {
  restoring.value = true
  try {
    const res = await axios.post('/api/admin/backup/restore', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      filename: restoreTargetFilename.value
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      showRestoreModal.value = false
      setTimeout(() => location.reload(), 1500)
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.msg || '恢复失败')
  } finally {
    restoring.value = false
  }
}

// 上传外部 .db 文件
const handleUploadDbFile = async (e) => {
  const file = e.target.files?.[0]
  if (!file) return
  if (!file.name.endsWith('.db')) {
    ElMessage.warning('仅支持上传 SQLite .db 格式文件')
    return
  }

  const formData = new FormData()
  formData.append('admin_user', props.currentUser.username)
  formData.append('admin_pwd', props.adminPassword)
  formData.append('file', file)

  uploadingBackup.value = true
  try {
    const res = await axios.post('/api/admin/backup/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      loadBackups()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.msg || '上传失败')
  } finally {
    uploadingBackup.value = false
    e.target.value = ''
  }
}

// 重新生成自签证书
const handleRegenerateSelfSigned = async () => {
  regeneratingCert.value = true
  try {
    const res = await axios.post('/api/admin/cert/self_signed', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      loadCertInfo()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('重新生成自签证书失败')
  } finally {
    regeneratingCert.value = false
  }
}

// 加载证书状态
const loadCertInfo = async () => {
  try {
    const res = await axios.post('/api/admin/cert/info', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword
    })
    if (res.data.code === 200) {
      certInfo.value = res.data.data
    }
  } catch (_) {}
}

const sendUserPushNotification = async () => {
  if (!notifyPushForm.title || !notifyPushForm.content) {
    return ElMessage.warning('请输入通知标题与正文内容')
  }
  if (notifyPushForm.target === 'single' && !notifyPushForm.target_user.trim()) {
    return ElMessage.warning('请输入接收通知的目标用户名')
  }

  const confirmMsg = notifyPushForm.target === 'all'
    ? '⚠️ 确定要向全站所有正常活跃的用户群发广播此通知吗？'
    : `确定要向用户 [${notifyPushForm.target_user}] 单独发送此通知吗？`

  if (!confirm(confirmMsg)) return

  sendingPush.value = true
  try {
    const res = await axios.post('/api/admin/notify/send', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      ...notifyPushForm
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      notifyPushForm.title = ''
      notifyPushForm.content = ''
      if (notifyPushForm.target === 'single') {
        notifyPushForm.target_user = ''
      }
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('通知发送请求失败')
  } finally {
    sendingPush.value = false
  }
}

const generatedReferralNotice = computed(() => {
  return `🎁【推荐好友注册双向奖励计划已开启】
邀请好友注册各享豪礼！好友通过您的专属邀请链接或邀请码注册激活成功：
• 邀请人奖励：立即获得 +${settingsForm.referral_inviter_traffic_gb} GB 高速流量，账户有效期延长 +${settingsForm.referral_inviter_days} 天！
• 新用户奖励：额外赠送 +${settingsForm.referral_invitee_traffic_gb} GB 新人礼包流量，账户有效期延长 +${settingsForm.referral_invitee_days} 天！
登录个人控制台即可获取您的专属推荐链接与邀请码，多邀多得！`
})

const publishReferralNotice = async () => {
  settingsForm.system_notice = generatedReferralNotice.value
  await saveAllSettings()
  ElMessage.success('推荐奖励方案已成功格式化并发布至全站系统公告！')
}

const saveAllSettings = async () => {
  try {
    const res = await axios.post('/api/admin/settings', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      ...settingsForm,
      smtp_ssl: settingsForm.smtp_ssl ? 'true' : 'false',
      task_notify_enable: settingsForm.task_notify_enable ? 'true' : 'false',
      auto_backup_enabled: settingsForm.auto_backup_enabled ? 'true' : 'false',
      referral_enabled: settingsForm.referral_enabled ? 'true' : 'false'
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('保存设置失败')
  }
}

const saveNotifySettings = async () => {
  try {
    const res = await axios.post('/api/user/notify_settings', {
      username: props.currentUser.username,
      notify_type: notifyForm.notify_type,
      serverchan_key: notifyForm.serverchan_key
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('保存失败')
  }
}

const testUserNotify = async () => {
  try {
    const res = await axios.post('/api/user/test_notify', { username: props.currentUser.username })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('测试发送失败')
  }
}

const sendTestEmail = async () => {
  if (!testEmailTo.value) return ElMessage.warning('请输入测试收件邮箱')
  testingEmail.value = true
  try {
    const res = await axios.post('/api/admin/test_email', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      test_to: testEmailTo.value
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('发信异常')
  } finally {
    testingEmail.value = false
  }
}

const triggerManualTask = async () => {
  triggeringTask.value = true
  try {
    const res = await axios.post('/api/admin/tasks/trigger', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('触发扫描任务失败')
  } finally {
    triggeringTask.value = false
  }
}
</script>

<style scoped>
.badge-count {
  margin-left: 6px;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 10px;
  background: rgba(16, 185, 129, 0.2);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.3);
  font-weight: 700;
}

.strategy-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin: 16px 0;
}

@media (max-width: 900px) {
  .strategy-grid {
    grid-template-columns: 1fr;
  }
}

.strategy-box {
  padding: 14px;
  background: rgba(15, 23, 42, 0.7);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.strategy-box label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #e2e8f0;
  margin-bottom: 8px;
}

.time-display {
  font-size: 14px;
  font-weight: 700;
  color: #38bdf8;
  margin-bottom: 6px;
}

.backup-actions-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding-top: 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.tag-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}

.tag-blue {
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.tag-purple {
  background: rgba(168, 85, 247, 0.15);
  color: #c084fc;
  border: 1px solid rgba(168, 85, 247, 0.3);
}

.tag-green {
  background: rgba(16, 185, 129, 0.15);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.backup-tips-box {
  padding: 12px;
  background: rgba(2, 6, 23, 0.8);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 12px;
  color: #94a3b8;
  margin-top: 16px;
  line-height: 1.6;
}

.referral-quick-bar {
  padding: 10px 12px;
  background: rgba(88, 28, 135, 0.25);
  border: 1px solid rgba(168, 85, 247, 0.3);
  border-radius: 8px;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.preview-box {
  padding: 16px;
  background: rgba(2, 6, 23, 0.9);
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.preview-content {
  padding: 12px;
  background: rgba(15, 23, 42, 0.9);
  border-radius: 8px;
  font-size: 12px;
  color: #cbd5e1;
  line-height: 1.6;
  white-space: pre-wrap;
  border: 1px solid rgba(255, 255, 255, 0.05);
  margin: 10px 0;
}

.input-with-addon {
  display: flex;
  align-items: center;
  gap: 8px;
}

.input-with-addon .cyber-input {
  flex: 1;
}

.addon-text {
  font-size: 12px;
  color: #94a3b8;
  white-space: nowrap;
}

/* 历史备份表格操作按钮组 (彻底消除默认 3D 边框，统一直角圆角与质感) */
.backup-btn-group {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.btn-backup-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  line-height: 1.2;
  transition: all 0.2s ease;
  outline: none;
  border: 1px solid transparent;
}

/* 1. 下载按钮：科技青蓝风格 */
.btn-backup-download {
  background: rgba(14, 165, 233, 0.15);
  border-color: rgba(56, 189, 248, 0.4);
  color: #38bdf8;
}
.btn-backup-download:hover {
  background: rgba(14, 165, 233, 0.32);
  border-color: #38bdf8;
  color: #ffffff;
  box-shadow: 0 0 10px rgba(56, 189, 248, 0.25);
  transform: translateY(-1px);
}

/* 2. 一键恢复按钮：高亮极客蓝渐变风格 */
.btn-backup-restore {
  background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%);
  border-color: #38bdf8;
  color: #ffffff;
  box-shadow: 0 0 8px rgba(56, 189, 248, 0.25);
}
.btn-backup-restore:hover {
  background: linear-gradient(135deg, #0369a1 0%, #1d4ed8 100%);
  border-color: #7dd3fc;
  box-shadow: 0 0 12px rgba(56, 189, 248, 0.4);
  transform: translateY(-1px);
}

/* 3. 删除按钮：警示暗红质感风格 (告别土黄与 3D 凸起) */
.btn-backup-delete {
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.35);
  color: #f87171;
}
.btn-backup-delete:hover {
  background: rgba(239, 68, 68, 0.32);
  border-color: #ef4444;
  color: #ffffff;
  box-shadow: 0 0 10px rgba(239, 68, 68, 0.25);
  transform: translateY(-1px);
}
</style>