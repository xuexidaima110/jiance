/**
 * 即梦视频任务监控器 - Background Service Worker
 * 负责：任务状态轮询、并发管理、备用任务调度
 */

const MAX_CONCURRENT = 10;         // 最大并发数
const POLL_INTERVAL_MS = 5000;     // 轮询间隔（毫秒）
const ALARM_NAME = 'taskPoller';
const ACTIVE_TASK_STALE_MS = 60000;
const SUBMITTED_TASK_GRACE_MS = 90000;

// ========== 状态管理 ==========
let state = {
  running: false,           // 监控是否启动
  activeTasks: [],          // 进行中的任务 [{id, prompt, submitTime, status}]
  pendingTasks: [],         // 备用任务队列 [{id, prompt, params}]
  completedTasks: [],       // 已完成任务
  failedTasks: [],          // 失败任务
  logs: [],                 // 操作日志
  authCookie: '',           // 认证cookie
  sessionToken: '',         // session token
};

// ========== 持久化 ==========
function compactTaskForStorage(task) {
  if (!task || typeof task !== 'object') return task;
  const clone = { ...task };

  if (clone.imageData) {
    clone._hasImageData = true;
    delete clone.imageData;
  }

  if (clone.params && typeof clone.params === 'object') {
    clone.params = { ...clone.params };
    if (clone.params.imageData) {
      clone.params._hasImageData = true;
      delete clone.params.imageData;
    }
    if (clone.params.debug) delete clone.params.debug;
  }

  if (clone._submitDebug) delete clone._submitDebug;
  if (clone.debug) delete clone.debug;
  if (clone.trace) delete clone.trace;

  return clone;
}

function buildPersistedState() {
  return {
    ...state,
    pendingTasks: (state.pendingTasks || []).map(compactTaskForStorage),
    activeTasks: (state.activeTasks || []).map(compactTaskForStorage),
    completedTasks: (state.completedTasks || []).slice(0, 100).map(compactTaskForStorage),
    failedTasks: (state.failedTasks || []).slice(0, 100).map(compactTaskForStorage),
    logs: (state.logs || []).slice(0, 80),
  };
}

async function saveState() {
  try {
    await chrome.storage.local.set({ jimengState: buildPersistedState() });
  } catch (e) {
    const msg = String(e?.message || e || '');
    console.warn('[即梦监控] saveState失败:', msg);
    if (msg.includes('QUOTA_BYTES') || msg.includes('QuotaBytes')) {
      const fallback = {
        running: state.running,
        activeTasks: (state.activeTasks || []).slice(0, 30).map(compactTaskForStorage),
        pendingTasks: (state.pendingTasks || []).slice(0, 30).map(compactTaskForStorage),
        completedTasks: [],
        failedTasks: [],
        logs: (state.logs || []).slice(0, 30),
        authCookie: state.authCookie || '',
        sessionToken: state.sessionToken || '',
      };
      await chrome.storage.local.set({ jimengState: fallback });
    }
  }
}

async function loadState() {
  const data = await chrome.storage.local.get('jimengState');
  if (data.jimengState) {
    state = { ...state, ...data.jimengState };
  }
}

// ========== 日志 ==========
function log(msg, level = 'info') {
  const entry = {
    time: new Date().toLocaleTimeString('zh-CN'),
    msg,
    level
  };
  state.logs.unshift(entry);
  if (state.logs.length > 200) state.logs = state.logs.slice(0, 200);
  // 推送给popup
  broadcastToPopup({ type: 'LOG', entry });
  console.log(`[即梦监控][${level}] ${msg}`);
}

function broadcastToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// ========== 查找即梦 Tab ==========
async function findJimengTab() {
  // 优先匹配 generate 页面（用户实际使用的页面）
  const patterns = [
    'https://jimeng.jianying.com/ai-tool/generate*',
    'https://jimeng.jianying.com/ai-tool/*',
    'https://jimeng.jianying.com/*',
  ];
  for (const pattern of patterns) {
    const tabs = await chrome.tabs.query({ url: pattern });
    if (tabs.length > 0) return tabs[0];
  }
  return null;
}

// ========== API 调用封装 ==========
/**
 * 查询任务列表（生成中的）
 */
