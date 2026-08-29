/**
 * Lightweight French/English discriminator used by the stage arbiters.
 *
 * The goal is not general language identification: it is catching the specific
 * failure this pipeline kept producing — an otherwise French script carrying
 * leftover English boilerplate ("Section 1:", "Let me know in the comments",
 * "The Benefits"). A whole-document ratio hides that, because a handful of
 * English lines drown in hundreds of French words. So detection runs per
 * segment and reports the offending segments back, which is what an arbiter
 * needs in order to explain the retry.
 */

// Words that are strong evidence for one language and are rare or absent in the
// other. Ambiguous tokens shared by both ("a", "on", "sur", "no", "son") are
// deliberately excluded — they were the reason the previous naive check
// misclassified short French sentences as English.
const FRENCH_MARKERS = new RegExp(
  '\\b(le|la|les|un|une|des|du|au|aux|et|ou|mais|donc|car|que|qui|quoi|dont|où|' +
  'ce|cet|cette|ces|mon|ma|mes|ton|ta|tes|ses|nos|vos|leur|leurs|notre|votre|' +
  'je|tu|il|elle|nous|vous|ils|elles|est|sont|était|étaient|sera|seront|' +
  'avez|avons|ont|avoir|être|faire|aller|venir|voir|savoir|pouvoir|vouloir|devoir|' +
  'pour|avec|sans|dans|chez|vers|depuis|pendant|entre|parce|ainsi|alors|' +
  'plus|moins|très|aussi|encore|déjà|toujours|jamais|beaucoup|peu|' +
  'votre|vôtre|cela|ceci|celui|celle|ceux|comment|pourquoi|quand)\\b',
  'gi'
);

const ENGLISH_MARKERS = new RegExp(
  '\\b(the|and|but|because|that|this|these|those|there|their|they|them|' +
  'my|your|his|her|its|our|we|you|he|she|it|i|' +
  'is|are|was|were|be|been|being|have|has|had|do|does|did|' +
  'will|would|could|should|may|might|must|can|shall|' +
  'with|without|from|into|about|through|during|between|before|after|' +
  'here|where|when|why|how|what|which|who|whom|' +
  'more|less|very|also|still|already|always|never|much|many|' +
  'every|each|other|another|such|than|then|now|just|only|' +
  'section|number|step|subscribe|comment|channel|video|welcome|benefits)\\b',
  'gi'
);

// Diacritics and elisions that essentially never appear in English prose.
const FRENCH_ORTHOGRAPHY = /[àâäçéèêëîïôöùûüÿœæ]|(?:\b[cdjlmnst]'|\bqu')/gi;

function countMatches(text, pattern) {
  const matches = String(text).match(pattern);
  return matches ? matches.length : 0;
}

function wordCount(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/**
 * Score a single segment. Returns the detected language and how confident the
 * evidence is, so callers can ignore segments that are simply too short to
 * classify (a three-word line carries no signal either way).
 */
function scoreSegment(segment) {
  const words = wordCount(segment);
  const french = countMatches(segment, FRENCH_MARKERS) + countMatches(segment, FRENCH_ORTHOGRAPHY);
  const english = countMatches(segment, ENGLISH_MARKERS);
  const evidence = french + english;

  if (words < 4 || evidence === 0) {
    return { language: null, confidence: 0, french, english, words };
  }

  const language = french === english ? null : french > english ? 'fr' : 'en';
  return {
    language,
    confidence: Math.abs(french - english) / evidence,
    french,
    english,
    words,
  };
}

function splitSegments(text) {
  return String(text)
    // Split on sentence enders and hard line breaks: boilerplate usually sits on
    // its own line, which keeps it from being diluted by surrounding prose.
    .split(/(?:[.!?]+\s+)|\n+/)
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
}

/**
 * Analyse a document against the language it is supposed to be written in.
 *
 * @param {string} text
 * @param {string} expected - 'fr' or 'en'
 * @returns {{consistent: boolean, ratio: number, offendingSegments: string[], analysed: number}}
 */
function analyze(text, expected = 'fr') {
  const target = String(expected).toLowerCase().startsWith('en') ? 'en' : 'fr';
  const segments = splitSegments(text);

  const offending = [];
  let analysed = 0;

  for (const segment of segments) {
    const score = scoreSegment(segment);
    if (!score.language) continue;
    analysed += 1;
    // Require reasonable confidence before blaming a segment: a French sentence
    // quoting one English product name should not trip the arbiter.
    if (score.language !== target && score.confidence >= 0.5) {
      offending.push(segment.slice(0, 160));
    }
  }

  const ratio = analysed === 0 ? 0 : offending.length / analysed;

  return {
    consistent: ratio <= 0.05,
    ratio,
    analysed,
    offendingSegments: offending.slice(0, 8),
  };
}

/**
 * Best-effort language guess for an arbitrary block of text (used when
 * inspecting an ingested source document).
 */
function detect(text) {
  const french = countMatches(text, FRENCH_MARKERS) + countMatches(text, FRENCH_ORTHOGRAPHY);
  const english = countMatches(text, ENGLISH_MARKERS);
  if (french === 0 && english === 0) return null;
  return french >= english ? 'fr' : 'en';
}

module.exports = { analyze, detect, scoreSegment };
