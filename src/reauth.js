import { spawn } from 'node:child_process';
import { openForManualLogin, isLoggedIn } from './session.js';
import { config } from './config.js';

/**
 * Reautenticacao remota: sobe um Chromium HEADED (nao headless) num
 * display virtual (Xvfb) e expõe esse display via noVNC (websockify), para
 * que o usuario complete o login SSO da Matrix direto do browser dele
 * (aba do noVNC), sem precisar abrir nenhum app nem ter acesso SSH ao
 * servidor. O profile persistente e o MESMO usado pelo servico headless
 * normal (config.profileDir) - login feito aqui vale para as proximas
 * geracoes de relatorio.
 */
const DISPLAY = ':99';
const VNC_PORT = 5900;
const NOVNC_PORT = 6080;

const state = {
  active: false,
  loggedIn: false,
  context: null,
  procs: [],
  pollTimer: null,
};

function spawnProc(cmd, args) {
  const proc = spawn(cmd, args, { stdio: 'ignore' });
  state.procs.push(proc);
  return proc;
}

function killAllProcs() {
  for (const proc of state.procs) {
    proc.kill();
  }
  state.procs = [];
}

export function reauthStatus() {
  return { active: state.active, loggedIn: state.loggedIn };
}

export async function startReauth() {
  if (state.active) return reauthStatus();

  state.active = true;
  state.loggedIn = false;

  try {
    spawnProc('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24']);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    spawnProc('x11vnc', ['-display', DISPLAY, '-forever', '-nopw', '-quiet', '-rfbport', String(VNC_PORT)]);
    await new Promise((resolve) => setTimeout(resolve, 500));

    spawnProc('websockify', ['--web=/usr/share/novnc', String(NOVNC_PORT), `localhost:${VNC_PORT}`]);

    process.env.DISPLAY = DISPLAY;
    const { context, page } = await openForManualLogin();
    state.context = context;

    state.pollTimer = setInterval(async () => {
      const logged = await isLoggedIn(page).catch(() => false);
      if (logged) {
        state.loggedIn = true;
        await stopReauth();
      }
    }, config.loginPollIntervalMs);
  } catch (err) {
    await stopReauth();
    throw err;
  }

  return reauthStatus();
}

export async function stopReauth() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.context) {
    await state.context.close().catch(() => {});
    state.context = null;
  }
  killAllProcs();
  state.active = false;
  return reauthStatus();
}
