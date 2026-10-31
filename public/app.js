const { createApp, ref, computed, onMounted, nextTick } = Vue;

// Desktop IPC 检测与环境判断
const isDesktop = typeof window !== 'undefined' && Boolean(window.desktop && typeof window.desktop.request === 'function');
const desktopPlatform = (isDesktop && window.desktop.platform) ? window.desktop.platform : '';

/**
 * 统一 API 请求 Helper:
 * - Desktop 模式: await window.desktop.request(path, options) 返回 { ok, status, data }
 * - Web 模式: fetch(path, options) 读取并解析 JSON
 * - 两者对 !ok 均抛出含有服务端 message/error 的 Error
 * - 返回兼容 Response 语义对象 { ok, status, data, json: async () => data }，避免重复反序列化
 */
async function apiFetch(path, options = {}) {
  let ok = false;
  let status = 0;
  let data = null;

  const method = (options.method || 'GET').toUpperCase();
  let body = options.body;
  const headers = { ...(options.headers || {}) };

  if (body !== undefined && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof URLSearchParams)) {
    body = JSON.stringify(body);
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  if (isDesktop) {
    const res = await window.desktop.request(path, { method, headers, body });
    ok = Boolean(res && res.ok);
    status = (res && res.status) ? res.status : (ok ? 200 : 500);
    data = res ? res.data : null;
  } else {
    const res = await fetch(path, { method, headers, body });
    ok = res.ok;
    status = res.status;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = text;
      }
    } else {
      data = null;
    }
  }

  if (!ok) {
    let errorMsg = `请求失败 (HTTP ${status})`;
    if (data && typeof data === 'object') {
      errorMsg = data.error || data.message || errorMsg;
    } else if (typeof data === 'string' && data.trim()) {
      errorMsg = data.trim();
    }
    const err = new Error(errorMsg);
    err.status = status;
    err.data = data;
    throw err;
  }

  return {
    ok: true,
    status,
    data,
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data))
  };
}

