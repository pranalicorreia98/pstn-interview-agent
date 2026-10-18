/**
 * Interview Brain Service
 *
 * Transport-agnostic interview logic extracted from voiceAgent.service.js.
 * Handles: STT → LLM → TTS pipeline, greeting/closing, transcript management.
 *
 * Used by:
 * - phoneAgent.service.js (LiveKit SIP transport for PSTN calls)
 * - Could also be used by Zoom/Attendee transport if migrated
 */

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const logger = require('../utils/logger');
const { createGoogleTTSStream } = require('./tts/googleTts.service');
const { getLanguageConfig, getNormalizedLangCode } = require('../config/languageVoices');

// Load interview prompt config from YAML
const PROMPT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'interviewPrompt.yaml');
let promptConfig = {};
try {
  promptConfig = yaml.load(fs.readFileSync(PROMPT_CONFIG_PATH, 'utf8'));
  logger.info('Loaded interview prompt config', { path: PROMPT_CONFIG_PATH });
} catch (err) {
  logger.warn('Failed to load interview prompt config, using defaults', { error: err.message });
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

const SAMPLE_RATE = 16000;

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

/**
 * Strip markdown and formatting artifacts so TTS speaks clean text.
 */
function sanitizeForTTS(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[~]{2}([^~]+)[~]{2}/g, '$1')
    .replace(/>\s*/g, '')
    .replace(/\|/g, '')
    .replace(/---+/g, '')
    .replace(/[*#`~_]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

class InterviewBrainService {
  constructor() {
    this.deepgramApiKey = process.env.DEEPGRAM_API_KEY;
    this.deepseekApiKey = process.env.DEEPSEEK_API_KEY;
    this.deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

    this.defaultPrompt = promptConfig.system_prompt || process.env.BOT_SYSTEM_PROMPT || 'You are a helpful interview assistant.';
    this.defaultGreeting = promptConfig.greeting || process.env.BOT_GREETING || 'Hello! I am your interview assistant.';
    this.defaultClosing = promptConfig.closing || 'Thank you for your time. Have a great day.';

    this.interviewDurationMs = (parseInt(process.env.INTERVIEW_DURATION_MINUTES) || 30) * 60 * 1000;

    // Active sessions map
    this.activeSessions = new Map();
  }

  /**
   * Create an interview session.
   *
   * @param {Object} config - Session configuration
   * @param {string} config.sessionId - Unique session identifier
   * @param {string} config.prompt - System prompt for LLM
   * @param {string} config.greeting - Initial greeting message
   * @param {string} config.closing - Closing message
   * @param {string} config.language - Language code (e.g., 'en', 'hi', 'mr')
   * @param {string} config.skills - Skills/topics for the interview
   * @param {boolean} config.autoGreet - Auto-greet on connection (true for phone)
   * @param {number} config.questionCount - Number of questions (0 = unlimited/screening)
   * @param {number} config.durationMinutes - Interview duration
   * @param {Object} callbacks - Callback functions
   * @param {Function} callbacks.onAudio - Called with audio buffer to send to candidate
   * @param {Function} callbacks.onTranscriptEntry - Called with transcript entries
   * @param {Function} callbacks.onInterviewComplete - Called when interview ends
   * @returns {Object} Session interface { pushAudio, close, getTranscript, getProctoringData }
   */
  createSession(config, callbacks) {
    if (!this.deepgramApiKey) {
      throw new Error('DEEPGRAM_API_KEY is required');
    }
    if (!this.deepseekApiKey) {
      throw new Error('DEEPSEEK_API_KEY is required');
    }

    const { onAudio, onTranscriptEntry, onInterviewComplete } = callbacks;
    const sessionId = config.sessionId || `session-${Date.now()}`;

    const deepgram = createClient(this.deepgramApiKey);
    const deepseek = new OpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey: this.deepseekApiKey
    });

    // Normalize language code
    const normalizedLanguage = getNormalizedLangCode(config.language);
    const languageConfig = getLanguageConfig(normalizedLanguage);

    // Check if skills are provided, otherwise fall back to communication skills assessment
    const { skills: effectiveSkills, isDefaultCommunication } = getEffectiveSkills(config.skills);

    // Build the system prompt, appending communication skills guidance if needed
    let systemPrompt = config.prompt || this.defaultPrompt;
    if (isDefaultCommunication) {
      logger.info('No technical skills provided, using communication skills assessment', { sessionId });
      systemPrompt = `${systemPrompt}\n\n${DEFAULT_COMMUNICATION_SKILLS_PROMPT}`;
    }

    const sessionConfig = {
      prompt: systemPrompt,
      greeting: config.greeting || this.defaultGreeting,
      closing: config.closing || this.defaultClosing,
      language: normalizedLanguage,
      skills: effectiveSkills,
      autoGreet: config.autoGreet !== false, // Default true for phone
      questionCount: config.questionCount || 0, // 0 = screening (unlimited)
      isDefaultCommunication, // Track if we're using default communication mode
    };

    // Apply language-specific greeting/closing templates
    if (languageConfig.greetingTemplate) {
      const candidateName = config.candidateName || languageConfig.fallbackCandidateName || '';
      sessionConfig.greeting = languageConfig.greetingTemplate
        .replace('{candidate_name}', candidateName)
        .replace('{org_name}', config.orgName || languageConfig.fallbackOrgName || 'our organization')
        .replace('{jd_title}', config.jdTitle || languageConfig.fallbackJdTitle || 'the position')
        .replace('{duration_minutes}', config.durationMinutes || '5')
        .replace(/,\s*,/g, ',')
        .replace(/\s{2,}/g, ' ');
    }
    if (languageConfig.closingTemplate) {
      sessionConfig.closing = languageConfig.closingTemplate;
    }

    // Language instruction for LLM
    const languageInstruction = languageConfig.languageInstruction || '';
    const fullSystemPrompt = languageInstruction
      ? `${languageInstruction}\n\n${sessionConfig.prompt}`
      : sessionConfig.prompt;

    const interviewDurationMs = config.durationMinutes
      ? config.durationMinutes * 60 * 1000
      : this.interviewDurationMs;

    // Session state
    const state = {
      conversationHistory: [{ role: 'system', content: fullSystemPrompt }],
      currentTranscript: '',
      isBotSpeaking: false,
      hasGreeted: false,
      autoGreetTriggered: false,
      sttReady: false,
      ttsReady: false,
      sttPausedUntil: 0,
      interviewEnded: false,
      closingSent: false,
      completionScheduled: false,
      isProcessingTurn: false,
      botResponseCount: 0,
      sessionStartTime: Date.now(),
      interviewTranscript: [],
      secondarySpeakerEvents: [],
      participantEvents: [],
    };

    // Duration timer
    const durationTimer = setTimeout(() => {
      if (!state.closingSent) {
        logger.info('Interview duration timer fired', { sessionId, durationMinutes: interviewDurationMs / 60000 });
        if (state.isBotSpeaking) {
          state.pendingClose = true;
        } else {
          sendClosingMessage();
        }
      }
    }, interviewDurationMs);

    // --- STT Setup (Deepgram) ---
    const sttLanguage = languageConfig.sttLanguage || 'en';
    const stt = deepgram.listen.live({
      model: 'nova-3',
      language: sttLanguage,
      smart_format: true,
      encoding: 'linear16',
      sample_rate: SAMPLE_RATE,
      interim_results: true,
      utterance_end_ms: config.sttUtteranceEndMs || 5000,
      vad_events: true,
      endpointing: config.sttEndpointing || 800,
      diarize: true,
    });

    stt.on(LiveTranscriptionEvents.Open, () => {
      state.sttReady = true;
      logger.info('STT connection opened', { sessionId, language: sttLanguage });
      checkAutoGreet();
    });

    stt.on(LiveTranscriptionEvents.Error, err => {
      logger.error('STT error', { sessionId, error: err.message });
    });

    stt.on(LiveTranscriptionEvents.Close, () => {
      state.sttReady = false;
      logger.info('STT connection closed', { sessionId });
    });

    stt.on(LiveTranscriptionEvents.Transcript, async (data) => {
      if (state.interviewEnded) return;
      if (Date.now() < state.sttPausedUntil) return;

      const transcript = data.channel?.alternatives?.[0]?.transcript || '';
      if (!transcript) return;

      // Accumulate transcript
      state.currentTranscript += ' ' + transcript;
      state.currentTranscript = state.currentTranscript.trim();

      // Process on speech_final or utterance_end
      if (data.is_final && data.speech_final) {
        await processUserTurn();
      }
    });

    stt.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
      if (state.currentTranscript.trim() && !state.isProcessingTurn) {
        await processUserTurn();
      }
    });

    // --- TTS Setup (Google Cloud) ---
    const tts = createGoogleTTSStream({
      language: sessionConfig.language,
      voice: languageConfig.ttsVoiceFemale,
      sampleRate: SAMPLE_RATE,
      gender: 'female',
    });

    tts.on('open', () => {
      state.ttsReady = true;
      logger.info('TTS connection opened', { sessionId });
      checkAutoGreet();
    });

    tts.on('audio', audioData => {
      const buffer = Buffer.from(audioData);
      if (buffer.length > 0) onAudio(buffer);
    });

    tts.on('flushed', () => {
      state.isBotSpeaking = false;
      // Echo cooldown
      const echoCooldownMs = sessionConfig.questionCount === 0 ? 2500 : 500;
      state.sttPausedUntil = Date.now() + echoCooldownMs;
      state.currentTranscript = '';
      logger.info('TTS flushed, echo cooldown active', { sessionId, cooldownMs: echoCooldownMs });

      if (state.pendingClose && !state.closingSent) {
        state.pendingClose = false;
        sendClosingMessage();
      }
    });

    tts.on('error', err => {
      logger.error('TTS error', { sessionId, error: err.message });
    });

    tts.on('close', () => {
      state.ttsReady = false;
      state.isBotSpeaking = false;
      logger.info('TTS connection closed', { sessionId });
    });

    // --- Helper Functions ---
    const checkAutoGreet = () => {
      if (sessionConfig.autoGreet && state.sttReady && state.ttsReady && !state.autoGreetTriggered) {
        triggerGreeting();
      }
    };

    const triggerGreeting = async () => {
      if (state.hasGreeted || state.autoGreetTriggered) return;
      state.autoGreetTriggered = true;
      state.hasGreeted = true;
      logger.info('Triggering greeting', { sessionId });

      try {
        state.isBotSpeaking = true;
        tts.sendText(sessionConfig.greeting);
        tts.flush();

        state.interviewTranscript.push({
          speaker: 'Interviewer',
          text: sessionConfig.greeting,
          timestamp_ms: Date.now() - state.sessionStartTime,
        });

        if (onTranscriptEntry) {
          onTranscriptEntry({ speaker: 'Interviewer', text: sessionConfig.greeting });
        }

        // Get first question from LLM
        state.conversationHistory.push({ role: 'user', content: 'Begin the interview. Ask the first question now.' });

        const stream = await deepseek.chat.completions.create({
          model: this.deepseekModel,
          messages: state.conversationHistory,
          max_tokens: 256,
          temperature: 0.3,
          stream: true,
        });

        let fullResponse = '';
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          fullResponse += content;
        }

        fullResponse = sanitizeForTTS(fullResponse.trim());
        if (fullResponse) {
          state.conversationHistory.push({ role: 'assistant', content: fullResponse });
          state.botResponseCount++;

          // Wait for greeting to finish before first question
          const greetingChars = sessionConfig.greeting.length;
          const waitMs = Math.min(Math.ceil(greetingChars * 60) + 500, 20000);
          await new Promise(r => setTimeout(r, waitMs));

          tts.sendText(fullResponse);
          tts.flush();

          state.interviewTranscript.push({
            speaker: 'Interviewer',
            text: fullResponse,
            timestamp_ms: Date.now() - state.sessionStartTime,
          });

          if (onTranscriptEntry) {
            onTranscriptEntry({ speaker: 'Interviewer', text: fullResponse });
          }
        }
      } catch (err) {
        logger.error('Error in greeting sequence', { sessionId, error: err.message });
      }
    };

    const processUserTurn = async () => {
      if (state.isProcessingTurn || state.interviewEnded) return;
      if (!state.currentTranscript.trim()) return;

      state.isProcessingTurn = true;
      const userText = state.currentTranscript.trim();
      state.currentTranscript = '';

      logger.info('Processing user turn', { sessionId, textLength: userText.length });

      // Trigger greeting if not yet done
      if (!state.hasGreeted) {
        state.isProcessingTurn = false;
        await triggerGreeting();
        return;
      }

      try {
        state.interviewTranscript.push({
          speaker: 'Candidate',
          text: userText,
          timestamp_ms: Date.now() - state.sessionStartTime,
        });

        if (onTranscriptEntry) {
          onTranscriptEntry({ speaker: 'Candidate', text: userText });
        }

        state.conversationHistory.push({ role: 'user', content: userText });

        // Check if we've asked all questions (fitment mode)
        if (sessionConfig.questionCount > 0 && state.botResponseCount >= sessionConfig.questionCount) {
          state.interviewEnded = true;
          // Acknowledge final answer then close
          const ackStream = await deepseek.chat.completions.create({
            model: this.deepseekModel,
            messages: [...state.conversationHistory, { role: 'user', content: 'Acknowledge this answer briefly, then say goodbye.' }],
            max_tokens: 128,
            temperature: 0.3,
            stream: true,
          });

          let ackResponse = '';
          for await (const chunk of ackStream) {
            ackResponse += chunk.choices[0]?.delta?.content || '';
          }

          ackResponse = sanitizeForTTS(ackResponse.trim());
          if (ackResponse) {
            state.isBotSpeaking = true;
            tts.sendText(ackResponse);
            tts.flush();

            state.interviewTranscript.push({
              speaker: 'Interviewer',
              text: ackResponse,
              timestamp_ms: Date.now() - state.sessionStartTime,
            });
          }

          // Schedule closing after acknowledgment
          setTimeout(sendClosingMessage, 5000);
          state.isProcessingTurn = false;
          return;
        }

        // Get next question from LLM
        const stream = await deepseek.chat.completions.create({
          model: this.deepseekModel,
          messages: state.conversationHistory,
          max_tokens: 256,
          temperature: 0.3,
          stream: true,
        });

        let fullResponse = '';
        for await (const chunk of stream) {
          fullResponse += chunk.choices[0]?.delta?.content || '';
        }

        fullResponse = sanitizeForTTS(fullResponse.trim());
        if (fullResponse) {
          state.conversationHistory.push({ role: 'assistant', content: fullResponse });
          state.botResponseCount++;
          state.isBotSpeaking = true;

          tts.sendText(fullResponse);
          tts.flush();

          state.interviewTranscript.push({
            speaker: 'Interviewer',
            text: fullResponse,
            timestamp_ms: Date.now() - state.sessionStartTime,
          });

          if (onTranscriptEntry) {
            onTranscriptEntry({ speaker: 'Interviewer', text: fullResponse });
          }
        }
      } catch (err) {
        logger.error('Error processing user turn', { sessionId, error: err.message });
      } finally {
        state.isProcessingTurn = false;
      }
    };

    const sendClosingMessage = () => {
      if (state.closingSent) return;
      state.closingSent = true;
      state.interviewEnded = true;

      logger.info('Sending closing message', { sessionId });

      state.isBotSpeaking = true;
      tts.sendText(sessionConfig.closing);
      tts.flush();

      state.interviewTranscript.push({
        speaker: 'Interviewer',
        text: sessionConfig.closing,
        timestamp_ms: Date.now() - state.sessionStartTime,
      });

      if (onTranscriptEntry) {
        onTranscriptEntry({ speaker: 'Interviewer', text: sessionConfig.closing });
      }

      // Schedule completion after closing plays
      if (!state.completionScheduled) {
        state.completionScheduled = true;
        setTimeout(() => {
          logger.info('Interview complete', { sessionId });
          if (onInterviewComplete) onInterviewComplete();
        }, 25000);
      }
    };

    // Session interface
    const session = {
      sessionId,

      /**
       * Push raw audio (16-bit PCM, 16kHz) from the candidate
       */
      pushAudio: (audioBuffer) => {
        if (state.sttReady && !state.interviewEnded) {
          stt.send(audioBuffer);
        }
      },

      /**
       * Close the session
       */
      close: () => {
        clearTimeout(durationTimer);
        try { stt.requestClose(); } catch (e) {}
        try { tts.requestClose(); } catch (e) {}
        this.activeSessions.delete(sessionId);
        logger.info('Session closed', { sessionId });
      },

      /**
       * Get the full transcript
       */
      getTranscript: () => [...state.interviewTranscript],

      /**
       * Get proctoring data
       */
      getProctoringData: () => ({
        secondarySpeakerEvents: [...state.secondarySpeakerEvents],
        participantEvents: [...state.participantEvents],
      }),
    };

    this.activeSessions.set(sessionId, session);
    return session;
  }

  /**
   * Get active session count
   */
  getActiveSessionCount() {
    return this.activeSessions.size;
  }

  /**
   * Close all active sessions
   */
  closeAllSessions() {
    for (const [sessionId, session] of this.activeSessions) {
      try {
        session.close();
      } catch (err) {
        logger.error('Error closing session', { sessionId, error: err.message });
      }
    }
  }
}

// Singleton instance
const interviewBrainService = new InterviewBrainService();

module.exports = interviewBrainService;
