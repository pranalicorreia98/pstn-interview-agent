/**
 * Google Cloud TTS Service
 *
 * Wrapper that provides a Deepgram-like interface for Google Cloud TTS.
 * Supports Indian regional languages: Hindi, Marathi, Telugu, Tamil, Kannada.
 *
 * Authentication:
 *   Option 1 (API Key): Set GOOGLE_TTS_API_KEY env var - uses REST API directly
 *   Option 2 (Service Account): Set GOOGLE_APPLICATION_CREDENTIALS env var
 *
 * Usage:
 *   const tts = new GoogleTTSStream(languageCode, voiceName, sampleRate);
 *   tts.on('open', () => console.log('Ready'));
 *   tts.on('audio', (buffer) => playAudio(buffer));
 *   tts.on('flushed', () => console.log('Done speaking'));
 *   tts.on('error', (err) => console.error(err));
 *   tts.on('close', () => console.log('Closed'));
 *
 *   await tts.connect();
 *   tts.sendText('Hello, how are you?');
 *   tts.flush();
 */

const { EventEmitter } = require('events');
const logger = require('../../utils/logger');

// Conditionally load the SDK - only needed when using service account auth
let TextToSpeechClient = null;
try {
  TextToSpeechClient = require('@google-cloud/text-to-speech').TextToSpeechClient;
} catch (e) {
  logger.info('Google Cloud TTS SDK not installed - will use REST API with API key');
}

// Language to voice mapping for Indian languages
const LANGUAGE_VOICE_MAP = {
  'en-IN': {
    voice: 'en-IN-Wavenet-D',      // Male
    voiceFemale: 'en-IN-Wavenet-A',
    languageCode: 'en-IN',
  },
  'hi-IN': {
    voice: 'hi-IN-Wavenet-D',      // Male
    voiceFemale: 'hi-IN-Wavenet-A',
    languageCode: 'hi-IN',
  },
  'mr-IN': {
    voice: 'mr-IN-Wavenet-B',      // Male
    voiceFemale: 'mr-IN-Wavenet-A',
    languageCode: 'mr-IN',
  },
  'te-IN': {
    voice: 'te-IN-Standard-B',     // Male (Wavenet not available)
    voiceFemale: 'te-IN-Standard-A',
    languageCode: 'te-IN',
  },
  'ta-IN': {
    voice: 'ta-IN-Wavenet-D',      // Male
    voiceFemale: 'ta-IN-Wavenet-A',
    languageCode: 'ta-IN',
  },
  'kn-IN': {
    voice: 'kn-IN-Wavenet-B',      // Male
    voiceFemale: 'kn-IN-Wavenet-A',
    languageCode: 'kn-IN',
  },
  'bn-IN': {
    voice: 'bn-IN-Wavenet-B',      // Male
    voiceFemale: 'bn-IN-Wavenet-A',
    languageCode: 'bn-IN',
  },
  'gu-IN': {
    voice: 'gu-IN-Wavenet-B',      // Male
    voiceFemale: 'gu-IN-Wavenet-A',
    languageCode: 'gu-IN',
  },
  'ml-IN': {
    voice: 'ml-IN-Wavenet-B',      // Male
    voiceFemale: 'ml-IN-Wavenet-A',
    languageCode: 'ml-IN',
  },
};

/**
 * GoogleTTSStream - Mimics Deepgram's LiveTTS interface
 *
 * Events emitted:
 *   - 'open': Connection ready (emitted after connect())
 *   - 'audio': Audio data buffer (LINEAR16 PCM)
 *   - 'flushed': All queued audio has been sent
 *   - 'error': Error occurred
 *   - 'close': Connection closed
 */
