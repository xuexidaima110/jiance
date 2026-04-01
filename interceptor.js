/**
 * 即梦视频任务监控器 - Interceptor v2（在页面上下文中运行）
 * 修复：扩大URL匹配范围、增加调试dump、支持即梦真实API结构
 */
(function () {
  'use strict';

  // 调试开关：开启后在控制台打印所有捕获到的请求
  const DEBUG = true;

  // ============ 任务状态归一化 ============
  // 即梦实际状态码（通过抓包验证）：
  // generate_status: 50=成功, 40=失败, 10=待处理, 20=处理中, 30=排队
  function normalizeStatus(raw) {
    if (raw === undefined || raw === null) return 'unknown';
    const n = Number(raw);
    if (!isNaN(n) && n !== 0) {
      if (n === 10) return 'pending';
      if (n === 20) return 'processing';
      if (n === 30) return 'in_queue';
      if (n === 40) return 'failed';
      if (n === 50) return 'success';
      if (n > 50)   return 'success';   // 兜底
      if (n > 40)   return 'failed';
      if (n > 0)    return 'processing'; // 其他正数=进行中
    }
    const s = String(raw).toLowerCase();
    if (['success', 'done', 'completed', 'finish', 'succeed'].includes(s)) return 'success';
    if (['failed', 'error', 'fail', 'cancelled', 'canceled'].includes(s)) return 'failed';
    if (['running', 'processing', 'in_progress', 'generating', 'submited', 'submitted'].includes(s)) return 'processing';
    if (['pending', 'queued', 'in_queue', 'waiting', 'queue'].includes(s)) return 'pending';
    return s;
  }

  function inferTaskKind(node, url) {
    const lowerUrl = String(url || '').toLowerCase();
    const textHints = [
      node?.draft_type,
      node?.item_type,
      node?.generate_type,
      node?.content_type,
      node?.biz_type,
      node?.type,
      node?.mode,
      node?.scene,
      node?.req_json?.draft_type,
      node?.req_json?.generate_type,
      node?.req_json?.content_type,
      node?.req_json?.mode,
    ].filter(Boolean).map(String).join('|').toLowerCase();

    if (
      node?.req_json?.video_time !== undefined ||
      node?.req_json?.fps !== undefined ||
      node?.video_time !== undefined ||
      node?.fps !== undefined ||
      node?.duration !== undefined ||
      node?.video_url ||
      node?.video_urls ||
      node?.play_url ||
      node?.preview_video_url ||
      lowerUrl.includes('video') ||
      textHints.includes('video') ||
      textHints.includes('motion')
    ) {
      return 'video';
    }

    if (
      lowerUrl.includes('image') ||
      textHints.includes('image') ||
      textHints.includes('picture') ||
      textHints.includes('photo')
    ) {
      return 'image';
    }

    return 'unknown';
  }

  // ============ 从响应体中提取任务 ============
  function extractTasks(url, data) {
    if (!data) return [];
    const tasksMap = {}; // 用Map去重，同一ID只保留优先级最高的状态

    let obj;
    try {
      obj = typeof data === 'string' ? JSON.parse(data) : data;
    } catch (e) {
      return [];
    }

    // 状态优先级（数字越大越可信）
    function statusPrio(s) {
      const map = { unknown: 0, pending: 1, in_queue: 2, submitted: 2, processing: 3, running: 3, success: 10, failed: 10 };
      return map[s] ?? 1;
    }

    // 递归深度搜索所有节点
    function findTasks(node, depth) {
      if (!node || depth > 8) return;

      if (Array.isArray(node)) {
        node.forEach(item => findTasks(item, depth + 1));
        return;
      }
      if (typeof node !== 'object') return;

      // 即梦任务对象必须有明确的任务ID字段（不用 node.id，太泛）
      // generate_id / item_id / task_id / work_id / aigc_id 都是即梦特有字段
      const id =
        node.generate_id ||
        node.item_id ||
        node.task_id ||
        node.work_id ||
        node.workId ||
        node.aigc_id;
        // 注意：故意不包含 node.video_id 和 node.id，避免把非任务对象误识别

      // 状态字段（generate_status 是即梦核心字段，优先）
      const statusRaw =
        node.generate_status ??
        node.item_status ??
        node.task_status ??
        node.video_status;
        // 注意：不用 node.status，避免普通响应对象被误识别

      if (id && statusRaw !== undefined) {
        const normalStatus = normalizeStatus(statusRaw);
        const kind = inferTaskKind(node, url);
        // 提取提示词
        const prompt =
          node.req_json?.prompt_text ||
          node.req_json?.text ||
          node.prompt_text ||
          node.prompt ||
          node.description ||
          node.title ||
          '';

        const task = {
          id: String(id),
          kind,
          status: normalStatus,
          statusRaw,
          prompt,
          createTime: node.create_time || node.created_at || node.submit_time || Date.now(),
          updateTime: node.update_time || node.updated_at || Date.now(),
          source: 'api',
          _url: url,
        };

        // 去重：同一ID保留优先级更高的状态
        const existing = tasksMap[task.id];
        if (!existing || statusPrio(normalStatus) >= statusPrio(existing.status)) {
          tasksMap[task.id] = task;
          if (DEBUG) {
            console.log('%c[即梦监控] 捕获任务', 'color:#a78bfa;font-weight:bold', task);
          }
        }
        return; // 找到任务节点后不再往里深挖，防止嵌套结构重复提取
      }

      // 继续往下搜索所有字段
      for (const key of Object.keys(node)) {
        const val = node[key];
        if (val && typeof val === 'object') {
          findTasks(val, depth + 1);
        }
      }
    }

    findTasks(obj, 0);
    return Object.values(tasksMap);

  }

  // ============ 判断是否是即梦相关请求（大幅放宽） ============
  function isJimengApiUrl(url) {
    if (!url) return false;
    // 同站相对路径 或 包含即梦域名的绝对路径
    // 即梦实际API路径通常是 /mweb/v1/... 或 /api/... 或 /dreamina/...
    if (url.startsWith('/')) return true; // 同站所有请求都拦截
    try {
      const u = new URL(url);
      return (
        u.hostname.includes('jianying.com') ||
        u.hostname.includes('jimeng') ||
        u.hostname.includes('bytedance') ||
        u.hostname.includes('byteimg') ||
        u.hostname.includes('dreamina')
      );
    } catch {
      return false;
    }
  }

  // 进一步判断是否是任务查询/生成相关API（用于重点提取）
  function isTaskRelatedUrl(url) {
    if (!url) return false;
    const keywords = [
      'generate', 'video', 'task', 'work', 'history', 'creation',
      'draft', 'aigc', 'item', 'query', 'list', 'status', 'poll',
      'dreamina', 'submit', 'record'
    ];
    const lower = url.toLowerCase();
    return keywords.some(k => lower.includes(k));
  }

  // ============ 拦截 Fetch ============
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const [input, init] = args;
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
    const response = await origFetch.apply(this, args);

    if (isJimengApiUrl(url)) {
      const cloned = response.clone();
      cloned.text().then(text => {
        // 调试：打印所有捕获的API请求
        if (DEBUG && isTaskRelatedUrl(url)) {
          try {
            const parsed = JSON.parse(text);
            console.log('%c[即梦监控][Fetch] ' + url, 'color:#60a5fa', parsed);
          } catch {
            console.log('%c[即梦监控][Fetch] ' + url, 'color:#60a5fa', text.slice(0, 200));
          }
        }

        if (isTaskRelatedUrl(url)) {
          const tasks = extractTasks(url, text);
          if (tasks.length > 0) {
            window.postMessage({ __source: 'jimeng_interceptor', type: 'TASK_DATA', tasks }, '*');
          }
        }

        // 捕获认证信息
        const reqHeaders = init?.headers || {};
        const headerObj = reqHeaders instanceof Headers
          ? Object.fromEntries(reqHeaders.entries())
          : (typeof reqHeaders === 'object' ? reqHeaders : {});
        const csrfToken =
          headerObj['x-csrf-token'] ||
          headerObj['csrf-token'] ||
          headerObj['x-tt-csrf-token'] ||
          headerObj['X-CSRFToken'] || '';
        const userId = headerObj['x-user-id'] || headerObj['x-uid'] || '';
        if (csrfToken || userId) {
          window.postMessage({ __source: 'jimeng_interceptor', type: 'AUTH_DATA', csrfToken, userId }, '*');
        }
      }).catch(() => {});
    }

    return response;
  };

  // ============ 拦截 XMLHttpRequest ============
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._jimengUrl = url;
    this._jimengMethod = method;
    this._jimengHeaders = {};
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._jimengHeaders) this._jimengHeaders[name.toLowerCase()] = value;
    return origSetRequestHeader.apply(this, [name, value]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this._jimengUrl || '';
    if (isJimengApiUrl(url)) {
      this.addEventListener('load', function () {
        try {
          const text = this.responseText;
          if (DEBUG && isTaskRelatedUrl(url)) {
            try {
              const parsed = JSON.parse(text);
              console.log('%c[即梦监控][XHR] ' + url, 'color:#34d399', parsed);
            } catch {
              console.log('%c[即梦监控][XHR] ' + url, 'color:#34d399', text.slice(0, 200));
            }
          }
          if (isTaskRelatedUrl(url)) {
            const tasks = extractTasks(url, text);
            if (tasks.length > 0) {
              window.postMessage({ __source: 'jimeng_interceptor', type: 'TASK_DATA', tasks }, '*');
            }
          }
        } catch (e) {}
      });
    }
    return origSend.apply(this, [body]);
  };

  // ============ 判断是否是即梦任务相关URL（保留兼容旧代码） ============
  function isJimengTaskUrl(url) {
    return isJimengApiUrl(url) && isTaskRelatedUrl(url);
  }

  // ============ 监听 content script 的消息 ============
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__source !== 'jimeng_content') return;

    if (data.type === 'SUBMIT_TASK') {
      const result = await doSubmitTask(data.params, data.reqId);
      window.postMessage({
        __source: 'jimeng_interceptor',
        type: 'SUBMIT_RESULT',
        reqId: data.reqId,
        result,
      }, '*');
    }

    // content script 主动拉到的API响应，让interceptor解析
    if (data.type === 'PARSE_RESPONSE') {
      const tasks = extractTasks(data.url, data.data);
      if (tasks.length > 0) {
        window.postMessage({ __source: 'jimeng_interceptor', type: 'TASK_DATA', tasks }, '*');
        console.log('[即梦监控] 主动轮询解析到', tasks.length, '个任务');
      } else if (DEBUG) {
        console.log('[即梦监控] 主动轮询响应（无任务）:', data.url, data.data);
      }
    }
  });

  /**
   * 在页面上下文中提交视频生成任务
   * 通过调用即梦的内部API实现
   */
  async function doSubmitTask(params, reqId) {
    try {
      // 获取页面的认证token（从cookie和meta标签）
      const csrfToken = getCsrfToken();
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'X-CSRF-Token': csrfToken,
      };

      // 即梦视频生成API（通过抓包获得的常见接口格式）
      // 实际路径可能因版本而异，这里列出已知的几种
      const apiUrls = [
        '/mweb/v1/generate_video_item',
        '/mweb/v1/video_draft/create',
        '/mweb/v1/aigc_drafts',
        '/api/v1/generate',
      ];

      // 构造请求体
      const body = buildTaskBody(params);

      // 尝试各API端点
      for (const apiPath of apiUrls) {
        try {
          const resp = await origFetch(apiPath, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            credentials: 'include',
          });
          if (resp.ok) {
            const json = await resp.json();
            // 提取任务ID
            const taskId = json?.data?.generate_id || json?.data?.task_id || json?.data?.id || json?.task_id;
            if (taskId) {
              return { taskId: String(taskId), raw: json };
            }
          }
        } catch (e) {}
      }

      return { error: '所有API端点均失败' };
    } catch (e) {
      return { error: e.message };
    }
  }

  function buildTaskBody(params) {
    // 即梦视频生成请求体格式（基于常见抓包格式）
    return {
      req_json: {
        prompt_text: params.prompt || '',
        negative_prompt: params.negativePrompt || '',
        width: params.width || 1280,
        height: params.height || 720,
        seed: params.seed ?? -1,
        sample_steps: params.steps || 50,
        video_time: params.duration || 5,
        fps: params.fps || 24,
        ...(params.imageUrl ? { image_urls: [params.imageUrl] } : {}),
        ...(params.extra || {}),
      },
      draft_type: params.draftType || 'video',
    };
  }

  function getCsrfToken() {
    // 尝试从meta标签获取
    const meta = document.querySelector('meta[name="csrf-token"]') ||
                  document.querySelector('meta[name="tt-csrf-token"]');
    if (meta) return meta.getAttribute('content') || '';

    // 从cookie获取
    const match = document.cookie.match(/(?:tt_csrf_token|csrf_token|_csrf)=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  console.log('[即梦监控] Interceptor 已注入到页面上下文');
})();
