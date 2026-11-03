window.__ModuleLoader__.load({
  id: 'dsh-remote-hosts',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'remoteHosts';

    const DICT = {
      en: {
        title: 'Remote hosts',
        description: 'Connect a machine and work on it through its own DSH GUI.',
        connect: 'Connect',
        connecting: 'Connecting…',
        disconnect: 'Disconnect',
        open: 'Open',
        copy: 'Copy link',
        copied: 'Copied',
        online: 'online',
        idle: 'not connected',
        error: 'failed',
        retrying: 'checking…',
        installing: 'installing…',
        empty: 'No host is configured. Add entries under this plugin in cordis.patch.yml.',
        localPort: 'local port',
        remotePort: 'remote port',
        sync: 'Sync config',
        syncing: 'Syncing…',
        syncHint: 'Push this computer\u2019s model providers, default model and API keys to the host. Local values win.',
        lastSync: 'config synced',
        neverSynced: 'config never synced',
        account: 'account',
        accountPending: 'account detected on first connect',
        hint: 'The GUI opens on the remote machine: every tool, the file tree and the terminal run there, not on this computer.',
      },
      zh: {
        title: '远程主机',
        description: '连接一台机器，用它自己的 DSH 界面在上面工作。',
        connect: '连接',
        connecting: '连接中…',
        disconnect: '断开',
        open: '打开',
        copy: '复制链接',
        copied: '已复制',
        online: '在线',
        idle: '未连接',
        error: '失败',
        retrying: '检测中…',
        installing: '安装 DSH 中…',
        empty: '还没有配置主机。在这个插件的 cordis.patch.yml 配置里添加。',
        localPort: '本地端口',
        remotePort: '远端端口',
        sync: '同步配置',
        syncing: '同步中…',
        syncHint: '把本机的模型 provider、默认模型和 API key 推送到这台机器。以本地为准。',
        lastSync: '配置已同步',
        neverSynced: '配置未同步',
        account: '账户',
        accountPending: '首次连接时自动识别账户',
        hint: '打开的是那台机器上的 DSH：工具、文件树、终端都在远端运行，不在本机。',
      },
    };

    const CSS = `
.rh-root { height: 100%; overflow: auto; background: var(--dsw-alias-bg-base); }
.rh-inner { max-width: 880px; margin: 0 auto; padding: 28px 24px 48px; }
.rh-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
.rh-title { font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0; }
.rh-sub { font-size: 13px; color: var(--dsw-alias-label-secondary); margin: 0 0 22px; line-height: 1.5; }
.rh-list { display: flex; flex-direction: column; gap: 10px; }
.rh-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px; background: var(--dsw-alias-bg-layer-1); }
.rh-row { display: flex; align-items: center; gap: 12px; }
.rh-main { flex: 1; min-width: 0; }
.rh-name { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); display: flex; align-items: center; gap: 8px; }
.rh-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rh-sync { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 4px; opacity: 0.85; }
.rh-note { color: var(--dsw-alias-state-warn-primary); opacity: 1; }
.rh-dot.installing { background: var(--dsw-alias-state-warn-primary); animation: rh-pulse 1.4s ease-in-out infinite; }
@keyframes rh-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.rh-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-idle-primary); }
.rh-dot.online { background: var(--dsw-alias-state-success-primary); }
.rh-dot.error { background: var(--dsw-alias-state-error-primary); }
.rh-dot.connecting { background: var(--dsw-alias-state-warn-primary); }
.rh-badge { font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.rh-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.rh-btn { height: 28px; padding: 0 12px; border-radius: 7px; font-size: 12px; font-weight: 500; cursor: pointer; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary); }
.rh-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.rh-btn:disabled { opacity: 0.55; cursor: default; }
.rh-btn.primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.rh-err { margin-top: 10px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); word-break: break-word; }
.rh-url { margin-top: 10px; display: flex; align-items: center; gap: 8px; }
.rh-link { flex: 1; min-width: 0; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-brand-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rh-empty { border: 1px dashed var(--dsw-alias-border-l1); border-radius: 10px; padding: 24px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.rh-hint { margin-top: 22px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
`;

    /** Build the translator once; never call it during render setup as a hook. */
    function translator(ctx) {
      try {
        const locale = ctx.get('locale');
        if (locale && typeof locale.register === 'function') {
          locale.register(NS, { en: DICT.en, zh: DICT.zh });
          const translate = locale.bind(NS);
          return (key) => {
            const value = translate(key);
            return typeof value === 'string' && value !== key ? value : DICT.zh[key] ?? key;
          };
        }
      } catch {
        /* fall through to the built-in copy */
      }
      return (key) => DICT.zh[key] ?? key;
    }

    async function api(path, init) {
      const response = await fetch(path, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
      if (!response.ok) throw new Error(data?.message || `${response.status} ${response.statusText}`);
      return data;
    }

    function HostCard(props) {
      const { host, busy, syncing, onConnect, onDisconnect, onSync, t } = props;
      const [copied, setCopied] = React.useState(false);
      const status = busy ? 'connecting' : host.status;
      const label =
        status === 'online'
          ? t('online')
          : status === 'error'
            ? t('error')
            : status === 'installing'
              ? t('installing')
              : status === 'connecting'
                ? t('retrying')
                : t('idle');
      return h(
        'div',
        { className: 'rh-card' },
        h(
          'div',
          { className: 'rh-row' },
          h('div', { className: 'rh-main' },
            h('div', { className: 'rh-name' },
              h('span', { className: `rh-dot ${status}` }),
              host.label,
            ),
            h('div', { className: 'rh-meta' },
              `${host.login}@${host.target} · ${host.transport} · ${t('localPort')} ${host.localPort} → ${t('remotePort')} ${host.remotePort}`,
            ),
            h('div', { className: 'rh-sync' },
              host.remoteHome
                ? `${t('account')} ${host.user} → ${host.remoteHome}`
                : t('accountPending'),
            ),
            host.note
              ? h('div', { className: 'rh-sync rh-note' }, host.note)
              : null,
            h('div', { className: 'rh-sync' },
              host.lastSync
                ? `${t('lastSync')} ${new Date(host.lastSync).toLocaleString()}`
                : t('neverSynced'),
            ),
          ),
          h('div', { className: 'rh-actions' },
            h('span', { className: 'rh-badge' }, label),
            h('button', {
              className: 'rh-btn',
              onClick: () => onSync(host.id),
              disabled: syncing,
              title: t('syncHint'),
            }, syncing ? t('syncing') : t('sync')),
            status === 'online'
              ? h('button', {
                  className: 'rh-btn',
                  onClick: () => onDisconnect(host.id),
                  disabled: busy,
                }, t('disconnect'))
              : h('button', {
                  className: 'rh-btn primary',
                  onClick: () => onConnect(host.id),
                  disabled: busy || status === 'installing',
                }, status === 'installing' ? t('installing') : busy ? t('connecting') : t('connect')),
          ),
        ),
        host.url && status === 'online'
          ? h('div', { className: 'rh-url' },
              h('a', {
                className: 'rh-link',
                href: host.url,
                target: '_blank',
                rel: 'noreferrer noopener',
                title: host.url,
              }, host.url),
              h('button', {
                className: 'rh-btn',
                onClick: () => {
                  try {
                    window.open(host.url, '_blank', 'noopener');
                  } catch {
                    /* the link above stays available */
                  }
                },
              }, t('open')),
              h('button', {
                className: 'rh-btn',
                onClick: async () => {
                  try {
                    await navigator.clipboard.writeText(host.url);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {
                    /* clipboard may be unavailable */
                  }
                },
              }, copied ? t('copied') : t('copy')),
            )
          : null,
        host.error ? h('div', { className: 'rh-err' }, host.error) : null,
      );
    }

    function Panel(props) {
      const t = props.t;
      const [hosts, setHosts] = React.useState([]);
      const [busyId, setBusyId] = React.useState(undefined);
      const [syncingId, setSyncingId] = React.useState(undefined);
      const [failure, setFailure] = React.useState(undefined);

      const refresh = React.useCallback(async () => {
        try {
          const data = await api('/api/remote-hosts/list');
          setHosts(data?.hosts ?? []);
          setFailure(undefined);
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error));
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        const tick = () => {
          if (!alive) return;
          refresh();
        };
        tick();
        const timer = setInterval(tick, 5000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [refresh]);

      const connect = async (id) => {
        setBusyId(id);
        try {
          const data = await api('/api/remote-hosts/connect', { method: 'POST', body: JSON.stringify({ id }) });
          setHosts((current) => current.map((host) => (host.id === id ? data.host : host)));
          if (data?.ok && data.host?.url) {
            try {
              window.open(data.host.url, '_blank', 'noopener');
            } catch {
              /* blocked popups fall back to the link */
            }
          }
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error));
        } finally {
          setBusyId(undefined);
        }
      };

      const disconnect = async (id) => {
        setBusyId(id);
        try {
          const data = await api('/api/remote-hosts/disconnect', { method: 'POST', body: JSON.stringify({ id }) });
          setHosts((current) => current.map((host) => (host.id === id ? data.host : host)));
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error));
        } finally {
          setBusyId(undefined);
        }
      };

      const sync = async (id) => {
        setSyncingId(id);
        try {
          const data = await api('/api/remote-hosts/sync', { method: 'POST', body: JSON.stringify({ id }) });
          setHosts((current) => current.map((host) => (host.id === id ? data.host : host)));
          setFailure(data?.ok ? undefined : data?.message ?? 'sync failed');
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error));
        } finally {
          setSyncingId(undefined);
        }
      };

      return h('div', { className: 'rh-root' },
        h('style', null, CSS),
        h('div', { className: 'rh-inner' },
          h('div', { className: 'rh-head' }, h('h1', { className: 'rh-title' }, t('title'))),
          h('p', { className: 'rh-sub' }, t('description')),
          hosts.length === 0
            ? h('div', { className: 'rh-empty' }, failure ?? t('empty'))
            : h('div', { className: 'rh-list' },
                hosts.map((host) =>
                  h(HostCard, {
                    key: host.id,
                    host,
                    busy: busyId === host.id,
                    syncing: syncingId === host.id,
                    onConnect: connect,
                    onDisconnect: disconnect,
                    onSync: sync,
                    t,
                  }),
                ),
              ),
          failure && hosts.length > 0 ? h('div', { className: 'rh-err' }, failure) : null,
          h('p', { className: 'rh-hint' }, t('hint')),
          h('p', { className: 'rh-hint' }, t('syncHint')),
        ),
      );
    }

    function PanelIcon(props) {
      const size = props?.size ?? 16;
      const active = props?.active === true;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
      },
        h('rect', {
          x: 1.75, y: 2.25, width: 12.5, height: 4.5, rx: 1.25,
          stroke: 'currentColor', strokeWidth: 1.2,
        }),
        h('rect', {
          x: 1.75, y: 9.25, width: 12.5, height: 4.5, rx: 1.25,
          stroke: 'currentColor', strokeWidth: 1.2,
        }),
        h('circle', { cx: 4.35, cy: 4.5, r: 0.85, fill: 'currentColor' }),
        h('circle', { cx: 4.35, cy: 11.5, r: 0.85, fill: 'currentColor' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const t = translator(ctx);
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'remote-hosts', order: 20, label: () => t('title') }, PanelIcon),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'remote-hosts' }, (props) => h(Panel, { ...props, t })),
        );
      },
    };
  },
});