async function fetchTaskList() {
  const tab = await findJimengTab();
  if (!tab) {
    log('未找到即梦页面，请先打开 jimeng.jianying.com/ai-tool/generate', 'warn');
    return null;
  }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TASK_LIST' });
    return result;
  } catch (e) {
    log('获取任务列表失败: ' + e.message, 'error');
    return null;
  }
}

/**
 * 提交视频生成任务
 */
async function submitTask(taskParams) {
  const tab = await findJimengTab();
  if (!tab) {
    log('未找到即梦页面，无法提交任务', 'warn');
    return { error: 'no-tab' };
  }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'SUBMIT_TASK',
      params: taskParams
    });
    if (result && !result.error) {
      return { ok: true, ...result };
    }
    return result || { error: 'empty-result' };
  } catch (e) {
    log('提交任务失败: ' + e.message, 'error');
    return { error: e.message };
  }
}

// ========== 状态判断辅助函数（全局，供多处使用）==========
function isRunningStatus(s) {
  return ['running', 'pending', 'in_progress', 'processing', 'in_queue', 'submitted', 'submited', 'submitting'].includes(s);
}
function isDoneStatus(s) {
  return ['success', 'completed', 'done', 'finish', 'succeed'].includes(s);
}
function isFailedStatus(s) {
  return ['failed', 'error', 'fail', 'cancelled', 'canceled'].includes(s);
}

function isVideoTask(task) {
  if (!task) return false;
  if (task.kind === 'video') return true;
  if (task.kind === 'image') return false;
  const hint = `${task._url || ''} ${task.prompt || ''}`.toLowerCase();
  if (hint.includes('video') || hint.includes('motion')) return true;
  if (hint.includes('image') || hint.includes('photo') || hint.includes('picture')) return false;
  return false;
}

