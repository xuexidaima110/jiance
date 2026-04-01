/**
 * 即梦视频任务监控器 - Content Script v2
 * 修复：支持 /ai-tool/generate 页面，主动轮询API，扩大任务识别
 */

(() => {
  'use strict';

  // ============ 状态 ============
  const intercepted = {
    tasks: {},       // taskId -> {id, status, prompt, ...}
    csrfToken: '',
    sessionId: '',
    deviceId: '',
    userId: '',
  };

  const ACTIVE_CACHE_TTL_MS = 30000;
  const FINISHED_CACHE_TTL_MS = 120000;

  function isExtensionContextValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function safeGetRuntimeUrl(path) {
    if (!isExtensionContextValid()) return null;
    try {
      return chrome.runtime.getURL(path);
    } catch {
      return null;
    }
  }

  async function safeSendRuntimeMessage(message) {
    if (!isExtensionContextValid()) return null;
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      const messageText = String(error?.message || error || '');
      if (!messageText.includes('Extension context invalidated')) {
        console.debug('[即梦监控] sendMessage 失败:', error);
      }
      return null;
    }
  }

  function isRunningStatus(status) {
    return ['running', 'pending', 'processing', 'in_queue', 'submitted'].includes(status);
  }

  function isFinishedStatus(status) {
    return ['success', 'failed'].includes(status);
  }

  function isVideoTask(task) {
    if (!task) return false;
    if (task.kind === 'video') return true;
    if (task.kind === 'image') return false;
    const hint = `${task._url || ''} ${task.prompt || ''}`.toLowerCase();       
    if (hint.includes('video') || hint.includes('motion')) return true;
    if (hint.includes('image') || hint.includes('photo') || hint.includes('picture')) return false;
    return false;
  }  function isDomVideoCard(element, text, html) {
    if (!element) return false;
    if (element.querySelector('video')) return true;
    if (element.querySelector('[class*="play"],[class*="preview-video"],[class*="video"]')) return true;
    if (text.includes('视频') || text.includes('秒')) return true;
    if ((html || '').toLowerCase().includes('<video')) return true;
    return false;
  }

  function pruneTaskCache() {
    const now = Date.now();
    for (const [taskId, task] of Object.entries(intercepted.tasks)) {
      if (!isVideoTask(task)) {
        delete intercepted.tasks[taskId];
        continue;
      }

      const lastSeenAt = task._lastSeenAt || 0;
      const ttl = isRunningStatus(task.status) ? ACTIVE_CACHE_TTL_MS : FINISHED_CACHE_TTL_MS;
      if (lastSeenAt && now - lastSeenAt > ttl) {
        delete intercepted.tasks[taskId];
      }
    }
  }

  function getVisibleTasks() {
    pruneTaskCache();
    return Object.values(intercepted.tasks).filter(isVideoTask);
  }

  function getRunningVideoTasks() {
    return getVisibleTasks().filter(task => isRunningStatus(task.status));
  }

  // 即梦已知的任务查询API列表（通过抓包整理）
  // 插件会轮流尝试，直到有效的为止
  const KNOWN_TASK_APIS = [
    '/mweb/v1/query_draft_list?workspace_id=0&count=20&offset=0&filter_type=1',
    '/mweb/v1/get_draft_list?count=20&offset=0',
    '/mweb/v1/query_draft_history?count=20&offset=0',
    '/mweb/v1/aigc_draft_list?count=20&offset=0',
    '/mweb/v1/video_draft_list?count=20',
    '/mweb/v1/works/list?page=1&size=20',
    '/api/v1/task/list?page=1&size=20',
  ];

  let activeApiPath = ''; // 记录有效的API路径

  // ============ 注入拦截脚本（在页面上下文中运行）============
  function injectInterceptor() {
    const scriptUrl = safeGetRuntimeUrl('interceptor.js');
    if (!scriptUrl) return;
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  injectInterceptor();

  // ============ 监听来自 interceptor.js 的消息 ============
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__source !== 'jimeng_interceptor') return;

    if (data.type === 'TASK_DATA') {
      // 从网络请求中捕获到的任务数据
      mergeTaskData(data.tasks || []);
    }
    if (data.type === 'AUTH_DATA') {
      // 捕获到认证信息
      if (data.csrfToken) intercepted.csrfToken = data.csrfToken;
      if (data.sessionId) intercepted.sessionId = data.sessionId;
      if (data.userId) intercepted.userId = data.userId;
      if (data.deviceId) intercepted.deviceId = data.deviceId;
    }
    if (data.type === 'SUBMIT_RESULT') {
      // 提交任务的结果
      window._jimengSubmitResolvers && window._jimengSubmitResolvers[data.reqId]?.(data.result);
    }
  });

  // 状态优先级：数字越高越可信，低优先级不能覆盖高优先级
  const STATUS_PRIORITY = {
    'unknown': 0,
    'pending': 1,
    'in_queue': 2,
    'submitted': 2,
    'processing': 3,
    'running': 3,
    'success': 10,
    'failed': 10,
  };
  function statusPriority(s) { return STATUS_PRIORITY[s] ?? 1; }

  function mergeTaskData(tasks) {
    const now = Date.now();
    for (const t of tasks) {
      if (!t.id || !isVideoTask(t)) continue;
      const prev = intercepted.tasks[t.id];
      if (!prev) {
        intercepted.tasks[t.id] = { ...t, _lastSeenAt: now };
      } else {
        // 只有新状态优先级 >= 旧状态优先级时才更新状态
        // 防止 unknown / pending 覆盖已知的 processing 状态
        const newPrio = statusPriority(t.status);
        const oldPrio = statusPriority(prev.status);
        if (newPrio >= oldPrio) {
          intercepted.tasks[t.id] = { ...prev, ...t, _lastSeenAt: now };
        } else {
          // 保留旧状态，但合并其他字段（如prompt）
          intercepted.tasks[t.id] = { ...prev, ...t, status: prev.status, _lastSeenAt: now };
        }
      }
    }
    // 上报给 background（同步活动任务）—— 扩大进行中状态的识别范围
    const runningTasks = getVisibleTasks().filter(t => {
      const s = t.status;
      return s === 'running' || s === 'pending' || s === 'processing' || s === 'in_queue' || s === 'submitted';
    });
    safeSendRuntimeMessage({ type: 'SYNC_ACTIVE_FROM_PAGE', tasks: runningTasks });
  }

  // ============ 主动轮询：在页面上下文中调用即梦API ============
  async function fetchTasksFromApi() {
    // 先用已知有效路径
    const tryPaths = activeApiPath
      ? [activeApiPath, ...KNOWN_TASK_APIS.filter(p => p !== activeApiPath)]
      : KNOWN_TASK_APIS;

    for (const path of tryPaths) {
      try {
        const resp = await fetch(path, {
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          }
        });
        if (!resp.ok) continue;
        const json = await resp.json();
        // 检查是否有任务数据（不报错且有data字段）
        if (json && (json.data || json.list || json.items || json.works)) {
          // 触发interceptor解析（通过让拦截器处理）
          window.postMessage({
            __source: 'jimeng_content',
            type: 'PARSE_RESPONSE',
            url: path,
            data: json,
          }, '*');
          if (!activeApiPath) {
            activeApiPath = path;
            console.log('[即梦监控] 发现有效API路径:', path);
          }
          return json;
        }
      } catch (e) {}
    }
    return null;
  }

  // ============ 响应 background 的消息 ============
  if (isExtensionContextValid()) chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleBgMessage(message).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  });

  async function simulateDomSubmit(params) {
    return new Promise(async (resolve) => {
      try {
        const task = params || {};
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const trace = [];
        const mark = (step, detail = '') => {
          const entry = `${new Date().toISOString()} | ${step}${detail ? ' | ' + detail : ''}`;
          trace.push(entry);
          console.log('[即梦提交流程]', entry);
        };
        const norm = t => String(t || '').replace(/\s+/g, '').trim();
        const textLike = (a, b) => {
          const x = norm(a);
          const y = norm(b);
          if (!x || !y) return false;
          return x === y || x.includes(y) || y.includes(x);
        };

        const getCandidateDocs = () => {
          const docs = [document];
          for (const frame of Array.from(document.querySelectorAll('iframe'))) {
            try {
              if (frame.contentDocument) docs.push(frame.contentDocument);
            } catch {}
          }
          return docs;
        };

        const pickWorkDoc = () => {
          let best = document;
          let score = -1;
          for (const d of getCandidateDocs()) {
            try {
              const s =
                d.querySelectorAll('textarea, [contenteditable="true"]').length * 3 +
                d.querySelectorAll('.arco-select-view, [role="combobox"], [class*="select-view"]').length * 2 +
                d.querySelectorAll('input[type="file"]').length;
              if (s > score) {
                score = s;
                best = d;
              }
            } catch {}
          }
          return best;
        };

        const workDoc = pickWorkDoc();

        const isVis = (el) => {
          if (!el || !(el instanceof Element)) return false;
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
        };

        const click = async (el) => {
          if (!el || !isVis(el)) return false;
          try {
            el.focus?.();
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy };
            if (typeof PointerEvent === 'function') {
              el.dispatchEvent(new PointerEvent('pointerdown', opts));
              el.dispatchEvent(new PointerEvent('pointerup', opts));
            }
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
            el.click?.();
            await sleep(140);
            return true;
          } catch {
            return false;
          }
        };

        const getToolbar = () =>
          workDoc.querySelector('[class*="left-panel"], [class*="sidebar"], [class*="tool"], [class*="toolbar"], [class*="control"], [class*="setting"], [class*="param"]') || workDoc.body;

        const queryAllSafe = (root, selector) => {
          try {
            return Array.from((root || workDoc).querySelectorAll(selector));
          } catch {
            return [];
          }
        };

        const LV_COMBO_SELECTOR = 'div[role="combobox"][class*="lv-select-single"]';
        const COMMON_COMBO_SELECTOR = '.arco-select-view, [class*="select-view"], [role="combobox"], .arco-trigger';

        const findByText = (keys, root) => {
          const ks = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
          const scope = root || workDoc.body;
          const all = Array.from(scope.querySelectorAll('label, span, div, p, button, li, [role]'));
          return all.find(el => {
            if (!isVis(el)) return false;
            const t = el.innerText || el.textContent || '';
            return ks.some(k => textLike(t, k));
          }) || null;
        };

        const FIELD_LABELS = {
          genMode: ['创作模式', '模式', '生成模式'],
          model: ['模型', 'Model'],
          refMode: ['参考模式', '参考', '参考强度'],
          ratio: ['视频比例', '比例', '画幅'],
          duration: ['时长', '视频时长', '片长']
        };

        const usedControls = new Set();

        const getLikelyComboRow = () => {
          const toolbar = getToolbar();

          // 方案2：父容器特征锁定（你提供的方法）
          const byHasInToolbar = queryAllSafe(toolbar, `.flex:has(> ${LV_COMBO_SELECTOR}) ${LV_COMBO_SELECTOR}`).filter(isVis);
          if (byHasInToolbar.length >= 3) {
            return byHasInToolbar.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
          }

          const byHasInDoc = queryAllSafe(workDoc, `.flex:has(> ${LV_COMBO_SELECTOR}) ${LV_COMBO_SELECTOR}`).filter(isVis);
          if (byHasInDoc.length >= 3) {
            return byHasInDoc.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
          }

          // 方案1：语义+核心类（你提供的方法）
          const lvCombos = queryAllSafe(toolbar, LV_COMBO_SELECTOR).filter(isVis);
          if (lvCombos.length >= 3) {
            return lvCombos.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
          }

          return [];
        };

        const orderedControls = () => {
          const lvRow = getLikelyComboRow();
          if (lvRow.length > 0) return lvRow;
          return queryAllSafe(getToolbar(), COMMON_COMBO_SELECTOR).filter(isVis);
        };

        const findControlByLabel = (labels, fallbackIndex) => {
          const toolbar = getToolbar();
          const labelEl = findByText(labels, toolbar) || findByText(labels, workDoc.body);
          if (labelEl) {
            let p = labelEl;
            for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
              const target = p.querySelector('.arco-select-view, [class*="select-view"], [role="combobox"], .arco-trigger');
              if (target && isVis(target) && !usedControls.has(target)) return target;
            }
          }
          const controls = orderedControls();
          if (controls[fallbackIndex] && !usedControls.has(controls[fallbackIndex])) return controls[fallbackIndex];
          const firstUnused = controls.find(ctrl => !usedControls.has(ctrl));
          return firstUnused || null;
        };

        const getHorizontalFieldControls = () => {
          const controls = orderedControls();
          if (controls.length === 0) return [];
          const withRect = controls
            .map(el => ({ el, r: el.getBoundingClientRect() }))
            .filter(item => item.r.width > 6 && item.r.height > 6)
            .sort((a, b) => (a.r.top - b.r.top) || (a.r.left - b.r.left));

          const firstCtrl = findControlByLabel(FIELD_LABELS.genMode, 0) || (withRect[0] && withRect[0].el);
          if (!firstCtrl) return controls;

          const firstRect = firstCtrl.getBoundingClientRect();
          const sameRow = withRect
            .filter(item => Math.abs(item.r.top - firstRect.top) <= 90 && item.r.right >= firstRect.left - 20)
            .sort((a, b) => a.r.left - b.r.left)
            .map(item => item.el);

          const deduped = [];
          let lastX = -99999;
          for (const el of sameRow) {
            const x = el.getBoundingClientRect().left;
            if (Math.abs(x - lastX) > 8) {
              deduped.push(el);
              lastX = x;
            }
          }

          if (deduped.length > 1 && deduped[0] !== firstCtrl) {
            const idx = deduped.indexOf(firstCtrl);
            if (idx >= 0) {
              deduped.splice(idx, 1);
              deduped.unshift(firstCtrl);
            }
          }

          return deduped.length > 0 ? deduped : controls;
        };

        const readControlText = (ctrl) => {
          if (!ctrl) return '';
          const valueEl = ctrl.querySelector('.arco-select-view-value, [class*="value"], [class*="content"]');
          return norm((valueEl?.innerText || valueEl?.textContent || ctrl.innerText || ctrl.textContent || ''));
        };

        const waitDropdown = async (timeout = 1800) => {
          const end = Date.now() + timeout;
          while (Date.now() < end) {
            const inWork = workDoc.querySelector('.arco-select-dropdown, .arco-trigger-popup, [class*="dropdown"], [class*="option-list"]');
            if (inWork && isVis(inWork)) return inWork;
            const inLv = workDoc.querySelector('.lv-select-dropdown, [class*="lv-select"][class*="dropdown"], [class*="lv-select-options"], [role="listbox"]');
            if (inLv && isVis(inLv)) return inLv;
            const inMain = document.querySelector('.arco-select-dropdown, .arco-trigger-popup, .lv-select-dropdown, [class*="dropdown"], [class*="option-list"], [role="listbox"]');
            if (inMain && isVis(inMain)) return inMain;
            await sleep(80);
          }
          return null;
        };

        const pickOption = async (optionText, options = {}) => {
          const strict = !!options.strict;
          const blockFast = !!options.blockFast;
          const target = norm(optionText || '').toLowerCase();
          const targetHasFast = /fast|极速/.test(target);

          await sleep(300);

          const nodes = [
            ...document.querySelectorAll('.arco-select-option, [role="option"], li')
          ];

          let best = null;
          let bestScore = -1;
          for (const opt of nodes) {
            if (!isVis(opt)) continue;
            const t = (opt.innerText || '').trim();
            if (!t) continue;

            const textN = norm(t).toLowerCase();
            const textHasFast = /fast|极速/.test(textN);
            if (blockFast && !targetHasFast && textHasFast) continue;

            let score = -1;
            if (textN === target) score = 3;
            else if (!strict && textLike(t, optionText)) score = 1;

            if (score > bestScore) {
              bestScore = score;
              best = opt;
            }
          }

          if (best) {
            best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            best.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await sleep(500);
            return true;
          }

          return false;
        };

        const selectField = async (fieldKey, optionText, idx, forcedCtrl) => {
          if (!optionText) return true;
          const labels = FIELD_LABELS[fieldKey] || [fieldKey];
          const ctrl = (forcedCtrl && isVis(forcedCtrl) && !usedControls.has(forcedCtrl)) ? forcedCtrl : findControlByLabel(labels, idx);
          if (!ctrl) return false;
          const current = readControlText(ctrl);
          if (current && textLike(current, optionText)) {
            usedControls.add(ctrl);
            return true;
          }
          await click(ctrl);
          await sleep(600 + Math.random() * 500);
          let ok = await pickOption(optionText);
          if (!ok) {
            await sleep(400);
            ok = await pickOption(optionText);
          }
          if (!ok) {
            workDoc.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await sleep(140);
            await click(ctrl);
            await sleep(600 + Math.random() * 500);
            ok = await pickOption(optionText);
          }
          if (ok) usedControls.add(ctrl);
          return ok;
        };

        const getPromptInput = () => {
          const ta = workDoc.querySelector('textarea.arco-input, textarea[placeholder*="提示"], textarea[placeholder*="描述"], textarea');
          if (ta && isVis(ta)) return ta;
          const ce = workDoc.querySelector('[contenteditable="true"][role="textbox"], [contenteditable="true"]');
          if (ce && isVis(ce)) return ce;
          return null;
        };

        const fillPromptText = async (text) => {
          if (!text) return true;
          const input = getPromptInput();
          if (!input) return false;
          input.focus?.();
          await sleep(70);

          if (input.tagName === 'TEXTAREA') {
            const prev = input.value || '';
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
            if (setter) setter.call(input, text);
            else input.value = text;

            const tracker = input._valueTracker;
            if (tracker && typeof tracker.setValue === 'function') tracker.setValue(prev);

            if (typeof InputEvent === 'function') {
              input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
            } else {
              input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            }
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(120);
            return textLike(input.value || '', text.slice(0, 16));
          }

          input.textContent = text;
          input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(120);
          return textLike(input.textContent || '', text.slice(0, 16));
        };

        const uploadImage = async () => {
          if (!task.imageData) return true;
          const input =
            workDoc.querySelector('input[type="file"]') ||
            document.querySelector('input[type="file"]');

          if (!input) {
            console.warn('上传 input 未找到');
            return false;
          }

          if (input.accept && !input.accept.includes('image')) {
            console.warn('上传 input 不接受图片类型:', input.accept);
            return false;
          }
          try {
            const b64 = task.imageData.split(',')[1] || task.imageData;
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const mime = (task.imageData.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
            const file = new File([arr], task.imageName || 'image.jpg', { type: mime });
            const dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(1000);
            return true;
          } catch {
            return false;
          }
        };

        const clearAllInputsBeforeSubmit = async () => {
          const promptNodes = Array.from(workDoc.querySelectorAll('textarea, [contenteditable="true"]')).filter(isVis);
          for (const node of promptNodes) {
            try {
              node.focus?.();
              if (node.tagName === 'TEXTAREA') {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
                if (setter) setter.call(node, '');
                else node.value = '';
              } else {
                node.textContent = '';
              }
              node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              node.dispatchEvent(new Event('change', { bubbles: true }));
            } catch {}
          }

          const fileInputs = Array.from(workDoc.querySelectorAll('input[type="file"]'));
          for (const input of fileInputs) {
            try {
              const emptyDt = new DataTransfer();
              input.files = emptyDt.files;
            } catch {}
            try { input.value = ''; } catch {}
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }

          const removeBtns = Array.from(workDoc.querySelectorAll('button, [role="button"], span, div'))
            .filter(el => {
              if (!isVis(el)) return false;
              const t = el.innerText || el.textContent || '';
              return textLike(t, '删除') || textLike(t, '移除') || textLike(t, '清空');
            });
          for (const btn of removeBtns.slice(0, 3)) {
            await click(btn);
            await sleep(80);
          }
        };

        const clickSubmitAtPrompt = async () => {
          const input = getPromptInput();
          const wrap = input ? (input.closest('[class*="prompt"], [class*="input"], [class*="editor"], [class*="textarea"]') || input.parentElement) : workDoc.body;
          const candidates = Array.from((wrap || workDoc.body).querySelectorAll('button, [role="button"], [aria-label]'))
            .filter(el => isVis(el) && !el.disabled);

          const strong = candidates.find(el => {
            const txt = el.innerText || el.textContent || '';
            const ar = el.getAttribute('aria-label') || '';
            const tt = el.getAttribute('title') || '';
            const cls = el.className || '';
            return textLike(txt, '提交') || textLike(txt, '生成') || textLike(ar, '提交') || textLike(ar, '生成') || textLike(tt, '提交') || textLike(tt, '生成') || /send|submit|generate/i.test(cls);
          });
          if (strong && await click(strong)) return true;

          const byPosition = candidates
            .map(el => ({ el, r: el.getBoundingClientRect() }))
            .sort((a, b) => (b.r.bottom - a.r.bottom) || (b.r.right - a.r.right));
          if (byPosition[0] && await click(byPosition[0].el)) return true;

          const smallBtn =
            workDoc.querySelector('button[type=submit]') ||
            [...document.querySelectorAll('button')].find(b =>
              b.getBoundingClientRect().width < 80 &&
              b.getBoundingClientRect().height < 80
            );
          if (smallBtn && isVis(smallBtn) && !smallBtn.disabled && await click(smallBtn)) return true;

          const globalBtn = workDoc.querySelector('[class*="send"], [class*="submit"], [class*="generate"], button[type="submit"], [aria-label*="提交"], [aria-label*="生成"]');
          if (globalBtn && isVis(globalBtn) && !globalBtn.disabled && await click(globalBtn)) return true;
          return false;
        };

        const getFocusableElements = () => {
          const selector = [
            'input:not([disabled])',
            'textarea:not([disabled])',
            'button:not([disabled])',
            '[role="combobox"]',
            '[role="button"]',
            '[tabindex]:not([tabindex="-1"])'
          ].join(',');
          return Array.from(workDoc.querySelectorAll(selector)).filter(el => isVis(el));
        };

        const advanceFocusByTab = () => {
          const focusables = getFocusableElements();
          if (focusables.length === 0) return null;
          const current = workDoc.activeElement || document.activeElement;
          let idx = focusables.findIndex(el => el === current);
          if (idx < 0) idx = 0;
          const next = focusables[(idx + 1) % focusables.length];
          next?.focus?.();
          return next || null;
        };

        const pressKey = async (key, keyCode) => {
          const code = keyCode || (key === 'Tab' ? 9 : key === 'Enter' ? 13 : key === 'ArrowUp' ? 38 : key === 'ArrowDown' ? 40 : 0);
          let target = workDoc.activeElement || document.activeElement || getPromptInput() || workDoc.body;

          if (key === 'Tab') {
            const moved = advanceFocusByTab();
            if (moved) target = moved;
          }

          const eventInit = {
            key,
            keyCode: code,
            which: code,
            bubbles: true,
            cancelable: true,
            composed: true
          };
          target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
          target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
          await sleep(120);
        };

        const focusPromptAndOpenByTab = async (tabCount) => {
          const prompt = getPromptInput();
          if (!prompt) return false;
          prompt.focus?.();
          await click(prompt);
          await sleep(220);

          for (let i = 0; i < tabCount; i++) {
            await pressKey('Tab', 9);
            await sleep(90);
          }

          await pressKey('Enter', 13);
          await sleep(320);
          return true;
        };

        const chooseByTabAndOption = async (tabCount, optionText, pickOpts = {}) => {
          const opened = await focusPromptAndOpenByTab(tabCount);
          if (!opened) return false;
          let ok = await pickOption(optionText, pickOpts);
          if (!ok) {
            await sleep(300);
            ok = await pickOption(optionText, pickOpts);
          }
          if (ok) {
            await pressKey('Enter', 13);
            await sleep(280);
          }
          return ok;
        };

        const openCreateTypeDropdown = async () => {
          const prompt = getPromptInput();
          if (!prompt) return false;
          await click(prompt);
          await sleep(180);

          const triggerCandidates = [
            ...queryAllSafe(workDoc, 'button, [role="button"], [role="combobox"], .arco-select-view, [class*="select-view"]'),
            ...queryAllSafe(document, 'button, [role="button"], [role="combobox"], .arco-select-view, [class*="select-view"]')
          ].filter(el => isVis(el));

          const trigger = triggerCandidates.find(el => {
            const t = (el.innerText || el.textContent || '').trim();
            return /Agent\s*模式|图片生成|视频生成|数字人|配音生成|动作模仿/.test(t);
          });

          if (trigger) {
            await click(trigger);
            await sleep(260);
          } else {
            const opened = await focusPromptAndOpenByTab(1);
            if (!opened) return false;
          }

          const dd = await waitDropdown(2200);
          return !!dd;
        };

        const chooseVideoGenByDropdownThird = async () => {
          const opened = await openCreateTypeDropdown();
          if (!opened) return false;

          const dd = await waitDropdown(1500);
          const root = dd || document.body;
          const all = queryAllSafe(root, 'li, [role="option"], .arco-dropdown-menu-item, .arco-select-option, [class*="option"]')
            .filter(el => isVis(el));

          const labels = ['Agent 模式', '图片生成', '视频生成', '数字人', '配音生成', '动作模仿'];
          const typed = all.filter(el => {
            const t = (el.innerText || el.textContent || '').trim();
            return labels.some(label => textLike(t, label));
          }).sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return (ra.top - rb.top) || (ra.left - rb.left);
          });

          let target = null;
          if (typed.length >= 3) {
            target = typed[2];
          } else {
            target = all.find(el => textLike((el.innerText || el.textContent || '').trim(), '视频生成')) || null;
          }

          if (!target) return false;
          await click(target);
          await sleep(320);

          const verifyModes = [
            ...queryAllSafe(workDoc, 'button, [role="button"], [role="combobox"], .arco-select-view, [class*="select-view"]'),
            ...queryAllSafe(document, 'button, [role="button"], [role="combobox"], .arco-select-view, [class*="select-view"]')
          ].filter(el => isVis(el));
          const switched = verifyModes.some(el => textLike((el.innerText || el.textContent || '').trim(), '视频生成'));
          if (!switched) {
            const exact = all.find(el => textLike((el.innerText || el.textContent || '').trim(), '视频生成'));
            if (exact) {
              await click(exact);
              await sleep(260);
            }
          }
          return true;
        };

        const ratioToPoint = (ratioText) => {
          const r = norm(ratioText).replace(/[xX×]/g, ':');
          const map = {
            '21:9': { x: 80, y: 80 },
            '16:9': { x: 200, y: 80 },
            '4:3': { x: 320, y: 80 },
            '1:1': { x: 440, y: 80 },
            '3:4': { x: 560, y: 80 },
            '9:16': { x: 680, y: 80 },
          };
          return map[r] || null;
        };

        const clickDialogAt = async (offsetX, offsetY) => {
          const dialog = workDoc.querySelector('div[role="dialog"]') || document.querySelector('div[role="dialog"]');
          if (!dialog || !isVis(dialog)) return false;

          const rect = dialog.getBoundingClientRect();
          const x = rect.left + offsetX;
          const y = rect.top + offsetY;
          const target = document.elementFromPoint(x, y) || dialog;
          const evt = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y };

          target.dispatchEvent(new MouseEvent('mousedown', evt));
          target.dispatchEvent(new MouseEvent('mouseup', evt));
          target.dispatchEvent(new MouseEvent('click', evt));
          await sleep(280);
          return true;
        };

        const chooseRatioByDialog = async (ratioText) => {
          const point = ratioToPoint(ratioText || '');
          if (!point) return false;
          const opened = await focusPromptAndOpenByTab(4);
          if (!opened) return false;

          const ok = await clickDialogAt(point.x, point.y);
          if (!ok) return false;

          const blank = workDoc.body || document.body;
          blank.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 8, clientY: 8 }));
          await sleep(220);
          return true;
        };

        const hasDuplicatePrompt = (promptText) => {
          const p = norm(promptText || '');
          if (!p) return false;
          return getVisibleTasks().some(taskItem => {
            const t = norm(taskItem?.prompt || '');
            if (!t) return false;
            return t === p || t.includes(p) || p.includes(t);
          });
        };

        const waitSubmitConfirmed = async (beforeRunningCount, beforeVisibleCount) => {
          const endAt = Date.now() + 12000;
          let lastFetchAt = 0;
          while (Date.now() < endAt) {
            if (Date.now() - lastFetchAt > 1800) {
              try { await fetchTasksFromApi(); } catch {}
              lastFetchAt = Date.now();
            }

            const runningNow = getRunningVideoTasks().length;
            if (runningNow > beforeRunningCount) {
              return { confirmed: true, signal: 'running-increased' };
            }

            const visibleNow = getVisibleTasks().length;
            if (visibleNow > beforeVisibleCount) {
              return { confirmed: true, signal: 'visible-increased' };
            }

            const input = getPromptInput();
            if (input && task.prompt) {
              if (input.tagName === 'TEXTAREA') {
                const v = norm(input.value || '');
                if (!v) return { confirmed: true, signal: 'prompt-cleared' };
              } else {
                const v = norm(input.textContent || '');
                if (!v) return { confirmed: true, signal: 'prompt-cleared' };
              }
            }

            await sleep(260);
          }
          return { confirmed: false, signal: 'no-confirm-signal' };
        };

        mark('step0', '开始清空页面状态');
        // 1) 先刷新页面内容（软刷新：清空弹层+清空输入）
        try { window.scrollTo(0, 0); } catch {}
        workDoc.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        await sleep(220);
        const clearBtn = findByText(['清空', '重置', '重新开始', '刷新'], workDoc.body);
        if (clearBtn) await click(clearBtn);
        await clearAllInputsBeforeSubmit();
        await sleep(260);

        mark('step1', `创作模式=${task.genMode || task.mode || '视频生成'}`);
        // 1) 先点击提示词框，Tab1，回车，按键选择视频生成并回车
        const genMode = task.genMode || task.mode || '视频生成';
        let ok1 = false;
        if (textLike(genMode, '视频生成')) {
          ok1 = await chooseVideoGenByDropdownThird();
        } else {
          ok1 = await chooseByTabAndOption(1, genMode);
        }
        await sleep(280);

        mark('step2', `模型=${task.model || task.modelName || ''}`);
        // 2) Tab2，回车，选择模型并回车
        const model = task.model || task.modelName || '';
        const ok2 = model ? await chooseByTabAndOption(2, model, { strict: true, blockFast: true }) : true;
        await sleep(280);

        mark('step3', `参考模式=${task.refMode || ''}`);
        // 3) Tab3，回车，选择参考模式并回车
        const refMode = task.refMode || '';
        const ok3 = refMode ? await chooseByTabAndOption(3, refMode) : true;
        await sleep(280);

        mark('step4', `比例=${task.ratio || ''}`);
        // 4) Tab4，回车，按弹窗相对坐标选比例，再点击空白关闭
        const ratio = task.ratio || '';
        const ok4 = ratio ? await chooseRatioByDialog(ratio) : true;
        await sleep(280);

        mark('step5', `时长=${task.duration || ''}`);
        // 5) Tab5，回车，选择时长并回车
        const duration = task.duration || '';
        const ok5 = duration ? await chooseByTabAndOption(5, duration) : true;
        await sleep(280);

        mark('step6', '填提示词+上传图片');
        // 6) 填提示词 + 传图片，然后回车提交
        const okPromptA = task.prompt ? await fillPromptText(task.prompt) : true;
        await sleep(120);
        const okImage = await uploadImage();
        const okPromptB = task.prompt ? await fillPromptText(task.prompt) : true;
        await sleep(180);

        if (task.prompt && hasDuplicatePrompt(task.prompt)) {
          mark('skip', '检测到重复提示词，取消提交');
          return resolve({ ok: true, confirmed: true, skipped: true, signal: 'duplicate-cancelled', debug: { ok1, ok2, ok3, ok4, ok5, okPromptA, okImage, okPromptB, trace } });
        }

        const beforeRunningCount = getRunningVideoTasks().length;
        const beforeVisibleCount = getVisibleTasks().length;

        mark('step7', '按Enter触发提交');
        await click(getPromptInput());
        await sleep(160);

        let submitted = false;
        await pressKey('Enter', 13);
        submitted = true;

        if (!submitted) {
          const endAt = Date.now() + 3000;
          while (!submitted && Date.now() < endAt) {
            submitted = await clickSubmitAtPrompt();
            await sleep(140);
          }
        }

        if (!submitted) {
          return resolve({
            error: '未找到提交按钮',
            debug: { ok1, ok2, ok3, ok4, ok5, okPromptA, okImage, okPromptB, trace }
          });
        }

        const submitConfirm = await waitSubmitConfirmed(beforeRunningCount, beforeVisibleCount);
        if (!submitConfirm.confirmed) {
          return resolve({
            error: '点击提交后未观察到任务进入队列',
            debug: { ok1, ok2, ok3, ok4, ok5, okPromptA, okImage, okPromptB, submitConfirm, trace }
          });
        }

        mark('done', `确认信号=${submitConfirm.signal}`);
        resolve({ ok: true, confirmed: true, signal: submitConfirm.signal, debug: { ok1, ok2, ok3, ok4, ok5, okPromptA, okImage, okPromptB, trace } });
      } catch (e) {
        resolve({ error: 'DOM操作异常: ' + e.message, debug: { trace } });
      }
    });
  }

  async function handleBgMessage(message) {
    switch (message.type) {

      case 'GET_TASK_LIST': {
        // 先主动拉一次API (带超时保护，防止阻塞)
        const fetchPromise = fetchTasksFromApi();
        const timeoutPromise = new Promise(resolve => setTimeout(resolve, 3000));
        await Promise.race([fetchPromise, timeoutPromise]);
        
        const domTasks = parseTasksFromDOM();
        if (domTasks.length > 0) mergeTaskData(domTasks);
        // 返回当前捕获到的所有任务
        const tasks = getVisibleTasks();
        return {
          allTasks: tasks,
          activeTasksSnapshot: getRunningVideoTasks(),
          apiAvailable: true,
        };
      }

      case 'SUBMIT_TASK': {
        const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ error: 'DOM模拟点击超时' }), 60000));
        const domPromise = simulateDomSubmit(message.params);
        const domResult = await Promise.race([domPromise, timeoutPromise]);
        
        if (domResult && !domResult.error) {
           return domResult;
        }

        console.log('[即梦监控] DOM提交失败，已禁用API兜底，直接返回错误:', domResult?.error);
        return {
          error: `DOM提交失败: ${domResult?.error || 'unknown'}`,
          apiFallbackSkipped: true,
          debug: domResult?.debug || null,
        };
      }

      case 'GET_AUTH': {
        return intercepted;
      }

      default:
        return { error: 'unknown' };
    }
  }

  // ============ DOM 观察：解析页面上的任务卡片 ============
  function parseTasksFromDOM() {
    const tasks = [];

    // 即梦视频生成页面的实际DOM结构（根据 /ai-tool/generate 页面）
    const selectors = [
      '[data-task-id]',
      '[data-id]',
      '[class*="task-item"]',
      '[class*="generate-item"]',
      '[class*="video-task"]',
      '[class*="creation-item"]',
      '[class*="history-item"]',
      '[class*="record-item"]',
      '[class*="work-item"]',
      '[class*="draft-item"]',
      '[class*="card-wrap"]',
      '[class*="GenerateItem"]',
      '[class*="TaskCard"]',
      '[class*="VideoCard"]',
    ];

    const seen = new Set();
    for (const sel of selectors) {
      let els;
      try { els = document.querySelectorAll(sel); } catch { continue; }
      for (const el of els) {
        const taskId =
          el.dataset.taskId ||
          el.dataset.id ||
          el.dataset.generateId ||
          el.getAttribute('data-task-id') ||
          el.getAttribute('data-id') ||
          el.getAttribute('data-generate-id');
        if (!taskId || seen.has(taskId)) continue;
        seen.add(taskId);

        // 推测状态（中文文本 + CSS类名）
        let status = 'unknown';
        const text = el.textContent || '';
        const html = el.innerHTML || '';

        if (
          el.querySelector('[class*="loading"],[class*="progress"],[class*="generating"],[class*="spinning"],[class*="pending"],[class*="running"]') ||
          text.includes('生成中') || text.includes('处理中') || text.includes('排队') ||
          text.includes('等待') || text.includes('提交中') || html.includes('loading')
        ) {
          status = 'processing';
        } else if (
          el.querySelector('[class*="fail"],[class*="error"],[class*="failed"]') ||
          text.includes('失败') || text.includes('错误') || text.includes('超时')
        ) {
          status = 'failed';
        } else if (
          el.querySelector('[class*="success"],[class*="done"],[class*="complete"],[class*="finish"]') ||
          text.includes('完成') || text.includes('成功') || text.includes('已生成')
        ) {
          status = 'success';
        }

        const kind = isDomVideoCard(el, text, html) ? 'video' : 'unknown';

        if (status !== 'unknown') {
          tasks.push({ id: taskId, status, source: 'dom', kind });
        }
      }
    }

    return tasks;
  }

  // 定期扫描DOM + 主动拉API
  let pollCount = 0;
  setInterval(async () => {
    const domTasks = parseTasksFromDOM();
    if (domTasks.length > 0) mergeTaskData(domTasks);

    // 每隔3次（约9秒）主动调一次API
    pollCount++;
    if (pollCount % 3 === 0) {
      await fetchTasksFromApi();
    }
  }, 3000);

  // ============ 监听即梦的自定义事件（如果有）============
  document.addEventListener('jimeng:task:update', (e) => {
    if (e.detail) mergeTaskData([e.detail]);
  });

  console.log('[即梦监控] Content script 已注入');
})();
