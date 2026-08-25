/**
 * Um relatorio a exportar: pagina do Matrix + seletores de formulario +
 * payload padrao de filtro + prefixo de nome de arquivo. `exportCsv.js` e
 * agnostico ao relatorio - so precisa desses dados para preencher o
 * formulario e montar a URL/payload de exportacao.
 *
 * Os seletores/payload do `hsm` foram CONFIRMADOS em 2026-08-24 inspecionando
 * a pagina real autenticada (via Claude in Chrome) - nao sao mais palpite:
 * - Form tem os mesmos `#filtro_relatorio`/`#enviaFiltro`/form_token do
 *   relatorio de atendimento, mas os campos de data sao
 *   `#dat_inicial_msg`/`#dat_final_msg` (payload usa as MESMAS chaves) -
 *   nomes diferentes de `#dat_inicial`/`#dat_final` do atendimento.
 * - HSM **nao tem campos de hora** (sem `#hor_inicial`/`#hor_final`) - o
 *   filtro e so por data. `hasTimeFilters: false` faz `exportCsv.js` pular
 *   esses campos por completo (preenchimento e payload).
 * - O payload real de export (capturado interceptando `window.open` no
 *   clique de "Exportar CSV") usa `sidx: "cod_mensagem"` (nao existe coluna
 *   de data explicita no sidx padrao da grid) e nao usa
 *   `bol_somente_agentes`/`bol_prioritario` (especificos do atendimento).
 */
export const REPORT_DEFINITIONS = {
  atendimento: {
    key: 'atendimento',
    label: 'Relatório de Atendimento',
    reportPath: '/relatorio-atendimento/relatorio-atendimento-analitico',
    fileLabel: 'relatorio-atendimento',
    hasTimeFilters: true,
    dateFieldSelectors: { dateFrom: '#dat_inicial', dateTo: '#dat_final' },
    timeFieldSelectors: { timeFrom: '#hor_inicial', timeTo: '#hor_final' },
    payloadDateKeys: { dateFrom: 'dat_inicial', dateTo: 'dat_final' },
    payloadTimeKeys: { timeFrom: 'hor_inicial', timeTo: 'hor_final' },
    defaultFilters: {
      bol_somente_agentes: '0',
      bol_prioritario: '0',
      rows: '10',
      page: '1',
      sidx: 'dat_entrada',
      sord: 'desc',
      searchOper: 'cn',
    },
  },
  hsm: {
    key: 'hsm',
    label: 'Relatório Analítico de Mensagens HSM',
    reportPath: '/relatorio-hsm/relatorio-analitico-mensagens-hsm',
    fileLabel: 'relatorio-hsm',
    hasTimeFilters: false,
    dateFieldSelectors: { dateFrom: '#dat_inicial_msg', dateTo: '#dat_final_msg' },
    payloadDateKeys: { dateFrom: 'dat_inicial_msg', dateTo: 'dat_final_msg' },
    defaultFilters: {
      rows: '10',
      page: '1',
      sidx: 'cod_mensagem',
      sord: 'desc',
      searchOper: 'cn',
    },
  },
};

/**
 * Terceiro relatorio: nao vem do Matrix (sem pagina/formulario/Playwright),
 * vem da API publica do Data Hub (ver exportDataHub.js e config.dataHub).
 * `dateField` e o nome da coluna de data-hora usada para filtrar pelo
 * periodo pedido e para ordenar decrescente - mesma regra de organizacao
 * de datas dos outros dois relatorios.
 */
export const HSM_POS_INSTALACAO_REPORT = {
  key: 'hsmPosInstalacao',
  label: 'HSM CX Pós-Instalação',
  fileLabel: 'hsm-cx-pos-instalacao',
  dateField: 'data_hora_disparo',
  columns: [
    'id',
    'data_hora_disparo',
    'cod_atendimento',
    'prot_atendimento',
    'cliente_nome',
    'telefone',
    'cliente_cidade',
    'cliente_bairro',
    'cliente_contrato',
    'status_envio',
    'mensagem_envio',
  ],
};
