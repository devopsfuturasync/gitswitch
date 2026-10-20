// Commit messages written by an AI the user already has: Claude Code (the
// `claude` CLI) or a local Ollama model. Nothing is sent anywhere else.
const { t: _t } = require('./i18n');
const { run } = require('./run');

const OLLAMA = 'http://127.0.0.1:11434';
const MAX_DIFF = 60 * 1024;

function claudePath() {
  return require('./platform').which('claude');
}

async function ollamaModels() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return (await res.json()).models.map((m) => m.name);
  } catch {
    return null;
  }
}

async function providers() {
  const [claude, models] = await Promise.all([claudePath(), ollamaModels()]);
  return {
    claude: claude ? { available: true, path: claude } : { available: false },
    ollama: models ? { available: true, models } : { available: false, models: [] },
  };
}

function prompt(language) {
  const lang = language === 'pt' ? 'Brazilian Portuguese' : 'English';
  return [
    `Write a git commit message in ${lang} for the diff below.`,
    'First line: a summary in the imperative mood, at most 72 characters.',
    'Then a blank line and a short body (2 to 5 lines, wrapped at 72) saying what changed and why.',
    'Reply with the message only: no markdown, no code fences, no quotes, no preamble.',
  ].join('\n');
}

// "Summary\n\nBody" -> { summary, description }, tolerating chatty models.
function parse(text) {
  const lines = text.replace(/\r/g, '').trim()
    .replace(/^```[a-z]*\n?|```$/g, '')
    .split('\n')
    .map((l) => l.replace(/^(summary|title|commit message|mensagem)\s*:\s*/i, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  const summary = (lines.shift() || '').replace(/^["'`]|["'`]$/g, '').trim();
  const description = lines.join('\n').replace(/^(body|description|descrição)\s*:\s*/im, '').trim();
  if (!summary) throw new Error(_t('A IA não devolveu uma mensagem. Tente de novo.'));
  return { summary, description };
}

async function commitMessage(diff, { provider, model, language } = {}) {
  if (!diff.trim()) throw new Error(_t('Não há alterações selecionadas para descrever.'));
  const clipped = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n[diff truncated]` : diff;
  const instructions = prompt(language);

  if (provider === 'ollama') {
    const models = await ollamaModels();
    if (!models) throw new Error(_t('O Ollama não está rodando. Abra o Ollama e tente de novo.'));
    const use = model && models.includes(model) ? model : models[0];
    if (!use) throw new Error(_t('Nenhum modelo no Ollama. Baixe um com: ollama pull llama3.2'));
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: use, prompt: `${instructions}\n\n${clipped}`, stream: false }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(_t('O Ollama respondeu {0}.', res.status));
    return { ...parse((await res.json()).response), provider: 'ollama', model: use };
  }

  if (provider === 'claude') {
    const exe = await claudePath();
    if (!exe) throw new Error(_t('O Claude Code (comando claude) não foi encontrado.'));
    const args = ['-p', instructions, '--output-format', 'text'];
    if (model) args.push('--model', model);
    let out;
    try {
      out = (await run(exe, args, { input: clipped })).stdout;
    } catch (err) {
      if (/not logged in|\/login/i.test(err.message)) throw new Error(_t('O Claude Code não está logado. Rode "claude" num terminal e faça /login.'));
      throw err;
    }
    return { ...parse(out), provider: 'claude', model: model || _t('padrão') };
  }

  throw new Error(_t('Escolha um provedor de IA em Configurações → IA.'));
}

module.exports = { providers, commitMessage };
