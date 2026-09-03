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
 * - 'duration' "H...H:MM:SS" (ex.: tempo de atendimento) guardado como
 *              BIGINT de segundos totais, NAO como TIME - o tipo TIME do
 *              MySQL/MariaDB tem range de so ate 838:59:59, e atendimentos
 *              reais passam disso (ex.: "7529:15:50", atendimento que ficou
 *              aberto por semanas) - descoberto na primeira carga real, dias
 *              inteiros silenciosamente falhavam ao salvar por causa disso.
 *              Reconstruido de volta pro formato "HH:MM:SS" original na
 *              leitura (ver getCachedRows/secondsToHms) - fica utilizavel
 *              tanto para agregacao SQL (AVG/SUM em segundos) quanto para
 *              quem consome a string original.
 * - 'datetime' DATETIME - lido com DATE_FORMAT (ver getCachedRows) para
 *              devolver o mesmo formato de string "yyyy-MM-dd HH:mm:ss" que
 *              a API original, sem depender de config global do driver.
 * - 'json'     campo multivalorado (ex.: lista de classificacoes) - unico
 *              caso onde ainda faz sentido guardar como JSON, por ser
 *              genuinamente uma lista, nao a linha inteira.
 *
 * Colunas de texto livre (nome de contato/agente/conta/servico, tag, email,
 * caminho de fila, matricula) usam TEXT em vez de VARCHAR com tamanho fixo -
 * na primeira carga real, `tag` (VARCHAR(255)) e `matricula` (VARCHAR(64))
 * estouraram o limite em varios dias (tag pode concatenar varias tags com
 * "||"), derrubando o dia inteiro do cache. Sem controle sobre o tamanho
 * real desses campos na origem, TEXT evita repetir o problema.
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
  ['queue_duration', 'tempo_fila', 'BIGINT', 'duration'],
  ['service_duration', 'tempo_atendimento', 'BIGINT', 'duration'],
  ['pending_duration', 'tempo_pendencia', 'BIGINT', 'duration'],
  ['tmic', 'tmic', 'BIGINT', 'duration'],
  ['tmia', 'tmia', 'BIGINT', 'duration'],
  ['service_type', 'tipo_atendimento', 'VARCHAR(64)', 'raw'],
  ['service_level', 'nivel_servico', 'VARCHAR(32)', 'raw'],
  ['original_interaction_id', 'id_atendimento_referencia', 'BIGINT', 'int'],
  ['status_id', 'id_status_atendimento', 'INT', 'int'],
  ['status', 'status', 'VARCHAR(64)', 'raw'],
  ['recurrence', 'recorrencia', 'VARCHAR(64)', 'raw'],
  ['contact_id', 'id_contato', 'BIGINT', 'int'],
  ['contact_name', 'contato', 'TEXT', 'raw'],
  ['phone', 'telefone', 'VARCHAR(32)', 'raw'],
  ['cpf_cnpj', 'cpf', 'VARCHAR(32)', 'raw'],
  ['cpf_cnpj_provided', 'cpf_informado', 'VARCHAR(32)', 'raw'],
  ['email', 'email', 'TEXT', 'raw'],
  ['registration_number', 'matricula', 'TEXT', 'raw'],
  ['classification_id', 'id_classificacao', 'BIGINT', 'int'],
  ['contact_classification', 'contato_classificacao', 'VARCHAR(64)', 'raw'],
  ['agent_name', 'agente', 'TEXT', 'raw'],
  ['queue_path', 'descricao_caminho_completo', 'TEXT', 'raw'],
  ['service_name', 'servico', 'TEXT', 'raw'],
  ['channel', 'tipo_integracao', 'VARCHAR(64)', 'raw'],
  ['account_name', 'conta', 'TEXT', 'raw'],
  ['notes', 'descricao_observacao', 'TEXT', 'raw'],
  ['mood_id', 'id_humor', 'INT', 'int'],
  ['mood_icon', 'icone', 'VARCHAR(64)', 'raw'],
  ['mood', 'humor', 'VARCHAR(64)', 'raw'],
  ['tag', 'tag', 'TEXT', 'raw'],
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