// ========== 核心调度逻辑 ==========
async function pollAndSchedule() {
  log(`[DEBUG] pollAndSchedule called. running=${state.running}`);
  if (!state.running) return;

  log('🔄 轮询任务状态...');

  // 1. 从页面获取当前任务快照（content.js 已主动拉过API）
  const pageData = await fetchTaskList();
  if (!pageData) {
    log('[DEBUG] fetchTaskList returned null. No tab or error.');
    return;
  }

  const allTasks = (pageData.allTasks || []).filter(isVideoTask);
  const activeTasksSnapshot = (pageData.activeTasksSnapshot || []).filter(isVideoTask);

  // 2. 以 allTasks 为参考更新 activeTasks
  //    核心原则：
  //    - 只有 API 明确返回 success/failed 才算结束
  //    - "找不到" 绝不立即删除，要累积 missCount
  //    - missCount 不是靠"连续未见"触发完成，而仅用于日志警告
  //      真正的完成判断只来自 API 返回的明确状态

  const nextActive = [];
  const justDone   = [];
  const justFailed = [];

  // 当前页面/API明确告知的运行中任务，作为进行中计数的权威快照
  for (const task of activeTasksSnapshot) {
    const existing = state.activeTasks.find(t => String(t.id) === String(task.id));
    nextActive.push({
      ...(existing || {}),
      ...task,
      _missCount: 0,
      _lastSeenAt: Date.now(),
      submitTime: existing?.submitTime || task.submitTime || Date.now(),
    });
  }

  for (const task of state.activeTasks) {
    if (!isVideoTask(task)) {
      continue;
    }

    if (nextActive.find(t => String(t.id) === String(task.id))) {
      continue;
    }

    // 在 API 快照里找这个任务（按 ID 精确匹配）
    const latest = allTasks.find(t => String(t.id) === String(task.id));        
    const latestStatus = latest ? latest.status : null;

    if (latestStatus && isDoneStatus(latestStatus)) {
      // API 明确说完成了
      justDone.push({ ...task, ...latest, _missCount: 0 });
    } else if (latestStatus && isFailedStatus(latestStatus)) {
      // API 明确说失败了
      justFailed.push({ ...task, ...latest, _missCount: 0 });
    } else if (latestStatus && isRunningStatus(latestStatus)) {
      // API 明确说在进行中
      if (!nextActive.find(t => String(t.id) === String(task.id))) {     
        nextActive.push({ ...task, ...latest, _missCount: 0, _lastSeenAt: Date.now() });                                                                              
      }
    } else {
      // 页面/API都找不到，或者是 unknown 状态：
      // 只使用过往的 _lastSeenAt 来判断是否过期，绝不再强行更新 _lastSeenAt，避免形成"幽灵任务"一直卡在进行中
      const createdAt = task.submitTime || task._lastSeenAt || 0;
      const keepGrace = createdAt > 0 && (Date.now() - createdAt <= SUBMITTED_TASK_GRACE_MS);                                                                         
      
      const isActiveInSnapshot = !!activeTasksSnapshot.find(t => String(t.id) === String(task.id));
      
      if (isActiveInSnapshot) {
         if (!nextActive.find(t => String(t.id) === String(task.id))) {
             nextActive.push({ ...task, _missCount: 0, _lastSeenAt: Date.now() });
         }
      } else if (keepGrace && isRunningStatus(task.status)) {
        if (!nextActive.find(t => String(t.id) === String(task.id))) {
             nextActive.push({ ...task, _missCount: (task._missCount || 0) + 1 });
        }
      } else if ((task._lastSeenAt || 0) > 0 && (Date.now() - task._lastSeenAt <= ACTIVE_TASK_STALE_MS) && isRunningStatus(task.status)) {
        if (!nextActive.find(t => String(t.id) === String(task.id))) {
             nextActive.push({ ...task, _missCount: (task._missCount || 0) + 1 });
        }
      } else {
        log(`🧹 任务已从进行中移除: [${task.id}] ${task.prompt || ''}`, 'warn');                                                                                
      }
    }
  }  // 3. 处理完成的任务
  for (const t of justDone) {
    log(`✅ 任务完成: [${t.id}] ${t.prompt || ''}`, 'success');
    state.completedTasks.unshift({ ...t, completedAt: Date.now() });
    broadcastToPopup({ type: 'TASK_DONE', task: t });
  }

  // 4. 处理失败的任务
  for (const t of justFailed) {
    log(`❌ 任务失败: [${t.id}] ${t.prompt || ''}`, 'error');
    state.failedTasks.unshift({ ...t, failedAt: Date.now() });
    broadcastToPopup({ type: 'TASK_FAILED', task: t });
  }

  // 5. 把 API 里发现的新进行中任务追加进来（页面上已有但我们未跟踪的）
  for (const pt of allTasks) {
    if (
      isRunningStatus(pt.status) &&
      !nextActive.find(t => String(t.id) === String(pt.id)) &&
      !justDone.find(t => String(t.id) === String(pt.id)) &&
      !justFailed.find(t => String(t.id) === String(pt.id))
    ) {
      log(`🔍 发现新进行中任务: [${pt.id}] ${pt.prompt || ''} (${pt.status})`);
      nextActive.push({ ...pt, _missCount: 0, _lastSeenAt: Date.now(), submitTime: pt.submitTime || Date.now() });
    }
  }

  state.activeTasks = nextActive;

  // 6. 计算缺口，补充备用任务
  const slots = MAX_CONCURRENT - state.activeTasks.length;
  log(`当前并发: ${state.activeTasks.length}/${MAX_CONCURRENT}，备用队列: ${state.pendingTasks.length}，空位: ${slots}`);

  if (slots > 0 && state.pendingTasks.length > 0) {
    const toSubmit = state.pendingTasks.filter(task => !task.paused).slice(0, slots);
    log(`[DEBUG] slots=${slots}, pending=${state.pendingTasks.length}, unpaused toSubmit=${toSubmit.length}`);
    for (const task of toSubmit) {
      log(`📤 提交备用任务: ${task.prompt || task.id}`);
      const submitRes = await submitTask(task);
      const isConfirmedSubmit = !!(submitRes && !submitRes.error && (submitRes.taskId || submitRes.confirmed === true));
      if (isConfirmedSubmit) {
        const trackedId = submitRes.taskId || ('local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
        state.activeTasks.push({
          id: trackedId,
          kind: 'video',
          prompt: task.prompt,
          status: submitRes.taskId ? 'pending' : 'submitting',
          submitTime: Date.now(),
          params: task,
          _localOnly: !submitRes.taskId,
          _lastSeenAt: Date.now(),
          _submitDebug: submitRes.debug || null,
        });
        state.pendingTasks = state.pendingTasks.filter(t => t.id !== task.id);
        if (submitRes.taskId) {
          log(`✔ 任务提交成功，ID: ${submitRes.taskId}`, 'success');
        } else {
          log(`✔ 提交动作已触发，等待页面生成任务ID: ${task.prompt || task.id}`, 'success');
        }
      } else {
        task._submitFails = (task._submitFails || 0) + 1;
        // 失败时不从队列删除，只标记暂停并记录失败次数，用户可手动重试
        task.paused = true;
        const reason = submitRes?.error || '提交未确认';
        log(`✘ 任务提交失败(${task._submitFails}次, ${reason})，已暂停等待重试: ${task.prompt || task.id}`, 'warn');
        broadcastToPopup({ type: 'STATE_UPDATE', state: getSafeState() });
      }
    }
  }

  await saveState();
  broadcastToPopup({ type: 'STATE_UPDATE', state: getSafeState() });
}

function schedulePollSoon() {
  if (!state.running) return;
  setTimeout(() => {
    pollAndSchedule().catch(error => {
      log(`调度执行失败: ${error.message}`, 'error');
    });
  }, 0);
}

function getSafeState() {
  return {
    running: state.running,
    activeCount: state.activeTasks.length,
    pendingCount: state.pendingTasks.length,
    completedCount: state.completedTasks.length,
    failedCount: state.failedTasks.length,
    activeTasks: state.activeTasks.slice(0, 20),
    pendingTasks: state.pendingTasks.slice(0, 50),
    completedTasks: state.completedTasks.slice(0, 20),
    failedTasks: state.failedTasks.slice(0, 20),
    logs: state.logs.slice(0, 50),
  };
}

// ========== Alarm 轮询 ==========
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await pollAndSchedule();
  }
});

