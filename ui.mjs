const STRINGS = {
  en: {
    title: 'WakaTime sync',
    state: 'Upload state',
    heartbeats: 'Heartbeats today',
    tokens: 'Uploaded today',
    scope: 'Upload scope',
    baselines: 'Tracked sessions',
    lastPost: 'Last upload',
    lastPoll: 'Last check',
    availability: 'Session data',
    refresh: 'Refresh',
    wakatime: 'WakaTime today',
    total: 'Total coded',
    ai: 'AI coding',
    aiTokens: 'AI tokens',
    aiModels: 'AI models',
    categories: 'Categories',
    projects: 'Projects',
    machines: 'Machines',
    noToken: 'Add an OAuth access token in the plugin settings to show WakaTime totals.',
    statsFailed: 'WakaTime stats unavailable',
    never: 'never',
    baselineHint: 'Baselines recorded. Heartbeats start with the next token increase.',
    hubHint: 'A Hub bridge is uploading every device; this plugin stands by.',
    bridgeDownHint: 'Hub bridge not reachable; uploading from this machine.',
    states: { idle: 'idle', starting: 'starting', ready: 'ready', off: 'off', 'dry-run': 'dry run', 'hub-active': 'Hub uploading', 'scope-unresolved': 'device unmatched', error: 'error' },
  },
  'zh-CN': {
    title: 'WakaTime 同步',
    state: '上报状态',
    heartbeats: '今日心跳',
    tokens: '今日已上报',
    scope: '上报范围',
    baselines: '已跟踪会话',
    lastPost: '最近上报',
    lastPoll: '上次检查',
    availability: '会话数据',
    refresh: '刷新',
    wakatime: 'WakaTime 今日',
    total: '编码总时长',
    ai: 'AI coding',
    aiTokens: 'AI token',
    aiModels: 'AI 模型',
    categories: '分类',
    projects: '项目',
    machines: '机器',
    noToken: '在插件设置里填入 OAuth access token 后，这里会显示 WakaTime 统计。',
    statsFailed: 'WakaTime 统计不可用',
    never: '尚未',
    baselineHint: '已记录基线，下一次 token 增长后开始发送心跳。',
    hubHint: '检测到 Hub 端桥正在统一上报，本插件自动待命，避免重复计数。',
    bridgeDownHint: 'Hub 桥不可达，暂由本机上报。',
    states: { idle: '空闲', starting: '启动中', ready: '正常', off: '已关闭', 'dry-run': '试运行', 'hub-active': 'Hub 接管', 'scope-unresolved': '未匹配设备', error: '出错' },
  },
  'zh-TW': {
    title: 'WakaTime 同步',
    state: '上報狀態',
    heartbeats: '今日心跳',
    tokens: '今日已上報',
    scope: '上報範圍',
    baselines: '已追蹤工作階段',
    lastPost: '最近上報',
    lastPoll: '上次檢查',
    availability: '工作階段資料',
    refresh: '重新整理',
    wakatime: 'WakaTime 今日',
    total: '編碼總時長',
    ai: 'AI coding',
    aiTokens: 'AI token',
    aiModels: 'AI 模型',
    categories: '分類',
    projects: '專案',
    machines: '機器',
    noToken: '在外掛設定裡填入 OAuth access token 後，這裡會顯示 WakaTime 統計。',
    statsFailed: 'WakaTime 統計不可用',
    never: '尚未',
    baselineHint: '已記錄基準，下一次 token 成長後開始傳送心跳。',
    hubHint: '偵測到 Hub 端的橋正在統一上報，此外掛自動待命，避免重複計數。',
    bridgeDownHint: 'Hub 橋不可達，暫由本機上報。',
    states: { idle: '閒置', starting: '啟動中', ready: '正常', off: '已關閉', 'dry-run': '試執行', 'hub-active': 'Hub 接管', 'scope-unresolved': '未匹配裝置', error: '錯誤' },
  },
};

function pickStrings() {
  const language = (navigator.language || 'en').toLowerCase();
  if (language.startsWith('zh-tw') || language.startsWith('zh-hk')) return STRINGS['zh-TW'];
  if (language.startsWith('zh')) return STRINGS['zh-CN'];
  return STRINGS.en;
}

function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat().format(Math.round(value));
}

