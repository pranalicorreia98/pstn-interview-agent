/**
 * Interview Brain Service — the STT → LLM → TTS interview session.
 *
 * SYNCED FROM clikhireBotIntegration/src/services/voiceAgent.service.js @ 2318ae1,
 * plus the `awaitReplyAfterGreeting` branch in triggerGreeting (added to BOTH files
 * together — inert on the Zoom bot, which never sets the flag — so they stay identical).
 * The constants/helpers block and createSession() below are copied verbatim from that
 * file so fixes can be carried across by copying again — don't edit them here; change
 * the Zoom bot and re-sync. Only buildSessionConfig() (interview row -> session config)
 * and the module wiring are PSTN-specific. Transport (LiveKit SIP) is in phoneAgent.
 *
 * Config-flag behaviour that is inert unless a flag is set: the camera check runs only
 * when config.cameraLines is set (Zoom screening), the screening greet-fallback only when
 * autoGreet is off, and greet-then-wait only when config.awaitReplyAfterGreeting is set
 * (PSTN fitment calls with a conversational opening).
 */

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const logger = require('../utils/logger');
const { createGoogleTTSStream } = require('./tts/googleTts.service');
const { getLanguageConfig, getNormalizedLangCode } = require('../config/languageVoices');

// ---- BEGIN verbatim from voiceAgent.service.js (module helpers) ----
// Load interview prompt config from YAML
const PROMPT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'interviewPrompt.yaml');
let promptConfig = {};
try {
  promptConfig = yaml.load(fs.readFileSync(PROMPT_CONFIG_PATH, 'utf8'));
  logger.info('Loaded interview prompt config', { path: PROMPT_CONFIG_PATH, promptLength: promptConfig.system_prompt?.length });
} catch (err) {
  logger.warn('Failed to load interview prompt config, using .env fallback', { error: err.message });
}

// Load fitment prompt config from YAML
const FITMENT_PROMPT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'fitmentPrompt.yaml');
let fitmentPromptConfig = {};
try {
  fitmentPromptConfig = yaml.load(fs.readFileSync(FITMENT_PROMPT_CONFIG_PATH, 'utf8'));
  logger.info('Loaded fitment prompt config', { path: FITMENT_PROMPT_CONFIG_PATH });
} catch (err) {
  logger.warn('Failed to load fitment prompt config', { error: err.message });
}

// Default fitment questions used when bot_config provides none
const DEFAULT_FITMENT_QUESTIONS = [
  '1. When would you be available to start a new role?',
  '2. What is your current notice period?',
  '3. What are your compensation expectations for this role?',
  '4. Are you open to relocating for this opportunity?',
  '5. What is your preferred work model — remote, hybrid, or in-office?'
].join('\n');

/**
 * Default communication skills topics when no technical skills are provided.
 * Used for general assessment of soft skills, personality, and cultural fit.
 */
const DEFAULT_COMMUNICATION_SKILLS_PROMPT = `
When no specific technical skills are provided for assessment, conduct a friendly conversational interview focusing on:

1. **Communication Skills**: Assess how clearly and confidently the candidate expresses themselves
2. **General Background**: Ask about their educational background and career journey
3. **Work Style**: Understand their preferred work environment and collaboration style
4. **Problem Solving**: Ask about challenges they've faced and how they handled them
5. **Personal Interests**: Learn about their hobbies, interests, or what motivates them
6. **Career Goals**: Understand their aspirations and what they're looking for

Keep the conversation warm and friendly. You can discuss topics like:
- Their family background (if they're comfortable)
- Where they grew up or currently live
- What they enjoy doing outside of work
- Their strengths and areas they want to improve
- Why they're interested in this opportunity

The goal is to assess their communication ability, personality, and cultural fit rather than technical expertise.
Ask open-ended questions and show genuine interest in their responses.
`;

/**
 * Determine effective skills - use provided skills or fall back to communication assessment
 */
function getEffectiveSkills(skills) {
  if (skills && skills.trim().length > 0) {
    return {
      skills: skills.trim(),
      isDefaultCommunication: false,
    };
  }

  return {
    skills: 'Communication Skills, Soft Skills, General Assessment',
    isDefaultCommunication: true,
  };
}

const SAMPLE_RATE = 16000;

/**
 * Strip markdown and formatting artifacts so TTS speaks clean text.
 * Removes: **bold**, *italic*, `code`, # headings, - bullets, numbered lists, etc.
 */
function sanitizeForTTS(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')      // ```code blocks``` — remove entirely
    .replace(/`([^`]*)`/g, '$1')         // `inline code` — keep text only
    .replace(/#{1,6}\s*/g, '')           // # headings
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1') // **bold**, *italic* — extract text
    .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')   // __bold__, _italic_
    .replace(/^\s*[-*+]\s+/gm, '')       // - bullet points at line start
    .replace(/^\s*\d+[.)]\s+/gm, '')     // 1. numbered lists
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [links](url) → links
    .replace(/[~]{2}([^~]+)[~]{2}/g, '$1')  // ~~strikethrough~~
    .replace(/>\s*/g, '')                // > blockquotes
    .replace(/\|/g, '')                  // | table separators
    .replace(/---+/g, '')               // --- horizontal rules
    .replace(/[*#`~_]/g, '')             // Remove ALL remaining special chars
    .replace(/\n{2,}/g, '. ')           // multiple newlines → sentence break
    .replace(/\n/g, ' ')               // single newlines → space
    .replace(/\s{2,}/g, ' ')            // collapse multiple spaces
    .trim();
}

// Hard limit on simultaneous voice sessions to prevent cost overrun
const MAX_CONCURRENT_SESSIONS = 3;

// Screening waits for the candidate to speak first. If their first words arrive before
// STT is connected they're lost, and both sides sit silent for the whole call (empty
// transcript, no report). Greet anyway after this long.
const SCREENING_GREET_FALLBACK_MS = 10000;

// Screening camera check (after the greeting). Camera state comes from the Zoom bot
// (participant_status camera_on / camera_off, re-sent every 10s).
const CAMERA_STATUS_WAIT_MS = 4000;          // extra wait for a first camera report
const CAMERA_REMINDER_INTERVAL_MS = 20000;   // repeat the request while it stays off
const CAMERA_MAX_WAIT_MS = 90000;            // then start the questions anyway

// Screening starts wrapping up this long before the end: the next answer gets the
// closing instead of another question.
const WRAP_UP_BEFORE_END_MS = 60000;

/** Fill {placeholders}; tidy what an empty value leaves ("Hello , welcome" -> "Hello, welcome") */
function fillTemplate(text, values) {
  return Object.entries(values)
    .reduce((t, [key, value]) => t.split(`{${key}}`).join(value ?? ''), text)
    .replace(/[ \t]+([,.])/g, '$1')
    .replace(/,\./g, '.');
}

/** "AMAN" -> "Aman"; names already in mixed case are left alone */
function toDisplayName(name) {
  return (name || '').trim().split(/\s+/)
    .map(w => (w.length > 1 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w))
    .join(' ');
}

// Live diarization flips single words of one voice to another speaker label ("is", "and"
// mid-sentence) — 36 such flags in one solo test. A real second voice speaks a phrase, so
// only a run of this many consecutive words from a non-primary speaker counts.
const MIN_SECONDARY_RUN_WORDS = 4;

/**
 * Runs of consecutive words by a speaker other than the session's primary speaker.
 * Primary = most words so far (not assumed to be label 0). Updates speakerWordCounts.
 */
