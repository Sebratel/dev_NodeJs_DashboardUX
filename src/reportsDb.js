import mysql from 'mysql2/promise';
import { config } from './config.js';

/**
 * Cache incremental dos relatorios da Matrix num MariaDB compartilhado (ver
 * config.massivesDb). Cada tabela guarda os campos do relatorio em colunas
 * tipadas (nomes em ingles) em vez de um JSON cru por linha - ver SCHEMAS
 * abaixo para o mapeamento coluna (ingles) <-> campo original da API da
 * Matrix (portugues), levantado inspecionando amostras reais ja cacheadas
 * (nao adivinhado).
 *
 * Estrategia de "marca d'agua": dados de dias passados nunca mudam, entao um
 * dia so precisa ser buscado da API UMA vez. So o dia mais recente ja salvo
 * (a marca d'agua) e sempre rebuscado e substituido, porque pode ter sido
 * salvo incompleto (ex.: o dia ainda nao tinha terminado quando foi salvo).
 * Dias depois da marca d'agua (nunca vistos) tambem vem da API e sao
 * inseridos, avancando a marca d'agua. Ver getWatermark()/replaceDayRows()
 * e o uso em matrixApiClient.js.
 */

export const TABLES = {
  hsmEnviadas: 'db_matrix_hsms_enviados',
  atendimentoAnalitico: 'db_matrix_atendimento_analitico',
};

/**
 * Uma entrada por coluna: [nome da coluna (ingles), campo original da API da
 * Matrix (portugues), tipo SQL, "kind" que controla cast na escrita/leitura].
 *
 * `kind`:
 * - 'raw'      texto (VARCHAR/TEXT) - sem cast, vai/volta como string.
 * - 'int'      numerico (BIGINT/INT/TINYINT) - a API devolve string
 *              ("3717366"), aqui vira number de verdade.
 * - 'time'     TIME ("HH:MM:SS") - mysql2 ja devolve como string por
 *              padrao, sem cast necessario.
 * - 'datetime' DATETIME - lido com DATE_FORMAT (ver getCachedRows) para
 *              devolver o mesmo formato de string "yyyy-MM-dd HH:mm:ss" que
 *              a API original, sem depender de config global do driver.
 * - 'json'     campo multivalorado (ex.: lista de classificacoes) - unico
 *              caso onde ainda faz sentido guardar como JSON, por ser
 *              genuinamente uma lista, nao a linha inteira.
 *
 * Campos do CSV "Relatorio de Atendimento" exportado pela Matrix que NAO
 * tem equivalente nesta API REST (confirmado inspecionando 300 linhas
 * reais do cache): Prioritario?, ID_Mailing, CPF entrada chat, E-mail
 * entrada chat, Protocolo dependente. Esses simplesmente nao existem no
 * modo "api" hoje - so o modo "novnc" (scraping do CSV nativo da Matrix)
 * teria esses campos, e esse modo nunca grava neste banco.
 */
