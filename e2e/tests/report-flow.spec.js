import { test, expect } from '@playwright/test';

test('gerar relatorio sem sessao autenticada mostra o erro real (nao a mensagem vazia)', async ({ page }) => {
  await page.goto('/');

  const [dataInicio, dataFim] = await page.locator('input[type="date"]').all();
  await dataInicio.fill('2026-08-24');
  await dataFim.fill('2026-08-25');

  await page.getByRole('button', { name: 'Gerar Relatório' }).click();

  const statusBox = page.locator('.status-box');
  await expect(statusBox).toContainText('Sessao da Matrix nao autenticada', { timeout: 30_000 });

  // Regressao do bug original: nao pode mais aparecer a mensagem generica
  // e vazia (errorList/successList vazios) que escondia o erro real.
  await expect(statusBox).not.toContainText('Concluido(s) com sucesso: nenhum');
});
