import readline from 'node:readline';

/**
 * Escuta o stdin em segundo plano. Resolve a Promise assim que o usuario
 * digitar "sair" ou "desistir" (ou apertar Ctrl+C). Usado com Promise.race
 * para interromper o loop de espera de login.
 */
export function createGiveUpSignal() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const promise = new Promise((resolve) => {
    rl.on('line', (line) => {
      const cmd = line.trim().toLowerCase();
      if (cmd === 'sair' || cmd === 'desistir') {
        resolve(true);
      }
    });
    rl.on('SIGINT', () => resolve(true));
  });

  return {
    promise,
    dispose: () => rl.close(),
  };
}