const ATENDIMENTO_COLUMNS = [
  ['interaction_id', 'id_atendimento', 'BIGINT', 'int'],
  ['entry_at', 'data_entrada', 'DATETIME', 'datetime'],
  ['service_started_at', 'data_atendimento', 'DATETIME', 'datetime'],
  ['queued_at', 'data_fila', 'DATETIME', 'datetime'],
  ['finished_at', 'data_termino', 'DATETIME', 'datetime'],
  ['channel_type_id', 'id_tipo_integracao', 'INT', 'int'],
  ['protocol_number', 'protocolo', 'VARCHAR(32)', 'raw'],
  ['external_number', 'externo', 'VARCHAR(64)', 'raw'],
  ['is_receptive', 'boleano_receptivo', 'TINYINT(1)', 'int'],
  ['queue_duration', 'tempo_fila', 'TIME', 'time'],
  ['service_duration', 'tempo_atendimento', 'TIME', 'time'],
  ['pending_duration', 'tempo_pendencia', 'TIME', 'time'],
  ['tmic', 'tmic', 'TIME', 'time'],
  ['tmia', 'tmia', 'TIME', 'time'],
  ['service_type', 'tipo_atendimento', 'VARCHAR(64)', 'raw'],
  ['service_level', 'nivel_servico', 'VARCHAR(32)', 'raw'],
  ['original_interaction_id', 'id_atendimento_referencia', 'BIGINT', 'int'],
  ['status_id', 'id_status_atendimento', 'INT', 'int'],
  ['status', 'status', 'VARCHAR(64)', 'raw'],
  ['recurrence', 'recorrencia', 'VARCHAR(64)', 'raw'],
  ['contact_id', 'id_contato', 'BIGINT', 'int'],
  ['contact_name', 'contato', 'VARCHAR(255)', 'raw'],
  ['phone', 'telefone', 'VARCHAR(32)', 'raw'],
  ['cpf_cnpj', 'cpf', 'VARCHAR(32)', 'raw'],
  ['cpf_cnpj_provided', 'cpf_informado', 'VARCHAR(32)', 'raw'],
  ['email', 'email', 'VARCHAR(255)', 'raw'],
  ['registration_number', 'matricula', 'VARCHAR(64)', 'raw'],
  ['classification_id', 'id_classificacao', 'BIGINT', 'int'],
  ['contact_classification', 'contato_classificacao', 'VARCHAR(32)', 'raw'],
  ['agent_name', 'agente', 'VARCHAR(255)', 'raw'],
  ['queue_path', 'descricao_caminho_completo', 'VARCHAR(255)', 'raw'],
  ['service_name', 'servico', 'VARCHAR(255)', 'raw'],
  ['channel', 'tipo_integracao', 'VARCHAR(64)', 'raw'],
  ['account_name', 'conta', 'VARCHAR(255)', 'raw'],
  ['notes', 'descricao_observacao', 'TEXT', 'raw'],
  ['mood_id', 'id_humor', 'INT', 'int'],
  ['mood_icon', 'icone', 'VARCHAR(64)', 'raw'],
  ['mood', 'humor', 'VARCHAR(64)', 'raw'],
  ['tag', 'tag', 'VARCHAR(255)', 'raw'],
  ['first_agent_message_at', 'data_prim_msg_agente', 'DATETIME', 'datetime'],
  ['last_agent_message_at', 'data_ulti_msg_agente', 'DATETIME', 'datetime'],
  ['first_auto_message_at', 'data_prim_msg_auto', 'DATETIME', 'datetime'],
  ['last_auto_message_at', 'data_ulti_msg_auto', 'DATETIME', 'datetime'],
  ['first_client_message_at', 'data_prim_msg_cliente', 'DATETIME', 'datetime'],
  ['last_client_message_at', 'data_ulti_msg_cliente', 'DATETIME', 'datetime'],
  ['client_message_count', 'qtd_cliente', 'INT', 'int'],
  ['agent_message_count', 'qtd_agente', 'INT', 'int'],
  ['auto_message_count', 'qtd_auto', 'INT', 'int'],
  ['other_classifications', 'outras_classificacoes', 'JSON', 'json'],
];

const HSM_COLUMNS = [
  ['message_id', 'cod_mensagem', 'BIGINT', 'int'],
  ['sent_at', 'dat_msg', 'DATETIME', 'datetime'],
  ['account_id', 'cod_conta', 'INT', 'int'],
  ['account_name', 'nom_conta', 'VARCHAR(255)', 'raw'],
  ['template_id', 'cod_hsm', 'INT', 'int'],
  ['template_name', 'nom_hsm', 'VARCHAR(255)', 'raw'],
  ['message_text', 'dsc_msg', 'TEXT', 'raw'],
  ['status_id', 'cod_status', 'INT', 'int'],
  ['status', 'status', 'VARCHAR(64)', 'raw'],
  ['interaction_id', 'cod_atendimento', 'BIGINT', 'int'],
  ['contact_name', 'nom_contato', 'VARCHAR(255)', 'raw'],
  ['phone', 'num_telefone', 'VARCHAR(32)', 'raw'],
  ['cpf', 'num_cpf', 'VARCHAR(32)', 'raw'],
  ['category', 'categoria', 'VARCHAR(64)', 'raw'],
];

/** Extra indices por tabela, alem do idx_report_date que toda tabela ja tem - colunas naturais de busca (id de negocio). */
const EXTRA_INDEXES = {
  [TABLES.atendimentoAnalitico]: [
    ['idx_interaction_id', 'interaction_id'],
    ['idx_protocol_number', 'protocol_number'],
  ],
  [TABLES.hsmEnviadas]: [
    ['idx_message_id', 'message_id'],
    ['idx_interaction_id', 'interaction_id'],
  ],
};