class GoogleTTSStream extends EventEmitter {
  constructor(languageCode = 'en-IN', voiceName = null, sampleRate = 16000) {
    super();

    // Resolve language config
    const langConfig = LANGUAGE_VOICE_MAP[languageCode] || LANGUAGE_VOICE_MAP['en-IN'];

    this.languageCode = langConfig.languageCode;
    this.voiceName = voiceName || langConfig.voice;
    this.sampleRate = sampleRate;

    this.client = null;
    this.apiKey = process.env.GOOGLE_TTS_API_KEY;
    this.useRestApi = !!this.apiKey; // Use REST API if API key is provided
    this.isConnected = false;
    this.pendingText = '';
    this.isSynthesizing = false;

    // Audio chunking settings (match Deepgram's ~100ms chunks)
    this.chunkSize = Math.floor(sampleRate * 0.1) * 2; // 100ms of 16-bit audio

    logger.info('GoogleTTSStream created', {
      languageCode: this.languageCode,
      voiceName: this.voiceName,
      sampleRate: this.sampleRate,
      authMethod: this.useRestApi ? 'API Key (REST)' : 'Service Account (SDK)',
    });
  }

  /**
   * Initialize the Google TTS client
   * Call this before sendText()
   */
  async connect() {
    try {
      if (this.useRestApi) {
        // Using REST API with API key - no client initialization needed
        logger.info('Google TTS using REST API with API key');
      } else if (TextToSpeechClient) {
        // Using SDK with service account credentials (GOOGLE_APPLICATION_CREDENTIALS)
        this.client = new TextToSpeechClient();
        logger.info('Google TTS using SDK with service account');
      } else {
        throw new Error('No authentication configured. Set GOOGLE_TTS_API_KEY or GOOGLE_APPLICATION_CREDENTIALS');
      }

      this.isConnected = true;
      logger.info('Google TTS client connected');

      // Emit 'open' event to match Deepgram interface
      // Use setImmediate to ensure event listeners are attached first
      setImmediate(() => {
        this.emit('open');
      });

      return true;
    } catch (error) {
      logger.error('Failed to connect Google TTS client', { error: error.message });
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Queue text for synthesis
   * Text is buffered until flush() is called
   */
  sendText(text) {
    if (!text || typeof text !== 'string') {
      return;
    }

    this.pendingText += text;
    logger.debug('Text queued for TTS', { textLength: text.length, totalPending: this.pendingText.length });
  }

  /**
   * Synthesize all pending text and emit audio chunks
   * Emits 'flushed' when complete
   */
  async flush() {
    if (!this.pendingText || this.isSynthesizing) {
      // Nothing to synthesize or already synthesizing
      if (!this.pendingText) {
        setImmediate(() => this.emit('flushed'));
      }
      return;
    }

    if (!this.isConnected) {
      logger.warn('Google TTS not connected, cannot flush');
      this.emit('error', new Error('TTS client not connected'));
      return;
    }

    // For REST API mode, we don't need a client object
    if (!this.useRestApi && !this.client) {
      logger.warn('Google TTS SDK client not initialized');
      this.emit('error', new Error('TTS SDK client not initialized'));
      return;
    }

    const textToSynthesize = this.pendingText;
    this.pendingText = '';
    this.isSynthesizing = true;

    // Timing: track TTS API call latency
    const ttsStartTime = Date.now();

    try {
      logger.info('Synthesizing speech', {
        textLength: textToSynthesize.length,
        text: textToSynthesize.substring(0, 100),
        voice: this.voiceName,
        authMethod: this.useRestApi ? 'REST API' : 'SDK',
      });

      let audioBuffer;

      if (this.useRestApi) {
        // Use REST API with API key
        audioBuffer = await this._synthesizeWithRestApi(textToSynthesize);
      } else {
        // Use SDK with service account
        audioBuffer = await this._synthesizeWithSdk(textToSynthesize);
      }

      const ttsEndTime = Date.now();
      const ttsLatencyMs = ttsEndTime - ttsStartTime;

      if (!audioBuffer || audioBuffer.length === 0) {
        throw new Error('No audio content in response');
      }

      logger.info('Speech synthesized', {
        audioBytes: audioBuffer.length,
        durationMs: Math.round((audioBuffer.length / 2) / this.sampleRate * 1000),
        apiLatencyMs: ttsLatencyMs,
      });

      // Emit audio in chunks to match Deepgram's streaming behavior
      // This provides smoother playback and allows for interruption
      for (let i = 0; i < audioBuffer.length; i += this.chunkSize) {
        const chunk = audioBuffer.slice(i, Math.min(i + this.chunkSize, audioBuffer.length));
        this.emit('audio', chunk);

        // Small delay between chunks to simulate streaming
        // This prevents buffer overflow and allows for interruption handling
        if (i + this.chunkSize < audioBuffer.length) {
          await this._sleep(10);
        }
      }

      this.isSynthesizing = false;
      this.emit('flushed');

    } catch (error) {
      this.isSynthesizing = false;
      logger.error('Google TTS synthesis failed', {
        error: error.message,
        code: error.code,
      });
      this.emit('error', error);
    }
  }

  /**
   * Synthesize speech using Google Cloud TTS REST API with API key
   * @private
   */
  async _synthesizeWithRestApi(text) {
    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${this.apiKey}`;

    const requestBody = {
      input: { text },
      voice: {
        languageCode: this.languageCode,
        name: this.voiceName,
      },
      audioConfig: {
        audioEncoding: 'LINEAR16',
        sampleRateHertz: this.sampleRate,
        speakingRate: 1.0,
        pitch: 0.0,
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google TTS API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    if (!data.audioContent) {
      throw new Error('No audioContent in API response');
    }

    // audioContent is base64 encoded
    return Buffer.from(data.audioContent, 'base64');
  }

  /**
   * Synthesize speech using Google Cloud TTS SDK with service account
   * @private
   */
  async _synthesizeWithSdk(text) {
    const request = {
      input: { text },
      voice: {
        languageCode: this.languageCode,
        name: this.voiceName,
      },
      audioConfig: {
        audioEncoding: 'LINEAR16',
        sampleRateHertz: this.sampleRate,
        speakingRate: 1.0,
        pitch: 0.0,
      },
    };

    const [response] = await this.client.synthesizeSpeech(request);
    return Buffer.from(response.audioContent);
  }

  /**
   * Close the TTS connection
   */
  requestClose() {
    logger.info('Closing Google TTS stream');
    this.isConnected = false;
    this.pendingText = '';

    // Only close SDK client if using service account auth
    if (this.client && !this.useRestApi) {
      this.client.close().catch(err => {
        logger.warn('Error closing TTS client', { error: err.message });
      });
      this.client = null;
    }

    this.emit('close');
  }

  /**
   * Get available voices for a language
   */
  async listVoices(languageCode = null) {
    try {
      if (this.useRestApi) {
        // Use REST API with API key
        let url = `https://texttospeech.googleapis.com/v1/voices?key=${this.apiKey}`;
        if (languageCode) {
          url += `&languageCode=${languageCode}`;
        }

        const response = await fetch(url);
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Google TTS API error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        return (data.voices || []).map(voice => ({
          name: voice.name,
          languageCodes: voice.languageCodes,
          ssmlGender: voice.ssmlGender,
          naturalSampleRateHertz: voice.naturalSampleRateHertz,
        }));
      } else {
        // Use SDK with service account
        if (!this.client) {
          await this.connect();
        }

        const [result] = await this.client.listVoices({
          languageCode: languageCode,
        });

        return result.voices.map(voice => ({
          name: voice.name,
          languageCodes: voice.languageCodes,
          ssmlGender: voice.ssmlGender,
          naturalSampleRateHertz: voice.naturalSampleRateHertz,
        }));
      }
    } catch (error) {
      logger.error('Failed to list voices', { error: error.message });
      throw error;
    }
  }

  /**
   * Helper: sleep for ms milliseconds
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Factory function to create a Google TTS stream
 * Matches the pattern used by Deepgram: deepgram.speak.live({...})
 */
function createGoogleTTSStream(options = {}) {
  const {
    language = 'en-IN',
    voice = null,
    sampleRate = 16000,
    gender = 'male', // 'male' or 'female'
  } = options;

  const langConfig = LANGUAGE_VOICE_MAP[language] || LANGUAGE_VOICE_MAP['en-IN'];
  const voiceName = voice || (gender === 'female' ? langConfig.voiceFemale : langConfig.voice);

  const stream = new GoogleTTSStream(language, voiceName, sampleRate);

  // Auto-connect (Deepgram auto-connects)
  stream.connect().catch(err => {
    logger.error('Auto-connect failed', { error: err.message });
  });

  return stream;
}

module.exports = {
  GoogleTTSStream,
  createGoogleTTSStream,
  LANGUAGE_VOICE_MAP,
};
