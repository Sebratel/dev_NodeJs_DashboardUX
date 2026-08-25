import { checkLogin } from './session.js';
import { exportCsv } from './exportCsv.js';
import { exportDataHubReport } from './exportDataHub.js';
import { config } from './config.js';
import { REPORT_DEFINITIONS, HSM_POS_INSTALACAO_REPORT } from './reportDefinitions.js';

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
 * abortando os OUTROS relatorios no meio, mesmo que estivessem prestes a
 * terminar com sucesso. allSettled deixa todos rodarem ate o fim (sucesso
 * ou falha) independentemente uns dos outros.
 */
export async function exportAllReports(context, atendimentoPage, filters) {
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

/**
 * Ponta a ponta, SO HEADLESS: verifica a sessao ja autenticada no perfil
 * persistente e roda os tres relatorios. Usado pelo servidor HTTP
 * (server.js) - diferente do CLI (index.js), que ainda oferece o fluxo de
 * login manual (navegador visivel + cancelar via stdin).
 *
 * Isso e uma limitacao real: quando automation roda como servico
 * server-side (container sem display), NAO HA como completar o login SSO
 * manual quando a sessao expira. Reautenticar exige rodar
 * `npm start -- --from=... --to=...` localmente (com display) apontando
 * para o MESMO profileDir/volume que o container usa, para o cookie de
 * sessao gerado la valer para o servico tambem.
 */
export async function runReportJob(filters) {
  const { context, page, loggedIn } = await checkLogin();

  if (!loggedIn) {
    await context.close();
    throw new Error(
      'Sessao da Matrix nao autenticada. Use o botao "Reautenticar" para logar pelo browser ' +
        '(POST /reauth/start) e tente gerar o relatorio de novo.',
    );
  }

  try {
    return await exportAllReports(context, page, filters);
  } finally {
    await context.close();
  }
}
