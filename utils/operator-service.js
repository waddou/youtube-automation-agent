const fs = require('fs').promises;
const axios = require('axios');
const { Logger } = require('./logger');

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

  checkLanguageConsistency(script, production) {
    const language = process.env.DEFAULT_LANGUAGE || 'fr';
    const isFrench = language === 'fr';
    
    if (isFrench) {
      // Count French words vs English words
      const frenchWords = (script.match(/\b(le|la|les|un|une|des|du|de|et|ou|mais|donc|car|que|qui|ce|cette|ces|mon|ma|mes|ton|ta|tes|son|sa|ses|notre|votre|leur|leurs|je|tu|il|elle|nous|vous|ils|elles|est|sont|ai|as|a|avons|avez|ont|être|avoir|faire|aller|venir|voir|savoir|pouvoir|vouloir|devoir|falloir)\b/gi) || []).length;
      const englishWords = (script.match(/\b(the|and|or|but|so|because|that|this|these|those|my|your|his|her|its|our|their|i|you|he|she|we|they|is|are|am|have|has|had|do|does|did|will|would|could|should|may|might|must|can|shall)\b/gi) || []).length;
      
      // If more than 10% English words in French content, flag it
      const totalWords = script.split(/\s+/).length;
      const englishRatio = englishWords / Math.max(totalWords, 1);
      
      return englishRatio < 0.1;
    }
    
    // For English, just check it's not mostly French
    return true;
  }

  checkScriptStructure(script) {
    // Check for repetitive patterns - same phrases repeated
    const sentences = script.split(/[.!?]+/).filter(s => s.trim().length > 20);
    if (sentences.length < 5) return true; // Not enough to check
    
    // Check for duplicate sentences (or very similar)
    const uniqueSentences = new Set(sentences.map(s => s.trim().toLowerCase()));
    const duplicateRatio = 1 - (uniqueSentences.size / sentences.length);
    
    // Check for repetitive intro patterns
    const introPatterns = [
      /today.{0,30}diving.{0,30}deep/i,
      /by the end.{0,30}you.{0,30}understand/i,
      /welcome back.{0,30}channel/i
    ];
    
    let introCount = 0;
    for (const pattern of introPatterns) {
      const matches = script.match(pattern);
      if (matches && matches.length > 1) introCount += matches.length - 1;
    }
    
    return duplicateRatio < 0.3 && introCount < 2;
  }

  checkWordCount(script, requestedLength) {
    const wordCount = script.split(/\s+/).length;
    const targets = {
      'short': { min: 800, max: 1500 },
      'medium': { min: 1500, max: 3000 },
      'long': { min: 3000, max: 5000 }
    };
    const target = targets[requestedLength] || targets.medium;
    return wordCount >= target.min && wordCount <= target.max;
  }

  checkImageQuality(assets) {
    if (!assets) return false;
    
    const thumbnail = assets.thumbnail;
    const video = assets.finalVideo;
    
    // Check thumbnail is actual image file
    if (thumbnail?.path) {
      const isInfoFile = thumbnail.path.endsWith('.info');
      const isSimulated = thumbnail.path.includes('sim_') || thumbnail.path.includes('.info');
      if (isInfoFile || isSimulated) return false;
    }
    
    // Check video assets
    if (video?.visualAssets) {
      for (const asset of video.visualAssets) {
        if (asset.endsWith('.info')) return false;
        if (asset.includes('sim_')) return false;
      }
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
