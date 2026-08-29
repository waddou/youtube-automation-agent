const OpenAI = require('openai');
const Replicate = require('replicate');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { Logger } = require('./logger');
const { runFFmpeg, checkFFmpeg, getMediaDuration, ffmpegInstallHint } = require('./ffmpeg');
const { MediaGenerationService } = require('./media-generation-service');
const { resolveLanguage } = require('./i18n');

// Encoding settings for slideshow renders. The picture is static between
// crossfades, so a fast preset costs nothing visually while cutting render time
// of a 9-minute 1080p slideshow from tens of minutes to a couple.
const SLIDESHOW_ENCODE = ['-preset', 'veryfast', '-crf', '24', '-tune', 'stillimage'];

class AIVideoGenerator {
  constructor(credentials, options = {}) {
    this.logger = new Logger('AIVideoGenerator');
    const resolvedCredentials = credentials?.credentials || credentials || {};
    this.db = options.db || null;
    this.lastVideoResult = null;
    this.lastNarrationResult = null;
    
    // Initialize AI services with graceful fallback
    const openaiKey = resolvedCredentials.openai?.apiKey || process.env.OPENAI_API_KEY;
    const replicateKey = resolvedCredentials.replicate?.apiKey || process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
    
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.logger.info('OpenAI service initialized');
    } else {
      this.logger.warn('OpenAI API key not found - AI features will be simulated');
    }
    
    if (replicateKey) {
      this.replicate = new Replicate({ auth: replicateKey });
      this.logger.info('Replicate service initialized');
    } else {
      this.logger.warn('Replicate API key not found - advanced video generation unavailable');
    }