function findSecondarySpeech(words, speakerWordCounts) {
  for (const w of words) {
    if (w.speaker !== undefined) speakerWordCounts.set(w.speaker, (speakerWordCounts.get(w.speaker) || 0) + 1);
  }
  let primary;
  for (const [speaker, count] of speakerWordCounts) {
    if (primary === undefined || count > speakerWordCounts.get(primary)) primary = speaker;
  }

  const runs = [];
  let run = [];
  const endRun = () => {
    if (run.length >= MIN_SECONDARY_RUN_WORDS) runs.push({ speaker: run[0].speaker, words: run });
    run = [];
  };
  for (const w of words) {
    if (w.speaker === undefined || w.speaker === primary) { endRun(); continue; }
    if (run.length && run[0].speaker !== w.speaker) endRun();
    run.push(w);
  }
  endRun();
  return runs;
}

// Deepgram keyterm prompting: boosts recognition of Indian hiring vocabulary that
// nova-3 otherwise mishears ("15 lakhs" came through as "15 likes"). Only sent for
// English sessions — keyterm is documented for English nova-3.
const STT_KEYTERMS = [
  'lakh', 'lakhs', 'crore', 'LPA', 'CTC', 'per annum',
  'notice period', 'serving notice', 'immediate joiner',
  'hybrid', 'in-office', 'work from home', 'relocate'
];

// Cap on audio held while the STT connection opens (~5 s of 16 kHz 16-bit mono).
const MAX_PRE_STT_BUFFER_BYTES = SAMPLE_RATE * 2 * 5;

// ---- END verbatim (module helpers) ----

class InterviewBrainService {
  constructor() {
    this.deepgramApiKey = process.env.DEEPGRAM_API_KEY;
    this.deepseekApiKey = process.env.DEEPSEEK_API_KEY;
    this.defaultPrompt = promptConfig.system_prompt || process.env.BOT_SYSTEM_PROMPT || 'You are a helpful interview assistant.';
    this.defaultGreeting = promptConfig.greeting || process.env.BOT_GREETING || 'Hello! I am your interview assistant.';
    this.defaultVoiceModel = promptConfig.voice_model || process.env.BOT_VOICE_MODEL || 'aura-2-thalia-en';
    this.defaultClosing = promptConfig.closing || 'Thank you for your time. Have a great day.';
    this.interviewDurationMs = (parseInt(process.env.INTERVIEW_DURATION_MINUTES) || 30) * 60 * 1000;
  }