/**
 * `protocol_number` e `agent_name` NAO vem da API de HSM - confirmado
 * auditando o retorno cru da API (`/rest/v2/hsmEnviadas`) direto, sem
 * cache, em 2305 linhas espalhadas por 11 datas e nas 3 categorias
 * existentes (MARKETING, UTILITY, ALERT_UPDATE): nenhum campo com "prot"
 * ou de agente no nome em nenhuma linha, so `cod_atendimento` (o ID interno
 * do atendimento relacionado, ja mapeado como `interaction_id` abaixo). O
 * numero de protocolo formatado (ex.: "68140003717366") e o nome do agente
 * so existem na tabela de Atendimento - por isso essas colunas tem um
 * resolver (5o elemento da tupla) em vez de virem direto de `row[apiField]`:
 * sao preenchidas com um lookup por `interaction_id` na tabela de
 * Atendimento no momento da escrita, ver CONTEXT_BUILDERS e o uso em
 * replaceDayRows(). Ficam NULL para atendimentos ainda nao cacheados na
 * tabela de Atendimento (ex.: fora do range ja alimentado).
 *
 * `HSM`/`Template` do CSV nativo da Matrix ja estao cobertos - sao
 * `nom_hsm`/`template_name` (nome amigavel) e `cod_hsm`/`template_id`
 * (codigo), so com nomes diferentes.
 */
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
  [
    'protocol_number',
    'protocolo',
    'VARCHAR(32)',
    'raw',
    (row, ctx) => ctx.protocolByInteractionId?.get(String(row.cod_atendimento)) ?? null,
  ],
  [
    'agent_name',
    'agente',
    'TEXT',
    'raw',
    (row, ctx) => ctx.agentNameByInteractionId?.get(String(row.cod_atendimento)) ?? null,
  ],
  ['contact_name', 'nom_contato', 'VARCHAR(255)', 'raw'],
  ['phone', 'num_telefone', 'VARCHAR(32)', 'raw'],
  ['cpf', 'num_cpf', 'VARCHAR(32)', 'raw'],
  ['category', 'categoria', 'VARCHAR(64)', 'raw'],
];

/**
 * Contexto extra por tabela, calculado uma vez por chamada de
 * replaceDayRows() (nao por linha) e passado ao resolver de colunas
 * derivadas (ver `protocol_number`/`agent_name` acima). Aqui: mapas
 * interaction_id -> protocol_number/agent_name, buscados em lote na tabela
 * de Atendimento (mesmo schema compartilhado, mesma tabela que este
 * servico ja e dono).
 */
const CONTEXT_BUILDERS = {
  [TABLES.hsmEnviadas]: async (connection, rows) => {
    const ids = [...new Set(rows.map((r) => Number(r.cod_atendimento)).filter(Number.isFinite))];
    if (!ids.length) return { protocolByInteractionId: new Map(), agentNameByInteractionId: new Map() };
    const [found] = await connection.query(
      `SELECT interaction_id, protocol_number, agent_name FROM ${TABLES.atendimentoAnalitico} WHERE interaction_id IN (?)`,
      [ids],
    );
    return {
      protocolByInteractionId: new Map(found.map((r) => [String(r.interaction_id), r.protocol_number])),
      agentNameByInteractionId: new Map(found.map((r) => [String(r.interaction_id), r.agent_name])),
    };
  },
};

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

/** "H...H:MM:SS" (parte de horas sem limite de digitos, pode passar de 838h) -> segundos totais (com sinal). */
function parseDurationToSeconds(value) {
  const m = String(value ?? '').match(/^(-?\d+):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, h, min, sec] = m;
  const sign = h.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(Number(h)) * 3600 + Number(min) * 60 + Number(sec));
}

/** Segundos totais -> "H...H:MM:SS", inverso exato de parseDurationToSeconds (mesma largura de horas, sem truncar). */
function secondsToHms(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined) return null;
  const sign = totalSeconds < 0 ? '-' : '';
  const abs = Math.abs(totalSeconds);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function castForWrite(kind, value) {
  if (kind === 'json') return JSON.stringify(value ?? []);
  if (value === undefined || value === null || value === '') return null;
  if (kind === 'int') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (kind === 'duration') return parseDurationToSeconds(value);
  return value;
}

function castForRead(kind, value) {
  if (kind === 'json') return typeof value === 'string' ? JSON.parse(value) : (value ?? []);
  if (kind === 'duration') return secondsToHms(value);
  return value;
}

/** Expressao de SELECT de uma coluna - datas usam DATE_FORMAT para devolver string no mesmo formato da API original, sem depender de config global do driver mysql2. */
function selectExpr([col, , , kind]) {
  return kind === 'datetime' ? `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s') AS ${col}` : col;
}

/** "BIGINT"/"VARCHAR(32)"/"TINYINT(1)" -> "bigint"/"varchar"/"tinyint" - pra comparar com information_schema.DATA_TYPE, que nao inclui o tamanho/display-width. */
function baseType(sqlType) {
  return sqlType.split('(')[0].trim().toLowerCase();
}

