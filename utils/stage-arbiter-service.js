const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('./logger');
const { analyze } = require('./language-detector');
const { resolveLanguage } = require('./i18n');

/**
 * Per-stage arbiters for the content generation pipeline.
 *
 * Quality used to be judged once, at the very end, by `OperatorService`. By then
 * a bad script had already been narrated, illustrated and rendered, so the only
 * available verdict was "needs attention" on a finished video — expensive to
 * produce and useless to ship.
 *
 * An arbiter runs immediately after each stage, while the output is still cheap
 * to throw away. When a check fails recoverably the stage is re-run with the
 * arbiter's feedback appended to its instructions, so the second attempt is
 * told precisely what was wrong instead of rolling the dice again.
 *
 * Verdict vocabulary:
 *   - `blocking: true`  -> the run cannot continue with this output
 *   - `blocking: false` -> recorded for the operator, does not stop the run
 */

const DEFAULT_MAX_ATTEMPTS = Number(process.env.STAGE_ARBITER_MAX_ATTEMPTS || 2);

// Words per minute used to convert a script into an estimated spoken duration.
// French narration sits around 150 wpm; the tolerance below is deliberately
// wide because pacing varies with content type.
const WORDS_PER_MINUTE = 150;

// Aligned with ScriptWriterAgent's word budgets. These bounds intentionally
// allow short videos: a guide whose answer is one fact does not need ten
// minutes, and the arbiter must not push writers to pad.
const LENGTH_TARGETS = {
  short: { minMinutes: 1.5, maxMinutes: 4 },
  medium: { minMinutes: 3.5, maxMinutes: 8 },
  long: { minMinutes: 7, maxMinutes: 14 },
};

