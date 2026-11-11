/**
 * Host half of the remote-hosts panel.
 *
 * Lists configured remote machines, checks whether each one already serves a
 * DSH web GUI, and on demand starts that GUI and opens a local SSH forward to
 * it. The browser half only renders state and posts intents; every process
 * lives here.
 */
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API = '/api/remote-hosts';
const MAX_BODY_BYTES = 8 * 1024;
// Bumped whenever the generated launcher script changes, so an install from an
// older build is rewritten instead of silently kept.
const LAUNCHER_REVISION = 3;

/** Cordis function-plugin name. */
export const name = 'remote-hosts';

/** The route carrier and the browser-trust fence. */
export const inject = ['webServer', 'connection'];

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Auto-assigned ports follow list position, so inserting a host in the middle
// would move every later one and leave open panels pointing at a dead port.
// Ports already handed out are reserved first; only then do new hosts and
// displaced ones take the next free number. Explicit ports always win.
function assignPorts(hosts, rawHosts, pinned) {
  const explicit = new Set();
  for (const raw of Array.isArray(rawHosts) ? rawHosts : []) {
    if (raw && typeof raw.id === 'string' && Number.isInteger(raw.localPort)) explicit.add(raw.id);
  }
  const used = new Set();
  const pending = [];
  // Explicit ports are claimed first so nothing can steal them, then ports
  // handed out earlier are re-claimed by id rather than by position.
  for (const host of hosts) {
    if (!explicit.has(host.id)) continue;
    used.add(host.localPort);
    pinned.set(host.id, host.localPort);
  }
  for (const host of hosts) {
    if (explicit.has(host.id)) continue;
    const kept = pinned.get(host.id);
    if (kept !== undefined && !used.has(kept)) {
      host.localPort = kept;
      used.add(kept);
    } else {
      pending.push(host);
    }
  }
  for (const host of pending) {
    let port = host.localPort;
    while (used.has(port)) port += 1;
    host.localPort = port;
    pinned.set(host.id, port);
    used.add(port);
  }
  return hosts;
}