    // Gemini media generation (images + native TTS) — free-tier alternative to OpenAI
    const geminiKey = resolvedCredentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        this.gemini = new GoogleGenAI({ apiKey: geminiKey });
        this.logger.info('Gemini media service initialized (images + TTS)');
      } catch (error) {
        this.logger.warn('Failed to initialize Gemini media service:', error.message);
      }
    }
    
    // OpenRouter exposes several image models behind one key. It matters as a
    // fallback because a Gemini key that has run out of credits fails every
    // image request, and the pipeline then has no imagery at all.
    const openRouterKey = resolvedCredentials.openRouter?.apiKey || process.env.OPENROUTER_API_KEY;
    if (openRouterKey) {
      this.openRouter = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: openRouterKey });
      this.openRouterImageModel = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image';
      this.logger.info(`OpenRouter image service initialized (model: ${this.openRouterImageModel})`);
    }

    // ElevenLabs configuration
    this.elevenLabsApiKey = resolvedCredentials.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY;
    this.elevenLabsVoiceId = resolvedCredentials.elevenLabs?.voiceId || process.env.ELEVENLABS_VOICE_ID;
    this.elevenLabsModel = process.env.ELEVENLABS_TTS_MODEL || 'eleven_v3';
    
    // Azure Speech configuration
    this.azureSpeechKey = resolvedCredentials.azure?.speechKey || process.env.AZURE_SPEECH_KEY;
    this.azureSpeechRegion = resolvedCredentials.azure?.speechRegion || process.env.AZURE_SPEECH_REGION;
    this.mediaGeneration = options.mediaGeneration || (this.db
      ? new MediaGenerationService(this.db, resolvedCredentials, { logger: this.logger })
      : null);
  }

  async generateTTSAudio(text, outputPath) {
    this.logger.info('Generating TTS audio...');
    this.lastNarrationResult = null;
    let provider = 'simulation';
    let model = null;

    try {
      let generatedPath;
      if (this.elevenLabsApiKey && this.elevenLabsVoiceId) {
        provider = 'elevenlabs';
        model = this.elevenLabsModel;
        generatedPath = await this.generateElevenLabsTTS(text, outputPath);
      } else if (this.openai) {
        provider = 'openai';
        model = 'gpt-4o-mini-tts';
        generatedPath = await this.generateOpenAITTS(text, outputPath);
      } else if (this.gemini) {
        provider = 'gemini';
        model = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
        generatedPath = await this.generateGeminiTTS(text, outputPath);
      } else {
        generatedPath = await this.simulateTTSGeneration(text, outputPath);
      }

      const usable = await this.isUsableAudioFile(generatedPath);
      this.lastNarrationResult = {
        status: usable ? 'ready' : 'unavailable',
        path: generatedPath,
        provider,
        model,
        externalTaskId: null,
        generatedAt: new Date().toISOString(),
        simulated: !usable,
        cost: { provider, amount: null, currency: null, invoiceRequired: provider !== 'simulation' }
      };
      return generatedPath;
    } catch (error) {
      this.lastNarrationResult = {
        status: 'failed', path: null, provider, model, externalTaskId: null,
        generatedAt: new Date().toISOString(), simulated: false, error: error.message,
        cost: { provider, amount: null, currency: null, invoiceRequired: provider !== 'simulation' }
      };
      this.logger.error('TTS generation failed:', error);
      throw error;
    }
  }

  /**
   * Narrate with ElevenLabs, segment by segment.
   *
   * Same rationale as the Gemini path: one request for a whole 8-12 minute
   * script is slow, hits per-request character limits, and loses everything
   * already synthesised when it fails. Segments are cached on disk so a retry
   * only pays for what is missing.
   */
  async generateElevenLabsTTS(text, outputPath) {
    const chunks = this.splitNarrationForTTS(text);

    if (chunks.length === 1) {
      await this.synthesizeElevenLabsChunk(chunks[0], outputPath);
      this.logger.info('ElevenLabs TTS generation complete');
      return outputPath;
    }

    this.logger.info(`Narrating ${chunks.length} segments with ElevenLabs...`);
    const parts = [];
    for (const [index, chunk] of chunks.entries()) {
      const partPath = `${outputPath}.part${String(index).padStart(2, '0')}.mp3`;
      if (await this.isUsableAudioFile(partPath)) {
        this.logger.info(`  segment ${index + 1}/${chunks.length} reused from cache`);
        parts.push(partPath);
        continue;
      }
      try {
        await this.synthesizeElevenLabsChunk(chunk, partPath);
      } catch (error) {
        this.logger.warn(
          `Narration stopped at segment ${index + 1}/${chunks.length}; ` +
          `${parts.length} completed segment(s) kept for the next attempt`
        );
        throw error;
      }
      parts.push(partPath);
      this.logger.info(`  segment ${index + 1}/${chunks.length} done`);
    }

    await this.concatAudioFiles(parts, outputPath);
    // Only drop the cache once the finished file exists.
    await Promise.all(parts.map(part => fs.unlink(part).catch(() => {})));

    this.logger.info('ElevenLabs TTS generation complete');
    return outputPath;
  }

  async synthesizeElevenLabsChunk(text, outputPath) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`;
    const attempts = Math.max(1, Number(process.env.ELEVENLABS_TTS_RETRIES || 3));

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await axios({
          method: 'POST',
          url,
          data: {
            text,
            model_id: this.elevenLabsModel,
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.8,
              style: 0.0,
              use_speaker_boost: true
            }
          },
          headers: {
            Accept: 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': this.elevenLabsApiKey
          },
          // Buffer rather than stream: a streamed error response would otherwise
          // be written into the .mp3 as if it were audio.
          responseType: 'arraybuffer',
          timeout: Number(process.env.ELEVENLABS_TIMEOUT_MS || 180000)
        });

        const audio = Buffer.from(response.data);
        if (audio.length < 1000) throw new Error('ElevenLabs returned an empty audio payload');
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, audio);
        return outputPath;
      } catch (error) {
        // Surface the API's own explanation; an arraybuffer error body is a
        // Buffer and would otherwise print as unreadable bytes.
        let detail = error.message;
        if (error.response?.data) {
          try {
            detail = Buffer.isBuffer(error.response.data)
              ? Buffer.from(error.response.data).toString('utf8').slice(0, 300)
              : JSON.stringify(error.response.data).slice(0, 300);
          } catch (_parseError) { /* keep the original message */ }
        }
        lastError = new Error(`ElevenLabs TTS failed (${error.response?.status || 'network'}): ${detail}`);
        if (attempt < attempts) {
          this.logger.warn(`${lastError.message} — retrying (${attempt}/${attempts})`);
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
    throw lastError;
  }

  /**
   * Join encoded audio segments without re-encoding them.
   */
  async concatAudioFiles(parts, outputPath) {
    const listPath = `${outputPath}.concat.txt`;
    const list = parts.map(part => `file '${path.resolve(part).replace(/'/g, "'\\''")}'`).join('\n');
    await fs.writeFile(listPath, list, 'utf8');
    try {
      await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);
    } finally {
      await fs.unlink(listPath).catch(() => {});
    }
    return outputPath;
  }

  async generateOpenAITTS(text, outputPath) {
    const response = await this.openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "coral",
      input: text,
      speed: 1.0
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    this.logger.info('OpenAI TTS generation complete');
    return outputPath;
  }

  /**
   * Narrate a full script with Gemini TTS.
   *
   * A whole 8-12 minute script sent as one request takes minutes and fails
   * often enough to block every long video — the run that motivated this
   * spent 4m34s before erroring out, leaving the pipeline with no narration
   * and therefore no assemblable video. Splitting on sentence boundaries keeps
   * each request small and lets a single failed chunk be retried on its own
   * instead of discarding the entire narration.
   */
  async generateGeminiTTS(text, outputPath) {
    const chunks = this.splitNarrationForTTS(text);

    if (chunks.length === 1) {
      await this.synthesizeGeminiChunk(chunks[0], outputPath);
      this.logger.info('Gemini TTS generation complete');
      return outputPath;
    }

    this.logger.info(`Narrating ${chunks.length} segments with Gemini TTS...`);
    const pcmParts = [];

    // Completed segments are kept on disk between runs. Synthesis is billed per
    // request, and a failure late in a long narration — a quota running out, a
    // transient 5xx — used to discard every segment already paid for. On a
    // retry, cached segments are reused and only the missing ones are bought.
    for (const [index, chunk] of chunks.entries()) {
      const partPath = `${outputPath}.part${String(index).padStart(2, '0')}.pcm`;
      if (await this.hasUsablePcm(partPath)) {
        this.logger.info(`  segment ${index + 1}/${chunks.length} reused from cache`);
        pcmParts.push(partPath);
        continue;
      }
      try {
        await this.synthesizeGeminiChunk(chunk, partPath, { rawPcm: true });
      } catch (error) {
        this.logger.warn(
          `Narration stopped at segment ${index + 1}/${chunks.length}; ` +
          `${pcmParts.length} completed segment(s) kept for the next attempt`
        );
        throw error;
      }
      pcmParts.push(partPath);
      this.logger.info(`  segment ${index + 1}/${chunks.length} done`);
    }

    // Raw PCM of identical format concatenates by simple byte append, which
    // avoids a lossy re-encode per segment and any inter-segment gap.
    const joinedPath = `${outputPath}.joined.pcm`;
    await fs.writeFile(joinedPath, Buffer.concat(await Promise.all(pcmParts.map(part => fs.readFile(part)))));
    await runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', joinedPath, outputPath]);
    await fs.unlink(joinedPath).catch(() => {});
    // Only discard the cache once the finished file exists.
    await Promise.all(pcmParts.map(part => fs.unlink(part).catch(() => {})));

    this.logger.info('Gemini TTS generation complete');
    return outputPath;
  }

  async hasUsablePcm(filePath) {
    try {
      const stats = await fs.stat(filePath);
      // A truncated write leaves a tiny file; anything under a second of 24kHz
      // 16-bit mono audio is not a real segment.
      return stats.size > 48000;
    } catch (_error) {
      return false;
    }
  }

  async synthesizeGeminiChunk(text, outputPath, options = {}) {
    const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
    const voiceName = process.env.GEMINI_TTS_VOICE || 'Kore';
    const attempts = Math.max(1, Number(process.env.GEMINI_TTS_RETRIES || 2));

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.gemini.models.generateContent({
          model,
          contents: [{ parts: [{ text }] }],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName }
              }
            }
          }
        });

        const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!audioData) throw new Error('Gemini TTS returned no audio data');

        const pcm = Buffer.from(audioData, 'base64');
        if (options.rawPcm) {
          // Gemini returns raw PCM (24kHz, mono, 16-bit); keep it unencoded so
          // segments can be joined losslessly.
          await fs.writeFile(outputPath, pcm);
          return outputPath;
        }

        const pcmPath = outputPath + '.pcm';
        await fs.writeFile(pcmPath, pcm);
        await runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, outputPath]);
        await fs.unlink(pcmPath).catch(() => {});
        return outputPath;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          this.logger.warn(`Gemini TTS segment failed (attempt ${attempt}/${attempts}): ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
    throw lastError;
  }

  /**
   * Split narration into TTS-sized pieces without cutting mid-sentence, since a
   * cut inside a sentence is audible as a dropped word.
   */
  splitNarrationForTTS(text, maxChars = Number(process.env.TTS_CHUNK_CHARS || 1800)) {
    const source = String(text || '').trim();
    if (source.length <= maxChars) return [source];

    // Split on sentence enders and blank lines, keeping the punctuation.
    const units = source.split(/(?<=[.!?])\s+|\n{2,}/).map(unit => unit.trim()).filter(Boolean);
    const chunks = [];
    let current = '';

    for (const unit of units) {
      if (current && `${current} ${unit}`.length > maxChars) {
        chunks.push(current);
        current = unit;
      } else {
        current = current ? `${current} ${unit}` : unit;
      }
    }
    if (current) chunks.push(current);

    return chunks.length ? chunks : [source];
  }

  /**
   * @param {string|{subject: string, style?: string}} brief - what the image
   *   must show. Callers pass a structured brief so the subject stays separate
   *   from the stylistic treatment.
   */
  async generateVisualAssets(brief, style = "documentary", count = 1) {
    const subject = typeof brief === 'object' && brief !== null ? brief.subject : brief;
    const resolvedStyle = (typeof brief === 'object' && brief?.style) || style;
    this.logger.info(`Generating ${count} visual assets with style: ${resolvedStyle}`);

    try {
      if (!this.openai && !this.gemini && !this.openRouter) {
        return await this.simulateVisualAssets(subject, resolvedStyle, count);
      }

      const enhancedPrompt = this.enhanceVisualPrompt(subject, resolvedStyle);
      const localPaths = [];

      for (let i = 0; i < count; i++) {
        const imagePath = path.join(__dirname, '..', 'data', 'assets', `visual_${Date.now()}_${i}.png`);
        await this.generateImage(enhancedPrompt, imagePath);
        localPaths.push(imagePath);
      }

      this.logger.info(`Generated ${localPaths.length} visual assets`);
      return localPaths;
    } catch (error) {
      this.logger.error('Visual asset generation failed:', error);
      return await this.simulateVisualAssets(subject, resolvedStyle, count);
    }
  }

  /**
   * Generate one image, trying each configured provider in turn.
   *
   * Providers fail for reasons that are specific to an account rather than to
   * the request — an exhausted quota, a model the plan cannot call. Stopping at
   * the first error left videos with no imagery even when another usable
   * provider was configured, so every provider gets a turn before giving up.
   */
  async generateImage(prompt, imagePath) {
    await fs.mkdir(path.dirname(imagePath), { recursive: true });

    const providers = [
      this.openai && { name: 'OpenAI', run: () => this.generateOpenAIImage(prompt, imagePath) },
      this.gemini && { name: 'Gemini', run: () => this.generateGeminiImage(prompt, imagePath) },
      this.openRouter && { name: 'OpenRouter', run: () => this.generateOpenRouterImage(prompt, imagePath) },
    ].filter(Boolean);

    if (!providers.length) throw new Error('No image generation provider configured');

    let lastError = null;
    for (const provider of providers) {
      try {
        return await provider.run();
      } catch (error) {
        lastError = error;
        this.logger.warn(`${provider.name} image generation failed: ${String(error.message).slice(0, 200)}`);
      }
    }
    throw lastError;
  }

  async generateOpenRouterImage(prompt, imagePath) {
    const response = await this.openRouter.chat.completions.create({
      model: this.openRouterImageModel,
      messages: [{ role: 'user', content: prompt }],
      // OpenRouter returns images on the chat endpoint when this is requested.
      modalities: ['image', 'text'],
    });

    const image = response.choices?.[0]?.message?.images?.[0];
    const dataUrl = image?.image_url?.url;
    if (!dataUrl) throw new Error('OpenRouter returned no image data');

    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    const buffer = Buffer.from(base64, 'base64');
    const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height) throw new Error('OpenRouter returned an invalid image');

    const extension = path.extname(imagePath).toLowerCase();
    // These models return a square regardless of what the prompt asks for, and
    // a square dropped into a 16:9 timeline is cropped on the sides — often
    // straight through the subject. Fit it to the frame here instead.
    const output = sharp(buffer, { failOn: 'error' })
      .resize(1920, 1080, { fit: 'cover', position: 'attention' });
    if (extension === '.jpg' || extension === '.jpeg') await output.jpeg({ quality: 92 }).toFile(imagePath);
    else if (extension === '.webp') await output.webp({ quality: 92 }).toFile(imagePath);
    else await output.png().toFile(imagePath);
    return imagePath;
  }

  async generateOpenAIImage(prompt, imagePath) {
    const response = await this.openai.images.generate({
      model: "gpt-image-2",
      prompt: prompt,
      n: 1,
      size: "1536x1024",
      quality: "high",
    });

    if (response.data[0].b64_json) {
      const buffer = Buffer.from(response.data[0].b64_json, 'base64');
      await fs.writeFile(imagePath, buffer);
    } else {
      await this.downloadImage(response.data[0].url, imagePath);
    }

    return imagePath;
  }

  async generateGeminiImage(prompt, imagePath) {
    const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

    const response = await this.gemini.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: '16:9',
          imageSize: '1K'
        }
      }
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    const imageParts = parts.filter(part =>
      part.inlineData?.data && (!part.inlineData.mimeType || part.inlineData.mimeType.startsWith('image/'))
    );
    const renderedImages = imageParts.filter(part => part.thought !== true);
    const imagePart = (renderedImages.length ? renderedImages : imageParts).at(-1);
    if (!imagePart) {
      throw new Error('Gemini image generation returned no image data');
    }

    const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
    const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Gemini image generation returned an invalid image asset');
    }

    const extension = path.extname(imagePath).toLowerCase();
    const output = sharp(imageBuffer, { failOn: 'error' });
    if (extension === '.jpg' || extension === '.jpeg') {
      await output.jpeg({ quality: 92 }).toFile(imagePath);
    } else if (extension === '.webp') {
      await output.webp({ quality: 92 }).toFile(imagePath);
    } else {
      await output.png().toFile(imagePath);
    }
    return imagePath;
  }

  enhanceVisualPrompt(prompt, style) {
    const styleEnhancements = {
      // Instructional content about a website, app or account: show the thing
      // itself. This is the default whenever a source page drives the video.
      interface: {
        treatment:
          'photorealistic screenshot-style depiction of a web interface on a desktop screen, ' +
          'realistic browser chrome, clean readable UI panels, plausible French-language labels, ' +
          'neutral office lighting, no fantasy elements',
        medium: 'high-resolution product screenshot, 16:9',
      },
      documentary: {
        treatment:
          'realistic documentary photography, natural lighting, authentic everyday setting, ' +
          'shallow depth of field, no text overlays',
        medium: 'high-quality photograph, 16:9',
      },
      ethereal: {
        treatment: 'ethereal, dreamy, mystical, soft lighting, floating particles, cosmic background',
        medium: 'digital art, 16:9',
      },
      modern: {
        treatment: 'modern, clean, minimalist, professional, sleek design, contemporary',
        medium: 'digital art, 16:9',
      },
      animated: {
        treatment: 'animated style, cartoon, vibrant colors, expressive, dynamic',
        medium: 'illustration, 16:9',
      },
      cinematic: {
        treatment: 'cinematic lighting, dramatic, high contrast, filmic color grading',
        medium: 'cinematic still, 16:9',
      },
      abstract: {
        treatment: 'abstract art, geometric shapes, gradient colors, artistic composition',
        medium: 'digital art, 16:9',
      },
    };

    const enhancement = styleEnhancements[style] || styleEnhancements.documentary;
    return [
      `Subject: ${prompt}`,
      `Treatment: ${enhancement.treatment}`,
      `Format: ${enhancement.medium}, high quality`,
      // Rendered words in AI imagery are unreliable and, in a localised video,
      // routinely come out in the wrong language.
      'Do not render paragraphs of text, captions, watermarks or logos.',
    ].join('. ');
  }

  async downloadImage(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async generateVideo(script, visualAssets, audioPath, outputPath, options = {}) {
    this.logger.info('Generating video from assets...');
    this.lastVideoResult = null;
    try {
      if (this.mediaGeneration && options.productionId) {
        const generated = await this.mediaGeneration.generateClips({
          jobId: options.jobId || null,
          productionId: options.productionId,
          script,
          visualAssets,
          outputDir: path.dirname(outputPath)
        });
        if (generated.clips.length) {
          const produced = await this.generateHybridVideo(
            generated.clips,
            visualAssets,
            audioPath,
            outputPath,
            options.estimatedDuration || this.calculateScriptDuration(script)
          );
          this.lastVideoResult = {
            requestedProvider: generated.requestedProvider,
            actualProvider: generated.actualProvider,
            model: generated.model,
            mode: generated.settings.mode,
            generatedSeconds: generated.clips.reduce((total, clip) => total + clip.duration, 0),
            tasks: generated.clips.map(clip => ({ scene: clip.index, taskId: clip.taskId, provider: clip.provider, model: clip.model })),
            scenes: generated.clips.map(clip => ({
              index: clip.index, label: clip.label, prompt: clip.prompt, duration: clip.duration,
              path: clip.path, taskId: clip.taskId, provider: clip.provider, model: clip.model
            }))
          };
          return produced;
        }
      }

      const produced = await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath);
      this.lastVideoResult = { requestedProvider: 'slideshow', actualProvider: 'slideshow', model: 'local-ffmpeg', mode: 'slideshow', generatedSeconds: 0, tasks: [], scenes: [] };
      return produced;
    } catch (error) {
      // The Logger's console line only shows the message string, so put the real
      // reason inline. Previously the stack alone went to the file transport and
      // the console printed "Video generation failed:" with no detail.
      const reason = error && error.message ? error.message : String(error);
      this.logger.error(`Video provider generation failed; using the local slideshow: ${reason}`, error);
      try {
        const produced = await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath);
        this.lastVideoResult = {
          requestedProvider: this.lastVideoResult?.requestedProvider || 'configured-provider',
          actualProvider: 'slideshow', model: 'local-ffmpeg', mode: 'fallback', generatedSeconds: 0,
          fallbackReason: reason, tasks: [], scenes: []
        };
        return produced;
      } catch (fallbackError) {
        this.logger.error(`Local slideshow fallback failed: ${fallbackError.message}`, fallbackError);
        const produced = await this.simulateVideoGeneration(script, visualAssets, audioPath, outputPath);
        this.lastVideoResult = {
          requestedProvider: 'configured-provider', actualProvider: 'simulation', model: null,
          mode: 'simulation', generatedSeconds: 0, fallbackReason: `${reason}; ${fallbackError.message}`, tasks: [], scenes: []
        };
        return produced;
      }
    }
  }

  async generateHybridVideo(clips, visualAssets, audioPath, outputPath, totalDuration) {
    if (!(await checkFFmpeg())) throw new Error(ffmpegInstallHint());
    const validImages = await this.filterLocalImageAssets(visualAssets);
    const segments = clips.map(clip => ({ type: 'video', path: clip.path, duration: clip.duration }));
    const generatedDuration = segments.reduce((sum, item) => sum + item.duration, 0);
    const remaining = Math.max(0, this.parseDurationSeconds(totalDuration) - generatedDuration);
    if (remaining && validImages.length) {
      const perImage = Math.max(2, remaining / validImages.length);
      for (const imagePath of validImages) segments.push({ type: 'image', path: imagePath, duration: perImage });
    }
    if (!segments.length) throw new Error('No usable provider clips or still images were generated');

    const visualPath = outputPath.replace(/\.mp4$/i, '_hybrid_visual.mp4');
    await this.renderMediaTimeline(segments, visualPath);
    await this.addAudioToVideo(visualPath, audioPath, outputPath, { loopVideo: true });
    await fs.unlink(visualPath).catch(() => {});
    return outputPath;
  }

  async renderMediaTimeline(segments, outputPath) {
    const args = ['-y'];
    for (const segment of segments) {
      if (segment.type === 'image') args.push('-loop', '1', '-t', Number(segment.duration).toFixed(2), '-framerate', '30', '-i', segment.path);
      else args.push('-stream_loop', '-1', '-i', segment.path);
    }
    const filters = segments.map((segment, index) =>
      `[${index}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p,trim=duration=${Number(segment.duration).toFixed(2)},setpts=PTS-STARTPTS[v${index}]`
    );
    filters.push(`${segments.map((_, index) => `[v${index}]`).join('')}concat=n=${segments.length}:v=1:a=0[vout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath);
    await runFFmpeg(args);
    return outputPath;
  }

  async filterLocalImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const images = [];
    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) continue;
      try {
        await fs.access(asset);
        images.push(asset);
      } catch (_error) { /* ignore missing assets */ }
    }
    return images;
  }

  parseDurationSeconds(value) {
    if (Number.isFinite(Number(value))) return Math.max(0, Number(value));
    const parts = String(value || '').split(':').map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) return Math.max(0, parts[0] * 60 + parts[1]);
    if (parts.length === 3 && parts.every(Number.isFinite)) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
    return 0;
  }

  async generateReplicateVideo(script, visualAssets, audioPath, outputPath) {
    const output = await this.replicate.run(
      "wan-video/wan-2.7-i2v",
      {
        input: {
          image: visualAssets[0],
          prompt: script.title || "smooth cinematic motion",
          duration: 5,
          resolution: "720p"
        }
      }
    );

    // Download the generated video
    if (output && output.length > 0) {
      await this.downloadVideo(output[0], outputPath);
      
      // Add audio track
      await this.addAudioToVideo(outputPath, audioPath, outputPath);
    }

    return outputPath;
  }

  async generateSlideshowVideo(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Creating slideshow video...');

    if (!(await checkFFmpeg())) {
      throw new Error(ffmpegInstallHint());
    }

    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const slidesDir = path.join(path.dirname(outputPath), 'slides');

    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1920, height: 1080 });

      // Create HTML for slideshow (only real image files can be embedded)
      const imageAssets = await this.filterImageAssets(visualAssets);
      await page.setContent(this.createSlideshowHTML(script, imageAssets));

      // Freeze CSS transitions/animations so each still is captured fully rendered
      await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' });
      await page.waitForTimeout(1000); // Wait for assets to load

      // Capture ONE still per slide instead of screenshotting at 30fps —
      // FFmpeg turns the stills into a crossfaded video in seconds.
      const slideCount = await page.evaluate(() => document.querySelectorAll('.slide').length);
      await fs.mkdir(slidesDir, { recursive: true });

      const stills = [];
      for (let i = 0; i < slideCount; i++) {
        await page.evaluate((index) => {
          document.querySelectorAll('.slide').forEach((slide, s) => {
            slide.classList.toggle('active', s === index);
          });
        }, i);

        const stillPath = path.join(slidesDir, `slide_${String(i).padStart(3, '0')}.png`);
        await page.screenshot({ path: stillPath });
        stills.push(stillPath);
      }

      const videoPath = outputPath.replace('.mp4', '_visual.mp4');
      // The narration is the source of truth for length. Estimating from word
      // count produced a 25-second slideshow under a 9-minute voice track, and
      // the mux then cut the narration off mid-sentence.
      const narrationSeconds = await getMediaDuration(audioPath);
      const duration = narrationSeconds && narrationSeconds > 1
        ? Math.ceil(narrationSeconds)
        : this.calculateScriptDuration(script);
      this.logger.info(`Slideshow duration: ${duration}s (${narrationSeconds ? 'measured from narration' : 'estimated from script'})`);
      await this.renderSlidesToVideo(stills, duration, videoPath);

      // Add audio
      await this.addAudioToVideo(videoPath, audioPath, outputPath);

      return outputPath;
    } finally {
      await browser.close().catch(() => {});
      await this.cleanupDirectory(slidesDir);
    }
  }

  async renderSlidesToVideo(stills, totalDuration, videoPath) {
    if (stills.length === 0) {
      throw new Error('No slides to render');
    }

    const fade = 0.5;
    // Each crossfade overlaps two slides, so the rendered timeline is shorter
    // than the sum of the slide durations by fade × (n − 1). Dividing the target
    // duration evenly ignored that and produced a video a few seconds shorter
    // than the narration — the mux then cut the closing call to action off.
    const transitions = Math.max(0, stills.length - 1);
    const perSlide = Math.max(2, (totalDuration + fade * transitions) / stills.length);

    const args = ['-y'];
    for (const still of stills) {
      args.push('-loop', '1', '-t', perSlide.toFixed(2), '-framerate', '30', '-i', still);
    }

    if (stills.length === 1) {
      args.push('-vf', 'format=yuv420p', '-c:v', 'libx264', ...SLIDESHOW_ENCODE, videoPath);
      await runFFmpeg(args);
      return videoPath;
    }

    // Chain crossfades: transition k starts fade seconds before slide k ends
    const filters = [];
    let prev = '[0:v]';
    for (let i = 1; i < stills.length; i++) {
      const out = `[v${i}]`;
      const offset = (i * (perSlide - fade)).toFixed(2);
      filters.push(`${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset}${out}`);
      prev = out;
    }
    filters.push(`${prev}format=yuv420p[vfinal]`);

    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[vfinal]',
      '-c:v', 'libx264',
      ...SLIDESHOW_ENCODE,
      '-r', '30',
      videoPath
    );

    await runFFmpeg(args);
    return videoPath;
  }

  async filterImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const mimeTypes = {
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp'
    };
    const images = [];

    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) {
        continue;
      }

      try {
        const imageBuffer = await fs.readFile(asset);
        const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
        const mimeType = mimeTypes[metadata.format];
        if (mimeType && metadata.width && metadata.height) {
          images.push(`data:${mimeType};base64,${imageBuffer.toString('base64')}`);
        }
      } catch (_error) {
        // Skip missing or invalid image files
      }
    }

    return images;
  }

  createSlideshowHTML(script, visualAssets) {
    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0;
            padding: 0;
            width: 1920px;
            height: 1080px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: 'Arial', sans-serif;
            overflow: hidden;
        }
        
        .slide {
            position: absolute;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 2s ease-in-out;
        }
        
        .slide.active {
            opacity: 1;
        }
        
        .content {
            text-align: center;
            color: white;
            max-width: 80%;
        }
        
        h1 {
            font-size: 72px;
            margin-bottom: 30px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        h2 {
            font-size: 48px;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        p {
            font-size: 36px;
            line-height: 1.4;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
        }
        
        .background-image {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            opacity: 0.3;
            z-index: -1;
        }
        
        .particles {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            z-index: -1;
        }
        
        .particle {
            position: absolute;
            background: rgba(255,255,255,0.8);
            border-radius: 50%;
            animation: float 6s ease-in-out infinite;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-20px); }
        }
    </style>