  // ---- BEGIN verbatim from voiceAgent.service.js (createSession) ----
  /**
   * Create a voice pipeline (STT + LLM + TTS) for a connection.
   * Returns a session object with stt, tts, and methods to interact.
   */
  createSession(config, onAudio) {
    if (!this.deepgramApiKey) {
      throw new Error('DEEPGRAM_API_KEY is required');
    }
    if (!this.deepseekApiKey) {
      throw new Error('DEEPSEEK_API_KEY is required');
    }

    const deepgram = createClient(this.deepgramApiKey);
    const deepseek = new OpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey: this.deepseekApiKey
    });

    // Normalize language code from DB (ISO 639-1 like "hi", "mr") to BCP-47 ("hi-IN", "mr-IN")
    // Default to English (en-IN) if not specified
    const normalizedLanguage = getNormalizedLangCode(config.language);

    // Check if skills are provided, otherwise fall back to communication skills assessment
    const { skills: effectiveSkills, isDefaultCommunication } = getEffectiveSkills(config.skills);

    // Build the system prompt, appending communication skills guidance if needed
    let systemPrompt = config.prompt || this.defaultPrompt;
    if (isDefaultCommunication) {
      logger.info('No technical skills provided, using communication skills assessment', { clientId: config.clientId });
      systemPrompt = `${systemPrompt}\n\n${DEFAULT_COMMUNICATION_SKILLS_PROMPT}`;
    }

    const sessionConfig = {
      prompt: systemPrompt,
      greeting: config.greeting || this.defaultGreeting,
      closing: config.closing || this.defaultClosing,
      voiceModel: config.voiceModel || this.defaultVoiceModel,
      skills: effectiveSkills,
      language: normalizedLanguage, // Language for TTS/STT - normalized to BCP-47 (e.g., "hi-IN")
      isDefaultCommunication, // Track if we're using default communication mode
    };

    // Get language configuration for TTS/STT
    const languageConfig = getLanguageConfig(sessionConfig.language);

    // This branch always uses Google TTS (testing Google TTS with English before regional languages)
    const useGoogleTTS = true;
    logger.info('TTS provider selection', {
      language: sessionConfig.language,
      voice: languageConfig.ttsVoice,
      provider: 'Google Cloud TTS'
    });

    // Override greeting and closing with language-specific versions if available
    // Replace placeholders: {candidate_name}, {org_name}, {jd_title}, {duration_minutes}
    // Use language-specific fallbacks to avoid mixing languages (e.g., "namaste there")
    if (languageConfig.greetingTemplate) {
      // Get the candidate name, using language-specific fallback or empty string
      const candidateNameValue = config.candidateName || languageConfig.fallbackCandidateName || '';

      // Build greeting - if candidateName is empty, clean up extra space/comma after greeting word
      let greetingText = languageConfig.greetingTemplate
        .replace('{candidate_name}', candidateNameValue)
        .replace('{org_name}', config.orgName || languageConfig.fallbackOrgName || 'our organization')
        .replace('{jd_title}', config.jdTitle || languageConfig.fallbackJdTitle || 'the position')
        .replace('{duration_minutes}', config.durationMinutes || '5');

      // Clean up greeting if candidate name was empty (removes ", ," or "  ")
      greetingText = greetingText.replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ');

      sessionConfig.greeting = greetingText;
      logger.info('Using language-specific greeting', { language: sessionConfig.language, hasCandidateName: !!candidateNameValue });
    }
    if (languageConfig.closingTemplate) {
      sessionConfig.closing = languageConfig.closingTemplate;
      logger.info('Using language-specific closing', { language: sessionConfig.language });
    }

    // Prepend language instruction to the system prompt if not English
    // This tells the LLM to conduct the interview in the target language
    const languageInstruction = languageConfig.languageInstruction || '';
    const fullSystemPrompt = languageInstruction
      ? `${languageInstruction}\n\n${sessionConfig.prompt}`
      : sessionConfig.prompt;

    logger.info('Language configuration applied', {
      language: sessionConfig.language,
      displayName: languageConfig.displayName,
      hasLanguageInstruction: !!languageInstruction,
      hasGreetingTemplate: !!languageConfig.greetingTemplate,
      hasClosingTemplate: !!languageConfig.closingTemplate,
      promptLength: fullSystemPrompt.length
    });

    // Per-session duration overrides the global default (set from DB or bot_config)
    const interviewDurationMs = config.durationMinutes
      ? config.durationMinutes * 60 * 1000
      : this.interviewDurationMs;

    // Fitment: finite question list — close as soon as the last answer is received.
    // 0 means unlimited (screening mode — duration timer handles the end).
    const questionCount = config.questionCount || 0;
    let botResponseCount = 0; // incremented each time the bot asks a question

    // Conversation history for DeepSeek context (includes system message with language instruction)
    const conversationHistory = [
      { role: 'system', content: fullSystemPrompt }
    ];

    // Every bot turn so far. History is trimmed to the last 20 messages for latency, so
    // without this list the model forgets its early questions and asks them again.
    // Screening only — fitment works through a fixed question list.
    const askedQuestions = [];
    const recordBotTurn = (text) => {
      conversationHistory.push({ role: 'assistant', content: text });
      askedQuestions.push(text);
    };
    const llmMessages = () => {
      if (questionCount !== 0 || askedQuestions.length === 0) return conversationHistory;
      const asked = askedQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n');
      return [
        conversationHistory[0],
        {
          role: 'system',
          content: 'Questions you have already asked in this interview. Never ask any of these again, '
            + 'not even reworded. Rephrasing the current question when the candidate asks for '
            + `clarification is fine.\n${asked}`
        },
        ...conversationHistory.slice(1)
      ];
    };

    // DeepSeek model selection - use deepseek-chat for conversational tasks
    const deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    // Screening needs variety: at 0.3 the model read the example questions out in order.
    // Fitment stays low so the fixed questions are asked as written.
    const llmTemperature = questionCount === 0 ? 0.7 : 0.3;

    // State tracking
    let currentTranscript = '';
    let isBotSpeaking = false;
    let pendingLLMAbort = null; // AbortController for cancelling in-flight LLM
    let ttsReady = false;
    let backupCloseTimer = null; // Resetable timer for closing after last fitment question
    let sttReady = false;
    let sttPausedUntil = 0; // Timestamp: don't send audio to STT until this time (echo cooldown)
    // Audio that arrives before STT is open. The session is created by the first audio
    // chunk — usually the candidate saying hello — so dropping it loses their first words.
    let preSttBuffer = [];
    let preSttBufferBytes = 0;
    let interviewEnded = false;     // Set after LLM acknowledges last fitment answer (or duration timer fires)
    let awaitingLastAnswer = false; // Set after last fitment question is asked — LLM still needed to acknowledge answer
    let pendingClose = false;    // Set when timer fires while bot is mid-speech
    let closingSent = false;     // Prevents closing from being sent more than once
    let completionScheduled = false; // Prevents onInterviewComplete from firing twice
    // Mutex: prevents concurrent processUserTurn executions.
    // STT can fire multiple events while an LLM call is in-flight (UtteranceEnd + speech_final,
    // echoes of bot audio leaking into the mixed stream, mid-utterance partials, etc.).
    // Without this guard every overlap causes a duplicate LLM call → duplicate questions → loops.
    let isProcessingTurn = false;

    // --- Proctoring state ---
    const secondarySpeakerEvents = []; // Detected non-primary speakers via diarization
    const participantEvents = [];      // Camera on/off, screen share events from Zoom (sent by Attendee)
    let lastSecondaryLogTime = 0;      // Throttle: record at most one secondary-speaker event per 5 s
    const speakerWordCounts = new Map(); // diarization label -> words, to find the primary speaker

    // --- Camera state (screening camera check) ---
    // null until the Zoom bot reports; "on" if any non-bot participant has video on
    // (in a screening that's the candidate).
    const cameraByParticipant = new Map();
    let cameraOn = null;
    let cameraWaiters = [];          // { predicate, resolve } from waitForCamera()
    let openingDone = false;         // camera check finished — later camera-offs get a reminder
    let cameraBackOnPending = false; // camera went off mid-interview; remind before next question
    const waitForCamera = (predicate, ms) => new Promise(resolve => {
      if (predicate(cameraOn)) return resolve();
      const waiter = { predicate, resolve: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        cameraWaiters = cameraWaiters.filter(w => w !== waiter);
        resolve();
      }, Math.max(0, ms));
      cameraWaiters.push(waiter);
    });
    const updateCamera = (participantId, on) => {
      cameraByParticipant.set(participantId || 'unknown', on);
      const wasOn = cameraOn;
      cameraOn = [...cameraByParticipant.values()].some(Boolean);
      if (cameraOn === wasOn) return;
      logger.info('Candidate camera status changed', { cameraOn, participantId });
      if (openingDone) cameraBackOnPending = cameraOn === false;
      const ready = cameraWaiters.filter(w => w.predicate(cameraOn));
      cameraWaiters = cameraWaiters.filter(w => !ready.includes(w));
      ready.forEach(w => w.resolve());
    };

    // Full interview transcript log — used to build VTT when the session ends
    const sessionStartTime = Date.now();
    const interviewTranscript = []; // { speaker, text, timestamp_ms, duration_ms }

    // --- Closing message helper ---
    // Single place to send the closing TTS and schedule connection teardown.
    // After closing audio plays (~25 s including TTS generation + streaming + Zoom playback),
    // onInterviewComplete() is called to close the WebSocket so Attendee bot leaves the meeting.
    //
    // If the main TTS connection dropped (Deepgram closes idle connections after ~30s, which
    // happens while the candidate answers the last question), we open a dedicated fresh
    // TTS connection just for the closing message rather than silently skipping it.
    const sendClosingMessage = () => {
      if (closingSent) return;
      closingSent = true;

      const speakClosing = (ttsConn) => {
        isBotSpeaking = true;
        ttsConn.sendText(sessionConfig.closing);
        ttsConn.flush();
        interviewTranscript.push({
          speaker: 'Interviewer',
          text: sessionConfig.closing,
          timestamp_ms: Date.now() - sessionStartTime,
          duration_ms: 0
        });
        logger.info('Closing message sent — scheduling interview completion in 25s');
        if (config.onInterviewComplete && !completionScheduled) {
          completionScheduled = true;
          setTimeout(config.onInterviewComplete, 25000);
        }
      };

      if (ttsReady) {
        speakClosing(tts);
      } else {
        // TTS connection dropped while candidate was answering.
        // Reconnect with Google TTS for the closing message.
        logger.warn('Google TTS dropped — reconnecting to play closing message');

        const closingTts = createGoogleTTSStream({
          language: sessionConfig.language,
          voice: languageConfig.ttsVoiceFemale,  // Use female voice
          sampleRate: SAMPLE_RATE,
          gender: 'female'
        });

        closingTts.on('audio', audioData => {
          const buffer = Buffer.from(audioData);
          if (buffer.length > 0) onAudio(buffer);
        });

        closingTts.on('open', () => {
          logger.info('Google Closing TTS reconnected — sending closing message');
          speakClosing(closingTts);
        });

        closingTts.on('flushed', () => {
          isBotSpeaking = false;
          try { closingTts.requestClose(); } catch (e) { /* ignore */ }
        });

        closingTts.on('error', err => {
          logger.error('Google Closing TTS error', { error: err.message });
          if (!completionScheduled) {
            completionScheduled = true;
            if (config.onInterviewComplete) setTimeout(config.onInterviewComplete, 1000);
          }
        });

        // Safety: if reconnect never opens within 8s, end call silently
        setTimeout(() => {
          if (!completionScheduled) {
            logger.warn('Closing TTS failed to connect in 8s — ending call without audio');
            completionScheduled = true;
            if (config.onInterviewComplete) config.onInterviewComplete();
          }
        }, 8000);
      }
    };

    // --- Backup close timer (fitment: after last question is asked) ---
    // Resets whenever STT fires after interviewEnded, so a candidate who is actively
    // answering but whose audio got caught in the 1s echo-cooldown window gets more time.
    // 90s window (was 45s) — shorter answers finish well within this.
    const BACKUP_CLOSE_MS = 90000;
    const scheduleBackupClose = () => {
      if (backupCloseTimer) clearTimeout(backupCloseTimer);
      backupCloseTimer = setTimeout(() => {
        backupCloseTimer = null;
        if (!closingSent) {
          interviewEnded = true;
          logger.info('Backup timer: no candidate answer — sending closing', { questionCount, botResponseCount });
          sendClosingMessage();
        }
      }, BACKUP_CLOSE_MS);
    };

    // --- STT (Deepgram Live Transcription) ---
    // endpointing / utterance_end_ms are tuned per mode:
    //   fitment  — tighter (400ms / 2s): answers are short, less thinking time needed
    //   screening — looser (800ms / 5s): candidates pause to think during technical questions
    // Use language-specific STT model (e.g., 'hi' for Hindi, 'mr' for Marathi)
    const sttLanguage = languageConfig.sttLanguage || 'en';
    logger.info('STT language configuration', { sttLanguage, configLanguage: sessionConfig.language });

    const stt = deepgram.listen.live({
      model: 'nova-3',
      language: sttLanguage,  // Use language from config (hi, mr, te, ta, etc.)
      smart_format: true,
      encoding: 'linear16',
      sample_rate: SAMPLE_RATE,
      interim_results: true,
      utterance_end_ms: config.sttUtteranceEndMs || 5000,
      vad_events: true,
      endpointing: config.sttEndpointing || 800,
      diarize: true, // Enable speaker diarization to detect secondary speakers (proctoring)
      ...(sttLanguage.startsWith('en') && { keyterm: STT_KEYTERMS })
    });

    stt.on(LiveTranscriptionEvents.Open, () => {
      sttReady = true;
      logger.info('Deepgram STT connection opened', { bufferedAudioBytes: preSttBufferBytes });
      for (const chunk of preSttBuffer) stt.send(chunk);
      preSttBuffer = [];
      preSttBufferBytes = 0;
      checkAutoGreet();
    });

    stt.on(LiveTranscriptionEvents.Error, err => {
      logger.error('Deepgram STT error', { error: err.message || err });
    });

    stt.on(LiveTranscriptionEvents.Close, () => {
      sttReady = false;
      logger.info('Deepgram STT connection closed');
    });

    // --- TTS (Google Cloud TTS) ---
    // This branch uses Google TTS for all interviews (English default)
    // to test Google TTS before adding regional languages
    logger.info('Initializing Google Cloud TTS', {
      language: sessionConfig.language,
      voice: languageConfig.ttsVoice
    });

    const tts = createGoogleTTSStream({
      language: sessionConfig.language,
      voice: languageConfig.ttsVoiceFemale,  // Use female voice
      sampleRate: SAMPLE_RATE,
      gender: 'female'
    });

    tts.on('open', () => {
      ttsReady = true;
      logger.info('Google TTS connection opened');
      checkAutoGreet();
    });

    tts.on('audio', audioData => {
      const buffer = Buffer.from(audioData);
      if (buffer.length > 0) {
        onAudio(buffer);
      }
    });

    tts.on('flushed', () => {
      isBotSpeaking = false;
      // After bot finishes speaking, pause STT briefly to avoid echo feedback.
      // Screening mode needs a longer cooldown (2.5s) because the audio path is
      // longer and bot voice leaks back into STT more easily, causing repeated questions.
      // Fitment mode reduced to 500ms for faster response (short answers, less echo risk).
      // Flushed now fires when playback actually ends (it used to fire as soon as the audio
      // was sent), so 2500ms here clipped the first words of every screening answer.
      const echoCooldownMs = questionCount === 0 ? 800 : 500;
      sttPausedUntil = Date.now() + echoCooldownMs;
      currentTranscript = ''; // Discard any transcript accumulated during bot speech
      logger.info(`Google TTS flushed — bot done speaking, STT paused for ${echoCooldownMs}ms cooldown`);

      // If the duration timer fired while bot was mid-speech, send closing now
      if (pendingClose && !closingSent) {
        pendingClose = false;
        logger.info('Sending deferred closing message (timer fired during bot speech)');
        sendClosingMessage();
      }
    });

    tts.on('error', err => {
      logger.error('Google TTS error', { error: err.message || err });
      // A failed synthesis never emits 'flushed', so without this isBotSpeaking stays
      // true forever: STT is gated off, the bot goes deaf and mute, and any deferred
      // closing never plays.
      isBotSpeaking = false;
      if (pendingClose && !closingSent) {
        pendingClose = false;
        sendClosingMessage();
      }
    });

    tts.on('close', () => {
      ttsReady = false;
      isBotSpeaking = false; // Safety: unblock STT if TTS closes unexpectedly mid-speech
      // If we were waiting to close after the last question, trigger it now
      // (sendClosingMessage will reconnect TTS since ttsReady = false)
      if (pendingClose && !closingSent) {
        pendingClose = false;
        sendClosingMessage();
      }
      logger.info('Google TTS connection closed');
    });

    // NOTE: Barge-in is disabled because realtime_audio.mixed contains the bot's
    // own TTS output. VAD would fire on the bot's own voice, creating a feedback
    // loop that aborts every response. With mixed audio, we cannot distinguish
    // between user speech and bot echo.

    // Speak one line and resolve when it has finished playing ('flushed' fires at playback
    // end). Timeout covers a TTS that never flushes.
    const speakAndWait = (text) => new Promise(resolve => {
      const clean = text ? sanitizeForTTS(text) : '';
      if (!clean || !ttsReady) return resolve();
      const done = () => {
        clearTimeout(timer);
        tts.removeListener('flushed', done);
        resolve();
      };
      const timer = setTimeout(done, clean.length * 80 + 3000);
      tts.on('flushed', done);
      isBotSpeaking = true;
      tts.sendText(clean);
      tts.flush();
      interviewTranscript.push({
        speaker: 'Interviewer',
        text: clean,
        timestamp_ms: Date.now() - sessionStartTime,
        duration_ms: 0
      });
    });

    // Screening opening, after the greeting: thank the candidate if their camera is on;
    // otherwise ask for it and wait (with reminders) before the first question.
    const runCameraCheck = async () => {
      const lines = config.cameraLines;
      if (!lines) return;
      try {
        if (cameraOn === null) await waitForCamera(on => on !== null, CAMERA_STATUS_WAIT_MS);
        if (cameraOn === null) {
          logger.info('Camera status unavailable — asking candidate to keep it on');
          await speakAndWait(lines.unknown);
          return;
        }
        if (!cameraOn) {
          logger.info('Candidate camera off at start — asking them to turn it on');
          await speakAndWait(lines.request);
          const deadline = Date.now() + CAMERA_MAX_WAIT_MS;
          while (!cameraOn && !closingSent && Date.now() < deadline) {
            await waitForCamera(on => on === true, Math.min(CAMERA_REMINDER_INTERVAL_MS, deadline - Date.now()));
            if (!cameraOn && !closingSent && Date.now() < deadline) await speakAndWait(lines.reminder);
          }
          if (!cameraOn) {
            logger.warn('Candidate camera still off — starting questions anyway', { waitedMs: CAMERA_MAX_WAIT_MS });
            await speakAndWait(lines.proceed);
            return;
          }
        }
        await speakAndWait(lines.thanks);
      } finally {
        openingDone = true;
      }
    };

    // Track whether we've greeted the candidate yet.
    let hasGreeted = false;
    let autoGreetTriggered = false; // prevents duplicate auto-greet if both STT+TTS open simultaneously
    let screeningGreetTimer = null; // Fallback greet for screening if the candidate never speaks

    // Shared greeting + first-question sequence.
    // Called either by processUserTurn (candidate speaks first — screening)
    // or by checkAutoGreet (auto-greet — fitment mode, bot speaks first).
    const triggerGreeting = async () => {
      if (hasGreeted || autoGreetTriggered) return;
      autoGreetTriggered = true;
      hasGreeted = true;
      logger.info('Triggering greeting and first question', { autoGreet: config.autoGreet });

      try {
        isBotSpeaking = true;
        let firstQuestion = '';

        // A conversational opening that invites a reply ("shall we do this now, or use the
        // link?"): speak it, then WAIT — the candidate's reply drives the first LLM turn,
        // instead of barrelling into question one. (PSTN fitment calls set this flag;
        // screening and the Zoom bot leave it off, so this branch is inert there.)
        if (config.awaitReplyAfterGreeting) {
          logger.info('Speaking opening, then waiting for the candidate to reply');
          await speakAndWait(sessionConfig.greeting);
          isBotSpeaking = false;
          return;
        }

        if (ttsReady) {
          logger.info('Speaking greeting via TTS', { greeting: sessionConfig.greeting, greetingLength: sessionConfig.greeting.length });

          // Generate Q1 while the greeting plays. The greeting is recorded in the
          // transcript as it's sent, so it's kept even if the LLM call fails.
          conversationHistory.push({ role: 'user', content: 'Begin the interview. Ask the first question now.' });
          const llmPromise = deepseek.chat.completions.create({
            model: deepseekModel,
            messages: llmMessages(),
            max_tokens: 256,
            temperature: llmTemperature,
            stream: true
          });
          const [, stream] = await Promise.all([speakAndWait(sessionConfig.greeting), llmPromise]);

          // Collect first question from LLM stream
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) firstQuestion += delta;
          }
          // Add assistant response to history
          if (firstQuestion) {
            recordBotTurn(firstQuestion);
          }

          await runCameraCheck();
          if (closingSent) return;
        } else {
          // No TTS - still need to get first question from LLM
          conversationHistory.push({ role: 'user', content: 'Begin the interview. Ask the first question now.' });
          const stream = await deepseek.chat.completions.create({
            model: deepseekModel,
            messages: llmMessages(),
            max_tokens: 256,
            temperature: llmTemperature,
            stream: true
          });
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) firstQuestion += delta;
          }
          if (firstQuestion) {
            recordBotTurn(firstQuestion);
          }
        }

        if (firstQuestion) {
          const clean = sanitizeForTTS(firstQuestion);
          if (clean) {
            // Guard TTS send — if TTS dropped during the greeting sleep, skip the send
            // but still count the question so the interview state stays consistent.
            if (ttsReady) {
              isBotSpeaking = true;
              logger.info('Sending first question to TTS', { question: clean, questionLength: clean.length });
              tts.sendText(clean);
              tts.flush();
            } else {
              logger.warn('TTS not ready when Q1 generated — question skipped, interview may proceed silently');
            }

            botResponseCount++; // Q1 asked (or attempted)
            interviewTranscript.push({
              speaker: 'Interviewer',
              text: firstQuestion,   // Q1 as its own entry — greeting already pushed above
              timestamp_ms: Date.now() - sessionStartTime,
              duration_ms: 0
            });

            // If Q1 is also the LAST question (questionCount = 1), wait for candidate answer
            if (questionCount > 0 && botResponseCount >= questionCount && !closingSent) {
              logger.info('Q1 is the only fitment question — waiting for candidate answer before closing');
              awaitingLastAnswer = true;
              scheduleBackupClose();
            }
          }
        }
      } catch (err) {
        logger.error('Error in greeting/first question flow', { error: err.message });
        isBotSpeaking = false;
      }
    };

    // --- Auto-greet trigger (fitment mode: bot speaks first) ---
    // Called from both STT.Open and TTS.Open so it fires as soon as both are ready,
    // whichever opens last. Uses the isProcessingTurn mutex so candidate audio during
    // the greeting sequence is safely blocked.
    const runGreeting = async () => {
      if (hasGreeted || autoGreetTriggered) return;
      if (isProcessingTurn) return;       // another call beat us here
      isProcessingTurn = true;
      try {
        await triggerGreeting();
      } finally {
        isProcessingTurn = false;
      }
    };

    const checkAutoGreet = async () => {
      if (hasGreeted || autoGreetTriggered) return;
      if (!sttReady || !ttsReady) return; // wait until both connections are up
      if (!config.autoGreet) {
        // Screening: candidate speaks first, but don't wait forever.
        if (!screeningGreetTimer) {
          screeningGreetTimer = setTimeout(() => {
            screeningGreetTimer = null;
            if (hasGreeted || autoGreetTriggered) return;
            logger.info('Screening: candidate has not spoken — greeting first', { waitedMs: SCREENING_GREET_FALLBACK_MS });
            runGreeting();
          }, SCREENING_GREET_FALLBACK_MS);
        }
        return;
      }
      await runGreeting();
    };

    // --- Process transcripts → LLM → TTS ---
    const processUserTurn = async (userText) => {
      if (!userText.trim()) return;
      if (interviewEnded) {
        // Candidate spoke after LLM already acknowledged last fitment answer (or after duration timer).
        // Don't call LLM again — closing is either already in progress or needs triggering.
        // Still record what they said: this is often their answer to the final question,
        // finished after time ran out, and dropping it left it out of the report.
        if (!closingSent) {
          interviewTranscript.push({
            speaker: 'Candidate',
            text: userText,
            timestamp_ms: Date.now() - sessionStartTime,
            duration_ms: 0
          });
        }
        if (!closingSent) {
          if (!isBotSpeaking) {
            if (backupCloseTimer) { clearTimeout(backupCloseTimer); backupCloseTimer = null; }
            logger.info('Candidate spoke after interview ended — sending closing');
            sendClosingMessage();
          } else {
            pendingClose = true;
            logger.info('Candidate spoke after interview ended while bot still speaking — deferring close');
          }
        }
        return;
      }

      // Mutex: drop this event if a turn is already being processed.
      // Covers: UtteranceEnd firing after speech_final for the same utterance,
      // bot-audio echoes leaking into STT via the mixed stream, rapid re-triggers, etc.
      if (isProcessingTurn) {
        logger.info('Dropping overlapping STT event — turn already in progress', { text: userText.substring(0, 60) });
        return;
      }
      isProcessingTurn = true;

      try {

      logger.info('User said', { text: userText });

      // Record user utterance in interview transcript
      const userTimestamp = Date.now() - sessionStartTime;
      interviewTranscript.push({
        speaker: 'Candidate',
        text: userText,
        timestamp_ms: userTimestamp,
        duration_ms: 0
      });

      // If this is the first user message and we haven't greeted yet
      // (covers screening mode where candidate speaks first; fitment uses auto-greet instead)
      if (!hasGreeted) {
        await triggerGreeting();
        return; // Don't process "hi/hello" as a real answer
      }

      // Check if interview duration has been reached — wrap up gracefully
      const elapsedMs = Date.now() - sessionStartTime;
      if (elapsedMs >= interviewDurationMs && !closingSent) {
        interviewEnded = true;
        logger.info('Interview duration reached, wrapping up', {
          elapsedMinutes: Math.floor(elapsedMs / 60000),
          durationMinutes: Math.floor(interviewDurationMs / 60000)
        });

        if (isBotSpeaking) {
          pendingClose = true;
          logger.info('Bot is mid-speech, deferring closing until current utterance ends');
        } else {
          sendClosingMessage();
        }
        return;
      }

      // Last minute of a screening: this answer gets the closing, not another question
      if (wrapUpRequested && !closingSent) {
        interviewEnded = true;
        logger.info('Wrap-up window — closing after the candidate\'s answer', {
          remainingSeconds: Math.round((interviewDurationMs - elapsedMs) / 1000)
        });
        if (isBotSpeaking) pendingClose = true; else sendClosingMessage();
        return;
      }

      // Keep conversation history manageable (last 20 exchanges, but always keep system message)
      if (conversationHistory.length > 21) {
        // Keep system message (index 0) and last 20 messages
        const systemMsg = conversationHistory[0];
        conversationHistory.splice(0, conversationHistory.length - 20);
        conversationHistory.unshift(systemMsg);
      }

      // Add user message to conversation history
      conversationHistory.push({ role: 'user', content: userText });

      // Stream LLM response with retry on rate limit errors.
      const APP_RETRY_DELAY_MS = 3000;
      const APP_MAX_RETRIES = 1;
      let fullResponse = null;
      // Track whether we actually sent a flush to TTS.
      // When true, TTS Flushed is the ONLY correct place to reset isBotSpeaking —
      // resetting it here (before Flushed fires) allows bot's own TTS audio to leak
      // back into STT via the mixed audio stream, causing echo-driven extra LLM calls
      // and question loops.
      let ttsFlushSent = false;

      for (let attempt = 0; attempt <= APP_MAX_RETRIES; attempt++) {
        try {
          isBotSpeaking = true;
          const abortController = new AbortController();
          pendingLLMAbort = abortController;

          // Timing: track LLM response time
          const llmStartTime = Date.now();

          // Call DeepSeek API with streaming
          const stream = await deepseek.chat.completions.create({
            model: deepseekModel,
            messages: llmMessages(),
            max_tokens: 256,
            temperature: llmTemperature,
            stream: true
          }, { signal: abortController.signal });

          const llmFirstChunkTime = Date.now();
          logger.info('LLM stream started', { latencyMs: llmFirstChunkTime - llmStartTime });

          let response = '';

          // Buffer the full LLM response before sending to TTS.
          // Streaming chunk-by-chunk causes uneven audio (fast/slow, dropped words)
          // because TTS has to synthesize tiny fragments with network latency gaps.
          for await (const chunk of stream) {
            if (abortController.signal.aborted) {
              logger.info('LLM stream aborted');
              break;
            }

            const delta = chunk.choices[0]?.delta?.content;
            if (delta) response += delta;
          }

          const llmEndTime = Date.now();
          logger.info('LLM response complete', {
            totalLatencyMs: llmEndTime - llmStartTime,
            streamDurationMs: llmEndTime - llmFirstChunkTime,
            responseLength: response.length
          });

          // Add assistant response to conversation history
          if (response) {
            recordBotTurn(response);
          }

          // Send the complete response to TTS in one go for smooth audio
          if (ttsReady && !abortController.signal.aborted && response) {
            let clean = sanitizeForTTS(response);
            if (clean && cameraBackOnPending && config.cameraLines?.backOn && cameraOn === false) {
              cameraBackOnPending = false;
              logger.info('Camera off mid-interview — reminding before next question');
              interviewTranscript.push({
                speaker: 'Interviewer',
                text: config.cameraLines.backOn,
                timestamp_ms: Date.now() - sessionStartTime,
                duration_ms: 0
              });
              clean = `${sanitizeForTTS(config.cameraLines.backOn)} ${clean}`;
            }
            if (clean) {
              tts.sendText(clean);
              tts.flush();
              ttsFlushSent = true;
            }
          }

          pendingLLMAbort = null;
          fullResponse = response;
          break; // Success — exit retry loop

        } catch (err) {
          pendingLLMAbort = null;

          if (err.name === 'AbortError') {
            logger.info('LLM request aborted');
            break;
          }

          const isRateLimit = err.status === 429
            || err.message?.includes('429')
            || err.message?.includes('rate_limit');

          if (isRateLimit && attempt < APP_MAX_RETRIES) {
            logger.warn('DeepSeek rate limited, retrying after delay', {
              attempt: attempt + 1,
              maxRetries: APP_MAX_RETRIES,
              delayMs: APP_RETRY_DELAY_MS
            });
            isBotSpeaking = false;
            await new Promise(resolve => setTimeout(resolve, APP_RETRY_DELAY_MS));
            continue;
          }

          logger.error('Error in LLM processing', { error: err.message, isRateLimit, attempt });
          break;
        }
      }

      if (fullResponse) {
        botResponseCount++; // another question asked
        logger.info('Bot responded', { text: fullResponse, textLength: fullResponse.length, botResponseCount, questionCount });
        const botTimestamp = Date.now() - sessionStartTime;
        interviewTranscript.push({
          speaker: 'Interviewer',
          text: fullResponse,
          timestamp_ms: botTimestamp,
          duration_ms: 0
        });

        if (questionCount > 0 && !closingSent) {
          if (botResponseCount > questionCount) {
            // LLM just acknowledged the candidate's last answer ("Perfect, thanks so much.").
            // Close after TTS finishes speaking the acknowledgment.
            logger.info('LLM acknowledged last fitment answer — closing after TTS', { questionCount, botResponseCount });
            interviewEnded = true;
            pendingClose = true;
          } else if (botResponseCount >= questionCount) {
            // Just asked the last fitment question — wait for candidate to answer.
            // LLM still needs to run once more to give the closing acknowledgment.
            logger.info('Last fitment question asked — waiting for candidate answer', { questionCount, botResponseCount });
            awaitingLastAnswer = true;
            scheduleBackupClose();
          }
        }

        // Reminder call (not an interview): the bot delivers the opening, hears one reply,
        // gives one acknowledgment, then wraps up — no questions. Inert unless
        // config.reminderMode is set (PSTN action='remind' calls); the Zoom bot never sets it.
        if (config.reminderMode && !closingSent) {
          logger.info('Reminder acknowledged — closing after this message');
          interviewEnded = true;
          pendingClose = true;
        }
      } else if (!interviewEnded) {
        // All retries failed — speak fallback so the user doesn't hear silence
        isBotSpeaking = true;
        const fallback = 'Sorry, could you repeat that?';
        if (ttsReady) {
          tts.sendText(fallback);
          tts.flush();
          ttsFlushSent = true;
        }
        logger.warn('LLM failed after retries, spoke fallback message');
      }

      // Only reset isBotSpeaking here when no TTS flush was sent.
      // When flush WAS sent, the TTS Flushed event resets it after audio finishes — doing
      // it here before Flushed fires lets bot audio echo into STT via the mixed stream.
      if (!ttsFlushSent) {
        isBotSpeaking = false;
      }

      } finally {
        isProcessingTurn = false;
      }
    };

    // --- Answer grace period ---
    // speech_final fires after `endpointing` ms of silence, which is shorter than a
    // natural mid-answer pause ("It is... around 30 days"). Answering immediately cut
    // candidates off and the transcript recorded fragments. Instead, wait answerGraceMs
    // more; if they resume speaking the timer is cancelled and the answer keeps growing.
    const answerGraceMs = config.answerGraceMs || 2000;
    let answerGraceTimer = null;
    let lastCandidateSpeechAt = 0; // Last STT words (interim or final) — "is the candidate talking?"

    const commitAnswer = (trigger) => {
      if (answerGraceTimer) { clearTimeout(answerGraceTimer); answerGraceTimer = null; }
      const userText = currentTranscript.trim();
      if (!userText) return;
      // Same gate as sendAudio(): text that surfaces while the bot is talking is echo
      if (isBotSpeaking || Date.now() < sttPausedUntil) {
        logger.info('Answer discarded — bot speaking or in echo cooldown', { trigger, text: userText.substring(0, 60) });
        currentTranscript = '';
        return;
      }
      logger.info('Candidate finished answering — processing', { trigger, text: userText });
      currentTranscript = '';
      processUserTurn(userText);
    };

    // --- Accumulate transcript and detect end of user turn ---
    stt.on(LiveTranscriptionEvents.Transcript, data => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (!transcript) return;
      lastCandidateSpeechAt = Date.now();

      // Any new words (interim or final) during the grace period: still answering
      if (answerGraceTimer) {
        clearTimeout(answerGraceTimer);
        answerGraceTimer = null;
        logger.info('Candidate resumed speaking — extending answer', { text: transcript.substring(0, 60) });
      }

      if (data.is_final) {
        // Proctoring: check for secondary speakers in diarized word list
        const now = Date.now();
        const secondaryRuns = findSecondarySpeech(data.channel?.alternatives?.[0]?.words || [], speakerWordCounts);
        if (secondaryRuns.length && now - lastSecondaryLogTime > 5000) { // throttle: at most 1 event per 5 s
          const { speaker, words } = secondaryRuns[0]; // one event per segment is sufficient
          const sampleText = words.map(w => w.punctuated_word || w.word).join(' ');
          lastSecondaryLogTime = now;
          secondarySpeakerEvents.push({
            timestamp_ms: now - sessionStartTime,
            speaker_id: speaker,
            sample_word: words[0].word || '',
            sample_text: sampleText,
            word_count: words.length
          });
          logger.warn('Proctoring: secondary speaker detected', { speaker, wordCount: words.length, text: sampleText });
        }

        currentTranscript += (currentTranscript ? ' ' : '') + transcript;
        logger.info('STT transcript (final)', {
          text: transcript,
          accumulated: currentTranscript,
          speechFinal: data.speech_final
        });

        // If we're waiting for the candidate to answer the last question,
        // any STT activity means they're actively speaking — reset the backup timer.
        // This prevents premature close when their answer got caught in the echo cooldown.
        if ((awaitingLastAnswer || interviewEnded) && !closingSent && backupCloseTimer) {
          logger.info('STT activity after last question — resetting backup close timer');
          scheduleBackupClose();
        }

        // speech_final means the user paused — give them answerGraceMs to continue
        if (data.speech_final && currentTranscript.trim()) {
          answerGraceTimer = setTimeout(() => commitAnswer('speech_final + grace'), answerGraceMs);
        }
      }
    });

    // UtteranceEnd is a fallback — fires after utterance_end_ms of silence.
    // Apply the same gate as sendAudio() — Deepgram can buffer audio before isBotSpeaking
    // was raised and emit UtteranceEnd after the bot starts talking, which would send
    // echoed bot audio to the LLM. Discard the accumulated transcript in that case.
    // utterance_end_ms is set longer than endpointing + grace, so this only fires
    // first when Deepgram never emitted speech_final for the utterance.
    stt.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      commitAnswer('utterance_end');
    });

    // Keep STT and TTS connections alive.
    // Deepgram closes idle connections after ~30s — this fires every 8s to prevent that.
    // TTS idles whenever the candidate is speaking (which can be 20-30s per answer),
    // so without this keepalive the TTS connection drops and closing never plays.
    const keepAlive = setInterval(() => {
      if (sttReady && stt.keepAlive) {
        stt.keepAlive();
      }
      if (ttsReady && tts.keepAlive) {
        tts.keepAlive();
      }
    }, 8000);

    // Screening wrap-up: a minute before the end, stop asking new questions. The answer
    // in progress (or the next one) is followed by the closing; durationTimer still ends
    // the call on time if the candidate stays silent.
    let wrapUpRequested = false;
    const wrapUpBeforeEndMs = config.wrapUpBeforeEndMs ?? WRAP_UP_BEFORE_END_MS;
    const wrapUpTimer = questionCount === 0 && interviewDurationMs > 2 * wrapUpBeforeEndMs
      ? setTimeout(() => {
        wrapUpRequested = true;
        logger.info('Interview is in its last minute — wrapping up after the current answer');
      }, interviewDurationMs - wrapUpBeforeEndMs)
      : null;

    // Proactive interview end timer — fires even if candidate is silent after the last question.
    // This ensures the closing message is always delivered regardless of candidate activity.
    let overtimeCloseTimer = null; // Caps how long a mid-answer candidate can run past the duration
    const durationTimer = setTimeout(() => {
      if (interviewEnded || closingSent) return;
      interviewEnded = true;
      logger.info('Interview duration timer fired — wrapping up', {
        durationMinutes: Math.floor(interviewDurationMs / 60000)
      });

      if (isBotSpeaking) {
        pendingClose = true;
        logger.info('Bot is mid-speech at timer fire, deferring closing to TTS Flushed');
      } else if (currentTranscript.trim() || answerGraceTimer || Date.now() - lastCandidateSpeechAt < 3000) {
        // Candidate is mid-answer. Closing now would talk over them and lose the answer.
        // commitAnswer -> processUserTurn (interviewEnded) records it and sends the closing.
        logger.info('Candidate mid-answer at timer fire, closing after they finish');
        overtimeCloseTimer = setTimeout(() => {
          overtimeCloseTimer = null;
          if (closingSent) return;
          logger.info('Candidate still talking 20s past interview duration — closing now');
          if (isBotSpeaking) pendingClose = true; else sendClosingMessage();
        }, 20000);
      } else {
        sendClosingMessage();
      }
    }, interviewDurationMs);

    // --- Session object ---
    const session = {
      stt,
      tts,
      keepAlive,
      /** Get the accumulated interview transcript entries */
      getTranscript() { return interviewTranscript; },

      /** Epoch ms this session started — transcript timestamps are relative to it */
      getStartTime() { return sessionStartTime; },

      /** Get proctoring data collected during this session */
      getProctoringData() {
        return { secondarySpeakerEvents, participantEvents };
      },

      /** Record a participant status event (camera/screen share) sent by Attendee bot pod */
      addParticipantEvent(event) {
        if (event.event === 'camera_on' || event.event === 'camera_off') {
          // Re-sent every 10s as a heartbeat — track state, record only changes
          const prev = cameraOn;
          updateCamera(event.participant_uuid, event.event === 'camera_on');
          if (cameraOn === prev) return;
        }
        // Attendee's own timestamp_ms is epoch time; keep it, but store session-relative
        // time like every other proctoring event
        participantEvents.push({
          ...event,
          attendee_timestamp_ms: event.timestamp_ms,
          timestamp_ms: Date.now() - sessionStartTime
        });
        logger.info('Proctoring: participant event recorded', event);
      },
      sttReady: () => sttReady,
      ttsReady: () => ttsReady,

      /** Send audio from meeting to STT (gated: skip while bot is speaking or in echo cooldown) */
      sendAudio(audioBuffer) {
        // Don't send audio to STT while bot is speaking — the mixed audio
        // contains the bot's own TTS output, which would create a feedback loop
        // (STT transcribes bot → processUserTurn → LLM → TTS → repeat).
        if (!sttReady) {
          if (!hasGreeted && preSttBufferBytes + audioBuffer.length <= MAX_PRE_STT_BUFFER_BYTES) {
            preSttBuffer.push(audioBuffer);
            preSttBufferBytes += audioBuffer.length;
          }
          return;
        }
        if (isBotSpeaking || Date.now() < sttPausedUntil) {
          return;
        }
        stt.send(audioBuffer);
      },

      /** Clean up all resources */
      close() {
        clearInterval(keepAlive);
        clearTimeout(durationTimer);
        if (wrapUpTimer) clearTimeout(wrapUpTimer);
        cameraWaiters.forEach(w => w.resolve());
        cameraWaiters = [];
        if (backupCloseTimer) { clearTimeout(backupCloseTimer); backupCloseTimer = null; }
        if (screeningGreetTimer) { clearTimeout(screeningGreetTimer); screeningGreetTimer = null; }
        if (answerGraceTimer) { clearTimeout(answerGraceTimer); answerGraceTimer = null; }
        if (overtimeCloseTimer) { clearTimeout(overtimeCloseTimer); overtimeCloseTimer = null; }

        if (pendingLLMAbort) {
          pendingLLMAbort.abort();
          pendingLLMAbort = null;
        }

        try { if (sttReady) stt.requestClose(); } catch (e) { /* ignore */ }
        try { if (ttsReady) tts.requestClose(); } catch (e) { /* ignore */ }

        logger.info('Voice session closed');
      }
    };

    return session;
  }
  // ---- END verbatim (createSession) ----

  /**
   * Session config for an interview row. The Zoom bot builds the same config in two
   * steps — api.service joinMeeting (row -> WebSocket URL params) and the voiceAgent
   * WebSocket handler (params -> config); this is both in one. Keep them in step.
   * The caller adds onInterviewComplete.
   */
  buildSessionConfig(interview) {
    let botConfig = interview.bot_config || {};
    if (typeof botConfig === 'string') {
      try { botConfig = JSON.parse(botConfig); } catch (e) { botConfig = {}; }
    }

    // The main app sends either the legacy flat shape or the newer PSTN "agenda" shape
    // ({ stage, duration_target_minutes, caller_identity, agenda: { opening, questions:
    // [{topic, question}], collect, fallback: { link, note } } }). Normalise both here.
    const agenda = botConfig.agenda || {};
    const stage = String(botConfig.stage || interview.interview_stage || 'screening').toLowerCase() === 'fitment'
      ? 'fitment' : 'screening';
    // duration_target_minutes (new) > bot_config.duration_minutes > the interview row
    const durationMinutes = parseInt(
      botConfig.duration_target_minutes || botConfig.duration_minutes || interview.duration_minutes, 10) || null;
    const questionItems = (agenda.questions || botConfig.questions || []).filter(q => q && q.question);
    const opening = (typeof agenda.opening === 'string' ? agenda.opening : '').trim();
    const fallback = agenda.fallback || null;
    // The main app's agenda currently carries no closing, so this is almost always empty
    // and the per-mode fallback below is used. Read it anyway, so if a closing is ever
    // added to bot_config the agent speaks it verbatim.
    const providedClosing = String(agenda.closing || botConfig.closing || '').trim();
    const skills = Array.isArray(interview.skills) ? interview.skills.join(',') : (interview.skills || '');

    // Two call types: action='conduct' runs the interview questions in-call (fitment);
    // action='remind' is just a reminder — deliver the opening, point them to the link,
    // and hang up WITHOUT asking any questions.
    const action = String(botConfig.action || 'conduct').toLowerCase();

    const configuredLanguage = getNormalizedLangCode(botConfig.language);
    const languageFallbacks = getLanguageConfig(configuredLanguage);
    const candidate = botConfig.candidate || {};
    let candidateName = languageFallbacks.fallbackCandidateName || '';
    const orgName = botConfig.org_name || languageFallbacks.fallbackOrgName || 'our organization';
    const jdTitle = botConfig.jd_title || languageFallbacks.fallbackJdTitle || 'the position';
    let prompt, greeting, closing, sessionSkills = skills;
    const effectiveDurationMinutes = durationMinutes || (stage === 'fitment' ? 10 : null);

    // --- Reminder call: NOT an interview. Deliver the opening, hear one reply, give one
    // acknowledgment + point to the link, then close. No questions, no transcript/report. ---
    if (action === 'remind') {
      candidateName = toDisplayName(candidate.first_name);
      const link = fallback?.link;
      prompt =
        `You are making a brief REMINDER phone call on behalf of ${orgName} about the candidate's ` +
        `${botConfig.stage_label || jdTitle}. This is NOT an interview and NOT a screening — you must ` +
        `NOT ask any questions of any kind, and you must NOT start an interview.\n\n` +
        `You have ALREADY delivered the opening message. The candidate is now replying. Respond with ` +
        `ONE short, warm, spoken sentence that acknowledges what they said (e.g. if they gave a time, ` +
        `say that works and you'll note it) and ` +
        (link
          ? `reminds them the link to continue is already in their WhatsApp and email. `
          : `lets them know their recruiter will follow up. `) +
        `Then STOP — say nothing else, ask nothing, start nothing. The system closes the call.\n\n` +
        `Plain spoken sentences only, no formatting.`;
      greeting = opening || fillTemplate(
        'Hi {candidate_name}, a quick reminder from {org_name} about your {jd_title}.',
        { candidate_name: candidateName, org_name: orgName, jd_title: jdTitle });
      closing = providedClosing || `Thank you${candidateName ? `, ${candidateName}` : ''}. Have a great day!`;
      return {
        prompt, greeting, closing, skills: '',
        durationMinutes: effectiveDurationMinutes || 2,
        questionCount: 0,
        candidateName, orgName, jdTitle,
        language: configuredLanguage,
        autoGreet: true,
        awaitReplyAfterGreeting: true, // speak the reminder, then wait for their reply
        reminderMode: true,            // one ack then wrap up (see createSession)
        sttEndpointing: 700, sttUtteranceEndMs: 3000, answerGraceMs: 1800,
        cameraLines: null,
      };
    }

    if (stage === 'fitment') {
      candidateName = [candidate.first_name, candidate.last_name].filter(Boolean).join(' ')
        || languageFallbacks.fallbackCandidateName || '';
      const questions = questionItems.length > 0
        ? questionItems.map((q, i) => `${i + 1}. ${q.question}`).join('\n')
        : DEFAULT_FITMENT_QUESTIONS;
      prompt = (fitmentPromptConfig.system_prompt || this.defaultPrompt)
        .replace(/\{org_name\}/g, orgName)
        .replace(/\{jd_title\}/g, jdTitle)
        .replace(/\{questions\}/g, questions);
      // Use the provided opening verbatim if present; else the fitment template.
      greeting = opening || (fitmentPromptConfig.greeting || this.defaultGreeting)
        .replace(/\{candidate_name\}/g, candidateName)
        .replace(/\{org_name\}/g, orgName)
        .replace(/\{jd_title\}/g, jdTitle)
        .replace(/\{duration_minutes\}/g, String(effectiveDurationMinutes || 10));
      closing = providedClosing || fitmentPromptConfig.closing || this.defaultClosing;
    } else {
      // Invite topic (screening_topic > topic > jd_title) replaces the skill list
      const topic = String(botConfig.screening_topic || botConfig.topic || botConfig.jd_title || '').trim();
      if (topic) sessionSkills = topic;
      const skillsLabel = topic
        || skills.split(',').map(s => s.trim()).filter(Boolean).join(', ')
        || 'general software engineering';
      prompt = this.defaultPrompt.replace(/\{skills\}/g, skillsLabel);
      candidateName = toDisplayName(candidate.first_name);
      const templateValues = {
        skills: skillsLabel,
        candidate_name: candidateName,
        duration_minutes: String(effectiveDurationMinutes || Math.round(this.interviewDurationMs / 60000))
      };
      greeting = opening || fillTemplate(this.defaultGreeting, templateValues);
      closing = providedClosing || fillTemplate(this.defaultClosing, templateValues);
    }

    // A conversational opening (and/or a fallback link) → tell the LLM how to handle the
    // candidate's reply to it: begin the questions if they're ready, or point them to the
    // link and wrap up if they'd rather not do it now.
    if (opening || fallback?.link) {
      const notes = [];
      if (opening) {
        notes.push(`This call already opened by saying:\n"${opening}"\nThe candidate is now replying to that opening — this OVERRIDES any rule about starting your first response with "To begin,". Respond to their reply first.`);
      }
      notes.push('When the candidate agrees or is ready, begin asking the questions above, one at a time, in order.');
      if (fallback?.link) {
        notes.push(`If the candidate is busy, would rather not do it now, or prefers the link, do NOT ask the questions — warmly acknowledge, tell them the link is already in their WhatsApp and email (${fallback.link}), and then say only "Perfect, thanks so much." so the system can close the call.`);
      }
      prompt += `\n\n\nTHIS CALL'S OPENING AND CONSENT:\n\n${notes.join('\n\n')}`;
    }

    // Same answer-timing tuning as the Zoom bot (see voiceAgent: endpointing + grace)
    return {
      prompt,
      greeting,
      closing,
      skills: sessionSkills,
      durationMinutes: effectiveDurationMinutes,
      questionCount: stage === 'fitment' ? (questionItems.length || 5) : 0,
      candidateName,
      orgName,
      jdTitle,
      language: configuredLanguage,
      // A phone call has no "candidate speaks first" — the bot opens as soon as they answer
      autoGreet: true,
      // Opening that invites a reply ("now, or use the link?") → greet, then WAIT for the
      // candidate before question one, instead of talking over the consent ask.
      awaitReplyAfterGreeting: !!opening,
      sttEndpointing: stage === 'fitment' ? 700 : 800,
      sttUtteranceEndMs: stage === 'fitment' ? 3000 : 5000,
      answerGraceMs: stage === 'fitment' ? 1800 : 2500,
      cameraLines: null // no camera on a phone call
    };
  }
}

module.exports = new InterviewBrainService();