function normalizeConfig(config) {
  const c = config ?? {};
  const transport = c.transport === 'ssh' ? 'ssh' : 'tsh';
  const raw = Array.isArray(c.hosts) ? c.hosts : [];
  const hosts = raw
    .filter((h) => h && typeof h.id === 'string' && typeof h.target === 'string')
    .map((h, index) => ({
      id: h.id,
      label: typeof h.label === 'string' && h.label ? h.label : h.id,
      target: h.target,
      login: typeof h.login === 'string' && h.login ? h.login : 'root',
      remotePort: Number.isInteger(h.remotePort) ? h.remotePort : 60727,
      localPort: Number.isInteger(h.localPort) ? h.localPort : 60728 + index,
      remoteDsh: typeof h.remoteDsh === 'string' && h.remoteDsh ? h.remoteDsh : undefined,
      // Optional per-host overrides; normally both are detected on connect.
      user: typeof h.user === 'string' && h.user ? h.user : undefined,
      remoteHome: typeof h.remoteHome === 'string' && h.remoteHome ? h.remoteHome : undefined,
      transport: h.transport === 'ssh' || h.transport === 'tsh' ? h.transport : transport,
    }));
  const sync = c.sync ?? {};
  const install = c.install ?? {};
  const discover = c.discover ?? {};
  const patterns = (value) =>
    (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter(
      (item) => typeof item === 'string' && item.length > 0,
    );
  return {
    tsh: typeof c.tsh === 'string' && c.tsh ? c.tsh : 'tsh',
    ssh: typeof c.ssh === 'string' && c.ssh ? c.ssh : 'ssh',
    hosts,
    // Machines listed above are always shown; discovery adds the rest from
    // `tsh ls`, so a machine that appears in the cluster shows up on its own.
    discover: {
      enabled: c.discover ? discover.enabled !== false : false,
      match: patterns(discover.match),
      exclude: patterns(discover.exclude),
      clusters: patterns(discover.clusters),
      login: typeof discover.login === 'string' && discover.login ? discover.login : 'root',
      ttlMs: Number.isInteger(discover.ttlMs) && discover.ttlMs >= 5000 ? discover.ttlMs : 30000,
    },
    connectTimeoutMs: Number.isInteger(c.connectTimeoutMs) ? c.connectTimeoutMs : 90000,
    sync: {
      // Local profile whose rows and keys are pushed to the host.
      profile: typeof sync.profile === 'string' && sync.profile ? sync.profile : 'desktop',
      rows: Array.isArray(sync.rows) && sync.rows.length > 0 ? sync.rows : ['agent-default-model', 'llm-pi-ai'],
      // Where per-person directories live on the host. The person's own name is
      // detected at connect time unless `remoteHome` or a host `user` is given.
      userRoot: typeof sync.userRoot === 'string' && sync.userRoot ? sync.userRoot : '/user',
      remoteHome: typeof sync.remoteHome === 'string' && sync.remoteHome ? sync.remoteHome : undefined,
      profiles:
        Array.isArray(sync.profiles) && sync.profiles.length > 0 ? sync.profiles : ['web', 'tui', 'headless'],
    },
    install: {
      // Version of @deepseek-ai/dsh to install under the account when it has none.
      version: typeof install?.version === 'string' && install.version ? install.version : 'latest',
      // Packages whose install scripts must run: without them the native parts
      // (terminal, process spawning) are missing and the remote GUI cannot work.
      allowScripts:
        Array.isArray(install?.allowScripts) && install.allowScripts.length > 0
          ? install.allowScripts
          : ['node-pty', 'koffi', '@deepseek-ai/dsh-subprocess-local', '@google/genai', 'protobufjs'],
      timeoutMs: Number.isInteger(install?.timeoutMs) ? install.timeoutMs : 1800000,
    },
  };
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return undefined;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

export function apply(ctx, config) {
  const pinnedPorts = new Map();
  let settings = normalizeConfig(config);
  assignPorts(settings.hosts, config?.hosts, pinnedPorts);
  const states = new Map();
  // Machines found by `tsh ls`; the listed ones in settings.hosts always win,
  // so an explicit entry can pin a label, a port or a different login.
  let discovered = [];
  const hostsAll = () => (discovered.length === 0 ? settings.hosts : [...settings.hosts, ...discovered]);

  const stateOf = (host) => {
    let state = states.get(host.id);
    if (!state) {
      state = { status: 'idle', url: undefined, error: undefined, forward: undefined, checking: false, remoteDsh: undefined };
      states.set(host.id, state);
    }
    return state;
  };

  for (const host of hostsAll()) stateOf(host);

  const connectionOf = () => Reflect.get(ctx, 'connection');
  const rejected = (req, res) => {
    const connection = connectionOf();
    if (!connection || typeof connection.requestRejection !== 'function') return false;
    let rejection;
    try {
      rejection = connection.requestRejection(req);
    } catch {
      return false;
    }
    if (!rejection) return false;
    sendJson(res, 403, { ok: false, code: 'rejected', message: 'request rejected by the connection trust fence' });
    return true;
  };

  const run = (command, args, timeout) =>
    new Promise((resolve) => {
      execFile(command, args, { timeout, maxBuffer: 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: Boolean(error && error.killed),
        });
      });
    });

  const sshArgs = (host, extra) => {
    if (host.transport === 'ssh') {
      return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...extra, `${host.login}@${host.target}`];
    }
    return ['ssh', `--login=${host.login}`, ...extra, host.target];
  };

  const binaryOf = (host) => (host.transport === 'ssh' ? settings.ssh : settings.tsh);

  /** Run one shell script on the remote host and return its stdout. */
  const remote = async (host, script, timeout = 30000) => {
    const args = [...sshArgs(host, []), '--', script];
    const result = await run(binaryOf(host), args, timeout);
    if (result.code !== 0 && result.stdout.trim() === '') {
      const message = result.timedOut ? 'connecting timed out' : result.stderr.trim() || `ssh exited with ${result.code}`;
      throw new Error(message);
    }
    return result.stdout;
  };

  /** Teleport's own identity: asked once per process, then reused. */
  let teleportUser;
  const teleportIdentity = async () => {
    if (teleportUser !== undefined) return teleportUser;
    teleportUser = undefined;
    const result = await run(settings.tsh, ['status', '--format=json'], 15000);
    if (result.code === 0) {
      try {
        const active = JSON.parse(result.stdout)?.active;
        const name = active?.username ?? active?.traits?.user_id?.[0] ?? active?.traits?.logins?.[0];
        if (typeof name === 'string' && name) teleportUser = name;
      } catch {
        /* leave it unknown and fall through to the other candidates */
      }
    }
    return teleportUser;
  };

  /** Candidate account names, most trustworthy first. */
  const accountCandidates = async (host) => {
    const list = [];
    if (host.user) list.push(host.user);
    if (host.transport === 'tsh') {
      const name = await teleportIdentity();
      if (name) list.push(name);
    }
    // Machine names often embed the person, e.g. devspace-alice-lq-dev-gpu-1.
    for (const token of String(host.target).split(/[^A-Za-z0-9_]+/)) {
      if (token.length >= 3) list.push(token);
    }
    list.push(host.login);
    return [...new Set(list.filter(Boolean))];
  };

  /**
   * Decide which account directory on the host belongs to this person.
   *
   * An explicit setting wins. Otherwise the candidates are checked against the
   * host itself, so a guess that names a directory nobody owns is dropped
   * instead of being trusted: nobody is sent into somebody else's directory.
   */
  const resolveHome = async (host, state) => {
    if (state.home) return state;
    const explicit = host.remoteHome ?? settings.sync.remoteHome;
    if (explicit) {
      state.home = explicit.replace(/\/+$/, '');
      state.user = explicit.split('/').filter(Boolean).pop();
      return state;
    }
    const root = settings.sync.userRoot.replace(/\/+$/, '');
    const candidates = await accountCandidates(host);
    const script = [
      `for c in ${candidates.map(quote).join(' ')}; do`,
      `  if [ -d ${quote(root)}/"$c" ]; then echo "FOUND=$c"; break; fi`,
      'done',
      'echo "HOME=$HOME"',
      'echo "LOGIN=$(id -un)"',
    ].join('\n');
    const stdout = await remote(host, script, 30000);
    const found = /^FOUND=(.+)$/m.exec(stdout)?.[1]?.trim();
    const home = /^HOME=(.+)$/m.exec(stdout)?.[1]?.trim();
    if (found) {
      state.user = found;
      state.home = `${root}/${found}`;
    } else if (home && home.startsWith(`${root}/`)) {
      state.user = home.slice(root.length + 1);
      state.home = home;
    } else if (home) {
      // No per-person directory: fall back to the login's own home rather than
      // inventing a path that does not exist.
      state.user = home.split('/').filter(Boolean).pop();
      state.home = home;
      state.homeFallback = true;
    } else {
      throw new Error(`cannot tell which account directory to use under ${root} on ${host.target}`);
    }
    return state;
  };

  /**
   * Write the launcher that gives that account its own DSH.
   *
   * The generated file is per person (`dsh-<user>`), loads that account's keys,
   * works in its directory and prefers the copy of DSH installed under it.
   */
  const ensureLauncher = async (host, state) => {
    // A launcher left by an older build may predate DSH_HOME, so rewrite it once
    // per run instead of trusting whatever is already on disk.
    if (state.launcher && state.launcherRevision === LAUNCHER_REVISION) return state.launcher;
    const home = state.home;
    const body = [
      '#!/bin/bash',
      `# Generated by the DSH remote hosts panel for ${state.user}.`,
      // DSH keeps its state under DSH_HOME. Without it the state lands in the
      // login user's home (root), and every session then opens at /root instead
      // of the account directory the panel is meant to work in.
      `export DSH_HOME=${quote(`${home}/.dsh`)}`,
      // Node installed next to the account (or installed here by the panel) is
      // not on a login shell's PATH, so put it first instead of demanding a
      // system-wide symlink.
      `export PATH=${quote(`${home}/.local/node/bin:${home}/.local/bin`)}:"$PATH"`,
      'set -a',
      // The env file only exists after a sync; a missing one must not abort.
      `[ -f ${quote(`${home}/.dsh/env`)} ] && . ${quote(`${home}/.dsh/env`)}`,
      'set +a',
      `cd ${quote(home)} || exit 1`,
      `if [ -x ${quote(`${home}/.local/bin/dsh`)} ]; then EXE=${quote(`${home}/.local/bin/dsh`)}; else EXE=$(command -v dsh); fi`,
      '[ -n "$EXE" ] || { echo "dsh is not installed for this account" >&2; exit 127; }',
      'exec "$EXE" "$@"',
      '',
    ].join('\n');
    const encoded = Buffer.from(body, 'utf8').toString('base64');
    const preferred = `/usr/local/bin/dsh-${state.user}`;
    const local = `${home}/.local/bin/dsh-${state.user}`;
    const script = [
      'set -e',
      'TMP=$(mktemp)',
      `printf %s ${quote(encoded)} | base64 -d > "$TMP"`,
      'chmod 755 "$TMP"',
      `if install -m 755 "$TMP" ${quote(preferred)} 2>/dev/null; then echo "LAUNCHER=${preferred}"; else`,
      `  mkdir -p ${quote(`${home}/.local/bin`)}`,
      `  install -m 755 "$TMP" ${quote(local)} && echo "LAUNCHER=${local}"`,
      'fi',
      'rm -f "$TMP"',
    ].join('\n');
    const stdout = await remote(host, script, 30000);
    const launcher = /^LAUNCHER=(.+)$/m.exec(stdout)?.[1]?.trim();
    if (!launcher) throw new Error(`cannot install a launcher for ${state.user} on ${host.target}`);
    state.launcher = launcher;
    state.launcherRevision = LAUNCHER_REVISION;
    return launcher;
  };

  /** The configured launcher, or one generated for the detected account. */
  const launcherFor = async (host, state) => host.remoteDsh ?? ensureLauncher(host, state);

  const probeScript = (host, state) =>
    [
      `command -v ${quote(host.remoteDsh ?? state.launcher)} >/dev/null 2>&1 && echo DSH=1 || echo DSH=0`,
      `printf 'HTTP='`,
      `curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:${host.remotePort}/ 2>/dev/null || printf '000'`,
      `printf '\\n'`,
      `grep -o 'http://127.0.0.1:${host.remotePort}/?token=[A-Za-z0-9_-]*' ${quote(`${state.home}/.dsh-web.log`)} 2>/dev/null | tail -n 1`,
      // DSH_HOME of whatever already serves that port: a server started before
      // the env file existed keeps its state in root's home, which is why its
      // sessions come up in /root.
      `printf 'DSHHOME='`,
      `for p in $(pgrep -f "web --host" 2>/dev/null); do tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | sed -n 's/^DSH_HOME=//p' | head -n 1; done | head -n 1`,
      `printf '\\n'`,
    ].join('\n');

  const parseProbe = (stdout) => {
    const dsh = /DSH=(\d)/.exec(stdout);
    const http = /HTTP=(\d{3})/.exec(stdout);
    const url = /http:\/\/[^\s'"]+token=[A-Za-z0-9_-]+/.exec(stdout);
    const dshHome = /^DSHHOME=(.*)$/m.exec(stdout)?.[1]?.trim();
    return {
      dsh: dsh ? dsh[1] === '1' : false,
      http: http ? http[1] : '000',
      url: url ? url[0] : undefined,
      dshHome: dshHome ? dshHome : undefined,
    };
  };

  const stopForward = (state) => {
    if (state.forward) {
      try {
        state.forward.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      state.forward = undefined;
    }
  };

  /**
   * Kill a tunnel left behind by an earlier run of this app.
   *
   * Quitting the app does not reap its children, so a forward started before a
   * restart keeps the local port bound while the new process has no handle on
   * it. The match is deliberately narrow — the exact `-L port:…` spec of this
   * host on a tsh/ssh command line — so nothing unrelated is touched.
   */
  const clearStaleForward = async (host) => {
    const spec = `-L ${host.localPort}:127.0.0.1:${host.remotePort}`;
    const listing = await run('/bin/sh', ['-c', 'ps -axo pid=,command='], 5000);
    for (const line of listing.stdout.split('\n')) {
      if (!line.includes(spec)) continue;
      if (!line.includes('tsh') && !line.includes('ssh')) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  };

  // A restart leaves the previous run's forwards alive; release those ports now
  // rather than at the moment someone clicks connect.
  for (const host of hostsAll()) void clearStaleForward(host);

  const startForward = (host, state) =>
    new Promise((resolve, reject) => {      const args = [
        ...sshArgs(host, ['-L', `${host.localPort}:127.0.0.1:${host.remotePort}`]),
        '--',
        'sleep 86400',
      ];
      const child = spawn(binaryOf(host), args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
      let settled = false;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        reject(new Error(message));
      };
      child.once('error', (error) => fail(`cannot start ${binaryOf(host)}: ${error.message}`));
      child.once('exit', (code) => {
        if (state.forward === child) state.forward = undefined;
        if (settled) return;
        if (/address already in use/i.test(stderr)) {
          fail(`local port ${host.localPort} is already in use; something else is holding it`);
          return;
        }
        fail(`the SSH forward exited with ${code}`);
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 4096) stderr = stderr.slice(-4096);
      });
      state.forward = child;
      setTimeout(() => {
        if (settled) return;
        if (stderr.trim() && /address already in use/i.test(stderr)) {
          fail(`local port ${host.localPort} is already in use; something else is holding it`);
          return;
        }
        if (stderr.trim() && /error|denied|fail/i.test(stderr)) {
          fail(stderr.trim().split('\n').slice(-2).join(' '));
          return;
        }
        settled = true;
        resolve();
      }, 1500);
    });

  /** Is there a DSH installed under this account's own prefix? */
  const isInstalled = async (host, state) => {
    if (state.installed !== undefined) return state.installed;
    const script = [
      // A node unpacked under the account keeps npm reachable even when the
      // machine has no system install; without this the probe would report
      // "npm missing" for a host that can actually install.
      `export PATH=${quote(`${state.home}/.local/node/bin:${state.home}/.local/bin`)}:"$PATH"`,
      `if [ -x ${quote(`${state.home}/.local/bin/dsh`)} ]; then echo "INSTALLED=1"; else echo "INSTALLED=0"; fi`,
      'echo "NODE=$(command -v node || echo -)"',
      'echo "NPM=$(command -v npm || echo -)"',
    ].join('\n');
    const stdout = await remote(host, script, 30000);
    state.installed = /^INSTALLED=1$/m.test(stdout);
    state.node = /^NODE=(.+)$/m.exec(stdout)?.[1]?.trim();
    state.npm = /^NPM=(.+)$/m.exec(stdout)?.[1]?.trim();
    return state.installed;
  };

  /**
   * Install DSH under the account's own prefix.
   *
   * Everything the account owns stays under its directory: the package in
   * `.local`, the npm cache in `.npm-cache`, and all state in `.dsh`. Nothing is
   * written to a system prefix, so one person's install cannot affect another's.
   */
  const installDsh = async (host, state) => {
    const home = state.home;
    if (!state.npm || state.npm === '-') {
      throw new Error(`npm was not found on ${host.target}; Node.js is required to install DSH under ${home}`);
    }
    const install = settings.install;
    const spec = install.version && install.version !== 'latest' ? `@deepseek-ai/dsh@${install.version}` : '@deepseek-ai/dsh@latest';
    const scripts = install.allowScripts.length > 0 ? `--allow-scripts=${install.allowScripts.join(',')}` : '';
    const script = [
      'set -e',
      `export PATH=${quote(`${home}/.local/node/bin:${home}/.local/bin`)}:"$PATH"`,
      `export npm_config_prefix=${quote(`${home}/.local`)}`,
      `export npm_config_cache=${quote(`${home}/.npm-cache`)}`,
      `mkdir -p ${quote(`${home}/.local`)} ${quote(`${home}/.npm-cache`)} ${quote(`${home}/.dsh`)}`,
      `chmod 700 ${quote(`${home}/.dsh`)} 2>/dev/null || true`,
      `npm install -g ${quote(spec)} ${scripts} --no-audit --no-fund --loglevel=error`,
      `test -x ${quote(`${home}/.local/bin/dsh`)}`,
      'echo "INSTALLED=1"',
    ]
      .join('\n')
      .trim();
    const stdout = await remote(host, script, install.timeoutMs);
    if (!/INSTALLED=1/.test(stdout)) throw new Error(`installing DSH under ${home} did not produce a dsh binary`);
    state.installed = true;
    return state;
  };

  /** Install, then carry on with the connect the panel asked for. */
  const installInBackground = (host, state) => {
    void (async () => {
      try {
        await installDsh(host, state);
        state.note = `starting DSH for ${state.user}`;
        await activate(host, state);
      } catch (error) {
        state.status = 'error';
        state.error = error instanceof Error ? error.message : String(error);
        state.note = undefined;
      }
    })();
  };

  /** Start the account's DSH and open the local forward to it. */
  const activate = async (host, state) => {
    const launcher = await launcherFor(host, state);
    const logPath = `${state.home}/.dsh-web.log`;
    const probe = parseProbe(await remote(host, probeScript(host, state), 30000));
    state.remoteDsh = probe.dsh;
    if (!probe.dsh) {
      throw new Error(
        `${launcher} is not available on ${host.target}. Install Node.js and @deepseek-ai/dsh under ${state.home} first.`,
      );
    }
    // A URL in the log only counts when something actually answers on the
    // port; a log left behind by a process that has since died would
    // otherwise hand back a link to nothing.
    const answering = probe.http !== '000';
    let url = answering ? probe.url : undefined;
    // A server started before DSH_HOME existed keeps its state in the login
    // user's home, so its sessions come up in /root. Restart it instead of
    // handing out a URL that opens in the wrong directory.
    const expectedHome = `${state.home}/.dsh`;
    if (url && probe.dshHome !== expectedHome) url = undefined;
    if (!url) {
      // Without a token we cannot reuse whatever already answers on that port,
      // so the plugin owns the lifecycle: replace the listener with its own.
      await remote(
        host,
        [
          // Match on the listen address rather than the executable: a launcher
          // `exec`s the real entry point, so neither its path nor the script
          // name survives in the command line.
          //
          // Both facts are kept in shell variables on purpose. If the script
          // text spelled out "127.0.0.1" and the port, `pkill -f` would match
          // the very shell running it — its command line is this script — and
          // the SSH session would die with status 255.
          'ADDR=127.0.0.1',
          `PORT=${host.remotePort}`,
          `pkill -f "web --host $ADDR --port $PORT" >/dev/null 2>&1 || true`,
          'sleep 1',
          `setsid nohup ${quote(launcher)} web --host "$ADDR" --port "$PORT" --no-open > ${quote(logPath)} 2>&1 < /dev/null &`,
          'echo STARTED',
        ].join('\n'),
        30000,
      );
      const deadline = Date.now() + settings.connectTimeoutMs;
      while (!url && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const again = parseProbe(await remote(host, probeScript(host, state), 30000));
        if (again.http !== '000') url = again.url;
      }
      if (!url) throw new Error('the remote DSH started but did not report a URL within the timeout');
    }
    stopForward(state);
    // A forward left over from a previous run keeps the port bound, and the
    // new one would exit with "address already in use" before it ever connects.
    await clearStaleForward(host);
    await startForward(host, state);
    const local = new URL(url);
    local.protocol = 'http:';
    local.hostname = '127.0.0.1';
    local.port = String(host.localPort);
    state.url = local.toString();
    state.status = 'online';
    return state;
  };

  const connect = async (host, state) => {
    state.status = 'connecting';
    state.error = undefined;
    state.note = undefined;
    try {
      // Which account this is, and whether that account already has its own
      // DSH, are both settled before anything starts: the started process must
      // belong to that account and read that account's state directory.
      await resolveHome(host, state);
      if (!(await isInstalled(host, state))) {
        // A first install downloads a few gigabytes. Doing that inside one HTTP
        // response would outlive the server's request timeout and strand the
        // panel, so it runs in the background and the panel polls the status.
        state.status = 'installing';
        state.note = `installing DSH under ${state.home}`;
        installInBackground(host, state);
        return state;
      }
      await activate(host, state);
      return state;
    } catch (error) {
      state.status = 'error';
      state.error = error instanceof Error ? error.message : String(error);
      stopForward(state);
      throw error;
    }
  };

  const describe = (host) => {
    const state = stateOf(host);
    return {
      id: host.id,
      label: host.label,
      target: host.target,
      login: host.login,
      transport: host.transport,
      localPort: host.localPort,
      remotePort: host.remotePort,
      // Filled in once the account has been identified on the host.
      user: state.user,
      remoteHome: state.home,
      launcher: state.launcher,
      status: state.status,
      url: state.url,
      error: state.error,
      note: state.note,
      installed: state.installed,
      lastSync: state.lastSync,
      // True when the row came from `tsh ls` rather than the config file.
      discovered: host.discovered === true,
    };
  };

  const hostById = (id) => hostsAll().find((host) => host.id === id);

  // The panel polls the list route every few seconds, so re-read the profile
  // layer there: our own row was only read once, at activation, and editing
  // cordis.patch.yml otherwise means restarting the whole app to see a new host.
  let yamlParse;
  const yamlParser = async () => {
    if (yamlParse !== undefined) return yamlParse;
    try {
      yamlParse = (await import('yaml')).parse;
    } catch {
      yamlParse = null;
    }
    return yamlParse;
  };

  const patchFile = () => {
    const dir = process.env.DSH_PROFILE_DIR
      ?? (process.env.DSH_PROFILE ? join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE) : undefined);
    return dir ? join(dir, 'cordis.patch.yml') : undefined;
  };

  // Entries may sit at the top level or inside another entry's `insert` list.
  const remoteHostsRow = (document) => {
    let found;
    const visit = (entries) => {
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.id === 'remote-hosts') found = entry;
        else if (Array.isArray(entry.insert)) visit(entry.insert);
      }
    };
    visit(document);
    return found;
  };

  let lastPatchText;
  const refreshFromDisk = async () => {
    const file = patchFile();
    if (!file) return;
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return;
    }
    // Concurrency and unchanged files both bail out here: only a real edit
    // re-reads the document, so polling stays one stat-free string compare.
    if (text === lastPatchText) return;
    lastPatchText = text;
    const parse = await yamlParser();
    if (!parse) return;
    let row;
    try {
      row = remoteHostsRow(parse(text));
    } catch {
      return;
    }
    if (!row || typeof row.config !== 'object' || row.config === null) return;
    // Any failure past this point would leave the panel without our config, so
    // an unreadable document keeps the settings already in effect.
    let next;
    try {
      next = normalizeConfig(row.config);
      assignPorts(next.hosts, row.config.hosts, pinnedPorts);
    } catch {
      return;
    }
    const live = new Set([...next.hosts, ...discovered].map((host) => host.id));
    for (const [id, state] of states) {
      if (live.has(id)) continue;
      stopForward(state);
      states.delete(id);
    }
    settings = next;
    for (const host of hostsAll()) stateOf(host);
  };

  const globMatch = (name, pattern) => {
    if (!pattern.includes('*')) return name.includes(pattern);
    const source = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${source}$`).test(name);
  };
  const matchesAny = (name, patterns) => patterns.length === 0 || patterns.some((p) => globMatch(name, p));

  // Replace the discovered set wholesale: a machine that leaves the cluster has
  // to leave the panel too, and its tunnel has to be dropped.
  const publishDiscovered = (nodes) => {
    const listed = new Set(settings.hosts.map((host) => host.target));
    const next = nodes
      .filter((node) => !listed.has(node.hostname))
      .sort((a, b) => a.hostname.localeCompare(b.hostname))
      .map((node, index) => ({
        id: node.hostname,
        label: node.hostname,
        target: node.hostname,
        login: settings.discover.login,
        remotePort: 60727,
        localPort: 60728 + index,
        transport: 'tsh',
        discovered: true,
      }));
    assignPorts([...settings.hosts, ...next], [], pinnedPorts);
    const live = new Set([...settings.hosts, ...next].map((host) => host.id));
    for (const [id, state] of states) {
      if (live.has(id)) continue;
      stopForward(state);
      states.delete(id);
    }
    discovered = next;
    for (const host of next) stateOf(host);
  };

  let discoveredAt = 0;
  let discovering = false;
  const discoverHosts = async () => {
    const options = settings.discover;
    if (!options.enabled || discovering) return;
    if (Date.now() - discoveredAt < options.ttlMs) return;
    discovering = true;
    try {
      const result = await run(settings.tsh, ['ls', '--format=json'], 10000);
      // An expired login or an unreachable proxy must not empty the panel.
      if (result.code !== 0) return;
      let document;
      try {
        document = JSON.parse(result.stdout);
      } catch {
        return;
      }
      if (!Array.isArray(document)) return;
      const nodes = [];
      for (const item of document) {
        const hostname = item?.spec?.hostname;
        if (typeof hostname !== 'string' || !hostname) continue;
        const cluster = item?.metadata?.labels?.cluster;
        if (options.clusters.length > 0 && !options.clusters.includes(cluster)) continue;
        if (!matchesAny(hostname, options.match)) continue;
        if (options.exclude.some((pattern) => hostname.includes(pattern))) continue;
        nodes.push({ hostname, cluster });
      }
      publishDiscovered(nodes);
    } finally {
      discoveredAt = Date.now();
      discovering = false;
    }
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}/list`,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('allow', 'GET');
            res.end();
            return;
          }
          await refreshFromDisk();
          await discoverHosts();
          sendJson(res, 200, { ok: true, hosts: hostsAll().map(describe) });
        },
      }),
    'remote-hosts: list route',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}/connect`,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('allow', 'POST');
            res.end();
            return;
          }
          const body = await readJsonBody(req);
          await refreshFromDisk();
          await discoverHosts();
          const host = hostById(body?.id);
          if (!host) {
            sendJson(res, 404, { ok: false, message: 'unknown host id' });
            return;
          }
          const state = stateOf(host);
          if (state.checking) {
            sendJson(res, 200, { ok: true, host: describe(host) });
            return;
          }
          state.checking = true;
          try {
            await connect(host, state);
            sendJson(res, 200, { ok: true, host: describe(host) });
          } catch (error) {
            sendJson(res, 200, { ok: false, host: describe(host), message: state.error });
          } finally {
            state.checking = false;
          }
        },
      }),
    'remote-hosts: connect route',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}/disconnect`,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('allow', 'POST');
            res.end();
            return;
          }
          const body = await readJsonBody(req);
          const host = hostById(body?.id);
          if (!host) {
            sendJson(res, 404, { ok: false, message: 'unknown host id' });
            return;
          }
          const state = stateOf(host);
          stopForward(state);
          state.status = 'idle';
          state.url = undefined;
          state.error = undefined;
          sendJson(res, 200, { ok: true, host: describe(host) });
        },
      }),
    'remote-hosts: disconnect route',
  );

  /** Where the pushed configuration is read from on this computer. */
  const localSources = () => {
    const home = homedir();
    return {
      patch: join(home, '.dsh', 'profiles', settings.sync.profile, 'cordis.patch.yml'),
      credentials: join(home, '.dsh', '.credentials.yaml'),
    };
  };

  /** Keep the named row blocks verbatim, in their original order. */
  const pickRows = (text, ids) => {
    const lines = text.split('\n');
    const starts = [];
    lines.forEach((line, index) => {
      const match = /^- id:\s*(.+?)\s*$/.exec(line);
      if (match) starts.push({ index, id: match[1] });
    });
    const blocks = [];
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index];
      if (!ids.includes(start.id)) continue;
      const end = index + 1 < starts.length ? starts[index + 1].index : lines.length;
      blocks.push(lines.slice(start.index, end).join('\n').replace(/\s+$/, ''));
    }
    return blocks.join('\n\n');
  };

  /** Read the `refs:` entries: names to plaintext secrets. */
  const pickKeys = (text) => {
    const keys = new Map();
    for (const line of text.split('\n')) {
      const match = /^\s{2}([A-Z][A-Z0-9_]*):\s*(\S.*)$/.exec(line);
      if (match) keys.set(match[1], match[2].trim().replace(/^['"]|['"]$/g, ''));
    }
    return keys;
  };

  /**
   * Push the local model rows and credentials to the host.
   *
   * The host reads provider keys from its environment, not from a credentials
   * file, so the pushed result is one patch per profile plus one private env
   * file. Local values win; the host copy is rewritten whole.
   */
  const syncHost = async (host, state) => {
    const sources = localSources();
    const patchText = await readFile(sources.patch, 'utf8').catch(() => undefined);
    if (!patchText) throw new Error(`cannot read the local profile patch at ${sources.patch}`);
    const rows = pickRows(patchText, settings.sync.rows);
    if (!rows.trim()) throw new Error(`none of ${settings.sync.rows.join(', ')} is in ${sources.patch}`);
    const credentials = await readFile(sources.credentials, 'utf8').catch(() => undefined);
    const keys = credentials ? pickKeys(credentials) : new Map();
    if (keys.size === 0) throw new Error(`no credentials found at ${sources.credentials}`);

    const header = [
      '# Pushed from this computer by the remote hosts panel.',
      `# Source: ${sources.patch}`,
      '# Local values win: change them locally and sync again.',
    ].join('\n');
    const patchContent = `${header}\n\n${rows}\n`;
    const envContent = [
      '# Model credentials pushed from this computer by the remote hosts panel.',
      ...[...keys].map(([key, value]) => `export ${key}='${value.replace(/'/g, `'\\''`)}'`),
      `export DSH_HOME=${state.home}/.dsh`,
      '',
    ].join('\n');

    const profiles = settings.sync.profiles;
    const patchPaths = profiles.map((profile) => `${state.home}/.dsh/profiles/${profile}/cordis.patch.yml`);
    const envPath = `${state.home}/.dsh/env`;
    const script = [
      'set -e',
      'umask 077',
      ...patchPaths.map((path) => `mkdir -p $(dirname ${quote(path)})`),
      `printf %s ${quote(Buffer.from(patchContent, 'utf8').toString('base64'))} | base64 -d > /tmp/dsh-sync-rows.yml`,
      ...patchPaths.map((path) => `cp /tmp/dsh-sync-rows.yml ${quote(path)}`),
      `printf %s ${quote(Buffer.from(envContent, 'utf8').toString('base64'))} | base64 -d > ${quote(envPath)}`,
      `chmod 600 ${quote(envPath)}`,
      'rm -f /tmp/dsh-sync-rows.yml',
      'echo SYNCED',
    ].join('\n');

    const stdout = await remote(host, script, 60000);
    if (!stdout.includes('SYNCED')) throw new Error('the host did not confirm the sync');
    return { user: state.user, home: state.home, keys: keys.size, profiles, envPath, patchPaths };
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}/sync`,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('allow', 'POST');
            res.end();
            return;
          }
          const body = await readJsonBody(req);
          const host = hostById(body?.id);
          if (!host) {
            sendJson(res, 404, { ok: false, message: 'unknown host id' });
            return;
          }
          const state = stateOf(host);
          try {
            await resolveHome(host, state);
            const report = await syncHost(host, state);
            state.lastSync = new Date().toISOString();
            sendJson(res, 200, { ok: true, host: describe(host), report });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 200, { ok: false, host: describe(host), message });
          }
        },
      }),
    'remote-hosts: sync route',
  );

  ctx.effect(
    () => () => {
      for (const state of states.values()) stopForward(state);
    },
    'remote-hosts: forward cleanup',
  );
}