const SCHEMAS = {
  [TABLES.atendimentoAnalitico]: ATENDIMENTO_COLUMNS,
  [TABLES.hsmEnviadas]: HSM_COLUMNS,
};

let pool = null;

function isConfigured() {
  return Boolean(
    config.massivesDb.host && config.massivesDb.user && config.massivesDb.database,
  );
}

function getPool() {
  if (!isConfigured()) return null;
  if (!pool) {
    pool = mysql.createPool({
      host: config.massivesDb.host,
      port: config.massivesDb.port,
      user: config.massivesDb.user,
      password: config.massivesDb.password,
      database: config.massivesDb.database,
      connectionLimit: 5,
      connectTimeout: 8000,
    });
  }
  return pool;
}

function toIsoDate(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** "yyyy-MM-dd" (string ou Date) -> Date a meia-noite LOCAL, mesma convencao de eachDay() em matrixApiClient.js. */
function toLocalMidnight(value) {
  if (value instanceof Date) return value;
  const [year, month, day] = String(value).split(/[-T ]/)[0].split('-').map(Number);
  return new Date(year, month - 1, day);
}

function castForWrite(kind, value) {
  if (kind === 'json') return JSON.stringify(value ?? []);
  if (value === undefined || value === null || value === '') return null;
  if (kind === 'int') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return value;
}

function castForRead(kind, value) {
  if (kind === 'json') return typeof value === 'string' ? JSON.parse(value) : (value ?? []);
  return value;
}

/** Expressao de SELECT de uma coluna - datas usam DATE_FORMAT para devolver string no mesmo formato da API original, sem depender de config global do driver mysql2. */
function selectExpr([col, , , kind]) {
  return kind === 'datetime' ? `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s') AS ${col}` : col;
}

/**
 * Cria a tabela (schema novo, colunas tipadas) se ainda nao existir.
 *
 * Migracao do schema antigo (coluna unica `payload JSON`): se a tabela ja
 * existir no formato antigo, ela e DROPADA e recriada no formato novo -
 * aprovado explicitamente porque estas tabelas sao SO um cache incremental
 * (nunca fonte da verdade, sempre reconstruivel a partir da API da Matrix -
 * ver getCacheBounds/replaceDayRows). O DROP so afeta a tabela EXATA
 * recebida em `table` (sempre um dos dois valores literais de TABLES, nunca
 * vindo de input externo) - nunca mexe em nenhuma outra tabela do schema
 * compartilhado (`API_WebDeveloper`), usado por outros projetos.
 */
async function ensureTable(db, table) {
  const schema = SCHEMAS[table];
  if (!schema) throw new Error(`[reportsDb] Schema desconhecido para a tabela ${table}`);

  const [legacyCheck] = await db.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'payload'`,
    [table],
  );
  if (legacyCheck[0].c > 0) {
    await db.query(`DROP TABLE ${table}`);
  }

  const columnsDdl = schema.map(([col, , type]) => `${col} ${type} NULL`).join(',\n      ');
  const indexesDdl = (EXTRA_INDEXES[table] ?? [])
    .map(([name, col]) => `,\n      INDEX ${name} (${col})`)
    .join('');

  await db.query(
    `CREATE TABLE IF NOT EXISTS ${table} (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      report_date DATE NOT NULL,
      ${columnsDdl},
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_report_date (report_date)${indexesDdl}
    )`,
  );
}

/**
 * Devolve o intervalo [min, max] de report_date ja salvo na tabela (min/max
 * null se a tabela esta vazia/nao existe/o banco esta inacessivel - nesses
 * casos quem chama trata como "sem cache", buscando tudo da API normalmente;
 * a integracao com o banco e so uma otimizacao, nunca pode quebrar o fluxo
 * existente).
 *
 * `max` e a "marca d'agua" (sempre rebuscada, pode ter sido salva incompleta
 * - ex.: o dia ainda nao tinha terminado quando foi salvo). `min` existe pra
 * detectar quando o cache NAO cobre o inicio do range pedido: um dia so pode
 * ser considerado coberto se estiver DENTRO de [min, max) - um dia anterior
 * ao `min` nunca foi buscado, mesmo sendo "menor que a marca d'agua", e
 * precisa vir da API (senao um request cujo dateFrom seja anterior ao
 * primeiro dia ja cacheado voltaria com esses dias vazios, silenciosamente).
 */
export async function getCacheBounds(table) {
  const db = getPool();
  if (!db) return { min: null, max: null };

  try {
    await ensureTable(db, table);
    const [rows] = await db.query(
      `SELECT MIN(report_date) AS minDate, MAX(report_date) AS maxDate FROM ${table}`,
    );
    const { minDate, maxDate } = rows[0] ?? {};
    return {
      min: minDate ? toLocalMidnight(minDate) : null,
      max: maxDate ? toLocalMidnight(maxDate) : null,
    };
  } catch (error) {
    console.warn(`[reportsDb] Falha ao ler marca d'agua de ${table}: ${error.message}`);
    return { min: null, max: null };
  }
}

