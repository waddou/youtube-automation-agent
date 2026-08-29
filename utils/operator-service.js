const fs = require('fs').promises;
const axios = require('axios');
const { Logger } = require('./logger');
const { analyze } = require('./language-detector');
const { resolveLanguage } = require('./i18n');
const { LENGTH_TARGETS, WORDS_PER_MINUTE } = require('./stage-arbiter-service');


class OperatorService {
  constructor(db) {
    this.db = db;
    this.logger = new Logger('OperatorService');
  }

  async runQualityChecks(production, profile = {}) {
    const title = String(production.seo?.title || production.script?.title || '').trim();
    const description = String(production.seo?.description || '').trim();
    const tags = Array.isArray(production.seo?.tags) ? production.seo.tags : [];
    const script = String(production.script?.fullScript || '').trim();
    const finalVideo = production.assets?.finalVideo;
    const thumbnail = production.assets?.thumbnail;
    const bannedTopics = Array.isArray(profile.bannedTopics) ? profile.bannedTopics : [];
    const strategy = production.strategy || production.script?.metadata?.strategy || {};
    const combinedText = `${title}\n${description}\n${script}`.toLowerCase();

    const checks = [
      this.check('title', title.length > 0 && title.length <= 100,
        title ? `Title is ${title.length}/100 characters` : 'A title is required'),
      this.check('description', description.length >= 50,
        description.length >= 50 ? 'Description is detailed enough' : 'Description should be at least 50 characters'),
      this.check('tags', tags.length >= 3,
        tags.length >= 3 ? `${tags.length} tags provided` : 'Add at least 3 relevant tags', false),
      this.check('script', script.length >= 200,
        script.length >= 200 ? 'Script content is present' : 'Script is missing or unusually short'),
      this.check('thumbnail', Boolean(thumbnail?.path),
        thumbnail?.path ? 'Thumbnail asset is present' : 'Thumbnail asset is missing', false),
      this.check('video', Boolean(finalVideo?.path && !finalVideo?.simulated),
        finalVideo?.simulated
          ? 'Only a simulated video was produced'
          : finalVideo?.path ? 'Final MP4 is ready' : 'Final MP4 is missing'),
      // Language consistency check
      this.check('language_consistency', this.checkLanguageConsistency(script, production),
        this.checkLanguageConsistency(script, production) ? 'Content language is consistent' : 'Content contains mixed languages - ensure single language throughout', false),
      // Script structure check - no repetitive sections
      this.check('script_structure', this.checkScriptStructure(script),
        this.checkScriptStructure(script) ? 'Script structure is varied' : 'Script has repetitive sections - ensure unique content per section', false),
      // Word count check
      this.check('word_count', this.checkWordCount(script, strategy?.requestedLengthKey || 'medium'),
        this.checkWordCount(script, strategy?.requestedLengthKey || 'medium') ? 'Script word count matches target length' : 'Script word count does not match target length', false),
      // Image quality check
      this.check('image_quality', this.checkImageQuality(production.assets),
        this.checkImageQuality(production.assets) ? 'Images are proper visual assets' : 'Images appear to be placeholders - use AI-generated or real images', false),
    ];

    const topic = String(production.strategy?.topic || '').trim();
    if (topic) {
      const duplicates = await this.db.getRow(
        `SELECT COUNT(*) AS count FROM content_strategies
         WHERE lower(trim(topic)) = lower(trim(?))
         AND created_at >= datetime('now', '-90 days')`,
        [topic]
      );
      const unique = Number(duplicates?.count || 0) <= 1;
      checks.push(this.check('duplicate_topic', unique,
        unique
          ? 'No duplicate topic detected in the last 90 days'
          : 'This exact topic was already generated recently', false));
    }

    if (finalVideo?.path && !finalVideo?.simulated) {
      checks.push(this.check('video_file', await this.fileExists(finalVideo.path),
        'Final video file exists on disk'));
    }

    const audio = production.assets?.audio || {};
    const intentionalSilence = audio.intentionalSilence === true &&
      String(audio.silenceReason || '').trim().length >= 10 &&
      Boolean(audio.silenceConfirmedAt);
    const productionAudioReady = !audio.simulated && await this.fileExists(audio.path);
    const scenes = production.scenes || [];
    let sceneAudioReady = false;
    if (scenes.length) {
      const readiness = [];
      for (const scene of scenes) {
        readiness.push(scene.narrationStatus === 'intentional_silence' || (
          scene.narrationStatus === 'current' && await this.fileExists(scene.audioPath)
        ));
      }
      sceneAudioReady = readiness.every(Boolean);
    }
    const narrationReady = intentionalSilence || productionAudioReady || sceneAudioReady;
    checks.push(this.check('narration', narrationReady,
      intentionalSilence
        ? `Intentional silence confirmed: ${audio.silenceReason}`
        : narrationReady
          ? `Narration is ready${audio.provider ? ` via ${audio.provider}` : ''}`
          : audio.intentionalSilence
            ? 'Intentional silence requires an operator confirmation and reason of at least 10 characters'
            : 'Narration is missing or unusable; regenerate it before approval'));

    const matchedBannedTopics = bannedTopics.filter(topic =>
      topic && combinedText.includes(String(topic).toLowerCase())
    );
    checks.push(this.check('brand_policy', matchedBannedTopics.length === 0,
      matchedBannedTopics.length
        ? `Content matches blocked terms: ${matchedBannedTopics.join(', ')}`
        : 'No blocked brand topics detected'));

    const provenance = production.provenance || {};
    const provenancePassed = ['verified', 'not_required'].includes(provenance.status || 'not_required');
    const unresolved = Number(provenance.summary?.unresolvedClaims || 0);
    checks.push(this.check('provenance', provenancePassed,
      provenance.status === 'verified'
        ? `${provenance.summary?.resolvedClaims || 0} factual claims resolved against reviewed evidence`
        : provenance.status === 'not_required'
          ? 'No externally verifiable factual claims were declared'
          : `${unresolved} factual claim${unresolved === 1 ? '' : 's'} still require evidence review`));

    const discoverability = production.discoverability;
    if (discoverability) {
      const actionable = (discoverability.findings || []).filter(finding =>
        ['CRITICAL', 'HIGH'].includes(finding.severity) && finding.reviewStatus !== 'dismissed'
      );
      const available = discoverability.status !== 'unavailable';
      checks.push(this.check(
        'discoverability',
        available && actionable.length === 0,
        !available
          ? `DarkzSEO advisory audit is unavailable${discoverability.error ? `: ${discoverability.error}` : ''}`
          : actionable.length
            ? `${actionable.length} high-priority discoverability finding${actionable.length === 1 ? '' : 's'} await remediation or dismissal`
            : `${discoverability.findings?.length || 0} discoverability finding${discoverability.findings?.length === 1 ? '' : 's'} recorded; no unresolved high-priority findings`,
        false
      ));
    }

    if (scenes.length) {
      const invalidScenes = scenes.filter(scene =>
        !scene.assetPath || ['missing_asset', 'failed', 'generating', 'needs_rebuild', 'visual_stale'].includes(scene.status) ||
        !['current', 'intentional_silence'].includes(scene.narrationStatus)
      );
      const unlicensedUploads = scenes.filter(scene => scene.assetOrigin === 'uploaded' && !scene.rightsConfirmed);
      checks.push(this.check('scene_integrity', invalidScenes.length === 0,
        invalidScenes.length === 0
          ? `${scenes.length} scene${scenes.length === 1 ? '' : 's'} are rebuilt and current`
          : `${invalidScenes.length} scene${invalidScenes.length === 1 ? '' : 's'} still require repair or rebuild`));
      checks.push(this.check('scene_rights', unlicensedUploads.length === 0,
        unlicensedUploads.length === 0
          ? 'Replacement scene assets have rights confirmation'
          : `${unlicensedUploads.length} uploaded scene asset${unlicensedUploads.length === 1 ? '' : 's'} lack rights confirmation`));
    }

    const blockingFailures = checks.filter(check => check.blocking && !check.passed);
    return {
      passed: blockingFailures.length === 0,
      score: Math.round((checks.filter(check => check.passed).length / checks.length) * 100),
      blockingFailures: blockingFailures.map(check => check.id),
      checks
    };
  }