</head>
<body>
    <div class="particles"></div>
    
    <!-- Title Slide -->
    <div class="slide active">
        ${visualAssets[0] ? `<img class="background-image" src="${visualAssets[0]}" />` : ''}
        <div class="content">
            <h1>${script.title}</h1>
            <p>Ethereal Dreamscript</p>
        </div>
    </div>
    
    ${this.generateContentSlides(script, visualAssets).join('')}
    
    <!-- Subscribe Slide -->
    <div class="slide">
        <div class="content">
            <h2>✨ Subscribe for More Stories ✨</h2>
            <p>New content daily at 2:00 PM</p>
        </div>
    </div>
    
    <script>
        // Create floating particles
        function createParticles() {
            const container = document.querySelector('.particles');
            for (let i = 0; i < 20; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.width = (Math.random() * 4 + 2) + 'px';
                particle.style.height = particle.style.width;
                particle.style.animationDelay = Math.random() * 6 + 's';
                container.appendChild(particle);
            }
        }
        
        let currentSlide = 0;
        const slides = document.querySelectorAll('.slide');
        
        function advanceAnimation() {
            slides[currentSlide].classList.remove('active');
            currentSlide = (currentSlide + 1) % slides.length;
            slides[currentSlide].classList.add('active');
        }
        
        window.advanceAnimation = advanceAnimation;
        createParticles();
    </script>