/**
 * Le as linhas ja cacheadas de report_date entre from/to (inclusive), em
 * ordem crescente de data - reconstruidas como objetos com as MESMAS chaves
 * (em portugues) que a API da Matrix devolve, para quem consome (exportApi.js,
 * matrixApiClient.js) continuar funcionando sem mudanca nenhuma mesmo com o
 * armazenamento agora sendo em colunas tipadas, nao mais um JSON cru.
 */
export async function getCachedRows(table, fromDate, toDate) {
  const db = getPool();
  if (!db) return [];

  const schema = SCHEMAS[table];
  try {
    const columnsSql = schema.map(selectExpr).join(', ');
    const [rows] = await db.query(
      `SELECT ${columnsSql} FROM ${table} WHERE report_date BETWEEN ? AND ? ORDER BY report_date`,
      [toIsoDate(fromDate), toIsoDate(toDate)],
    );
    return rows.map((row) => {
      const apiRow = {};
      for (const [col, apiField, , kind] of schema) {
        apiRow[apiField] = castForRead(kind, row[col]);
      }
      return apiRow;
    });
  } catch (error) {
    console.warn(`[reportsDb] Falha ao ler cache de ${table}: ${error.message}`);
    return [];
  }
}

/**
 * Substitui todas as linhas de UM dia (delete + insert numa transacao) -
 * usado tanto para o dia novo (marca d'agua ainda nao tinha esse dia) quanto
 * para reescrever a marca d'agua anterior (que pode ter sido salva
 * incompleta). Falha aqui e so logada, nunca propagada - perder o cache de
 * um dia nao pode derrubar a exportacao do relatorio em si.
 *
 * Cada linha (objeto com as chaves originais da API) e desmembrada nas
 * colunas tipadas de `schema` antes do INSERT - ver SCHEMAS acima.
 */
export async function replaceDayRows(table, day, rows) {
  const db = getPool();
  if (!db) return;

  const schema = SCHEMAS[table];
  const isoDay = toIsoDate(day);
  let connection;
  try {
    // getConnection() tambem pode falhar (rede/credenciais) - tem que estar
    // DENTRO do try, senao a rejeicao escapa sem passar pelo catch abaixo e
    // derruba o relatorio inteiro (foi exatamente isso que aconteceu num
    // teste manual com o banco temporariamente inacessivel).
    connection = await db.getConnection();
    await ensureTable(connection, table);
    await connection.beginTransaction();
    await connection.query(`DELETE FROM ${table} WHERE report_date = ?`, [isoDay]);
    if (rows.length) {
      const columnNames = schema.map(([col]) => col);
      const insertColumns = ['report_date', ...columnNames].join(', ');
      const values = rows.map((row) => [
        isoDay,
        ...schema.map(([, apiField, , kind]) => castForWrite(kind, row[apiField])),
      ]);
      await connection.query(`INSERT INTO ${table} (${insertColumns}) VALUES ?`, [values]);
    }
    await connection.commit();
  } catch (error) {
    await connection?.rollback().catch(() => {});
    console.warn(`[reportsDb] Falha ao salvar cache de ${table} (${isoDay}): ${error.message}`);
  } finally {
    connection?.release();
  }
}