  /**
   * Final-gate quality checks.
   *
   * These duplicate what the per-stage arbiters already enforce, and exist as a
   * last line of defence for productions that reached review by another route
   * (a resumed job reusing old checkpoints, an imported production). They
   * delegate to the shared implementations so the two layers cannot drift apart
   * and disagree about the same artefact.
   */
  checkLanguageConsistency(script, _production) {
    const language = resolveLanguage(process.env.DEFAULT_LANGUAGE);
    return analyze(String(script || ''), language).consistent;
  }

  checkScriptStructure(script) {
    const sentences = String(script || '')
      .split(/[.!?\n]+/)
      .map(sentence => sentence.trim().toLowerCase())
      .filter(sentence => sentence.length > 25);
    if (sentences.length < 5) return true;

    const seen = new Map();
    for (const sentence of sentences) seen.set(sentence, (seen.get(sentence) || 0) + 1);
    const duplicates = [...seen.values()].reduce((total, count) => total + count - 1, 0);
    return duplicates / sentences.length <= 0.3;
  }

  checkWordCount(script, requestedLength) {
    const words = String(script || '').split(/\s+/).filter(Boolean).length;
    const target = LENGTH_TARGETS[requestedLength] || LENGTH_TARGETS.medium;
    return (
      words >= target.minMinutes * WORDS_PER_MINUTE &&
      words <= target.maxMinutes * WORDS_PER_MINUTE
    );
  }

  checkImageQuality(assets) {
    if (!assets) return false;

    const isPlaceholder = value => {
      const target = String(value || '');
      if (!target) return false;
      return target.endsWith('.info') || /placeholder_/.test(target) || /_sim_/.test(target);
    };

    if (isPlaceholder(assets.thumbnail?.path)) return false;

    for (const asset of assets.video?.visualAssets || []) {
      if (isPlaceholder(typeof asset === 'string' ? asset : asset?.path)) return false;
    }

    return true;
  }

  check(id, passed, message, blocking = true) {
    return { id, passed: Boolean(passed), blocking, message };
  }

  async fileExists(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return stats.isFile() && stats.size > 0;
    } catch (_error) {
      return false;
    }
  }

  async notify(notification) {
    const enabled = await this.db.getSetting('notification_enabled');
    if (enabled === 'false') return null;

    const id = await this.db.createNotification(notification);
    const webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        await axios.post(webhookUrl, {
          text: `${notification.title}: ${notification.message}`,
          content: `${notification.title}: ${notification.message}`,
          ...notification
        }, { timeout: 5000 });
      } catch (error) {
        this.logger.warn(`Notification webhook failed: ${error.message}`);
      }
    }
    return id;
  }
}

module.exports = { OperatorService };
