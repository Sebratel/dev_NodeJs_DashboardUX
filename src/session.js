import { chromium } from 'playwright';
import { config } from './config.js';

/**
 * A tela de login tambem renderiza inputs "form_token" (dentro de
 * #form-login e #form-forgot), entao a presenca desse campo sozinha nao
 * prova que estamos autenticados. O indicador confiavel e a AUSENCIA do
 * formulario de login na pagina do relatorio.
 */
async function isReportPageLoaded(page) {
  const hasLoginForm = await page.locator('#form-login').count();
  const hasReportFilterForm = await page.locator('#filtro_relatorio').count();
  return hasLoginForm === 0 && hasReportFilterForm > 0;
}

/**
 * Abre o perfil persistente do Chromium (mesmo diretorio sempre) em modo
 * headless e verifica se a sessao guardada nele ainda esta autenticada.
 * Como e um profile de verdade (nao so cookies), cache/IndexedDB/etc
 * tambem sao preservados entre execucoes.
 */
export async function checkLogin() {
  const context = await chromium.launchPersistentContext(config.profileDir, { headless: true });
  const page = await context.newPage();

  await page.goto(`${config.baseUrl}${config.reportPath}`, { waitUntil: 'domcontentloaded' });
  const loggedIn = await isReportPageLoaded(page);

  return { context, page, loggedIn };
}

/**
 * Abre o MESMO perfil persistente, mas em modo visivel, para o usuario
 * autenticar manualmente. Login feito aqui fica salvo no profile e vale
 * para as proximas execucoes headless.
 */
export async function openForManualLogin() {
  const context = await chromium.launchPersistentContext(config.profileDir, { headless: false });
  const page = await context.newPage();
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });

  // O clique em si nao e a parte sensivel do login (so dispara o redirect
  // para o OAuth do Google) - escolher a conta, digitar senha e 2FA
  // continuam manuais, tratados pelo poll de isLoggedIn() depois disso.
  const ssoButton = page.locator('button[data-nome="SSO GOOGLE"]');
  if (await ssoButton.count() > 0) {
    await ssoButton.click();
  }

  return { context, page };
}

export async function isLoggedIn(page) {
  await page.goto(`${config.baseUrl}${config.reportPath}`, { waitUntil: 'domcontentloaded' });
  return isReportPageLoaded(page);
}
