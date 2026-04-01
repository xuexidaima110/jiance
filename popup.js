/**
 * 即梦视频任务监控器 - Popup 控制逻辑
 */
(function () {
  'use strict';

  // ======= 状态 =======
  let currentState = {
    running: false,
    activeCount: 0,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 0,
    activeTasks: [],
    pendingTasks: [],
    completedTasks: [],
    failedTasks: [],
    logs: [],
  };

  const MODEL_OPTIONS_BY_REF_MODE = {
    '智能多帧': ['Seedance 1.5 Pro'],
    '首尾帧': ['Seedance 2.0 Fast', 'Seedance 2.0', 'Seedance 1.5 Pro', 'Seedance 1.0', 'Seedance 1.0 Fast'],
    '全能参考': ['Seedance 2.0 Fast', 'Seedance 2.0']
  };

  function isExtensionContextValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  // ======= 发消息给 background =======
  async function sendMsg(type, payload = {}) {
    if (!isExtensionContextValid()) return null;
    try {
      return await chrome.runtime.sendMessage({ type, ...payload });
    } catch (error) {
      const messageText = String(error?.message || error || '');
      if (!messageText.includes('Extension context invalidated')) {
        console.debug('[即梦监控] popup sendMessage 失败:', error);
      }
      return null;
    }
  }

  // ======= 初始化 =======
  async function init() {
    const state = await sendMsg('GET_STATE');
    if (state) updateUI(state);

    bindEvents();

    if (!isExtensionContextValid()) return;
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'STATE_UPDATE') {
        updateUI(message.state);
      }
      if (message.type === 'LOG') {
        appendLog(message.entry);
      }
      if (message.type === 'TASK_DONE' || message.type === 'TASK_FAILED') {
        sendMsg('GET_STATE').then(s => s && updateUI(s));
      }
    });
  }

  // ======= 更新 UI =======
  function updateUI(state) {
    currentState = { ...currentState, ...state };

    const dot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    if (state.running) {
      dot.className = 'status-dot running';
      statusText.textContent = '监控中';
    } else {
      dot.className = 'status-dot stopped';
      statusText.textContent = '未运行';
    }

    const btnToggle = document.getElementById('btnToggle');
    if (state.running) {
      btnToggle.textContent = '⏹ 停止监控';
      btnToggle.classList.add('stop');
    } else {
      btnToggle.textContent = '▶ 启动监控';
      btnToggle.classList.remove('stop');
    }

    setText('activeCount', state.activeCount ?? 0);
    setText('pendingCount', state.pendingCount ?? 0);
    setText('completedCount', state.completedCount ?? 0);
    setText('failedCount', state.failedCount ?? 0);

    const pct = Math.round(((state.activeCount || 0) / 10) * 100);
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('progressLabel').textContent = `${state.activeCount || 0} / 10`;

    renderPendingList(state.pendingTasks || []);
    renderActiveList(state.activeTasks || []);
    renderHistoryList(state.completedTasks || [], state.failedTasks || []);
    renderLogList(state.logs || []);
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  // ======= 渲染备用任务列表 =======
  function renderPendingList(tasks) {
    const container = document.getElementById('pendingList');
    if (tasks.length === 0) {
      container.innerHTML = '<div class="empty-hint">备用队列为空，请添加任务</div>';
      return;
    }
    container.innerHTML = tasks.map((t, i) => {
      const isFailed = t.paused && t._submitFails > 0;
      const cardClass = isFailed ? 'failed' : (t.paused ? 'paused' : 'pending');
      const icon = isFailed ? '❌' : (t.paused ? '⏸' : '⏳');
      const badgeClass = isFailed ? 'badge-failed' : (t.paused ? 'badge-failed' : 'badge-pending');
      const badgeText = isFailed ? `提交失败×${t._submitFails}` : (t.paused ? '已暂停' : '待提交');
      const retryBtn = isFailed
        ? `<button class="btn-icon btn-retry-pending" title="重试" data-task-id="${escHtml(t.id)}">&#128257;</button>`
        : '';
      return `
      <div class="task-card ${cardClass}">
        <span class="task-status-icon">${icon}</span>
        <div class="task-body">
          <div class="task-prompt">${escHtml(t.prompt || '（无提示词）')}</div>
          <div class="task-meta">
            <span class="task-id">#${i + 1}</span>
            <span class="task-status-badge ${badgeClass}">${badgeText}</span>
            ${t.ratio ? `<span class="task-time">${escHtml(t.model || '')} ${escHtml(t.ratio)} ${escHtml(t.duration || '')}</span>` : ''}
            ${t.refMode ? `<span class="task-time">${escHtml(t.refMode)}</span>` : ''}
            ${t.imageName ? `<span class="task-time">📷 ${escHtml(t.imageName)}</span>` : ''}
          </div>
        </div>
        <div class="task-actions">
          ${retryBtn}
          <button class="btn-icon btn-toggle-pending ${t.paused ? 'pause-active' : ''}" title="${t.paused ? '恢复' : '暂停'}" data-task-id="${escHtml(t.id)}">${t.paused ? '▶' : '⏸'}</button>
          <button class="btn-icon btn-remove-pending remove-danger" title="取消" data-task-id="${escHtml(t.id)}">✕</button>
        </div>
      </div>
    `;
    }).join('');
  }

  // ======= 渲染进行中列表 =======
  function renderActiveList(tasks) {
    const container = document.getElementById('activeList');
    if (tasks.length === 0) {
      container.innerHTML = '<div class="empty-hint">暂无进行中的任务</div>';
      return;
    }
    container.innerHTML = tasks.map(t => {
      const elapsed = t.submitTime ? Math.round((Date.now() - t.submitTime) / 1000) : '?';
      const statusLabel = getStatusLabel(t.status);
      const statusBadge = getStatusBadge(t.status);
      const missWarn = (t._missCount > 0) ? `<span class="task-time" style="color:#fbbf24">⚠未见${t._missCount}次</span>` : '';
      return `
        <div class="task-card ${t.status === 'running' || t.status === 'processing' ? 'running' : 'pending'}">
          <span class="task-status-icon">${statusLabel.icon}</span>
          <div class="task-body">
            <div class="task-prompt">${escHtml(t.prompt || t.id || '运行中...')}</div>
            <div class="task-meta">
              <span class="task-id">${escHtml(String(t.id || '').slice(0, 16))}</span>
              <span class="task-time">+${elapsed}s</span>
              <span class="task-status-badge ${statusBadge}">${statusLabel.text}</span>
              ${missWarn}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ======= 渲染历史记录 =======
  function renderHistoryList(completed, failed) {
    const container = document.getElementById('historyList');
    const all = [
      ...completed.map(t => ({ ...t, _type: 'success' })),
      ...failed.map(t => ({ ...t, _type: 'failed' }))
    ].sort((a, b) => (b.completedAt || b.failedAt || 0) - (a.completedAt || a.failedAt || 0));

    if (all.length === 0) {
      container.innerHTML = '<div class="empty-hint">暂无历史记录</div>';
      return;
    }
    container.innerHTML = all.slice(0, 50).map(t => {
      const icon = t._type === 'success' ? '✅' : '❌';
      const cardClass = t._type === 'success' ? 'success' : 'failed';
      const timeStr = new Date(t.completedAt || t.failedAt || 0).toLocaleTimeString('zh-CN');
      return `
        <div class="task-card ${cardClass}">
          <span class="task-status-icon">${icon}</span>
          <div class="task-body">
            <div class="task-prompt">${escHtml(t.prompt || t.id || '')}</div>
            <div class="task-meta">
              <span class="task-id">${escHtml(String(t.id || '').slice(0, 16))}</span>
              <span class="task-time">${timeStr}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ======= 渲染日志 =======
  function renderLogList(logs) {
    const container = document.getElementById('logList');
    if (logs.length === 0) {
      container.innerHTML = '<div class="empty-hint">暂无日志</div>';
      return;
    }
    container.innerHTML = logs.map(entry => `
      <div class="log-entry log-${entry.level || 'info'}">
        <span class="log-time">${entry.time || ''}</span>
        <span class="log-msg">${escHtml(entry.msg || '')}</span>
      </div>
    `).join('');
  }

  function appendLog(entry) {
    currentState.logs = [entry, ...(currentState.logs || [])].slice(0, 50);
    renderLogList(currentState.logs);
  }

  // ======= 工具函数 =======
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getStatusLabel(status) {
    const map = {
      running: { icon: '🔵', text: '运行中' },
      processing: { icon: '🔵', text: '处理中' },
      in_queue: { icon: '🟡', text: '排队中' },
      pending: { icon: '🟡', text: '等待中' },
      success: { icon: '🟢', text: '已完成' },
      failed: { icon: '🔴', text: '已失败' },
    };
    return map[status] || { icon: '⚪', text: status || '未知' };
  }

  function getStatusBadge(status) {
    if (['running', 'processing'].includes(status)) return 'badge-running';
    if (['pending', 'in_queue'].includes(status)) return 'badge-pending';
    if (['success', 'done'].includes(status)) return 'badge-success';
    if (['failed', 'error'].includes(status)) return 'badge-failed';
    return 'badge-pending';
  }

  function syncModelOptionsByRefMode() {
    const refModeEl = document.getElementById('taskRefMode');
    const modelEl = document.getElementById('taskModel');
    if (!refModeEl || !modelEl) return;

    const refMode = refModeEl.value;
    const allowedModels = MODEL_OPTIONS_BY_REF_MODE[refMode] || MODEL_OPTIONS_BY_REF_MODE['首尾帧'];

    Array.from(modelEl.options).forEach(option => {
      const enabled = allowedModels.includes(option.value);
      option.disabled = !enabled;
      option.hidden = !enabled;
    });

    if (!allowedModels.includes(modelEl.value)) {
      modelEl.value = allowedModels[0];
    }
  }

  // ======= 绑定事件 =======
  function bindEvents() {
    
    // 图片上传预览和 @ 联想功能
    const taskImageFile = document.getElementById('taskImageFile');
    const taskImagePreview = document.getElementById('taskImagePreview');
    const taskPrompt = document.getElementById('taskPrompt');
    const mentionsList = document.getElementById('mentionsList');
    const taskRefMode = document.getElementById('taskRefMode');

    let uploadedFiles = [];

    syncModelOptionsByRefMode();
    taskRefMode.addEventListener('change', syncModelOptionsByRefMode);

    taskImageFile.addEventListener('change', (e) => {
      let files = Array.from(e.target.files || []);
      if (files.length > 9) {
        alert('最多只能选择9张图片');
        files = files.slice(0, 9);
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        taskImageFile.files = dt.files;
      }
      uploadedFiles = files;
      taskImagePreview.innerHTML = '';
      files.forEach(file => {
        const div = document.createElement('div');
        div.style.cssText = 'padding:2px 4px; background:#e0e7ff; color:#3730a3; border-radius:4px; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:80px;';
        div.textContent = file.name;
        div.title = file.name;
        taskImagePreview.appendChild(div);
      });
    });

    taskPrompt.addEventListener('input', (e) => {
      const val = taskPrompt.value;
      const cursorPos = taskPrompt.selectionStart;
      const textBeforeCursor = val.slice(0, cursorPos);
      const lastAtPos = textBeforeCursor.lastIndexOf('@');

      if (lastAtPos !== -1 && lastAtPos >= textBeforeCursor.lastIndexOf('\n')) {
        const searchStr = textBeforeCursor.slice(lastAtPos + 1).toLowerCase();
        if (uploadedFiles.length > 0) {
          const matches = uploadedFiles.filter(f => f.name.toLowerCase().includes(searchStr));
          if (matches.length > 0) {
            mentionsList.innerHTML = matches.map(f => `
              <div class="mention-item" style="padding:6px 12px; cursor:pointer; border-bottom:1px solid #eee; font-size:13px; color:#333;" data-name="${f.name}">
                📷 ${f.name}
              </div>
            `).join('');
            mentionsList.style.display = 'block';
            
            mentionsList.querySelectorAll('.mention-item').forEach(item => {
              item.addEventListener('click', () => {
                const name = item.dataset.name;
                const newText = val.slice(0, lastAtPos) + `@[${name}] ` + val.slice(cursorPos);
                taskPrompt.value = newText;
                mentionsList.style.display = 'none';
                taskPrompt.focus();
              });
            });
            return;
          }
        }
      }
      mentionsList.style.display = 'none';
    });

    document.addEventListener('click', (e) => {
      if (e.target !== taskPrompt && !mentionsList.contains(e.target)) {
        mentionsList.style.display = 'none';
      }
    });

    // 启动/停止
    document.getElementById('btnToggle').addEventListener('click', async () => {
      if (currentState.running) {
        await sendMsg('STOP_MONITOR');
      } else {
        await sendMsg('START_MONITOR');
      }
      const state = await sendMsg('GET_STATE');
      if (state) updateUI(state);
    });

    // 立即轮询
    document.getElementById('btnForcePoll').addEventListener('click', () => {
      sendMsg('FORCE_POLL');
    });

    // 打开即梦
    document.getElementById('btnOpenJimeng').addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://jimeng.jianying.com/ai-tool/generate?workspace=0' });
    });

    // 调试
    document.getElementById('btnDebugCapture').addEventListener('click', async () => {
      const tabs = await chrome.tabs.query({ url: 'https://jimeng.jianying.com/*' });
      if (tabs.length === 0) return alert('请先打开即梦页面');
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => console.log('DEBUG')
      }).catch(() => {});
      alert('请按 F12 打开看日志');
    });

    // 添加任务
    document.getElementById('btnAddTask').addEventListener('click', async () => {
      const promptEl = document.getElementById('taskPrompt');
      let raw = promptEl.value.trim();
      if (!raw) return;

      const genMode = document.getElementById('taskGenMode').value;
      const model = document.getElementById('taskModel').value;
      const refMode = document.getElementById('taskRefMode').value;
      const ratio = document.getElementById('taskRatio').value;
      const duration = document.getElementById('taskDuration').value;

      const fileInput = document.getElementById('taskImageFile');
      let files = Array.from(fileInput.files || []).slice(0, 9);
      
      const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

      const readFiles = async (files) => {
        return Promise.all(files.map(file => new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = e => resolve({ name: file.name, data: e.target.result });
          reader.readAsDataURL(file);
        })));
      };

      let imagesData = [];
      if (files.length > 0) {
        imagesData = await readFiles(files);
      }

      const tasks = lines.map((prompt) => {
        let taskImageData = null;
        let taskImageName = null;
        
        for (const img of imagesData) {
          // 查找 @[filename]
          const tag = `@[${img.name}]`;
          if (prompt.includes(tag)) {
            taskImageData = img.data;
            taskImageName = img.name;
            prompt = prompt.replace(tag, '').trim();
            break;
          }
        }
        
        // 如果没有特定 @ 某张图，但有图片，则默认使用第一张
        if (!taskImageData && imagesData.length > 0) {
          taskImageData = imagesData[0].data;
          taskImageName = imagesData[0].name;
        }

        return {
          prompt,
          genMode,
          model,
          refMode,
          ratio,
          duration,
          imageData: taskImageData,
          imageName: taskImageName
        };
      });

      await sendMsg('ADD_PENDING_TASKS_BATCH', { tasks });
      
      promptEl.value = '';
      if (fileInput) fileInput.value = '';
      const preview = document.getElementById('taskImagePreview');
      if (preview) preview.innerHTML = '';
      uploadedFiles = [];
      mentionsList.style.display = 'none';

      const state = await sendMsg('GET_STATE');
      if (state) updateUI(state);
    });

    document.getElementById('btnClearPreviousData').addEventListener('click', async () => {
      if (!confirm('确定清空之前的已完成、失败和日志数据？')) return;
      await sendMsg('CLEAR_PREVIOUS_DATA');
      const state = await sendMsg('GET_STATE');
      if (state) updateUI(state);
    });

    // 清空备用队列
    document.getElementById('btnClearPending').addEventListener('click', async () => {
      if (!confirm('确定清空备用队列？')) return;
      await sendMsg('CLEAR_PENDING');
      const state = await sendMsg('GET_STATE');
      if (state) updateUI(state);
    });

    // 清空历史
    document.getElementById('btnClearHistory').addEventListener('click', async () => {
      await sendMsg('CLEAR_COMPLETED');
      const state = await sendMsg('GET_STATE');
      if (state) updateUI(state);
    });

    // 清空日志
    document.getElementById('btnClearLogs').addEventListener('click', async () => {
      await sendMsg('CLEAR_LOGS');
      currentState.logs = [];
      renderLogList([]);
    });

    // 删除单条任务 (事件委托)
    document.getElementById('pendingList').addEventListener('click', async (event) => {
      // 重试失败任务
      const retryButton = event.target.closest('.btn-retry-pending');
      if (retryButton) {
        const taskId = retryButton.dataset.taskId;
        if (!taskId) return;
        await sendMsg('RETRY_FAILED_TASK', { taskId });
        const state = await sendMsg('GET_STATE');
        if (state) updateUI(state);
        return;
      }

      const toggleButton = event.target.closest('.btn-toggle-pending');
      if (toggleButton) {
        const taskId = toggleButton.dataset.taskId;
        if (!taskId) return;
        await sendMsg('TOGGLE_PENDING_TASK_PAUSED', { taskId });
        const state = await sendMsg('GET_STATE');
        if (state) updateUI(state);
        return;
      }

      const button = event.target.closest('.btn-remove-pending');
      if (!button) return;
      const taskId = button.dataset.taskId;
      if (!taskId) return;
      await removePendingTask(taskId);
    });

    // Tab 切换
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tabName = btn.dataset.tab;
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + tabName).classList.add('active');
      });
    });
  }

  // ======= 删除备用任务 =======
  async function removePendingTask(taskId) {
    await sendMsg('REMOVE_PENDING_TASK', { taskId });
    const state = await sendMsg('GET_STATE');
    if (state) updateUI(state);
  }

  // ======= 启动 =======
  document.addEventListener('DOMContentLoaded', init);
})();