/**
 * Centralised locale handling for everything the viewer can hear or read.
 *
 * Before this module the pipeline mixed hardcoded English labels ("Section 1:",
 * "MAIN CONTENT", "Number 3:") into French scripts, and the TTS engine read them
 * out loud — producing videos that switched language mid-sentence. Every label
 * that can reach narration, the rendered slideshow, or an AI prompt now resolves
 * through here so a single language setting governs the whole run.
 */

const SUPPORTED = ['fr', 'en'];

const LABELS = {
  fr: {
    languageName: 'français',
    languageEnglishName: 'French',
    title: 'TITRE',
    hook: 'ACCROCHE',
    introduction: 'INTRODUCTION',
    mainContent: 'CONTENU PRINCIPAL',
    conclusion: 'CONCLUSION',
    callToAction: 'APPEL À L\'ACTION',
    visuals: 'VISUELS',
    estimatedDuration: 'DURÉE ESTIMÉE',
    tone: 'TON',
    pacing: 'RYTHME',
    keywords: 'MOTS-CLÉS',
    section: 'Partie',
    step: 'Étape',
    number: 'Numéro',
    impact: 'Impact',
    tip: 'Astuce',
    summary: 'Au programme',
    keyTakeaways: 'À retenir',
    subscribeReminder: 'Abonnez-vous !',
  },
  en: {
    languageName: 'English',
    languageEnglishName: 'English',
    title: 'TITLE',
    hook: 'HOOK',
    introduction: 'INTRODUCTION',
    mainContent: 'MAIN CONTENT',
    conclusion: 'CONCLUSION',
    callToAction: 'CALL TO ACTION',
    visuals: 'VISUALS',
    estimatedDuration: 'ESTIMATED DURATION',
    tone: 'TONE',
    pacing: 'PACING',
    keywords: 'KEYWORDS',
    section: 'Section',
    step: 'Step',
    number: 'Number',
    impact: 'Impact',
    tip: 'Tip',
    summary: 'What we cover',
    keyTakeaways: 'Key takeaways',
    subscribeReminder: 'Subscribe for more!',
  },
};

/**
 * Resolve the active content language.
 *
 * Explicit strategy/profile values win over the environment default so a single
 * channel can produce another language without changing the process config.
 */
function resolveLanguage(candidate) {
  const raw = candidate || process.env.DEFAULT_LANGUAGE || 'fr';
  const normalized = String(raw).trim().toLowerCase().slice(0, 2);
  return SUPPORTED.includes(normalized) ? normalized : 'fr';
}

function labels(language) {
  return LABELS[resolveLanguage(language)];
}

function label(language, key) {
  const table = labels(language);
  return table[key] ?? LABELS.en[key] ?? key;
}

/**
 * Human-readable language instruction injected into AI prompts.
 */
function promptLanguageDirective(language) {
  const resolved = resolveLanguage(language);
  const table = LABELS[resolved];
  return (
    `Write every single word of the output in ${table.languageEnglishName} (${table.languageName}). ` +
    'Titles, section headings, bullets, hook, call to action and claims must all be in that language. ' +
    'Do not mix languages, do not leave English boilerplate, and do not translate proper nouns or brand names.'
  );
}

module.exports = {
  SUPPORTED,
  resolveLanguage,
  labels,
  label,
  promptLanguageDirective,
};