// ========== 消息处理 ==========
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(e => {
    sendResponse({ error: e.message });
  });
  return true; // 保持异步
});

async function handleMessage(message, sender) {
  switch (message.type) {

    case 'GET_STATE':
      return getSafeState();

    case 'START_MONITOR':
      state.running = true;
      chrome.alarms.create(ALARM_NAME, {
        delayInMinutes: 0.08, // ~5秒后启动
        periodInMinutes: POLL_INTERVAL_MS / 60000
      });
      log('▶ 监控已启动', 'success');
      await saveState();
      schedulePollSoon();
      return { ok: true };

    case 'STOP_MONITOR':
      state.running = false;
      chrome.alarms.clear(ALARM_NAME);
      log('⏹ 监控已停止', 'warn');
      await saveState();
      return { ok: true };

    case 'ADD_PENDING_TASK': {
      const task = message.task;
      task.id = task.id || 'pending_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      task.paused = !!task.paused;
      state.pendingTasks.push(task);
      log(`➕ 添加备用任务: ${task.prompt || task.id}`);
      await saveState();
      broadcastToPopup({ type: 'STATE_UPDATE', state: getSafeState() });
      if (!task.paused) schedulePollSoon();
      return { ok: true, id: task.id };
    }

    case 'ADD_PENDING_TASKS_BATCH': {
      const tasks = message.tasks || [];
      let hasRunnableTask = false;
      for (const task of tasks) {
        task.id = task.id || 'pending_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        task.paused = !!task.paused;
        if (!task.paused) hasRunnableTask = true;
        state.pendingTasks.push(task);
      }
      log(`➕ 批量添加 ${tasks.length} 个备用任务`);
      await saveState();
      broadcastToPopup({ type: 'STATE_UPDATE', state: getSafeState() });
      if (hasRunnableTask) schedulePollSoon();
      return { ok: true };
    }

    case 'REMOVE_PENDING_TASK': {
      state.pendingTasks = state.pendingTasks.filter(t => t.id !== message.taskId);
      log(`🗑 已移除备用任务: ${message.taskId}`);
      await saveState();
      broadcastToPopup({ type: 'STATE_UPDATE', state: getSafeState() });
      schedulePollSoon();
      return { ok: true };
    }

    case 'TOGGLE_PENDING_TASK_PAUSED': {
      let targetTask = null;
      state.pendingTasks = state.pendingTasks.map(task => {
        if (task.id !== message.taskId) return task;
        targetTask = { ...task, paused: !task.paused };
        return targetTask;
      });
      if (targetTask) {
        log(`${targetTask.paused ? '⏸' : '▶'} 备用任务${targetTask.paused ? '已暂停' : '已恢复'}: ${targetTask.prompt || targetTask.id}`);
        await saveState();
        broadcastToPopup({ type: 'STATE_UPDATE', state: getSafeState() });
        schedulePollSoon();
        return { ok: true, paused: targetTask.paused };
      }
      return { ok: false, error: 'Task not found' };
    }

    case 'CLEAR_PENDING':
      state.pendingTasks = [];
      await saveState();
      broadcastToPopup({ type: 'STATE_UPDATE', state: getSafeState() });
      return { ok: true };

    case 'CLEAR_COMPLETED':
      state.completedTasks = [];
      state.failedTasks = [];
      await saveState();
      broadcastToPopup({ type: 'STATE_UPDATE', state: getSafeState() });
      return { ok: true };

    case 'CLEAR_PREVIOUS_DATA':
      state.completedTasks = [];
      state.failedTasks = [];
      state.logs = [];
      await saveState();
      broadcastToPopup({ type: 'STATE_UPDATE', state: getSafeState() });
      return { ok: true };

    case 'CLEAR_LOGS':
      state.logs = [];
      await saveState();
      broadcastToPopup({ type: 'STATE_UPDATE', state: getSafeState() });
      return { ok: true };

    case 'FORCE_POLL':
      await pollAndSchedule();
      return { ok: true };

    case 'RETRY_FAILED_TASK': {
      // 重新启动某个失败的备用任务（清除失败标记，恢复待提交状态）
      state.pendingTasks = state.pendingTasks.map(task => {
        if (task.id !== message.taskId) return task;
        return { ...task, paused: false, _submitFails: 0 };
      });
      log(`🔁 重试任务: ${message.taskId}`);
      await saveState();
      broadcastToPopup({ type: 'STATE_UPDATE', state: getSafeState() });
      schedulePollSoon();
      return { ok: true };
    }

    case 'RETRY_ALL_FAILED': {
      // 重新启动所有失败的备用任务
      let retryCount = 0;
      state.pendingTasks = state.pendingTasks.map(task => {
        if (!task.paused || !(task._submitFails > 0)) return task;
        retryCount++;
        return { ...task, paused: false, _submitFails: 0 };
      });
      log(`🔁 重试全部 ${retryCount} 个失败任务`);
      await saveState();
      broadcastToPopup({ type: 'STATE_UPDATE', state: getSafeState() });
      if (retryCount > 0) schedulePollSoon();
      return { ok: true, retryCount };
    }

    case 'SYNC_ACTIVE_FROM_PAGE': {
      // content script 上报页面上检测到的进行中任务
      // 只做"新增"，不更新已有任务的状态（状态更新由 pollAndSchedule 负责）
      const pageTasks = message.tasks || [];
      let added = 0;
      for (const pt of pageTasks) {
        if (!pt.id) continue;
        if (!isVideoTask(pt)) continue;
        const exists = state.activeTasks.find(t => String(t.id) === String(pt.id));
        if (!exists && isRunningStatus(pt.status)) {
          state.activeTasks.push({
            ...pt,
            _missCount: 0,
            _lastSeenAt: Date.now(),
            submitTime: pt.submitTime || Date.now(),
          });
          added++;
        }
      }
      if (added > 0) {
        await saveState();
        broadcastToPopup({ type: 'STATE_UPDATE', state: getSafeState() });
      }
      return { ok: true };
    }

    case 'SET_MAX_CONCURRENT':
      // 未来扩展
      return { ok: true };

    default:
      return { error: 'Unknown message type' };
  }
}

// ========== 初始化 ==========
(async () => {
  await loadState();
  if (state.running) {
    // 重新启动轮询
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 0.08,
      periodInMinutes: POLL_INTERVAL_MS / 60000
    });
    log('🔁 Service Worker 重启，恢复监控');
  }
  log('✨ 即梦任务监控器已加载');
})();
