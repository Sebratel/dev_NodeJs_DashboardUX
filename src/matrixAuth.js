import { config } from './config.js';

// Renova um pouco antes da expiracao real, para nunca correr o risco de usar
// um token que vence no meio de uma rajada de requisicoes concorrentes.
const REFRESH_MARGIN_MS = 60_000;

let cached = null; // { token, expiryMs }
let loginPromise = null;

function assertCredentials() {
  if (!config.matrixApi.login || !config.matrixApi.senha) {
    throw new Error(
      '[matrixApi] MATRIX_API_LOGIN / MATRIX_API_SENHA nao configurados. Defina as ' +
        'variaveis de ambiente com as credenciais de um usuario da Matrix (ver ' +
        'automation/.env.example).',
    );
  }
}

/**
 * Le o campo `exp` (segundos desde epoch, sem ambiguidade de fuso) direto do
 * corpo do JWT, em vez de usar a string `expiry` da resposta de login - essa
 * vem formatada no fuso America/Sao_Paulo (confirmado manualmente), o que
 * daria conta errada se o processo rodar em outro fuso (containers Docker
 * normalmente rodam em UTC).
 */
function decodeJwtExpiryMs(token) {
  const payload = token.split('.')[1];
  const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  return exp * 1000;
}

/**
 * Login programatico via POST /rest/v2/authuser (login + chave/senha) -
 * confirmado manualmente que NAO precisa do cookie de sessao do browser
 * (SACMessenger): so login/chave bastam. O token retornado e o mesmo JWT
 * usado no header Authorization das outras chamadas REST, valido por ~1h.
 */
async function login() {
  assertCredentials();

  const body = new URLSearchParams();
  body.set('login', config.matrixApi.login);
  body.set('chave', config.matrixApi.senha);

  const response = await fetch(new URL('/rest/v2/authuser', config.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    throw new Error(`[matrixApi] Falha ao autenticar (authuser): HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data.success || !data.result?.token) {
    throw new Error(
      `[matrixApi] Falha ao autenticar (authuser): ${data.message ?? 'resposta inesperada'}`,
    );
  }

  return { token: data.result.token, expiryMs: decodeJwtExpiryMs(data.result.token) };
}

/**
 * Devolve um bearer token valido, autenticando na primeira chamada e
 * reautenticando sozinho perto da expiracao. Chamadas concorrentes que
 * percebem o token vencido ao mesmo tempo (comum aqui, com a pool de 25 em
 * matrixApiClient.js) compartilham a MESMA promise de login, para nao
 * disparar N logins simultaneos.
 */
export async function getValidToken() {
  if (cached && cached.expiryMs - Date.now() > REFRESH_MARGIN_MS) {
    return cached.token;
  }

  if (!loginPromise) {
    loginPromise = login()
      .then((result) => {
        cached = result;
        return result.token;
      })
      .finally(() => {
        loginPromise = null;
      });
  }

  return loginPromise;
}
