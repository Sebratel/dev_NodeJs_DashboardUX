import { test, expect } from '@playwright/test';

test('botao Reautenticar abre o login remoto via noVNC numa nova aba e limpa ao cancelar', async ({ page, context }) => {
  await page.goto('/');

  const [novncPage] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('button', { name: 'Reautenticar' }).click(),
  ]);

  await novncPage.waitForLoadState('domcontentloaded');
  expect(novncPage.url()).toContain('localhost:6080/vnc.html');

  // A tela remota (Chromium headed) deve carregar dentro do canvas do
  // noVNC - confirma que Xvfb + x11vnc + websockify subiram de verdade,
  // nao so que o endpoint HTTP respondeu 200.
  await expect(novncPage.locator('canvas')).toBeVisible({ timeout: 20_000 });

  await expect(page.getByText('Aguardando login...')).toBeVisible();

  await page.getByRole('button', { name: 'Cancelar reautenticação' }).click();

  // cancel() dispara stopReauth() sem esperar (fire-and-forget) - da tempo
  // do POST /reauth/stop terminar (mata Xvfb/x11vnc/websockify) antes de
  // checar o status.
  await expect
    .poll(
      async () => {
        const status = await page.request.get('http://localhost:3210/api/reports/reauth/status');
        return (await status.json()).active;
      },
      { timeout: 10_000 },
    )
    .toBe(false);

  await novncPage.close();
});