/**
 * Compara o tipo declarado em `schema` com o DATA_TYPE real do information_schema.
 *
 * MariaDB guarda JSON como LONGTEXT por baixo dos panos (JSON e so um alias
 * de tipo, nao um tipo nativo de verdade como no MySQL) - sem essa excecao,
 * a coluna `other_classifications` (declarada 'JSON') SEMPRE bateria como
 * "tipo diferente" (declarado 'json' vs real 'longtext'), fazendo
 * ensureTable() dropar e recriar a tabela inteira em TODA chamada, mesmo
 * sem nenhuma mudanca de schema de verdade. Foi exatamente isso que
 * aconteceu numa carga real: 1,6M linhas buscadas da API, mas cada dia
 * processado dropava a tabela toda de novo antes do proprio INSERT (o dia
 * anterior nunca sobrevivia) - resultado final, tabela vazia apesar do
 * fetch inteiro ter funcionado.
 */
function typesMatch(declaredType, actualType) {
  const declared = baseType(declaredType);
  if (declared === actualType) return true;
  if (declared === 'json' && actualType === 'longtext') return true;
  return false;
}

/**
 * Cria a tabela (schema novo, colunas tipadas) se ainda nao existir, ou
 * evolui incrementalmente uma tabela ja existente para bater com `schema`.
 *
 * Tres casos de migracao, todos so afetam a tabela EXATA recebida em
 * `table` (sempre um dos dois valores literais de TABLES, nunca vindo de
 * input externo) - nunca mexem em nenhuma outra tabela do schema
 * compartilhado (`API_WebDeveloper`), usado por outros projetos:
 *
 * 1. Schema antigo (coluna unica `payload JSON`) OU alguma coluna existente
 *    com tipo diferente do declarado em `schema` (ex.: `service_duration`
 *    era TIME, virou BIGINT depois que a primeira carga real mostrou
 *    duracoes > 838h, fora do range do TIME): a tabela e DROPADA e recriada
 *    do zero - aprovado explicitamente porque estas tabelas sao SO um cache
 *    incremental (nunca fonte da verdade, sempre reconstruivel a partir da
 *    API da Matrix - ver getCacheBounds/replaceDayRows). Sem esse check de
 *    tipo, uma coluna que so muda de tipo (sem mudar de nome) passaria
 *    batido pelo caso 2 abaixo e ficaria com o tipo antigo, quebrando o
 *    INSERT (foi exatamente o que aconteceu testando esta migracao).
 * 2. Schema novo mas faltando coluna(s) (ex.: `protocol_number`/`agent_name`
 *    adicionados depois que a tabela ja existia): ADD COLUMN incremental,
 *    sem perder os dados ja cacheados - linhas antigas ficam com a coluna
 *    nova NULL ate a marca d'agua avancar de novo sobre elas.
 */
async function ensureTable(db, table) {
  const schema = SCHEMAS[table];
  if (!schema) throw new Error(`[reportsDb] Schema desconhecido para a tabela ${table}`);

  const columnsDdl = schema.map(([col, , type]) => `${col} ${type} NULL`).join(',\n      ');
  const indexesDdl = (EXTRA_INDEXES[table] ?? [])
    .map(([name, col]) => `,\n      INDEX ${name} (${col})`)
    .join('');
  const createDdl = `CREATE TABLE ${table} (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      report_date DATE NOT NULL,
      ${columnsDdl},
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_report_date (report_date)${indexesDdl}
    )`;

  const [existingCols] = await db.query(
    `SELECT column_name AS name, data_type AS dataType FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [table],
  );

  if (!existingCols.length) {
    await db.query(createDdl.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
    return;
  }

  const existingTypeByName = new Map(existingCols.map((c) => [c.name, c.dataType?.toLowerCase()]));
  const hasLegacyPayload = existingTypeByName.has('payload');
  const hasTypeMismatch = schema.some(([col, , type]) => {
    const existingType = existingTypeByName.get(col);
    return existingType && !typesMatch(type, existingType);
  });

  if (hasLegacyPayload || hasTypeMismatch) {
    await db.query(`DROP TABLE ${table}`);
    await db.query(createDdl);
    return;
  }

  for (const [col, , type] of schema) {
    if (!existingTypeByName.has(col)) {
      await db.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${type} NULL`);
    }
  }
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
    // Contexto de colunas derivadas (ex.: protocol_number do HSM, ver
    // CONTEXT_BUILDERS) - so leitura, fora da transacao de escrita abaixo.
    const ctx = (await CONTEXT_BUILDERS[table]?.(connection, rows)) ?? {};
    await connection.beginTransaction();
    await connection.query(`DELETE FROM ${table} WHERE report_date = ?`, [isoDay]);
    if (rows.length) {
      const columnNames = schema.map(([col]) => col);
      const insertColumns = ['report_date', ...columnNames].join(', ');
      const values = rows.map((row) => [
        isoDay,
        ...schema.map(([, apiField, , kind, resolveWrite]) =>
          castForWrite(kind, resolveWrite ? resolveWrite(row, ctx) : row[apiField]),
        ),
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
