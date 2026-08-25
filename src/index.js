import { checkLogin, openForManualLogin, isLoggedIn } from './session.js';
import { exportCsv } from './exportCsv.js';
import { exportDataHubReport } from './exportDataHub.js';
import { createGiveUpSignal } from './giveUp.js';
import { config } from './config.js';
import { REPORT_DEFINITIONS, HSM_POS_INSTALACAO_REPORT } from './reportDefinitions.js';

function parseArgs() {
  const raw = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, value] = arg.replace(/^--/, '').split('=');
      return [key, value];
    }),
  );

  return {
    dateFrom: raw.from,
    dateTo: raw.to,
    timeFrom: raw.timeFrom ?? '00:00',
    timeTo: raw.timeTo ?? '23:59',
  };
}

/**
 * Espera o login acontecer NA MESMA pagina/contexto ja aberto (nao cria um
 * novo browser). Isso importa porque o cookie de sessao da Matrix parece
 * ser "de sessao" (sem Max-Age) - se fechassemos esse navegador e
 * abrissemos outro depois do login, o Chromium descartaria o cookie e a
 * proxima checagem headless voltaria a achar que nao estamos logados.
 */
async function waitForLoginInSameContext(page) {
  const giveUp = createGiveUpSignal();

  const pollLogin = (async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, config.loginPollIntervalMs));
      const loggedIn = await isLoggedIn(page).catch(() => false);
      if (loggedIn) return true;
    }
  })();

  const result = await Promise.race([
    pollLogin.then(() => 'logged-in'),
    giveUp.promise.then(() => 'gave-up'),
  ]);

  giveUp.dispose();
  return result === 'gave-up';
}

/**
 * Roda os tres relatorios (atendimento + HSM + HSM CX Pos-Instalacao) de
 * forma assincrona, em paralelo. Atendimento e HSM cada um em sua propria
 * aba (Page) do MESMO contexto de browser - assim os dois compartilham a
 * mesma sessao autenticada (os cookies vivem no contexto, nao na aba) sem
 * disputar o profile Chromium, que so pode ser aberto por um processo por
 * vez. O terceiro relatorio nao usa Playwright/browser nenhum - vem de uma
 * API REST publica (Data Hub, ver exportDataHub.js) e roda como uma
 * promise HTTP independente, junto com as outras duas.
 *
 * Usa Promise.allSettled (nao Promise.all) DE PROPOSITO: com Promise.all,
 * a falha de UM relatorio rejeita a promise combinada imediatamente,
 * main() cai no catch e chama process.exit(1) - matando o processo Node
 * inteiro e abortando os OUTROS relatorios no meio, mesmo que estivessem
 * prestes a terminar com sucesso. allSettled deixa todos rodarem ate o
 * fim (sucesso ou falha) independentemente uns dos outros.
 */
async function exportAllReports(context, atendimentoPage, filters) {
  const hsmPage = await context.newPage();
  await hsmPage.goto(`${config.baseUrl}${REPORT_DEFINITIONS.hsm.reportPath}`, {
    waitUntil: 'domcontentloaded',
  });

  const [atendimentoResult, hsmResult, hsmPosInstalacaoResult] = await Promise.allSettled([
    exportCsv(context, atendimentoPage, REPORT_DEFINITIONS.atendimento, filters),
    exportCsv(context, hsmPage, REPORT_DEFINITIONS.hsm, filters),
    exportDataHubReport(HSM_POS_INSTALACAO_REPORT, filters),
  ]);

  await hsmPage.close();

  const describeError = (result) =>
    result.status === 'rejected' ? (result.reason?.message ?? String(result.reason)) : null;

  return {
    files: {
      atendimento: atendimentoResult.status === 'fulfilled' ? atendimentoResult.value : null,
      hsm: hsmResult.status === 'fulfilled' ? hsmResult.value : null,
      hsmPosInstalacao:
        hsmPosInstalacaoResult.status === 'fulfilled' ? hsmPosInstalacaoResult.value : null,
    },
    errors: {
      atendimento: describeError(atendimentoResult),
      hsm: describeError(hsmResult),
      hsmPosInstalacao: describeError(hsmPosInstalacaoResult),
    },
  };
}

async function main() {
  const filters = parseArgs();
  if (!filters.dateFrom || !filters.dateTo) {
    console.error(
      'Uso: npm start -- --from=dd-MM-yyyy --to=dd-MM-yyyy [--timeFrom=HH:mm] [--timeTo=HH:mm]',
    );
    process.exit(1);
  }

  // 1) Tenta direto em modo headless: cobre o caso da sessao ainda ser valida
  //    dentro do MESMO processo (sem fechar/reabrir o navegador no meio).
  let { context, page, loggedIn } = await checkLogin();

  if (!loggedIn) {
    await context.close();

    console.log('\n>>> Sessao nao autenticada.');
    console.log('>>> Um navegador foi aberto para voce fazer login manualmente.');
    console.log('>>> Digite "sair" ou "desistir" a qualquer momento para cancelar.\n');

    ({ context, page } = await openForManualLogin());
    const gaveUp = await waitForLoginInSameContext(page);

    if (gaveUp) {
      await context.close();
      console.log('Operacao cancelada pelo usuario.');
      process.exit(0);
    }

    console.log('\n>>> Login detectado! Prosseguindo com a exportacao...');
  }

  try {
    const { files, errors } = await exportAllReports(context, page, filters);
    const hasErrors = Object.values(errors).some(Boolean);

    if (hasErrors) {
      console.error(
        `\nUm ou mais relatorios falharam:` +
          Object.entries(errors)
            .filter(([, message]) => message)
            .map(([report, message]) => `\n  - ${report}: ${message}`)
            .join(''),
      );
    } else {
      console.log(
        `\nTodos os relatorios foram baixados com sucesso:` +
          Object.entries(files)
            .map(([report, filePath]) => `\n  - ${report}: ${filePath}`)
            .join(''),
      );
    }

    console.log(`RESULT ${JSON.stringify({ files, errors })}`);

    if (hasErrors) {
      process.exitCode = 1;
    }
  } finally {
    // O profile persistente e gravado em disco ao fechar o contexto, entao
    // proximas execucoes ainda se beneficiam de cookies/localStorage
    // persistentes (nao-sessao) que o site eventualmente definir.
    await context.close();
  }
}

main().catch((err) => {
  console.error('Erro inesperado:', err);
  process.exit(1);
});
