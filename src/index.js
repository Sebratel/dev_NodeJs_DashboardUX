import { checkLogin, openForManualLogin, isLoggedIn } from './session.js';
import { exportCsv } from './exportCsv.js';
import { createGiveUpSignal } from './giveUp.js';
import { config } from './config.js';

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
    const filePath = await exportCsv(context, page, filters);
    console.log(`\nCSV exportado com sucesso: ${filePath}`);
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