</body>
</html>`;
  }

  generateContentSlides(script, visualAssets) {
    const slides = [];
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        // Cycle through the available visuals rather than clamping to the last
        // one: clamping left every section past the final asset sharing the same
        // frame, so a video with more sections than screenshots froze on one
        // image for its entire second half.
        const assetIndex = visualAssets.length
          ? (index + 1) % visualAssets.length
          : 0;
        
        slides.push(`
        <div class="slide">
            ${visualAssets[assetIndex] ? `<img class="background-image" src="${visualAssets[assetIndex]}" />` : ''}
            <div class="content">
                <h2>${section.title}</h2>
                ${this.formatSectionContent(section)}
            </div>
        </div>`);
      });
    }
    
    return slides;
  }

  /**
   * Render a section's own words onto its slide.
   *
   * Array-shaped `content` — what the AI writer produces — was not handled, so
   * every AI-written script fell through to a hardcoded English placeholder
   * ("Content coming soon..."), burned into the frames of an otherwise French
   * video. There is now no English fallback at all: with nothing to show, the
   * slide keeps just its title.
   */
  formatSectionContent(section) {
    const escape = text => String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const paragraph = (text, limit = 200) => {
      const clean = String(text).trim();
      if (!clean) return '';
      const truncated = clean.length > limit ? `${clean.slice(0, limit).trimEnd()}…` : clean;
      return `<p>${escape(truncated)}</p>`;
    };

    // One short line only. The narrator is already speaking this text, and the
    // slide's background is a screenshot of the interface being explained —
    // stacking full paragraphs on top of it hid the very thing the viewer needs
    // to see.
    if (Array.isArray(section.content) && section.content.length) {
      return paragraph(section.content[0], 120);
    }

    if (Array.isArray(section.items) && section.items.length) {
      const item = section.items[0];
      return paragraph(`${item.number ? `${item.number}. ` : ''}${item.title || ''}`, 120);
    }

    if (Array.isArray(section.steps) && section.steps.length) {
      return paragraph(section.steps[0].title, 120);
    }

    if (Array.isArray(section.points) && section.points.length) {
      return paragraph(section.points[0], 120);
    }

    if (typeof section.content === 'string') {
      return paragraph(section.content, 120);
    }

    return '';
  }

  /**
   * Estimate spoken duration from the script, used only when no narration file
   * exists to measure.
   *
   * This previously counted `section.content` only when it was a string. The AI
   * path returns it as an array of sentences, so the entire body of every
   * AI-written script counted as zero words and the estimate collapsed to its
   * 30-second floor.
   */
  calculateScriptDuration(script) {
    const words = text => (typeof text === 'string' ? text.split(/\s+/).filter(Boolean).length : 0);
    let totalWords = 0;

    if (script.hook) totalWords += words(script.hook.text);
    if (script.introduction) {
      totalWords += words(script.introduction.greeting);
      totalWords += words(script.introduction.topicIntro);
      totalWords += words(script.introduction.valueProposition);
      totalWords += words(script.introduction.credibility);
    }

    for (const section of script.mainContent?.sections || []) {
      totalWords += words(section.title);
      if (Array.isArray(section.content)) {
        for (const line of section.content) totalWords += words(line);
      } else {
        totalWords += words(section.content);
      }
      for (const item of section.items || []) totalWords += words(item.title) + words(item.description);
      for (const step of section.steps || []) totalWords += words(step.title) + words(step.description) + words(step.tip);
      for (const point of section.points || []) totalWords += words(point);
    }

    if (script.conclusion) {
      for (const line of script.conclusion.recap || []) totalWords += words(line);
      totalWords += words(script.conclusion.finalThought);
    }

    const cta = script.callToAction || {};
    totalWords += words(cta.subscribe) + words(cta.like) + words(cta.comment);

    // 150 words per minute is a typical narration pace.
    return Math.max(30, Math.ceil((totalWords / 150) * 60));
  }

  async addAudioToVideo(videoPath, audioPath, outputPath, options = {}) {
    const hasRealAudio = await this.isUsableAudioFile(audioPath);

    if (!hasRealAudio) {
      if (options.allowSilent === true) {
        this.logger.warn('Creating an intentionally silent video from an operator-confirmed override.');
        if (videoPath !== outputPath) await fs.copyFile(videoPath, outputPath);
        return outputPath;
      }
      const error = new Error('Narration audio is required. Regenerate narration or explicitly confirm an intentional silent video.');
      error.code = 'NARRATION_REQUIRED';
      throw error;
    }

    // FFmpeg cannot write to its own input, so mux to a temp file when paths collide
    const muxPath = outputPath === videoPath
      ? outputPath.replace(/\.mp4$/i, '_muxed.mp4')
      : outputPath;

    const videoInput = options.loopVideo ? ['-stream_loop', '-1', '-i', videoPath] : ['-i', videoPath];
    await runFFmpeg(['-y', ...videoInput, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', muxPath]);

    if (muxPath !== outputPath) {
      await fs.rename(muxPath, outputPath);
    }

    this.logger.info('Audio added to video successfully');
    return outputPath;
  }

  async isUsableAudioFile(audioPath) {
    if (typeof audioPath !== 'string' || audioPath.endsWith('.info')) {
      return false;
    }

    try {
      const stats = await fs.stat(audioPath);
      return stats.isFile() && stats.size > 0;
    } catch (error) {
      return false;
    }
  }

  async downloadVideo(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async cleanupDirectory(dirPath) {
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        await fs.unlink(path.join(dirPath, file));
      }
      await fs.rmdir(dirPath);
    } catch (error) {
      this.logger.warn('Cleanup failed:', error.message);
    }
  }

  async generateThumbnail(script, style = "ethereal") {
    this.logger.info('Generating custom thumbnail...');

    try {
      if (!this.openai && !this.gemini && !this.openRouter) {
        return await this.simulateThumbnailGeneration(script, style);
      }

      const prompt = this.buildThumbnailPrompt(script, style);
      const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_${Date.now()}.png`);

      await this.generateImage(prompt, thumbnailPath);
      const metadata = await sharp(thumbnailPath).metadata();

      return {
        path: thumbnailPath,
        dimensions: { width: metadata.width, height: metadata.height },
        fileSize: await this.getFileSize(thumbnailPath)
      };
    } catch (error) {
      this.logger.error('Thumbnail generation failed:', error);
      return await this.simulateThumbnailGeneration(script, style);
    }
  }

  /**
   * Compose a thumbnail brief in the high-CTR YouTube idiom: a real person
   * reacting or pointing, a few very large words, and supporting iconography.
   *
   * The previous one-liner asked for an "ethereal" thumbnail and got abstract
   * artwork nobody clicks. Two constraints matter beyond composition: any text
   * rendered must be in the video's own language — an English overlay on a
   * French video is the same defect this pipeline exists to remove — and it must
   * be short, because image models mangle long strings.
   */
  buildThumbnailPrompt(script, style = 'youtube') {
    const language = resolveLanguage(script.language || script.metadata?.strategy?.language);
    const french = language === 'fr';
    const headline = this.thumbnailHeadline(script.title);

    if (style && style !== 'youtube' && style !== 'ethereal') {
      return [
        `YouTube thumbnail for "${script.title}"`,
        `${style} style, eye-catching, high contrast, professional, clickable`,
      ].join('. ');
    }

    return [
      'Photorealistic YouTube thumbnail, 16:9, high click-through style.',
      'Composition: a friendly professional person on the right side, waist-up, ' +
        'business-casual, looking at the camera and pointing toward the left where the text sits.',
      'Left two-thirds reserved for very large bold sans-serif text with a thick outline, high contrast on a darker background.',
      `Headline text to render, exactly and only this: "${headline}".`,
      french
        ? 'All rendered text must be in French. Do not add any English words anywhere in the image.'
        : 'All rendered text must be in English.',
      'Supporting elements: subtle interface icons and a smartphone showing a login screen, deep blue and gold accents, soft glow.',
      'No watermark, no logo of any real company, no paragraph of small text, no gibberish lettering.',
    ].join(' ');
  }

  /**
   * Image models render a handful of words reliably and longer strings as
   * garbled shapes, so the headline is trimmed to its most meaningful part.
   */
  thumbnailHeadline(title) {
    const clean = String(title || '').replace(/\s+/g, ' ').trim();
    // Titles read "Subject : qualifier"; only the subject fits on a thumbnail.
    const subject = clean.split(/\s*[:\u2014\u2013]\s*/)[0].trim();

    // Drop grammatical filler so the remaining words are the ones a viewer
    // scans for \u2014 brand and object, not articles.
    const filler = new Set([
      'mon', 'ma', 'mes', 'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd',
      'au', 'aux', 'et', 'ou', 'pour', 'avec', 'sans', 'dans', 'sur', 'en', 'à',
      'my', 'the', 'a', 'an', 'of', 'for', 'with', 'to', 'in', 'on',
    ]);
    const words = subject.split(/\s+/).filter(word => !filler.has(word.toLowerCase().replace(/[^a-z\u00e0-\u00ff]/gi, '')));

    // Image models render a few large words cleanly and longer strings as
    // garbled, clipped shapes \u2014 a 48-character headline came back as
    // "CARIEFOUR ... CONNXION ... PAS \u00c0 PA". Four words, 26 characters, is the
    // most that survives reliably.
    const headline = [];
    for (const word of words) {
      const candidate = [...headline, word].join(' ');
      if (headline.length >= 4 || candidate.length > 26) break;
      headline.push(word);
    }

    return (headline.length ? headline.join(' ') : subject.slice(0, 26)).toUpperCase();
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  // Simulation methods for when APIs are not available
  async simulateTTSGeneration(text, outputPath) {
    this.logger.info('Simulating TTS generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI TTS audio would be generated here',
      text: text.substring(0, 100) + '...',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  /**
   * Last-resort stand-in when no image provider is reachable.
   *
   * Two properties matter here. The file is named `placeholder_*` so the stage
   * arbiter can tell it apart from real imagery and refuse to ship it — the
   * previous version was indistinguishable from a generated asset and sailed
   * through every check. And it renders the section's own wording rather than a
   * truncated English prompt dump, so a placeholder that does reach a preview
   * still reads in the video's language.
   */
  async simulateVisualAssets(prompt, style, count) {
    this.logger.warn(`No image provider available — writing ${count} placeholder visual(s)`);

    const { createCanvas } = require('canvas');
    const _subject = String(prompt || "").replace(/\s+/g, " ").trim();

    const palettes = {
      interface: ['#0f172a', '#1e293b'],
      documentary: ['#1c1917', '#292524'],
      ethereal: ['#1a1a2e', '#0f0f23'],
      modern: ['#f8fafc', '#e2e8f0'],
    };
    const [from, to] = palettes[style] || palettes.documentary;
    const onLight = style === 'modern';

    const paths = [];
    for (let i = 0; i < count; i++) {
      const assetPath = path.join(
        __dirname, '..', 'data', 'assets', `placeholder_${Date.now()}_${i}.png`
      );
      await fs.mkdir(path.dirname(assetPath), { recursive: true });

      const canvas = createCanvas(1920, 1080);
      const ctx = canvas.getContext('2d');

      const gradient = ctx.createLinearGradient(0, 0, 1920, 1080);
      gradient.addColorStop(0, from);
      gradient.addColorStop(1, to);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1920, 1080);

      // Deliberately no text. The slideshow renders the section title and its
      // wording as an HTML overlay on top of this image; drawing the same words
      // into the background made every caption appear twice, on two layers.
      ctx.strokeStyle = onLight ? 'rgba(15,23,42,0.10)' : 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 2;
      for (let x = -1080; x < 1920; x += 120) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + 1080, 1080);
        ctx.stroke();
      }

      paths.push(assetPath);
      const buffer = canvas.toBuffer('image/png');
      await fs.writeFile(assetPath, buffer);
    }
    
    return paths;
  }

  /**
   * Draw centred, word-wrapped text. Long French section titles overflowed a
   * single `fillText` call and were silently clipped mid-word.
   */
  wrapCanvasText(ctx, text, centerX, startY, maxWidth, lineHeight, maxLines) {
    const words = String(text).split(/\s+/).filter(Boolean);
    if (!words.length) return;

    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && current) {
        lines.push(current);
        current = word;
        if (lines.length === maxLines) break;
      } else {
        current = candidate;
      }
    }
    if (lines.length < maxLines && current) lines.push(current);
    if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) {
      lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[\s,;:]+$/, '')}…`;
    }

    // Keep the block vertically centred on the requested anchor.
    const offset = ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, index) => {
      ctx.fillText(line, centerX, startY - offset + index * lineHeight);
    });
  }

  async simulateVideoGeneration(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Simulating video generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI video would be generated here',
      script: script.title,
      visualAssets: visualAssets.length,
      audioPath: audioPath,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateThumbnailGeneration(script, style) {
    this.logger.info('Simulating thumbnail generation...');
    
    const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_sim_${Date.now()}.info`);
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    
    await fs.writeFile(thumbnailPath, JSON.stringify({
      message: 'AI thumbnail would be generated here',
      title: script.title,
      style: style,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return {
      path: thumbnailPath,
      dimensions: { width: 1792, height: 1024 },
      fileSize: 1024,
      simulated: true
    };
  }
}

module.exports = { AIVideoGenerator };