createApp({
  setup() {
    const loading = ref(false);
    const configBusy = ref(false);
    const applying = ref(false);
    const restoring = ref(false);
    const savingGroup = ref(false);
    const savingListener = ref(false);
    const savingSub = ref(false);
    const deletingGroup = ref({});
    const deletingListener = ref({});
    const deletingSub = ref({});

    const currentTab = ref('listeners');
    const status = ref({ mihomoRunning: false, coreVersion: '', activeProfile: '' });
    const subscriptions = ref({});
    const groups = ref([]);
    const listeners = ref([]);
    const nodes = ref([]);
    const backups = ref([]);
    const toasts = ref([]);
    const expandedGroups = ref({});
    const subRefreshing = ref({});
    const testingPorts = ref(false);
    const portTestResults = ref([]);
    const portTestingState = ref({});

    // Speed Test & Selection reactive states
    const groupTestUrls = ref({});
    const groupTimeouts = ref({});
    const groupDelays = ref({});
    const groupStats = ref({});
    const groupTesting = ref({});
    const singleTesting = ref({});
    const selectingNode = ref({});
    const sortByDelay = ref({});
    const frozenGroupNodes = ref({});

    // Computed O(1) 节点名索引映射，避免遍历 O(N) find
    const nodeByName = computed(() => {
      const map = new Map();
      const list = nodes.value || [];
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        if (n && n.name) map.set(n.name, n);
      }
      return map;
    });

    const urlPresets = [
      { label: '✨ Gemini API (推荐)', url: 'https://generativelanguage.googleapis.com' },
      { label: 'Gemini 网页', url: 'https://gemini.google.com' },
      { label: 'Google 204', url: 'https://www.gstatic.com/generate_204' },
      { label: 'Cloudflare', url: 'https://cp.cloudflare.com/generate_204' },
      { label: 'OpenAI API', url: 'https://api.openai.com/v1/models' }
    ];

    // 保持现有 4 个 Tab，不扩展规则管理
    const tabs = [
      { id: 'listeners', name: '独立端口路由', icon: 'radio' },
      { id: 'groups', name: '代理组与策略', icon: 'layers' },
      { id: 'subscriptions', name: '多订阅池', icon: 'cloud-download' },
      { id: 'backups', name: '诊断与备份', icon: 'shield-check' }
    ];

    // Modals state
    const listenerModal = ref({ open: false, isEdit: false, form: { port: 7891, name: '', proxy: '', udp: true } });
    const groupModal = ref({ open: false, isEdit: false, form: { name: '', type: 'select', use: [], filter: '', testUrl: 'https://www.google.com/generate_204', interval: 300, includeActiveProfile: true } });
    const subModal = ref({ open: false, isEdit: false, form: { id: '', name: '', url: '', prefix: '' } });

    const showToast = (message, type = 'info') => {
      const id = Date.now() + Math.random();
      toasts.value.push({ id, message, type });
      setTimeout(() => removeToast(id), 5000);
    };

    const removeToast = (id) => {
      toasts.value = toasts.value.filter(t => t.id !== id);
    };

    const copyText = async (txt) => {
      try {
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(txt);
        } else {
          const input = document.createElement('textarea');
          input.value = txt;
          input.style.position = 'fixed';
          input.style.opacity = '0';
          document.body.appendChild(input);
          input.select();
          document.execCommand('copy');
          document.body.removeChild(input);
        }
        showToast(`已复制到剪贴板: ${txt}`, 'success');
      } catch (e) {
        showToast(`复制失败: ${e.message}`, 'error');
      }
    };

    const formatTime = (ts) => {
      if (!ts) return '未同步';
      try {
        const d = new Date(ts);
        return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch(e) {
        return ts;
      }
    };

    /**
     * 全局加载数据：
     * - 使用 Promise.allSettled 确保某个接口故障时保留其他已加载数据，不把故障伪装成空列表
     * - 首次加载与静默刷新均优雅保留先前状态
     */
    const loadAllData = async () => {
      loading.value = true;
      try {
        const results = await Promise.allSettled([
          apiFetch('/api/status').then(r => r.json()),
          apiFetch('/api/subscriptions').then(r => r.json()),
          apiFetch('/api/groups').then(r => r.json()),
          apiFetch('/api/listeners').then(r => r.json()),
          apiFetch('/api/nodes').then(r => r.json()),
          apiFetch('/api/backups').then(r => r.json())
        ]);

        const [statusRes, subsRes, groupsRes, listenersRes, nodesRes, backupsRes] = results;
        let anyFailed = false;

        if (statusRes.status === 'fulfilled' && statusRes.value) {
          status.value = statusRes.value;
        } else if (statusRes.status === 'rejected') {
          anyFailed = true;
        }

        if (subsRes.status === 'fulfilled' && subsRes.value && typeof subsRes.value === 'object') {
          subscriptions.value = subsRes.value;
        } else if (subsRes.status === 'rejected') {
          anyFailed = true;
        }

        if (groupsRes.status === 'fulfilled' && Array.isArray(groupsRes.value)) {
          groups.value = groupsRes.value;
        } else if (groupsRes.status === 'rejected') {
          anyFailed = true;
        }

        if (listenersRes.status === 'fulfilled' && Array.isArray(listenersRes.value)) {
          listeners.value = listenersRes.value;
        } else if (listenersRes.status === 'rejected') {
          anyFailed = true;
        }

        if (nodesRes.status === 'fulfilled' && Array.isArray(nodesRes.value)) {
          nodes.value = nodesRes.value;
        } else if (nodesRes.status === 'rejected') {
          anyFailed = true;
        }

        if (backupsRes.status === 'fulfilled' && Array.isArray(backupsRes.value)) {
          backups.value = backupsRes.value;
        } else if (backupsRes.status === 'rejected') {
          anyFailed = true;
        }

        if (anyFailed && (groups.value.length > 0 || listeners.value.length > 0)) {
          showToast('部分配置接口请求失败，已保留先前显示内容', 'warning');
        }
      } catch (err) {
        showToast('加载配置数据失败: ' + err.message, 'error');
      } finally {
        loading.value = false;
        nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
      }
    };

    /**
     * 节点筛选匹配：
     * 1. 严格根据 group.use 来源订阅过滤节点
     * 2. 执行 group.filter 正则表达式匹配
     * 3. 活动配置 direct 节点由 Script.js 动态运行时合并，静态列表明确展示订阅源匹配节点
     */
    const getMatchedNodes = (group, limit = 10) => {
      if (!nodes.value || nodes.value.length === 0) return [];
      let filtered = nodes.value;

      // 按 group.use 来源订阅过滤
      if (Array.isArray(group.use)) {
        if (group.use.length === 0) {
          filtered = [];
        } else {
          const allowedProviders = new Set(group.use.map(String));
          filtered = filtered.filter(n => allowedProviders.has(String(n.provider)));
        }
      }

      // 按包含正则过滤
      if (group.filter && filtered.length > 0) {
        try {
          const cleanFilter = group.filter.replace(/^\(\?[a-z]+\)/i, '');
          const regex = new RegExp(cleanFilter, 'i');
          filtered = filtered.filter(n => regex.test(n.name));
        } catch(e) {}
      }

      return limit ? filtered.slice(0, limit) : filtered;
    };

    const getMatchedNodesCount = (group) => {
      return getMatchedNodes(group, 0).length;
    };

    /**
     * 解析节点所属的订阅 provider id。
     *
     * 订阅节点在 Mihomo 中不注册到 /proxies 顶层，单节点测速必须带上
     * provider 才能命中 /providers/proxies/{provider}/{name}/healthcheck。
     * 运行时组名（group.all）里的活动配置节点没有 provider，返回 null。
     */
    const lookupNodeProvider = (nodeName) => {
      const node = nodeByName.value.get(nodeName);
      return node && node.provider ? node.provider : null;
    };

    const toggleGroupExpand = (name) => {
      expandedGroups.value[name] = !expandedGroups.value[name];
    };

    // Subscriptions
    const openSubModal = (id = null, sub = null) => {
      if (id && sub) {
        subModal.value = { open: true, isEdit: true, form: { id, ...sub } };
      } else {
        subModal.value = { open: true, isEdit: false, form: { id: `p${Object.keys(subscriptions.value).length + 2}`, name: '', url: '', prefix: '' } };
      }
      nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    };

    const saveSub = async () => {
      if (savingSub.value) return;
      const form = subModal.value.form;
      const id = (form.id || '').trim();
      const url = (form.url || '').trim();

      if (!id) {
        showToast('订阅唯一 ID 不能为空', 'error');
        return;
      }
      if (!url) {
        showToast('订阅链接 URL 不能为空', 'error');
        return;
      }

      savingSub.value = true;
      try {
        await apiFetch('/api/subscriptions', {
          method: 'POST',
          body: {
            ...form,
            id,
            url
          }
        });
        subModal.value.open = false;
        showToast('订阅源已保存。点击「在线刷新节点」拉取节点，或写入 Script.js 后在 Verge 中生效', 'success');
        loadAllData();
      } catch(e) {
        // 400 校验失败时保留表单不关闭
        showToast('保存订阅失败: ' + e.message, 'error');
      } finally {
        savingSub.value = false;
      }
    };

    const deleteSub = async (id) => {
      if (deletingSub.value[id]) return;
      if (!confirm(`确定删除订阅「${id}」吗？\n\n删除后使用此订阅的代理组将移除此来源。`)) return;
      deletingSub.value[id] = true;
      try {
        await apiFetch(`/api/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
        showToast('订阅已删除，需重新写入配置并在 Verge 中生成生效', 'success');
        await loadAllData();
      } catch(e) {
        showToast('删除失败: ' + e.message, 'error');
      } finally {
        deletingSub.value[id] = false;
      }
    };

    const refreshSub = async (id) => {
      if (subRefreshing.value[id]) return;
      subRefreshing.value[id] = true;
      try {
        await apiFetch(`/api/subscriptions/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
        showToast(`订阅 ${id} 在线拉取完成`, 'success');
        await loadAllData();
      } catch(e) {
        showToast('刷新订阅失败: ' + e.message, 'error');
      } finally {
        subRefreshing.value[id] = false;
      }
    };

    // Listeners
    const openListenerModal = (l = null) => {
      if (l) {
        listenerModal.value = { open: true, isEdit: true, form: { ...l } };
      } else {
        listenerModal.value = { open: true, isEdit: false, form: { port: 7894, name: 'custom-in', proxy: groups.value[0]?.name || 'AGY Gemini', udp: true } };
      }
      nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    };

    const saveListener = async () => {
      if (savingListener.value) return;
      const form = listenerModal.value.form;
      const name = (form.name || '').trim();
      const port = Number(form.port);

      if (!name) {
        showToast('监听器名称不能为空', 'error');
        return;
      }
      if (!port || !Number.isInteger(port) || port < 1 || port > 65535) {
        showToast('监听端口必须是 1 到 65535 之间的整数', 'error');
        return;
      }
      if (!form.proxy) {
        showToast('请选择直连目标代理组', 'error');
        return;
      }

      savingListener.value = true;
      try {
        await apiFetch('/api/listeners', {
          method: 'POST',
          body: {
            ...form,
            name,
            port
          }
        });
        listenerModal.value.open = false;
        showToast('端口映射已保存。请在右上角点击「保存写入到 Script.js」，并在 Verge 中重新生成配置生效', 'success');
        loadAllData();
      } catch(e) {
        // 400 或 409 端口冲突时保留表单不关闭
        showToast('保存端口映射失败: ' + e.message, 'error');
      } finally {
        savingListener.value = false;
      }
    };

    const deleteListener = async (name) => {
      if (deletingListener.value[name]) return;
      if (!confirm(`确定删除端口映射「${name}」吗？`)) return;
      deletingListener.value[name] = true;
      try {
        await apiFetch(`/api/listeners/${encodeURIComponent(name)}`, { method: 'DELETE' });
        showToast('端口映射已删除，需重新写入配置并在 Verge 中生效', 'success');
        await loadAllData();
      } catch(e) {
        showToast('删除失败: ' + e.message, 'error');
      } finally {
        deletingListener.value[name] = false;
      }
    };

    // Groups
    const openGroupModal = (g = null) => {
      if (g) {
        groupModal.value = {
          open: true,
          isEdit: true,
          form: {
            name: g.name || '',
            type: g.type || 'select',
            use: Array.isArray(g.use) ? [...g.use] : [],
            filter: g.filter || '',
            testUrl: g.testUrl || 'https://www.google.com/generate_204',
            interval: g.interval !== undefined ? g.interval : 300,
            includeActiveProfile: g.includeActiveProfile !== undefined ? Boolean(g.includeActiveProfile) : true
          }
        };
      } else {
        groupModal.value = {
          open: true,
          isEdit: false,
          form: {
            name: '',
            type: 'select',
            use: Object.keys(subscriptions.value),
            filter: '(?i)(美|US)',
            testUrl: 'https://www.google.com/generate_204',
            interval: 300,
            includeActiveProfile: true
          }
        };
      }
      nextTick(() => { if (window.lucide) window.lucide.createIcons(); });
    };

    const saveGroup = async () => {
      if (savingGroup.value) return;
      const form = groupModal.value.form;
      const name = (form.name || '').trim();

      if (!name) {
        showToast('代理组名称不能为空', 'error');
        return;
      }
      if ((!form.use || form.use.length === 0) && !form.includeActiveProfile) {
        showToast('请至少勾选一个来源订阅或勾选合并活动配置', 'error');
        return;
      }

      savingGroup.value = true;
      try {
        await apiFetch('/api/groups', {
          method: 'POST',
          body: {
            ...form,
            name
          }
        });
        groupModal.value.open = false;
        showToast('代理组策略已保存。请在右上角点击「保存写入到 Script.js」，并在 Verge 中重新生成配置生效', 'success');
        loadAllData();
      } catch(e) {
        // 400 错误时保留表单不关闭
        showToast('保存代理组失败: ' + e.message, 'error');
      } finally {
        savingGroup.value = false;
      }
    };

    const deleteGroup = async (name) => {
      if (deletingGroup.value[name]) return;
      
      const boundListeners = listeners.value.filter(l => l.proxy === name);
      let confirmMsg = `确定删除代理组「${name}」吗？`;
      if (boundListeners.length > 0) {
        const portNames = boundListeners.map(l => `${l.name}(:${l.port})`).join('、');
        confirmMsg += `\n\n⚠️ 严重提示：该代理组正被 ${boundListeners.length} 个独立端口映射（${portNames}）直连。删除此代理组将同时移除这些端口！`;
      }

      if (!confirm(confirmMsg)) return;

      deletingGroup.value[name] = true;
      try {
        await apiFetch(`/api/groups/${encodeURIComponent(name)}`, { method: 'DELETE' });
        showToast('代理组已删除，需重新写入配置并在 Verge 中生效', 'success');
        await loadAllData();
      } catch(e) {
        showToast('删除失败: ' + e.message, 'error');
      } finally {
        deletingGroup.value[name] = false;
      }
    };

    // Apply Config
    const applyConfig = async () => {
      if (configBusy.value) return;
      configBusy.value = true;
      applying.value = true;

      try {
        const res = await apiFetch('/api/apply', { method: 'POST' }).then(r => r.json());

        if (res.partial || (res.providers && res.providers.some(p => !p.ok))) {
          const failedDetails = res.failedProviders && res.failedProviders.length > 0
            ? `（失败订阅: ${res.failedProviders.join(', ')}）`
            : '';
          showToast(`⚠️ Script.js 已写入，但部分订阅刷新失败${failedDetails}。请在 Clash Verge 中切换配置测试`, 'warning');
        } else if (res.success || res.ok) {
          showToast('✅ 配置已安全写入 Script.js！提示：新增代理组与端口需在 Clash Verge 中切换配置或重启内核后正式加载生效。', 'success');
        } else {
          showToast('❌ 写入失败: ' + (res.message || '未知错误'), 'error');
        }
        await loadAllData();
      } catch(e) {
        if (e.status === 409) {
          showToast('配置正在处理中 (409)，请勿重复并发提交', 'error');
        } else if (e.status === 504) {
          showToast('写入超时 (504)，Script.js 可能已在后台写入完成，请刷新面板确认，不要自动重试', 'error');
        } else {
          showToast('写入 Script.js 请求失败: ' + e.message, 'error');
        }
      } finally {
        applying.value = false;
        configBusy.value = false;
      }
    };

    const restoreBackup = async (file) => {
      if (configBusy.value) return;
      const confirmMsg = `确定回滚到脚本文件 ${file} 吗？\n\n注意：此操作仅恢复 Script.js 脚本，面板中已保存配置不会回滚；再次写入会覆盖恢复后的脚本。`;
      if (!confirm(confirmMsg)) return;

      configBusy.value = true;
      restoring.value = true;

      try {
        const res = await apiFetch('/api/backups/restore', {
          method: 'POST',
          body: { file }
        }).then(r => r.json());

        if (res.success || res.ok) {
          const noteText = res.note || '注意：面板中配置未回滚，需在 Verge 中切换配置加载生效';
          showToast(`已恢复 Script.js 到 ${res.restoredFrom || file}。${noteText}`, 'success');
          await loadAllData();
        } else {
          showToast('回滚失败: ' + (res.message || '未知错误'), 'error');
        }
      } catch(e) {
        if (e.status === 409) {
          showToast('配置正在处理中 (409)，无法同时回滚', 'error');
        } else {
          showToast('回滚异常: ' + e.message, 'error');
        }
      } finally {
        restoring.value = false;
        configBusy.value = false;
      }
    };

    /**
     * 端口测试：
     * - 保留原有测试结果，不全局清空造成布局崩溃
     * - 最多 3 并发执行，大幅减少超时等待
     * - 纯 CSS spinner 局部更新，不调用 Lucide 全页扫描
     */
    const testAllPorts = async () => {
      if (testingPorts.value) return;
      testingPorts.value = true;

      const portsToTest = Array.from(new Set([7890, ...listeners.value.map(l => Number(l.port)).filter(Boolean)]));
      
      const currentMap = new Map(portTestResults.value.map(r => [r.port, r]));
      portTestResults.value = portsToTest.map(port => currentMap.get(port) || { port, ok: null, latency: null });

      const queue = [...portsToTest];
      const worker = async () => {
        while (queue.length > 0) {
          const port = queue.shift();
          portTestingState.value[port] = true;
          const start = Date.now();
          try {
            const res = await apiFetch(`/api/test-port?port=${encodeURIComponent(port)}`).then(r => r.json());
            const idx = portTestResults.value.findIndex(r => r.port === port);
            const item = { port, ok: res.ok, latency: res.latency || (Date.now() - start) };
            if (idx !== -1) portTestResults.value[idx] = item;
            else portTestResults.value.push(item);
          } catch(e) {
            const idx = portTestResults.value.findIndex(r => r.port === port);
            const item = { port, ok: false, latency: 0 };
            if (idx !== -1) portTestResults.value[idx] = item;
            else portTestResults.value.push(item);
          } finally {
            portTestingState.value[port] = false;
          }
        }
      };

      const concurrency = Math.min(3, portsToTest.length || 1);
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      testingPorts.value = false;
    };

    // Speed Test & Selection handlers
    const getGroupTestUrl = (groupName) => {
      return groupTestUrls.value[groupName] || 'https://generativelanguage.googleapis.com';
    };

    const setGroupTestUrl = (groupName, url) => {
      groupTestUrls.value[groupName] = url;
    };

    const getGroupTimeout = (groupName) => {
      return groupTimeouts.value[groupName] || 5000;
    };

    const setGroupTimeout = (groupName, val) => {
      groupTimeouts.value[groupName] = Number(val) || 5000;
    };

    /**
     * 组内测速优化：
     * 1. 同步设置 groupTesting 防重复提交
     * 2. 冻结当前节点顺序，测速中不跳变
     * 3. 先 nextTick + rAF 让局部反馈 paint 上屏再发网络请求
     * 4. 成功不弹全局 toast，保留旧结果并就地更新
     * 5. 测速路径无全页 Lucide 图标重建
     */
    const runGroupDelayTest = async (groupName) => {
      if (groupTesting.value[groupName]) return;
      groupTesting.value[groupName] = true;

      // 冻结当前显示的节点顺序，避免测速进行中节点位置频繁跳跃
      const currentGroup = groups.value.find(g => g.name === groupName) || { name: groupName };
      const currentNodes = getGroupDisplayNodes(currentGroup, expandedGroups.value[groupName]);
      frozenGroupNodes.value[groupName] = currentNodes.map(n => n.name);

      await nextTick();
      if (typeof requestAnimationFrame === 'function') {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }

      const url = getGroupTestUrl(groupName);
      const timeout = getGroupTimeout(groupName);

      try {
        const res = await apiFetch(`/api/groups/${encodeURIComponent(groupName)}/delay`, {
          method: 'POST',
          body: { url, timeout }
        }).then(r => r.json());

        if (res && res.success && res.delays) {
          if (!groupDelays.value[groupName]) {
            groupDelays.value[groupName] = {};
          }
          groupDelays.value[groupName] = { ...groupDelays.value[groupName], ...res.delays };

          const values = Object.values(res.delays);
          const alive = values.filter(v => typeof v === 'number' && v > 0);
          const dead = values.filter(v => v === 0);
          const min = alive.length > 0 ? Math.min(...alive) : 0;
          const avg = alive.length > 0 ? Math.round(alive.reduce((a, b) => a + b, 0) / alive.length) : 0;

          groupStats.value[groupName] = {
            total: values.length,
            aliveCount: alive.length,
            deadCount: dead.length,
            fastest: min,
            avg: avg,
            testedAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          };
          // 成功不产生全局 toast，局部就地展示结果
        } else {
          showToast('测速失败: ' + (res?.message || res?.error || '未知错误'), 'error');
        }
      } catch (err) {
        showToast('测速异常: ' + err.message, 'error');
      } finally {
        groupTesting.value[groupName] = false;
        delete frozenGroupNodes.value[groupName];
        // 测速路径不触发全页 lucide 重新扫描
      }
    };

    /**
     * 单节点测速：
     * - 状态 key 包含 groupName + ':' + nodeName，避免状态串扰
     * - 测速时不弹开始/完成 toast，只保留失败报错
     * - 测速中保留旧值并在徽标处显示小 spinner
     */
    const runSingleNodeDelayTest = async (groupName, nodeName) => {
      const key = groupName + ':' + nodeName;
      if (singleTesting.value[key] || groupTesting.value[groupName]) return;
      singleTesting.value[key] = true;

      await nextTick();
      if (typeof requestAnimationFrame === 'function') {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }

      const url = getGroupTestUrl(groupName);
      const timeout = getGroupTimeout(groupName);
      const provider = lookupNodeProvider(nodeName);

      try {
        const res = await apiFetch(`/api/proxies/${encodeURIComponent(nodeName)}/delay`, {
          method: 'POST',
          body: provider ? { url, timeout, provider } : { url, timeout }
        }).then(r => r.json());

        if (res && res.success && typeof res.delay === 'number') {
          if (!groupDelays.value[groupName]) groupDelays.value[groupName] = {};
          groupDelays.value[groupName][nodeName] = res.delay;
        } else {
          showToast(`节点「${nodeName}」为订阅聚合节点，请点击上方「⚡ 开始组内测速」`, 'info');
        }
      } catch (err) {
        showToast('单节点测速失败: ' + err.message, 'error');
      } finally {
        singleTesting.value[key] = false;
      }
    };

    const isNodeTesting = (groupName, nodeName) => {
      return Boolean(
        groupTesting.value[groupName] ||
        singleTesting.value[groupName + ':' + nodeName]
      );
    };

    const selectActiveNode = async (groupName, proxyName) => {
      const key = groupName + ':' + proxyName;
      if (selectingNode.value[key]) return;
      selectingNode.value[key] = true;
      try {
        const res = await apiFetch(`/api/groups/${encodeURIComponent(groupName)}/select`, {
          method: 'POST',
          body: { proxy: proxyName }
        }).then(r => r.json());

        if (res && res.success) {
          const g = groups.value.find(item => item.name === groupName);
          if (g) g.now = proxyName;
          showToast(`已将「${proxyName}」设为「${groupName}」当前活动出口`, 'success');
        } else {
          showToast('切换节点失败: ' + (res?.message || res?.error), 'error');
        }
      } catch (err) {
        showToast('切换节点异常: ' + err.message, 'error');
      } finally {
        selectingNode.value[key] = false;
      }
    };

    const getNodeDelay = (groupName, nodeName) => {
      if (groupDelays.value && groupDelays.value[groupName] && groupDelays.value[groupName][nodeName] !== undefined) {
        return groupDelays.value[groupName][nodeName];
      }
      const found = nodeByName.value.get(nodeName);
      return found && typeof found.delay === 'number' ? found.delay : null;
    };

    const getNodeDelayText = (delay) => {
      if (delay === null || delay === undefined) return '--';
      if (delay === 0) return '超时';
      return `${delay}ms`;
    };

    const getNodeDelayBadgeClass = (delay) => {
      if (delay === null || delay === undefined) {
        return 'bg-dark-750/50 text-slate-500 border-dark-700';
      }
      if (delay === 0) {
        return 'bg-rose-950/70 text-rose-300 border-rose-500/40';
      }
      if (delay < 350) {
        return 'bg-emerald-950/70 text-emerald-300 border-emerald-500/40';
      }
      if (delay < 800) {
        return 'bg-amber-950/70 text-amber-300 border-amber-500/40';
      }
      return 'bg-orange-950/70 text-orange-300 border-orange-500/40';
    };

    const getGroupDisplayNodes = (group, isExpanded) => {
      if (!group) return [];
      let list = [];

      // 测速中冻结已有排序顺序，避免列表跳动
      if (groupTesting.value[group.name] && frozenGroupNodes.value[group.name]) {
        list = frozenGroupNodes.value[group.name].map(name => ({
          name,
          provider: lookupNodeProvider(name),
          delay: getNodeDelay(group.name, name)
        }));
        return isExpanded ? list : list.slice(0, 9);
      }

      if (Array.isArray(group.all) && group.all.length > 0) {
        list = group.all.map(name => ({
          name,
          provider: lookupNodeProvider(name),
          delay: getNodeDelay(group.name, name)
        }));
      } else {
        list = getMatchedNodes(group, 0).map(n => ({
          name: n.name,
          provider: n.provider,
          delay: getNodeDelay(group.name, n.name)
        }));
      }

      if (sortByDelay.value[group.name]) {
        list = [...list].sort((a, b) => {
          const valA = a.delay === null || a.delay === undefined ? 999999 : a.delay === 0 ? 888888 : a.delay;
          const valB = b.delay === null || b.delay === undefined ? 999999 : b.delay === 0 ? 888888 : b.delay;
          return valA - valB;
        });
      }

      return isExpanded ? list : list.slice(0, 9);
    };

    const toggleSortByDelay = (groupName) => {
      sortByDelay.value[groupName] = !sortByDelay.value[groupName];
    };

    onMounted(() => {
      loadAllData();
    });

    return {
      isDesktop,
      desktopPlatform,
      loading,
      configBusy,
      applying,
      restoring,
      savingGroup,
      savingListener,
      savingSub,
      deletingGroup,
      deletingListener,
      deletingSub,
      currentTab,
      tabs,
      status,
      subscriptions,
      groups,
      listeners,
      nodes,
      backups,
      toasts,
      expandedGroups,
      subRefreshing,
      testingPorts,
      portTestResults,
      portTestingState,
      groupTestUrls,
      groupTimeouts,
      groupDelays,
      groupStats,
      groupTesting,
      singleTesting,
      selectingNode,
      sortByDelay,
      urlPresets,
      listenerModal,
      groupModal,
      subModal,
      removeToast,
      copyText,
      formatTime,
      loadAllData,
      getMatchedNodes,
      getMatchedNodesCount,
      toggleGroupExpand,
      openSubModal,
      saveSub,
      deleteSub,
      refreshSub,
      openListenerModal,
      saveListener,
      deleteListener,
      openGroupModal,
      saveGroup,
      deleteGroup,
      applyConfig,
      restoreBackup,
      testAllPorts,
      getGroupTestUrl,
      setGroupTestUrl,
      getGroupTimeout,
      setGroupTimeout,
      runGroupDelayTest,
      runSingleNodeDelayTest,
      isNodeTesting,
      selectActiveNode,
      getNodeDelay,
      getNodeDelayText,
      getNodeDelayBadgeClass,
      getGroupDisplayNodes,
      toggleSortByDelay
    };
  }
}).mount('#app');
