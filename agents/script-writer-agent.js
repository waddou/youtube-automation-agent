const { Logger } = require('../utils/logger');
const { AITextService } = require('../utils/ai-text-service');
const { resolveLanguage, label, promptLanguageDirective } = require('../utils/i18n');
const { SourceIngestionService } = require('../utils/source-ingestion-service');

// Spoken-word budget per requested video length. The AI stage previously asked
// for a 8-12 minute script but capped the response at 1800 tokens, so the JSON
// was truncated, parsing failed, and the run silently fell back to the generic
// English template — which is why finished videos were an introduction on loop.
const LENGTH_BUDGETS = {
  short: { words: 550, maxTokens: 3000, sections: 3 },
  medium: { words: 1500, maxTokens: 7000, sections: 6 },
  long: { words: 2600, maxTokens: 12000, sections: 9 },
};

class ScriptWriterAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ScriptWriter');
    this.templates = this.loadTemplates();
    this.aiTextService = new AITextService(credentials?.credentials || credentials || {});
  }

  async initialize() {
    this.logger.info('Initializing Script Writer Agent...');
    return true;
  }

  loadTemplates() {
    return {
      tutorial: {
        structure: ['hook', 'introduction', 'problem', 'solution_steps', 'demonstration', 'recap', 'cta'],
        tone: 'educational',
        pacing: 'moderate'
      },
      explainer: {
        structure: ['hook', 'question', 'background', 'explanation', 'examples', 'implications', 'summary', 'cta'],
        tone: 'informative',
        pacing: 'steady'
      },
      list: {
        structure: ['hook', 'introduction', 'list_items', 'bonus_item', 'summary', 'cta'],
        tone: 'engaging',
        pacing: 'quick'
      },
      review: {
        structure: ['hook', 'introduction', 'overview', 'pros', 'cons', 'comparison', 'verdict', 'cta'],
        tone: 'analytical',
        pacing: 'detailed'
      },
      story: {
        structure: ['hook', 'setup', 'conflict', 'journey', 'climax', 'resolution', 'lesson', 'cta'],
        tone: 'narrative',
        pacing: 'dynamic'
      }
    };
  }

  async generateScript(strategy, options = {}) {
    try {
      this.logger.info(`Generating script for: ${strategy.topic}`);

      // Pin the language for this run so every template helper resolves the same
      // way. Reading the environment inside each helper used to let one part of
      // a script be French and another English within a single video.
      this.language = resolveLanguage(strategy.language);

      const template = this.templates[String(strategy?.contentType || '').toLowerCase()] || this.templates.explainer;
      const aiScript = await this.generateScriptWithAI(strategy, template, options);
      if (aiScript) {
        aiScript.fullScript = this.formatFullScript(aiScript);
        await this.db.saveScript(aiScript);
        this.logger.info(`Script generated with AI provider: ${aiScript.title}`);
        return aiScript;
      }
      
      this.logger.info('Using template script generation');
      // Generate script components
      const hook = await this.generateHook(strategy);
      const introduction = await this.generateIntroduction(strategy);
      const mainContent = await this.generateMainContent(strategy, template);
      const conclusion = await this.generateConclusion(strategy);
      const cta = await this.generateCTA(strategy);

      // Assemble complete script
      const script = {
        title: await this.generateTitle(strategy),
        hook,
        introduction,
        mainContent,
        conclusion,
        callToAction: cta,
        duration: this.estimateDuration(mainContent),
        tone: template.tone,
        pacing: template.pacing,
        keywords: strategy.keywords,
        claims: [],
        metadata: {
          strategy: strategy,
          generatedAt: new Date().toISOString(),
          version: '1.0'
        }
      };

      // Format for readability
      script.fullScript = this.formatFullScript(script);
      
      // Save to database
      await this.db.saveScript(script);
      
      this.logger.info(`Script generated: ${script.title}`);
      return script;
    } catch (error) {
      this.logger.error('Failed to generate script:', error);
      throw error;
    }
  }

  async generateScriptWithAI(strategy, template, options = {}) {
    if (!this.aiTextService.isAvailable()) {
      this.logger.info('Using template script generation because no AI text provider is configured');
      return null;
    }

    const language = resolveLanguage(strategy.language);
    const budget = LENGTH_BUDGETS[strategy.requestedLengthKey] || LENGTH_BUDGETS.medium;
    const sourceDocument = strategy.sourceDocument || options.sourceDocument || null;

    const prompt = [
      'You are writing a YouTube script plan.',
      'Return only valid JSON with this exact shape:',
      `{
  "title": "compelling title under 100 characters",
  "hook": "opening hook in one sentence",
  "introduction": {
    "topicIntro": "one sentence naming what this video is about",
    "valueProposition": "one sentence on what the viewer will be able to do afterwards"
  },
  "sections": [
    { "title": "section title", "content": ["spoken script sentence"], "duration": 60 }
  ],
  "cta": "clear call to action",
  "claims": [
    { "text": "specific factual claim a reviewer must verify", "riskLevel": "standard|high", "sourceUrls": ["exact supplied source URL"] }
  ]
}`,
      '',
      promptLanguageDirective(language),
      '',
      `Topic: ${strategy.topic}`,
      `Style/content type: ${strategy.contentType}`,
      `Angle: ${strategy.angle}`,
      `Target audience: ${strategy.targetAudience}`,
      `Desired length: ${strategy.requestedLength || process.env.DEFAULT_VIDEO_LENGTH || '8-12 minutes'}`,
      `Tone: ${template.tone}`,
      `Pacing: ${template.pacing}`,
      `Brand voice: ${strategy.brandVoice || 'clear, credible, and engaging'}`,
      `Channel goal: ${strategy.channelGoal || 'help the viewer understand and act'}`,
      `Channel value proposition: ${strategy.channelValueProposition || 'give the viewer practical value'}`,
      `Editorial rationale: ${strategy.planRationale || 'fit the selected topic and audience'}`,
      `Channel constraints: ${strategy.channelConstraints || 'none beyond the factual-safety rules below'}`,
      `Preferred call to action: ${strategy.callToAction || 'invite the viewer to subscribe'}`,
      `Keywords: ${(strategy.keywords || []).join(', ')}`,
      `Research sources: ${JSON.stringify(strategy.researchSources || [])}`,
      '',
      this.buildLengthDirective(budget),
      this.buildSourceDirective(sourceDocument),
      'Avoid fabricated statistics, unsupported claims, and fake urgency. List every externally verifiable factual claim in claims.',
      'Use only exact URLs from Research sources; use an empty sourceUrls array when the supplied sources do not support a claim.',
      'Never restate the introduction inside a later section: each section must add information the viewer did not already hear.',
      'The introduction announces what is coming; the first section must then start delivering it, not repeat the announcement.',
      options.arbiterFeedback ? `\n${options.arbiterFeedback}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const response = await this.aiTextService.generateText(prompt, {
        maxTokens: budget.maxTokens,
        temperature: 0.7
      });
      const parsed = this.parseAIJsonResponse(response);
      const sections = this.normalizeAISections(parsed.sections, strategy);

      if (!parsed.title || !parsed.hook || sections.length === 0) {
        throw new Error('AI script response missing required fields');
      }

      this.logger.info(`Using AI script generation via ${this.aiTextService.providerName}`);
      return {
        title: String(parsed.title).slice(0, 100),
        hook: this.normalizeAIHook(parsed.hook),
        language,
        introduction: await this.buildIntroduction(strategy, parsed.introduction),
        mainContent: {
          sections,
          totalDuration: this.calculateSectionsDuration(sections)
        },
        conclusion: await this.generateConclusion(strategy),
        callToAction: this.normalizeAICTA(parsed.cta, strategy),
        duration: this.estimateDuration({ sections }),
        tone: template.tone,
        pacing: template.pacing,
        keywords: strategy.keywords || [],
        claims: this.normalizeAIClaims(parsed.claims, strategy.researchSources || []),
        metadata: {
          strategy,
          generatedAt: new Date().toISOString(),
          version: '1.0',
          generationSource: 'ai'
        }
      };
    } catch (error) {
      this.logger.warn(`AI script generation failed; using template fallback: ${error.message}`);
      return null;
    }
  }

  /**
   * State the word budget explicitly. Models under-deliver badly when asked for
   * a duration ("8-12 minutes") instead of a quantity, and an under-length
   * script is what leaves a video padded with repeated filler.
   */
  buildLengthDirective(budget) {
    return (
      `Write approximately ${budget.words} words of spoken narration in total, ` +
      `spread across at least ${budget.sections} substantive sections. ` +
      'The "content" array of each section must contain full spoken sentences, not bullet keywords.'
    );
  }

  /**
   * When the operator supplied a guide, the script is an adaptation of that
   * guide — not a loosely related essay. The outline is handed over as an
   * ordered contract so the video walks the reader through the same chapters.
   */
  buildSourceDirective(sourceDocument) {
    const context = SourceIngestionService.toPromptContext(sourceDocument);
    if (!context || !context.outline?.length) return '';

    const outline = context.outline
      .map(entry => `${entry.order}. ${entry.heading}\n   ${entry.summary.replace(/\s+/g, ' ').trim()}`)
      .join('\n');

    return [
      '',
      'SOURCE GUIDE — this script is an adaptation of the following document.',
      `Source title: ${context.title}`,
      `Source URL: ${context.url}`,
      'Its table of contents is the required structure of the video:',
      outline,
      '',
      'Rules for using the source guide:',
      '- Create one script section per numbered chapter above, in the same order.',
      '- Base each section on that chapter\'s actual content; do not invent facts absent from it.',
      '- Open by announcing what the video will cover (the table of contents), then deliver it.',
      '- Do not pad with generic advice: everything must trace back to the source guide.',
      '',
    ].join('\n');
  }

  parseAIJsonResponse(response) {
    const text = String(response || '').trim();
    const withoutFences = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    try {
      return JSON.parse(withoutFences);
    } catch (error) {
      const match = withoutFences.match(/\{[\s\S]*\}/);
      if (!match) {
        throw error;
      }
      return JSON.parse(match[0]);
    }
  }

  normalizeAIHook(hook) {
    const text = typeof hook === 'object' && hook !== null ? hook.text : hook;
    return {
      type: 'ai',
      text: String(text).trim(),
      duration: '0:00-0:05'
    };
  }

  normalizeAISections(sections, strategy) {
    if (!Array.isArray(sections)) {
      return [];
    }

    return sections
      .slice(0, 8)
      .map((section, index) => {
        const rawContent = Array.isArray(section.content)
          ? section.content
          : [section.content || section.summary || section.description];
        const content = rawContent
          .filter(Boolean)
          .map(line => String(line).trim())
          .filter(Boolean);

        const language = resolveLanguage(strategy.language);
        const rawTitle = String(section.title || `${strategy.topic} — ${label(language, 'section')} ${index + 1}`).trim();
        return {
          type: 'ai_generated',
          title: this.cleanSectionTitle(rawTitle),
          content,
          duration: parseInt(section.duration, 10) || 60
        };
      })
      .filter(section => section.title && section.content.length > 0);
  }

  /**
   * Strip list numbering the model copies from the source outline.
   *
   * Section titles are spoken aloud, and "1. Trouver le bon espace" is read as
   * "un, trouver le bon espace" — an artefact of the written outline leaking
   * into speech.
   */
  cleanSectionTitle(title) {
    return String(title)
      .replace(/^\s*(?:\d{1,2}|[ivxlIVXL]{1,4})\s*[).:\-–—]\s*/, '')
      .replace(/^\s*[-•–—]\s*/, '')
      .trim();
  }

  normalizeAIClaims(claims, sources) {
    if (!Array.isArray(claims)) return [];
    const allowedUrls = new Set((sources || []).map(source => source.url));
    return claims.slice(0, 25).map(item => ({
      text: String(item?.text || item?.claim || '').trim().slice(0, 1000),
      riskLevel: item?.riskLevel === 'high' ? 'high' : 'standard',
      sourceUrls: [...new Set((Array.isArray(item?.sourceUrls) ? item.sourceUrls : [])
        .map(url => String(url))
        .filter(url => allowedUrls.has(url)))]
    })).filter(item => item.text);
  }

  normalizeAICTA(cta, strategy) {
    const fallback = this.ctaFallback(strategy);
    if (cta && typeof cta === 'object') {
      return {
        type: 'call_to_action',
        subscribe: String(cta.subscribe || cta.text || fallback.subscribe),
        like: String(cta.like || fallback.like),
        comment: String(cta.comment || fallback.comment),
        nextVideo: String(cta.nextVideo || fallback.nextVideo),
        duration: '15 seconds'
      };
    }

    return {
      type: 'call_to_action',
      subscribe: String(cta || fallback.subscribe),
      like: fallback.like,
      comment: fallback.comment,
      nextVideo: fallback.nextVideo,
      duration: '15 seconds'
    };
  }

  ctaFallback(strategy) {
    if (resolveLanguage(strategy.language) === 'fr') {
      return {
        subscribe: `Abonnez-vous pour d'autres vidéos pratiques sur ${strategy.topic}.`,
        like: 'Mettez un pouce bleu si cette vidéo vous a aidé.',
        comment: `Partagez votre expérience avec ${strategy.topic} en commentaire.`,
        nextVideo: 'Regardez la vidéo suivante pour aller plus loin.',
      };
    }
    return {
      subscribe: `Subscribe for more practical videos about ${strategy.topic}.`,
      like: 'Like this video if it helped.',
      comment: `Share your experience with ${strategy.topic} in the comments.`,
      nextVideo: 'Watch the next related video for more context.',
    };
  }

  async generateTitle(strategy) {
    const year = new Date().getFullYear();

    if (resolveLanguage(strategy.language) === 'fr') {
      // When a source guide drives the run, its own title is the most accurate
      // description of what the video actually delivers.
      if (strategy.sourceDocument?.title) {
        return String(strategy.sourceDocument.title).slice(0, 100);
      }
      const byType = {
        Tutorial: `${strategy.topic} : le guide étape par étape`,
        List: `${strategy.topic} : les points essentiels à connaître`,
        Review: `${strategy.topic} : est-ce vraiment utile ?`,
      };
      if (byType[strategy.contentType]) return byType[strategy.contentType];

      const templates = [
        `${strategy.angle}`,
        `${strategy.topic} : le guide complet`,
        `Tout ce qu'il faut savoir sur ${strategy.topic}`,
        `${strategy.topic} en ${year} : ce qui change`,
        `${strategy.topic} : du débutant à l'expert`,
      ].filter(Boolean);
      return templates[Math.floor(Math.random() * templates.length)];
    }

    if (strategy.contentType === 'Tutorial') {
      return `How to ${strategy.topic}: Step-by-Step Guide`;
    } else if (strategy.contentType === 'List') {
      return `Top 10 ${strategy.topic} Tips You Need to Know`;
    } else if (strategy.contentType === 'Review') {
      return `${strategy.topic} Review: Is It Worth It?`;
    }

    const templates = [
      `${strategy.angle}`,
      `${strategy.topic}: The Complete Guide`,
      `Everything You Need to Know About ${strategy.topic}`,
      `${strategy.topic} in ${year}: What's Changed?`,
      `${strategy.topic}: Beginner to Expert Guide`
    ].filter(Boolean);
    return templates[Math.floor(Math.random() * templates.length)];
  }

  async generateHook(strategy) {
    const language = resolveLanguage(this.language);
    const isFrench = language === 'fr';
    
    const hooks = isFrench ? [
      {
        type: 'question',
        text: `Vous êtes-vous déjà demandé ${this.generateQuestionAboutFR(strategy.topic)} ?`
      },
      {
        type: 'statistic',
        text: `Savez-vous que ${this.generateStatisticFR(strategy.topic)} ?`
      },
      {
        type: 'statement',
        text: `${strategy.topic} va tout changer, et voici pourquoi...`
      },
      {
        type: 'challenge',
        text: `La plupart des gens croient comprendre ${strategy.topic}, mais ils ont tout faux.`
      },
      {
        type: 'promise',
        text: `Dans les prochaines minutes, vous allez apprendre exactement comment maîtriser ${strategy.topic}.`
      }
    ] : [
      {
        type: 'question',
        text: `Have you ever wondered ${this.generateQuestionAbout(strategy.topic)}?`
      },
      {
        type: 'statistic',
        text: `Did you know that ${this.generateStatistic(strategy.topic)}?`
      },
      {
        type: 'statement',
        text: `${strategy.topic} is about to change everything, and here's why...`
      },
      {
        type: 'challenge',
        text: `Most people think they understand ${strategy.topic}, but they're completely wrong.`
      },
      {
        type: 'promise',
        text: `In the next few minutes, you'll learn exactly how to master ${strategy.topic}.`
      }
    ];

    const selected = hooks[Math.floor(Math.random() * hooks.length)];
    
    return {
      type: selected.type,
      text: selected.text,
      duration: '0:00-0:05'
    };
  }

  generateQuestionAbout(topic) {
    const questions = [
      `why ${topic} is becoming so important`,
      `how ${topic} actually works`,
      `what makes ${topic} different from everything else`,
      `why experts are talking about ${topic}`,
      `how ${topic} could change your life`
    ];
    
    return questions[Math.floor(Math.random() * questions.length)];
  }

  generateQuestionAboutFR(topic) {
    const questions = [
      `pourquoi ${topic} devient si important`,
      `comment ${topic} fonctionne vraiment`,
      `ce qui rend ${topic} différent de tout le reste`,
      `pourquoi les experts parlent de ${topic}`,
      `comment ${topic} pourrait changer votre vie`
    ];
    
    return questions[Math.floor(Math.random() * questions.length)];
  }

  generateStatistic(topic) {
    const stats = [
      `many people are still figuring out how ${topic} works`,
      `the conversation around ${topic} keeps expanding`,
      `experts continue to debate where ${topic} is headed`,
      `people often miss the practical side of ${topic}`,
      `${topic} can be easier to approach with a clear framework`
    ];
    
    return stats[Math.floor(Math.random() * stats.length)];
  }

  generateStatisticFR(topic) {
    const stats = [
      `beaucoup de gens cherchent encore à comprendre comment fonctionne ${topic}`,
      `la conversation autour de ${topic} ne cesse de s'élargir`,
      `les experts continuent de débattre sur l'avenir de ${topic}`,
      `on passe souvent à côté de l'aspect pratique de ${topic}`,
      `${topic} peut être plus simple à aborder avec un bon cadre`
    ];
    
    return stats[Math.floor(Math.random() * stats.length)];
  }

  /**
   * Prefer the model's own introduction over the generic template.
   *
   * The template phrasing ("Aujourd'hui, nous allons voir en détail <topic>")
   * restates the title and then the first section restates it again — the
   * looping-introduction effect viewers noticed. An introduction written
   * alongside the sections knows what follows it and can hand over instead of
   * duplicating.
   */
  async buildIntroduction(strategy, aiIntroduction) {
    const template = await this.generateIntroduction(strategy);
    if (!aiIntroduction || typeof aiIntroduction !== 'object') return template;

    const topicIntro = String(aiIntroduction.topicIntro || '').trim();
    const valueProposition = String(aiIntroduction.valueProposition || '').trim();

    return {
      ...template,
      topicIntro: topicIntro || template.topicIntro,
      valueProposition: valueProposition || template.valueProposition,
    };
  }

  async generateIntroduction(strategy) {
    const language = resolveLanguage(this.language);
    const isFrench = language === 'fr';

    return {
      greeting: isFrench ? 'Bonjour à tous, bienvenue sur la chaîne !' : 'Hey everyone, welcome back to the channel!',
      topicIntro: isFrench ? `Aujourd'hui, nous allons voir en détail ${strategy.topic}.` : `Today, we're diving deep into ${strategy.topic}.`,
      valueProposition: isFrench ? `À la fin de cette vidéo, vous comprendrez exactement ${this.getValuePropositionFR(strategy)}.` : `By the end of this video, you'll understand exactly ${this.getValueProposition(strategy)}.`,
      credibility: this.getCredibilityStatement(strategy, language),
      duration: '0:05-0:20'
    };
  }

  /**
   * State where the information comes from — or say nothing.
   *
   * The previous helpers picked at random from claims the channel had not
   * earned ("I've spent months researching this topic", "Après avoir accompagné
   * des centaines de personnes"). Those are fabricated credentials asserted to
   * the viewer, which the pipeline's own factual-safety rules forbid. A
   * verifiable citation is the only honest form of credibility available here.
   */
  getCredibilityStatement(strategy, language) {
    const source = strategy?.sourceDocument;
    if (!source?.title) return '';

    let publisher = null;
    try {
      publisher = new URL(source.url).hostname.replace(/^www\./, '');
    } catch (_error) {
      publisher = null;
    }

    if (resolveLanguage(language) === 'fr') {
      return publisher
        ? `Ce guide reprend les informations publiées sur ${publisher}.`
        : `Ce guide reprend les informations du document « ${source.title} ».`;
    }
    return publisher
      ? `This guide follows the information published on ${publisher}.`
      : `This guide follows the document "${source.title}".`;
  }

  getValueProposition(strategy) {
    const propositions = {
      'Tutorial': `how to implement ${strategy.topic} step by step`,
      'Explainer': `what ${strategy.topic} is and why it matters`,
      'List': `the most important things about ${strategy.topic}`,
      'Review': `whether ${strategy.topic} is right for you`,
      'Story': `the incredible journey of ${strategy.topic}`
    };
    
    return propositions[strategy.contentType] || `everything about ${strategy.topic}`;
  }

  getValuePropositionFR(strategy) {
    const propositions = {
      'Tutorial': `comment mettre en œuvre ${strategy.topic} étape par étape`,
      'Explainer': `ce qu'est ${strategy.topic} et pourquoi cela compte`,
      'List': `les choses les plus importantes à savoir sur ${strategy.topic}`,
      'Review': `si ${strategy.topic} est fait pour vous`,
      'Story': `l'incroyable histoire de ${strategy.topic}`
    };
    
    return propositions[strategy.contentType] || `tout sur ${strategy.topic}`;
  }



  async generateMainContent(strategy, template) {
    const sections = [];
    
    for (const section of template.structure) {
      if (!['hook', 'introduction', 'cta'].includes(section)) {
        sections.push(await this.generateSection(section, strategy));
      }
    }
    
    return {
      sections,
      totalDuration: this.calculateSectionsDuration(sections)
    };
  }

  async generateSection(sectionType, strategy) {
    const sectionGenerators = {
      problem: () => this.generateProblemSection(strategy),
      solution_steps: () => this.generateSolutionSteps(strategy),
      demonstration: () => this.generateDemonstration(strategy),
      explanation: () => this.generateExplanation(strategy),
      examples: () => this.generateExamples(strategy),
      list_items: () => this.generateListItems(strategy),
      pros: () => this.generatePros(strategy),
      cons: () => this.generateCons(strategy),
      comparison: () => this.generateComparison(strategy),
      implications: () => this.generateImplications(strategy)
    };

    const generator = sectionGenerators[sectionType];
    
    if (generator) {
      return await generator();
    }
    
    return this.generateGenericSection(sectionType, strategy);
  }

  async generateProblemSection(strategy) {
    return {
      type: 'problem',
      title: 'The Challenge',
      content: [
        `Many people struggle with ${strategy.topic}.`,
        `The main issues are:`,
        `1. Lack of clear information`,
        `2. Complexity and confusion`,
        `3. Not knowing where to start`,
        `But don't worry, we're going to solve all of these today.`
      ],
      visuals: ['Problem illustration', 'Statistics graphic'],
      duration: 30
    };
  }

  async generateSolutionSteps(strategy) {
    const steps = [];
    const numSteps = 3 + Math.floor(Math.random() * 3); // 3-5 steps
    
    for (let i = 1; i <= numSteps; i++) {
      steps.push({
        number: i,
        title: `Step ${i}: ${this.generateStepTitle(strategy.topic, i)}`,
        description: this.generateStepDescription(strategy.topic, i),
        tip: this.generateProTip(strategy.topic)
      });
    }
    
    return {
      type: 'solution_steps',
      title: 'The Solution',
      steps,
      duration: steps.length * 45
    };
  }

  generateStepTitle(topic, stepNumber) {
    const titles = [
      'Research and Preparation',
      'Setting Up the Foundation',
      'Implementation and Execution',
      'Testing and Optimization',
      'Scaling and Automation'
    ];
    
    return titles[stepNumber - 1] || `Advanced ${topic} Techniques`;
  }

  generateStepDescription(topic, _stepNumber) {
    return `This step involves understanding the key aspects of ${topic} and how to apply them effectively. Pay special attention to the details here, as they make all the difference.`;
  }

  generateProTip(_topic) {
    const tips = [
      `Pro tip: Start small and scale gradually`,
      `Remember: Consistency is more important than perfection`,
      `Quick tip: Document everything as you go`,
      `Expert advice: Focus on one aspect at a time`,
      `Insider secret: This works best when combined with regular practice`
    ];
    
    return tips[Math.floor(Math.random() * tips.length)];
  }

  async generateDemonstration(_strategy) {
    return {
      type: 'demonstration',
      title: 'Live Demo',
      content: [
        `Now let me show you exactly how this works.`,
        `[Screen recording or visual demonstration]`,
        `As you can see, the process is straightforward once you understand the basics.`,
        `The key is to follow the steps exactly as shown.`
      ],
      visuals: ['Screen recording', 'Step-by-step graphics'],
      duration: 120
    };
  }

  async generateExplanation(strategy) {
    return {
      type: 'explanation',
      title: 'Deep Dive',
      content: [
        `Let's break down ${strategy.topic} into its core components.`,
        `First, we need to understand the fundamental principles.`,
        `The science behind this is fascinating...`,
        `[Detailed explanation with visuals]`,
        `This is why ${strategy.topic} works so effectively.`
      ],
      visuals: ['Diagrams', 'Infographics', 'Charts'],
      duration: 90
    };
  }

  async generateExamples(strategy) {
    return {
      type: 'examples',
      title: 'Real-World Examples',
      content: [
        `Let's look at some real examples of ${strategy.topic} in action.`,
        `Example 1: [Specific case study]`,
        `Example 2: [Another relevant example]`,
        `Example 3: [Third compelling example]`,
        `These examples show the versatility and power of ${strategy.topic}.`
      ],
      visuals: ['Case study graphics', 'Before/after comparisons'],
      duration: 75
    };
  }

  async generateListItems(strategy) {
    const items = [];
    const numItems = 5 + Math.floor(Math.random() * 6); // 5-10 items
    
    for (let i = 1; i <= numItems; i++) {
      items.push({
        number: numItems - i + 1, // Countdown for engagement
        title: this.generateListItemTitle(strategy.topic, i),
        description: this.generateListItemDescription(strategy.topic),
        impact: this.generateImpactStatement()
      });
    }
    
    return {
      type: 'list_items',
      title: `Top ${numItems} Things About ${strategy.topic}`,
      items,
      duration: items.length * 30
    };
  }

  generateListItemTitle(topic, index) {
    const titles = [
      `The Hidden Power of ${topic}`,
      `Why ${topic} Matters More Than You Think`,
      `The Surprising Truth About ${topic}`,
      `How ${topic} Can Transform Your Approach`,
      `The ${topic} Secret Nobody Talks About`,
      `Mastering ${topic} in Record Time`,
      `The Ultimate ${topic} Hack`,
      `${topic}: The Game Changer`,
      `Breaking Down ${topic} Myths`,
      `The Future of ${topic}`
    ];
    
    return titles[index - 1] || `Advanced ${topic} Technique #${index}`;
  }

  generateListItemDescription(topic) {
    return `This aspect of ${topic} is crucial because it fundamentally changes how we approach the subject. Understanding this will give you a significant advantage.`;
  }

  generateImpactStatement() {
    const language = resolveLanguage(this.language);
    const isFrench = language === 'fr';
    
    const impacts = isFrench ? [
      'Cela seul peut vous faire gagner des heures',
      'Un vrai game-changer pour les débutants',
      'Indispensable pour réussir sur le long terme',
      'Souvent négligé mais crucial',
      'La différence entre succès et échec'
    ] : [
      'This alone can save you hours',
      'Game-changing for beginners',
      'Essential for long-term success',
      'Often overlooked but critical',
      'The difference between success and failure'
    ];
    
    return impacts[Math.floor(Math.random() * impacts.length)];
  }

  async generatePros(_strategy) {
    const language = resolveLanguage(this.language);
    const isFrench = language === 'fr';
    
    return {
      type: 'pros',
      title: isFrench ? 'Les avantages' : 'The Benefits',
      points: isFrench ? [
        'Facile à démarrer',
        'Solution économique',
        'Résultats prouvés',
        'Approche évolutive',
        'Support de la communauté'
      ] : [
        'Easy to get started',
        'Cost-effective solution',
        'Proven results',
        'Scalable approach',
        'Community support'
      ],
      duration: 45
    };
  }

  async generateCons(_strategy) {
    const language = resolveLanguage(this.language);
    const isFrench = language === 'fr';
    
    return {
      type: 'cons',
      title: isFrench ? 'Points d\'attention' : 'Things to Consider',
      points: isFrench ? [
        'Courbe d\'apprentissage au début',
        'Demande des efforts constants',
        'Les résultats peuvent varier',
        'Quelques connaissances techniques utiles'
      ] : [
        'Learning curve at the beginning',
        'Requires consistent effort',
        'Results may vary',
        'Some technical knowledge helpful'
      ],
      duration: 30
    };
  }

  async generateComparison(strategy) {
    const language = resolveLanguage(this.language);
    const isFrench = language === 'fr';
    
    return {
      type: 'comparison',
      title: isFrench ? 'Comment ça se compare' : 'How It Compares',
      content: isFrench ? `Par rapport aux alternatives, ${strategy.topic} se démarque par son approche unique et son efficacité prouvée.` : `Compared to alternatives, ${strategy.topic} stands out because of its unique approach and proven effectiveness.`,
      comparisonPoints: isFrench ? [
        'Plus efficace que les méthodes traditionnelles',
        'Meilleur ROI que les concurrents',
        'Plus facile à mettre en œuvre',
        'Plus durable sur le long terme'
      ] : [
        'More efficient than traditional methods',
        'Better ROI than competitors',
        'Easier to implement',
        'More sustainable long-term'
      ],
      duration: 60
    };
  }

  async generateImplications(strategy) {
    const language = resolveLanguage(this.language);
    const isFrench = language === 'fr';
    
    return {
      type: 'implications',
      title: isFrench ? 'Ce que cela signifie' : 'What This Means',
      content: isFrench ? [
        `Les implications de ${strategy.topic} sont considérables.`,
        'Cela va changer notre façon de voir l\'industrie.',
        'Les premiers adopteurs auront un avantage significatif.',
        'Le potentiel de croissance est énorme.'
      ] : [
        `The implications of ${strategy.topic} are far-reaching.`,
        'This will change how we think about the industry.',
        'Early adopters will have a significant advantage.',
        'The potential for growth is enormous.'
      ],
      duration: 45
    };
  }

  generateGenericSection(sectionType, strategy) {
    const language = resolveLanguage(this.language);
    const isFrench = language === 'fr';
    
    return {
      type: sectionType,
      title: sectionType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      content: isFrench ? `Cette section couvre les aspects importants de ${strategy.topic} que vous devez connaître.` : `This section covers important aspects of ${strategy.topic} that you need to know.`,
      duration: 60
    };
  }

  async generateConclusion(strategy) {
    const language = resolveLanguage(this.language);
    const isFrench = language === 'fr';
    
    return {
      type: 'conclusion',
      title: isFrench ? 'En résumé' : 'Wrapping Up',
      recap: isFrench ? [
        `Voilà tout ce qu'il faut savoir sur ${strategy.topic}.`,
        'Nous avons couvert les points clés :',
        '- Les fondamentaux et pourquoi ils comptent',
        '- Les étapes pratiques pour commencer',
        '- Des applications concrètes et des exemples',
        '- Des conseils pour réussir sur le long terme'
      ] : [
        `So that's everything you need to know about ${strategy.topic}.`,
        'We covered the key points:',
        '- The fundamentals and why they matter',
        '- Practical steps to get started',
        '- Real-world applications and examples',
        '- Tips for long-term success'
      ],
      finalThought: isFrench ? `Rappelez-vous, ${strategy.topic} est un chemin, pas une destination. Continuez à apprendre et à progresser !` : `Remember, ${strategy.topic} is a journey, not a destination. Keep learning and improving!`,
      duration: '30 seconds'
    };
  }

  async generateCTA(strategy) {
    const language = resolveLanguage(this.language);
    const isFrench = language === 'fr';
    
    return {
      type: 'call_to_action',
      subscribe: isFrench ? "Si cette vidéo vous a aidé, abonnez-vous et activez la cloche !" : "If you found this helpful, make sure to subscribe and hit the notification bell!",
      like: isFrench ? "Mettez un pouce vers le haut si vous avez appris quelque chose." : "Give this video a thumbs up if you learned something new.",
      comment: isFrench ? `Dites-moi en commentaire : quelle est votre expérience avec ${strategy.topic} ?` : `Let me know in the comments: What's your experience with ${strategy.topic}?`,
      nextVideo: isFrench ? "Regardez la vidéo suivante pour aller plus loin." : "Check out this related video for more insights.",
      duration: '15 seconds'
    };
  }

  formatFullScript(script) {
    // Reference document for humans: it carries timing markers and stage
    // directions. It is deliberately NOT what gets narrated — see
    // ProductionManagementAgent.formatScriptForTTS for the spoken text.
    const lang = resolveLanguage(script.language || this.language);
    const t = key => label(lang, key);
    let fullScript = '';

    fullScript += `${t('title')}: ${script.title}\n\n`;
    fullScript += '\u2550'.repeat(50) + '\n\n';

    fullScript += `[${script.hook.duration}] ${t('hook')}\n`;
    fullScript += `${script.hook.text}\n\n`;

    fullScript += `[${script.introduction.duration}] ${t('introduction')}\n`;
    fullScript += `${script.introduction.greeting}\n`;
    fullScript += `${script.introduction.topicIntro}\n`;
    fullScript += `${script.introduction.valueProposition}\n`;
    fullScript += `${script.introduction.credibility}\n\n`;

    fullScript += `${t('mainContent')}\n`;
    fullScript += '\u2500'.repeat(30) + '\n\n';

    for (const section of script.mainContent.sections) {
      fullScript += `[${this.formatDuration(section.duration)}] ${section.title.toUpperCase()}\n`;

      if (Array.isArray(section.content)) {
        section.content.forEach(line => {
          fullScript += `${line}\n`;
        });
      } else if (section.steps) {
        section.steps.forEach(step => {
          fullScript += `\n${step.title}\n`;
          fullScript += `${step.description}\n`;
          fullScript += `${t('tip')} : ${step.tip}\n`;
        });
      } else if (section.items) {
        section.items.forEach(item => {
          fullScript += `\n#${item.number} : ${item.title}\n`;
          fullScript += `${item.description}\n`;
          fullScript += `${t('impact')} : ${item.impact}\n`;
        });
      } else if (section.points) {
        section.points.forEach(point => {
          fullScript += `\u2022 ${point}\n`;
        });
      } else {
        fullScript += `${section.content}\n`;
      }

      if (section.visuals) {
        fullScript += `\n[${t('visuals')}: ${section.visuals.join(', ')}]\n`;
      }

      fullScript += '\n';
    }

    fullScript += `[${script.conclusion.duration}] ${t('conclusion')}\n`;
    script.conclusion.recap.forEach(line => {
      fullScript += `${line}\n`;
    });
    fullScript += `\n${script.conclusion.finalThought}\n\n`;

    fullScript += `[${script.callToAction.duration}] ${t('callToAction')}\n`;
    fullScript += `${script.callToAction.subscribe}\n`;
    fullScript += `${script.callToAction.like}\n`;
    fullScript += `${script.callToAction.comment}\n`;
    fullScript += `${script.callToAction.nextVideo}\n\n`;

    fullScript += '\u2550'.repeat(50) + '\n';
    fullScript += `${t('estimatedDuration')}: ${script.duration}\n`;
    fullScript += `${t('tone')}: ${script.tone}\n`;
    fullScript += `${t('pacing')}: ${script.pacing}\n`;
    fullScript += `${t('keywords')}: ${(script.keywords || []).join(', ')}\n`;

    return fullScript;
  }

  estimateDuration(mainContent) {
    const totalSeconds = mainContent.sections.reduce((total, section) => {
      return total + (section.duration || 60);
    }, 0);
    
    // Add hook, intro, conclusion, CTA
    const fullDuration = totalSeconds + 5 + 15 + 30 + 15;
    
    return this.formatDuration(fullDuration);
  }

  formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  calculateSectionsDuration(sections) {
    return sections.reduce((total, section) => total + (section.duration || 60), 0);
  }
}

module.exports = { ScriptWriterAgent };
