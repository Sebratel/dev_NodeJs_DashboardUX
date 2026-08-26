import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openForManualLogin, isLoggedIn, saveSessionState } from './session.js';
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
  pollPage: null,
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

/**
 * Se o processo Node reiniciar (crash, redeploy) sem passar por
 * stopReauth(), Xvfb/x11vnc/websockify/Chromium ficam orfaos rodando -
 * state.procs (em memoria) esquece deles, mas eles continuam disputando
 * as mesmas portas (5900/6080) e o mesmo profileDir com a proxima
 * chamada, causando conexoes que ficam presas em "Connecting..." no
 * noVNC. Mata por nome antes de subir um conjunto novo, para garantir
 * que so exista UM de cada.
 */
function killStrayProcesses() {
  spawnSync('pkill', ['-9', '-f', 'Xvfb :99']);
  spawnSync('pkill', ['-9', '-f', 'x11vnc']);
  spawnSync('pkill', ['-9', '-f', 'websockify']);
  // Chromium headed do playwright: identificado pelo profileDir na linha
  // de comando (--user-data-dir=...), nao ha flag "--headless=false" real.
  spawnSync('pkill', ['-9', '-f', config.profileDir]);

  // pkill -9 mata o processo mas nao da chance dele apagar os proprios
  // arquivos de lock (SingletonLock/SingletonSocket/SingletonCookie) do
  // profileDir - sobrevivem ao kill e travam qualquer launch seguinte com
  // "profile appears to be in use by another Chromium process", mesmo com
  // o processo antigo ja morto. Precisa apagar manualmente.
  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    fs.rmSync(path.join(config.profileDir, lockFile), { force: true });
  }
}

export function reauthStatus() {
  return { active: state.active, loggedIn: state.loggedIn };
}

export async function startReauth() {
  console.log('[reauth] startReauth chamado. active atual=', state.active);
  if (state.active) return reauthStatus();

  // Precisa ser síncrono, ANTES de qualquer await - senão duas chamadas
  // POST /reauth/start em sequência rápida (ex.: duplo clique, ou o
  // usuário recarregando a página e clicando de novo antes da primeira
  // resposta voltar) passam ambas pelo "if (state.active)" acima enquanto
  // ainda é false, e cada uma sobe seu próprio Xvfb/x11vnc/websockify -
  // exatamente o problema de processos duplicados que killStrayProcesses
  // devia evitar.
  state.active = true;
  state.loggedIn = false;

  killStrayProcesses();
  console.log('[reauth] processos orfaos mortos, subindo Xvfb/x11vnc/websockify...');
  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    spawnProc('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24']);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // -noxdamage: Xvfb nao implementa a extensao XDAMAGE corretamente: sem
    // essa flag o x11vnc entra num loop de polling a ~100% de CPU e trava
    // (nunca completa o handshake RFB com novos clientes - noVNC preso em
    // "Connecting..." para sempre). Sintoma observado em producao.
    spawnProc('x11vnc', [
      '-display', DISPLAY,
      '-forever',
      '-nopw',
      '-quiet',
      '-noxdamage',
      '-rfbport', String(VNC_PORT),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 500));

    spawnProc('websockify', ['--web=/usr/share/novnc', String(NOVNC_PORT), `localhost:${VNC_PORT}`]);
    console.log('[reauth] Xvfb/x11vnc/websockify no ar, abrindo Chromium headed...');

    process.env.DISPLAY = DISPLAY;
    const { context } = await openForManualLogin();
    state.context = context;

    // Aba dedicada ao poll, criada UMA vez so (nao a cada tick) - abrir/
    // fechar aba repetidamente no mesmo browser headed pisca a janela toda
    // (sintoma observado: "pagina fica atualizando constantemente"). Uma
    // aba unica reaproveitada nao causa esse efeito, e como e uma pagina
    // de verdade (nao um fetch cru) roda o JS da SPA - necessario porque
    // o Matrix so injeta #form-login/#filtro_relatorio no DOM depois de
    // montar a rota certa, entao um fetch sem JS nunca veria esses ids.
    state.pollPage = await context.newPage();
    console.log('[reauth] Chromium headed pronto, iniciando poll a cada %dms', config.loginPollIntervalMs);

    let tick = 0;
    state.pollTimer = setInterval(async () => {
      tick += 1;
      console.log('[reauth] poll tick #%d', tick);
      try {
        const logged = await isLoggedIn(state.pollPage);
        console.log('[reauth] poll tick #%d resultado: loggedIn=%s', tick, logged);
        if (logged) {
          state.loggedIn = true;
          console.log('[reauth] login detectado, salvando storageState antes de fechar');
          // Precisa salvar ANTES do context.close() dentro de stopReauth() -
          // o cookie de sessao do Matrix (sem expiracao) some assim que o
          // Chromium fecha, entao capturar depois seria tarde demais.
          await saveSessionState(context).catch((err) => {
            console.log('[reauth] falha ao salvar storageState:', err?.message ?? err);
          });
          await stopReauth();
        }
      } catch (err) {
        console.log('[reauth] poll tick #%d erro transitorio:', tick, err?.message ?? err);
      }
    }, config.loginPollIntervalMs);
  } catch (err) {
    console.log('[reauth] erro ao iniciar reauth:', err?.message ?? err);
    await stopReauth();
    throw err;
  }

  return reauthStatus();
}

export async function stopReauth() {
  console.log('[reauth] stopReauth chamado');
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.pollPage) {
    await state.pollPage.close().catch(() => {});
    state.pollPage = null;
  }
  if (state.context) {
    await state.context.close().catch(() => {});
    state.context = null;
  }
  killAllProcs();
  state.active = false;
  return reauthStatus();
}
