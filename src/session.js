import { chromium } from 'playwright';
import fs from 'node:fs';
import { config } from './config.js';

/**
 * launchPersistentContext ignora a opcao 'storageState' (ela so se aplica
 * a browser.newContext() comum - testado e confirmado: passar storageState
 * pra launchPersistentContext nao tem efeito nenhum, os cookies salvos
 * continuam sem ser carregados). Por isso injetamos os cookies manualmente
 * via context.addCookies() logo apos abrir o context, que funciona em
 * qualquer tipo de context.
 */
async function loadSavedCookies(context) {
  if (!fs.existsSync(config.storageStatePath)) return;
  const { cookies } = JSON.parse(fs.readFileSync(config.storageStatePath, 'utf-8'));
  await context.addCookies(cookies);
  console.log('[session] %d cookies salvos carregados de %s', cookies.length, config.storageStatePath);
}

/**
 * Chama isso assim que confirmar um login bem-sucedido, ANTES de fechar o
 * context - depois de fechado os cookies de sessao (sem expiracao) somem
 * de vez, entao precisa capturar enquanto o context ainda esta vivo.
 */
export async function saveSessionState(context) {
  await context.storageState({ path: config.storageStatePath });
  console.log('[session] storageState salvo em', config.storageStatePath);
}

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
  console.log('[session] checkLogin: abrindo profile headless', config.profileDir);
  const context = await chromium.launchPersistentContext(config.profileDir, { headless: true });
  await loadSavedCookies(context);
  const page = await context.newPage();

  await page.goto(`${config.baseUrl}${config.reportPath}`, { waitUntil: 'networkidle' });
  const loggedIn = await isReportPageLoaded(page);
  console.log('[session] checkLogin: url=%s loggedIn=%s', page.url(), loggedIn);

  return { context, page, loggedIn };
}

/**
 * Abre o MESMO perfil persistente, mas em modo visivel, para o usuario
 * autenticar manualmente. Login feito aqui fica salvo no profile e vale
 * para as proximas execucoes headless.
 */
export async function openForManualLogin() {
  console.log('[session] openForManualLogin: abrindo profile headed', config.profileDir);
  const context = await chromium.launchPersistentContext(config.profileDir, { headless: false });
  await loadSavedCookies(context);
  const page = await context.newPage();

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      console.log('[session] page navegou para', frame.url());
    }
  });
  context.on('page', (newPage) => {
    console.log('[session] nova aba/popup aberta no context:', newPage.url());
    newPage.on('framenavigated', (frame) => {
      if (frame === newPage.mainFrame()) {
        console.log('[session] popup navegou para', frame.url());
      }
    });
  });

  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
  console.log('[session] openForManualLogin: pagina inicial carregada, url=', page.url());

  // O clique em si nao e a parte sensivel do login (so dispara o redirect
  // para o OAuth do Google) - escolher a conta, digitar senha e 2FA
  // continuam manuais, tratados pelo poll de isLoggedIn() depois disso.
  const ssoButton = page.locator('button[data-nome="SSO GOOGLE"]');
  const ssoCount = await ssoButton.count();
  console.log('[session] openForManualLogin: botao SSO GOOGLE encontrado?', ssoCount > 0);
  if (ssoCount > 0) {
    await ssoButton.click();
    console.log('[session] openForManualLogin: clicou no botao SSO GOOGLE');
  }

  return { context, page };
}

/**
 * O app do Matrix e uma SPA: o HTML inicial (mesmo autenticado) e so o
 * "shell" - nem #form-login nem #filtro_relatorio existem ate o JS montar
 * a tela certa pra rota/estado de auth atual. 'domcontentloaded' dispara
 * cedo demais (antes desse mount); 'networkidle' da tempo do bundle
 * carregar e da SPA decidir o que renderizar.
 */
export async function isLoggedIn(page) {
  await page.goto(`${config.baseUrl}${config.reportPath}`, { waitUntil: 'networkidle' });
  const result = await isReportPageLoaded(page);
  console.log('[session] isLoggedIn: url=%s loggedIn=%s', page.url(), result);
  return result;
}