function formatCompact(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatTime(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function activate(ctx) {
  const t = pickStrings();

  return {
    mount(container, context) {
      const root = document.createElement('div');
      root.className = 'wakatime-sync';
      root.innerHTML = `
        <div class="wakatime-sync__head">
          <span class="wakatime-sync__title"></span>
          <span class="wakatime-sync__pill" data-field="state"></span>
          <button class="wakatime-sync__refresh" type="button"></button>
        </div>
        <div class="wakatime-sync__grid">
          <div class="wakatime-sync__stat"><span data-label="heartbeats"></span><strong data-field="heartbeats">—</strong></div>
          <div class="wakatime-sync__stat"><span data-label="tokens"></span><strong data-field="tokens">—</strong></div>
          <div class="wakatime-sync__stat"><span data-label="scope"></span><strong data-field="scope">—</strong></div>
          <div class="wakatime-sync__stat"><span data-label="baselines"></span><strong data-field="baselines">—</strong></div>
          <div class="wakatime-sync__stat"><span data-label="lastPost"></span><strong data-field="lastPost">—</strong></div>
          <div class="wakatime-sync__stat"><span data-label="lastPoll"></span><strong data-field="lastPoll">—</strong></div>
          <div class="wakatime-sync__stat"><span data-label="availability"></span><strong data-field="availability">—</strong></div>
        </div>
        <p class="wakatime-sync__hint" data-field="hint" hidden></p>
        <p class="wakatime-sync__error" data-field="error" hidden></p>
        <div class="wakatime-sync__section">
          <div class="wakatime-sync__section-head"><span></span></div>
          <div class="wakatime-sync__waka" data-field="waka"></div>
        </div>`;
      container.append(root);

      const query = selector => root.querySelector(selector);
      const setText = (selector, text) => {
        const node = query(selector);
        if (node) node.textContent = text;
      };
      setText('.wakatime-sync__title', t.title);
      setText('.wakatime-sync__section-head span', t.wakatime);
      setText('.wakatime-sync__refresh', t.refresh);
      for (const key of ['heartbeats', 'tokens', 'scope', 'baselines', 'lastPost', 'lastPoll', 'availability']) {
        setText(`[data-label="${key}"]`, t[key]);
      }

      const pill = query('[data-field="state"]');
      const hintNode = query('[data-field="hint"]');
      const errorNode = query('[data-field="error"]');
      const wakaNode = query('[data-field="waka"]');
      let unsubscribe;
      let closed = false;
      let generation = 0;

      function renderStatus(status) {
        const state = status && status.state ? status.state : 'idle';
        pill.dataset.state = state;
        pill.textContent = t.states[state] || state;
        setText('[data-field="heartbeats"]', formatNumber(status && status.counters && status.counters.heartbeats));
        const input = status && status.counters ? status.counters.input : 0;
        const output = status && status.counters ? status.counters.output : 0;
        setText('[data-field="tokens"]', `${formatCompact(input)} in · ${formatCompact(output)} out`);
        setText('[data-field="scope"]', (status && status.scope && status.scope.label) || '—');
        setText('[data-field="baselines"]', formatNumber(status && status.baselines));
        setText('[data-field="lastPost"]', formatTime(status && status.lastPostAt) || t.never);
        setText('[data-field="lastPoll"]', formatTime(status && status.lastPollAt) || t.never);
        const availability = status && status.availability ? status.availability : '—';
        setText('[data-field="availability"]', status && status.truncated ? `${availability} (partial)` : availability);
        const heartbeats = status && status.counters ? status.counters.heartbeats : 0;
        const hub = status && status.state === 'hub-active';
        const ready = status && (status.state === 'ready' || status.state === 'dry-run' || hub);
        const delegationMode = status && status.delegation ? status.delegation.mode : '';
        const bridgeDown = !hub && (delegationMode === 'bridge-unreachable' || delegationMode === 'bridge-error');
        let hint = '';
        if (hub) hint = t.hubHint;
        else if (bridgeDown) hint = t.bridgeDownHint;
        else if (ready && !heartbeats) hint = t.baselineHint;
        hintNode.hidden = !hint;
        hintNode.textContent = hint;
        if (status && status.lastError) {
          errorNode.hidden = false;
          errorNode.textContent = status.lastError;
        } else {
          errorNode.hidden = true;
          errorNode.textContent = '';
        }
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, character => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[character]);
      }

      function list(items, label) {
        if (!items || !items.length) return '';
        const rows = items.map(item => `<li><span>${escapeHtml(item.name)}</span><em>${formatDuration(item.seconds)}</em></li>`).join('');
        return `<h4>${label}</h4><ul>${rows}</ul>`;
      }

      function renderWakatime(stats) {
        const models = (stats.aiModels || []).map(model => `<li><span>${escapeHtml(model.name)}</span><em>${formatCompact(model.inputTokens + model.cachedInputTokens)} in · ${formatCompact(model.outputTokens)} out</em></li>`).join('');
        const cost = typeof stats.aiModelCostUsd === 'number' ? `$${stats.aiModelCostUsd.toFixed(2)}` : '';
        wakaNode.innerHTML = `
          <div class="wakatime-sync__totals">
            <div><span>${t.total}</span><strong>${formatDuration(stats.totalSeconds)}</strong></div>
            <div><span>${t.ai}</span><strong>${formatDuration(stats.aiSeconds)}</strong></div>
            <div><span>${t.aiTokens}</span><strong>${formatCompact(stats.aiInputTokens)} in · ${formatCompact(stats.aiOutputTokens)} out</strong></div>
          </div>
          ${models ? `<h4>${t.aiModels}${cost ? ` · ${cost}` : ''}</h4><ul>${models}</ul>` : ''}
          ${list(stats.categories, t.categories)}
          ${list(stats.projects, t.projects)}
          ${list(stats.machines, t.machines)}`;
      }

      async function loadWakatime() {
        const request = ++generation;
        try {
          const stats = await ctx.backend.call('wakatime-stats');
          if (closed || request !== generation) return;
          renderWakatime(stats);
        } catch (error) {
          if (closed || request !== generation) return;
          const message = /No OAuth access token/.test(error.message) ? t.noToken : `${t.statsFailed}: ${error.message}`;
          wakaNode.innerHTML = `<p class="wakatime-sync__hint">${escapeHtml(message)}</p>`;
        }
      }

      async function refresh() {
        const button = query('.wakatime-sync__refresh');
        button.disabled = true;
        try {
          const status = await ctx.backend.call('refresh');
          if (!closed) renderStatus(status);
          await loadWakatime();
        } catch (error) {
          if (!closed) {
            errorNode.hidden = false;
            errorNode.textContent = error.message;
          }
        } finally {
          button.disabled = false;
        }
      }

      query('.wakatime-sync__refresh').addEventListener('click', refresh);
      try {
        unsubscribe = ctx.backend.subscribe(renderStatus);
      } catch (error) {
        errorNode.hidden = false;
        errorNode.textContent = error.message;
      }
      void loadWakatime();

      return {
        update(next) {
          if (next && next.visible === false) return;
          void next;
        },
        dispose() {
          closed = true;
          generation++;
          unsubscribe?.();
          root.remove();
        },
      };
    },
  };
}