class StageArbiterService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('StageArbiter');
    this.maxAttempts = Math.max(1, Number(options.maxAttempts || DEFAULT_MAX_ATTEMPTS));
    // Escape hatch: operators can downgrade every arbiter to advisory if a run
    // must go through despite a failure.
    this.enforcing = String(process.env.STAGE_ARBITER_ENFORCE ?? 'true').toLowerCase() !== 'false';
    this.onVerdict = options.onVerdict || null;
  }

  /**
   * Run a stage under arbitration.
   *
   * @param {string} stage - pipeline stage id ('strategy', 'script', ...)
   * @param {(feedback: string|null, attempt: number) => Promise<any>} producer
   * @param {object} context - shared run context (language, source document, ...)
   */
  async enforce(stage, producer, context = {}) {
    const attempts = [];
    let lastResult = null;
    let lastVerdict = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const feedback = lastVerdict ? this.buildFeedback(lastVerdict) : null;
      if (feedback) {
        this.logger.warn(`Retrying stage "${stage}" (attempt ${attempt}/${this.maxAttempts}) after arbiter feedback`);
      }

      lastResult = await producer(feedback, attempt);
      lastVerdict = await this.review(stage, lastResult, context);
      attempts.push({ attempt, passed: lastVerdict.passed, failures: lastVerdict.failures.map(check => check.id) });

      if (this.onVerdict) {
        await this.onVerdict({ stage, attempt, verdict: lastVerdict }).catch(() => {});
      }

      if (lastVerdict.passed) {
        this.logger.info(`Arbiter passed stage "${stage}" on attempt ${attempt}`);
        break;
      }

      const recoverable = lastVerdict.failures.some(check => check.recoverable);
      if (!recoverable) break;
    }

    const verdict = { ...lastVerdict, attempts, stage };
    this.attachVerdict(lastResult, verdict);

    if (!verdict.passed && this.enforcing) {
      const blocking = verdict.failures.filter(check => check.blocking);
      if (blocking.length) {
        const error = new Error(
          `Arbiter rejected stage "${stage}" after ${attempts.length} attempt(s): ` +
            blocking.map(check => check.message).join(' | ')
        );
        error.code = 'STAGE_ARBITER_REJECTED';
        error.stage = stage;
        error.verdict = verdict;
        throw error;
      }
    }

    if (!verdict.passed) {
      this.logger.warn(
        `Stage "${stage}" continues with unresolved advisories: ${verdict.failures.map(c => c.id).join(', ')}`
      );
    }

    return lastResult;
  }

  /**
   * Store the verdict on the artefact so it survives into persistence and the
   * operator UI, without breaking consumers that ignore it.
   */
  attachVerdict(result, verdict) {
    if (!result || typeof result !== 'object') return;
    if (!result.arbiter) {
      Object.defineProperty(result, 'arbiter', { value: verdict, enumerable: true, writable: true });
    } else {
      result.arbiter = verdict;
    }
  }

  async review(stage, result, context = {}) {
    const reviewer = this.reviewers()[stage];
    if (!reviewer) {
      return { stage, passed: true, checks: [], failures: [] };
    }

    let checks;
    try {
      checks = await reviewer.call(this, result, context);
    } catch (error) {
      this.logger.error(`Arbiter for stage "${stage}" crashed: ${error.message}`);
      // An arbiter that cannot run must not silently approve the output, but it
      // must not hard-fail an otherwise healthy run either.
      checks = [this.check('arbiter_error', false, `Arbiter could not evaluate this stage: ${error.message}`, {
        blocking: false,
        recoverable: false,
      })];
    }

    const failures = checks.filter(check => !check.passed);
    return {
      stage,
      passed: failures.every(check => !check.blocking),
      checks,
      failures,
      evaluatedAt: new Date().toISOString(),
    };
  }

  reviewers() {
    return {
      strategy: this.reviewStrategy,
      script: this.reviewScript,
      thumbnail: this.reviewThumbnail,
      seo: this.reviewSeo,
      production: this.reviewProduction,
    };
  }

  check(id, passed, message, options = {}) {
    return {
      id,
      passed: Boolean(passed),
      message,
      blocking: options.blocking !== false,
      recoverable: options.recoverable !== false,
      // Guidance is what the retry actually consumes; keep it imperative.
      guidance: options.guidance || null,
      evidence: options.evidence || null,
    };
  }

  /**
   * Compose arbiter failures into an instruction block for the retry.
   */
  buildFeedback(verdict) {
    const recoverable = verdict.failures.filter(check => check.recoverable);
    if (!recoverable.length) return null;

    const lines = recoverable.map(check => {
      const guidance = check.guidance ? ` ${check.guidance}` : '';
      const evidence = check.evidence ? ` Exemples à corriger : ${JSON.stringify(check.evidence).slice(0, 400)}.` : '';
      return `- ${check.message}.${guidance}${evidence}`;
    });

    return [
      'The previous attempt was rejected by the quality arbiter. Fix every point below:',
      ...lines,
      'Produce a corrected version that satisfies all of these constraints.',
    ].join('\n');
  }

  // ---------------------------------------------------------------- reviewers

  async reviewStrategy(strategy, context) {
    const checks = [];
    const language = resolveLanguage(context.language);

    checks.push(
      this.check('strategy_present', strategy && typeof strategy === 'object', 'Strategy stage returned no usable object', {
        recoverable: false,
      })
    );
    if (!strategy || typeof strategy !== 'object') return checks;

    const topic = String(strategy.topic || '').trim();
    checks.push(this.check('strategy_topic', topic.length >= 3, 'Strategy has no usable topic'));

    // A bare URL as the topic means the source link was never resolved into a
    // subject — the exact failure that produced a video about nothing.
    checks.push(
      this.check('strategy_topic_not_url', !/^https?:\/\//i.test(topic),
        'Topic is a raw URL instead of a subject derived from the source', {
          guidance: 'Derive a human-readable topic from the ingested source document title.',
        })
    );

    if (context.sourceDocument) {
      const sourceTitle = String(context.sourceDocument.title || '').toLowerCase();
      const topicLower = topic.toLowerCase();
      const sharedTerms = this.significantTerms(sourceTitle).filter(term => topicLower.includes(term));
      checks.push(
        this.check('strategy_matches_source', sourceTitle.length === 0 || sharedTerms.length > 0,
          'Strategy topic is unrelated to the supplied source document', {
            guidance: `Anchor the topic to the source document titled "${context.sourceDocument.title}".`,
            evidence: { sourceTitle: context.sourceDocument.title, topic },
          })
      );
    }

    const strategyText = [topic, strategy.angle, strategy.targetAudience].filter(Boolean).join('. ');
    const languageReport = analyze(strategyText, language);
    checks.push(
      this.check('strategy_language', languageReport.consistent,
        `Strategy fields are not written in the target language (${language})`, {
          blocking: false,
          guidance: `Write the topic, angle and audience in ${language === 'fr' ? 'French' : 'English'}.`,
          evidence: languageReport.offendingSegments,
        })
    );

    return checks;
  }

  async reviewScript(script, context) {
    const checks = [];
    const language = resolveLanguage(context.language);

    checks.push(
      this.check('script_present', script && typeof script === 'object', 'Script stage returned no usable object', {
        recoverable: false,
      })
    );
    if (!script || typeof script !== 'object') return checks;

    const sections = script.mainContent?.sections || [];
    const spoken = this.spokenText(script);
    const words = spoken.split(/\s+/).filter(Boolean).length;

    // 1. Language consistency — the defect that made narration switch mid-video.
    const languageReport = analyze(spoken, language);
    checks.push(
      this.check('script_language', languageReport.consistent,
        `Narration mixes languages: ${Math.round(languageReport.ratio * 100)}% of segments are not in ${language}`, {
          guidance: `Rewrite every line in ${language === 'fr' ? 'French' : 'English'} with no leftover boilerplate from another language.`,
          evidence: languageReport.offendingSegments,
        })
    );

    // 2. Real structure, not an introduction restated.
    checks.push(
      this.check('script_sections', sections.length >= 3,
        `Script has only ${sections.length} content section(s)`, {
          guidance: 'Produce at least three distinct sections that each advance the subject.',
        })
    );

    const repetition = this.repetitionReport(script, sections);
    checks.push(
      this.check('script_not_repetitive', repetition.ratio <= 0.25,
        `Script repeats itself: ${Math.round(repetition.ratio * 100)}% of sentences are duplicates`, {
          guidance: 'Every section must deliver new information; do not restate the introduction.',
          evidence: repetition.samples,
        })
    );

    checks.push(
      this.check('script_distinct_titles', repetition.distinctTitles,
        'Several sections share the same title', {
          guidance: 'Give each section a distinct, descriptive title.',
        })
    );

    // 3. Length matches what was asked for.
    const target = LENGTH_TARGETS[context.lengthKey] || LENGTH_TARGETS.medium;
    const minWords = Math.round(target.minMinutes * WORDS_PER_MINUTE);
    const maxWords = Math.round(target.maxMinutes * WORDS_PER_MINUTE);
    checks.push(
      this.check('script_length', words >= minWords && words <= maxWords,
        `Narration is ${words} words, outside the ${minWords}-${maxWords} word target for a "${context.lengthKey || 'medium'}" video`, {
          blocking: words < minWords * 0.6,
          guidance: `Write roughly ${minWords}-${maxWords} words of spoken narration.`,
        })
    );

    // 4. The script must actually follow the supplied guide.
    if (context.sourceDocument?.outline?.length) {
      const coverage = this.sourceCoverage(script, context.sourceDocument);
      checks.push(
        // A video synthesises its source rather than reciting it, so full
        // coverage is not the goal — only that the script is genuinely about
        // the supplied guide and not a loosely related essay.
        this.check('script_covers_source', coverage.ratio >= 0.3,
          `Script only covers ${Math.round(coverage.ratio * 100)}% of the source guide's outline`, {
            guidance:
              'Ground the script in the supplied guide: the topics you cover must come from it.',
            evidence: { missing: coverage.missing.slice(0, 6) },
          })
      );
    }

    checks.push(
      this.check('script_title', String(script.title || '').trim().length > 0 && String(script.title).length <= 100,
        'Script title is missing or longer than 100 characters')
    );

    checks.push(
      this.check('script_has_cta', Boolean(this.ctaText(script).trim()),
        'Script has no call to action', { blocking: false })
    );

    return checks;
  }

  async reviewThumbnail(thumbnail, _context) {
    const checks = [];
    checks.push(
      this.check('thumbnail_present', thumbnail && typeof thumbnail === 'object', 'Thumbnail stage returned nothing', {
        recoverable: false,
      })
    );
    if (!thumbnail || typeof thumbnail !== 'object') return checks;

    const thumbPath = thumbnail.path || thumbnail.filePath || null;
    const usable = thumbPath ? await this.isRealImage(thumbPath) : false;
    checks.push(
      this.check('thumbnail_is_image', usable,
        'Thumbnail is missing or is a placeholder rather than a real image', {
          blocking: false,
          evidence: thumbPath ? { path: path.basename(String(thumbPath)) } : null,
        })
    );
    return checks;
  }

  async reviewSeo(seo, context) {
    const checks = [];
    const language = resolveLanguage(context.language);

    checks.push(
      this.check('seo_present', seo && typeof seo === 'object', 'SEO stage returned nothing', { recoverable: false })
    );
    if (!seo || typeof seo !== 'object') return checks;

    const title = String(seo.title || '').trim();
    const description = String(seo.description || '').trim();
    const tags = Array.isArray(seo.tags) ? seo.tags : [];

    checks.push(
      this.check('seo_title', title.length > 0 && title.length <= 100,
        `SEO title is missing or exceeds YouTube's 100-character limit (${title.length})`)
    );
    checks.push(
      this.check('seo_description', description.length >= 50 && description.length <= 5000,
        `SEO description is ${description.length} characters, outside the 50-5000 range`, { blocking: false })
    );
    checks.push(
      this.check('seo_tags', tags.length >= 3, `Only ${tags.length} tag(s) generated`, { blocking: false })
    );

    const seoReport = analyze(`${title}. ${description}`, language);
    checks.push(
      this.check('seo_language', seoReport.consistent,
        `SEO metadata is not written in ${language}`, {
          // Advisory rather than blocking: metadata is editable in the review UI
          // before publication, unlike narration which is baked into the audio.
          blocking: false,
          guidance: `Write the title and description in ${language === 'fr' ? 'French' : 'English'}.`,
          evidence: seoReport.offendingSegments,
        })
    );

    return checks;
  }

  async reviewProduction(production, context) {
    const checks = [];
    checks.push(
      this.check('production_present', production && typeof production === 'object', 'Production stage returned nothing', {
        recoverable: false,
      })
    );
    if (!production || typeof production !== 'object') return checks;

    const assets = production.assets || {};
    const visualAssets = assets.video?.visualAssets || [];

    // Placeholder detection: the pipeline used to emit .info stubs and flat
    // gradients and still call the stage a success.
    const realVisuals = [];
    for (const asset of visualAssets) {
      const assetPath = typeof asset === 'string' ? asset : asset?.path;
      if (assetPath && await this.isRealImage(assetPath)) realVisuals.push(assetPath);
    }

    // A finished, non-simulated video is itself proof that usable imagery
    // existed: some provider paths render clips directly without ever writing
    // intermediate stills. Only demand still assets when there is no such video.
    const finalVideo = assets.finalVideo || {};
    const hasRenderedVideo = Boolean(finalVideo.path) && finalVideo.simulated !== true;

    checks.push(
      this.check('production_visuals_present', realVisuals.length > 0 || hasRenderedVideo,
        'No usable visual assets were produced', {
          guidance: 'Generate real imagery for each scene before rendering.',
        })
    );

    const sectionCount = (production.script?.mainContent?.sections || []).length;
    if (sectionCount > 0 && realVisuals.length > 0) {
      // One visual for a ten-section video is what produces "the images have
      // nothing to do with the content" — the same frame under every chapter.
      const expected = Math.max(2, Math.ceil(sectionCount * 0.5));
      checks.push(
        this.check('production_visual_coverage', realVisuals.length >= expected,
          `Only ${realVisuals.length} visual(s) for ${sectionCount} sections (expected at least ${expected})`, {
            blocking: false,
            guidance: 'Generate a distinct visual per section so imagery tracks the narration.',
          })
      );
    }

    const audio = assets.audio || {};
    const hasNarration = Boolean(audio.path) && audio.simulated !== true && audio.status !== 'unavailable';
    checks.push(
      this.check('production_narration', hasNarration,
        'Narration audio is missing or simulated', {
          // Without narration *and* without a rendered video there is nothing
          // publishable, so the stage must fail loudly. Letting it "pass" is
          // what allowed placeholder-only runs to look successful.
          blocking: !hasRenderedVideo,
          // Re-running rarely helps: the usual causes are an unconfigured or
          // exhausted TTS provider, which needs an operator, not another attempt.
          recoverable: false,
          guidance: 'Configure a working TTS provider so the video carries real narration.',
          evidence: audio.error ? { error: String(audio.error).slice(0, 300) } : null,
        })
    );

    if (context.sourceDocument?.screenshots?.length) {
      const usesSourceShots = realVisuals.some(assetPath =>
        context.sourceDocument.screenshots.some(shot => shot.path === assetPath)
      );
      checks.push(
        this.check('production_uses_source_visuals', usesSourceShots,
          'Screenshots captured from the source page were not used as visuals', {
            blocking: false,
            guidance: 'Prefer real screenshots of the documented interface over generated art.',
          })
      );
    }

    return checks;
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Reconstruct only what the narrator says — labels, timing markers and stage
   * directions must not be judged as narration, and must never be spoken.
   */
  spokenText(script) {
    const parts = [];
    if (script.hook?.text) parts.push(script.hook.text);
    const intro = script.introduction || {};
    parts.push(intro.greeting, intro.topicIntro, intro.valueProposition, intro.credibility);

    for (const section of script.mainContent?.sections || []) {
      parts.push(section.title);
      if (Array.isArray(section.content)) parts.push(...section.content);
      else if (typeof section.content === 'string') parts.push(section.content);
      for (const step of section.steps || []) parts.push(step.title, step.description, step.tip);
      for (const item of section.items || []) parts.push(item.title, item.description);
      for (const point of section.points || []) parts.push(point);
    }

    const conclusion = script.conclusion || {};
    parts.push(...(conclusion.recap || []), conclusion.finalThought);
    parts.push(this.ctaText(script));

    return parts
      .filter(part => typeof part === 'string' && part.trim())
      .join('\n');
  }

  ctaText(script) {
    const cta = script.callToAction || {};
    return [cta.subscribe, cta.like, cta.comment, cta.nextVideo]
      .filter(value => typeof value === 'string')
      .join(' ');
  }

  repetitionReport(script, sections) {
    const sentences = this.spokenText(script)
      .split(/[.!?\n]+/)
      .map(sentence => sentence.trim().toLowerCase())
      .filter(sentence => sentence.length > 25);

    const seen = new Map();
    for (const sentence of sentences) {
      seen.set(sentence, (seen.get(sentence) || 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
    const duplicateCount = duplicates.reduce((total, [, count]) => total + count - 1, 0);

    const titles = sections.map(section => String(section.title || '').trim().toLowerCase()).filter(Boolean);

    return {
      ratio: sentences.length ? duplicateCount / sentences.length : 0,
      samples: duplicates.slice(0, 4).map(([sentence]) => sentence.slice(0, 120)),
      distinctTitles: titles.length === new Set(titles).size,
    };
  }

  /**
   * How much of the source guide's outline the script actually addresses.
   * Matching is term-based rather than exact-string, since a good script
   * rephrases a heading rather than copying it verbatim.
   */
  sourceCoverage(script, sourceDocument) {
    const haystack = this.spokenText(script).toLowerCase();
    const headings = sourceDocument.outline || [];
    const missing = [];
    let covered = 0;

    for (const heading of headings) {
      const terms = this.significantTerms(heading.text);
      if (!terms.length) continue;
      const hits = terms.filter(term => haystack.includes(term)).length;
      if (hits / terms.length >= 0.4) covered += 1;
      else missing.push(heading.text);
    }

    const total = covered + missing.length;
    return { ratio: total ? covered / total : 1, missing, covered, total };
  }

  significantTerms(text) {
    const stopwords = new Set([
      'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'au', 'aux', 'et', 'ou', 'que', 'qui',
      'pour', 'avec', 'sans', 'dans', 'sur', 'mon', 'ma', 'mes', 'ce', 'cet', 'cette', 'ces',
      'en', 'par', 'est', 'sont', 'ne', 'pas', 'plus', 'the', 'and', 'for', 'with', 'what', 'from',
      'faire', 'peut', 'pouvez', 'vous', 'votre', 'depuis', 'quoi', 'dont',
    ]);
    return [
      ...new Set(
        String(text)
          .toLowerCase()
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .split(/[^a-z0-9]+/)
          .filter(term => term.length >= 4 && !stopwords.has(term))
      ),
    ];
  }

  /**
   * A real image, not a stub. Checks the magic bytes rather than the extension,
   * because the old pipeline wrote JSON into files it called assets.
   */
  async isRealImage(filePath) {
    try {
      const target = String(filePath);
      if (target.endsWith('.info')) return false;
      // Generated stand-ins are valid PNGs, so the magic-byte check below cannot
      // catch them; they identify themselves by filename instead.
      if (/(?:^|[/\\])placeholder_/.test(target) || /_sim_/.test(target)) return false;
      const handle = await fs.open(target, 'r');
      try {
        const buffer = Buffer.alloc(12);
        const { bytesRead } = await handle.read(buffer, 0, 12, 0);
        if (bytesRead < 8) return false;
        const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
        const isWebp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
          buffer.subarray(8, 12).toString('ascii') === 'WEBP';
        if (!isPng && !isJpeg && !isWebp) return false;
        const stats = await fs.stat(target);
        // Below ~2 KB a 1920x1080 render is a blank or failed frame.
        return stats.size > 2048;
      } finally {
        await handle.close();
      }
    } catch (_error) {
      return false;
    }
  }
}

module.exports = { StageArbiterService, LENGTH_TARGETS, WORDS_PER_MINUTE };
