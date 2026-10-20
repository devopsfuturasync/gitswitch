// Languages. The Portuguese text in the code is the key; locales/<lang>.json
// map it to other languages, and anything missing falls back to the key.
// Placeholders are positional: _t('Conta ativa: {0}', login).
const LOCALES = {
  en: require('./locales/en.json'),
  es: require('./locales/es.json'),
};
const SUPPORTED = ['pt', 'en', 'es'];
const NAMES = { pt: 'Português', en: 'English', es: 'Español' };

let lang = 'en';

// First supported language in a preference list ("pt-BR", "es_ES.UTF-8"…);
// English when none matches.
function pick(list) {
  for (const raw of list.filter(Boolean)) {
    const code = String(raw).toLowerCase().slice(0, 2);
    if (SUPPORTED.includes(code)) return code;
  }
  return 'en';
}

// What the OS prefers, for processes without Electron (the CLI).
function systemPreferences() {
  return [
    process.env.GITSWITCH_LANG, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale,
  ];
}

function setLanguage(code) {
  lang = SUPPORTED.includes(code) ? code : 'en';
}

function format(text, args) {
  return text.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i]) : m));
}

function t(key, ...args) {
  const dict = LOCALES[lang];
  return format((dict && dict[key]) || key, args);
}

module.exports = {
  t, pick, setLanguage, systemPreferences, SUPPORTED, NAMES,
  language: () => lang,
  dictionary: () => LOCALES[lang] || {},
  locale: () => ({ pt: 'pt-BR', en: 'en-US', es: 'es' }[lang]),
};
