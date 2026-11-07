/**
 * Phone Agent Service
 *
 * LiveKit Room transport adapter for PSTN calls.
 * Connects the candidate's SIP audio track to the interview brain and publishes the
 * brain's TTS audio back into the room (which LiveKit plays down the phone line).
 *
 * Key differences from Zoom/Attendee transport:
 * - Separate audio tracks (no mixed audio) — the bot never hears itself
 * - Always auto-greet (the bot opens as soon as the candidate answers)
 * - PCM via the LiveKit RTC SDK: AudioStream resamples the call to 16 kHz mono for STT,
 *   AudioSource takes the brain's 16 kHz mono TTS
 */

const {
  Room, RoomEvent, TrackKind, TrackSource, TrackPublishOptions,
  AudioSource, AudioStream, AudioFrame, LocalAudioTrack, AudioResampler,
} = require('@livekit/rtc-node');
const logger = require('../utils/logger');
const interviewBrain = require('./interviewBrain.service');
const telephonyService = require('./telephony.service');
const transcriptService = require('./transcript.service');

// Maximum concurrent phone calls (cost control)
const MAX_CONCURRENT_CALLS = parseInt(process.env.MAX_CONCURRENT_CALLS) || 3;

const INPUT_RATE = 16000;   // the brain's STT/TTS sample rate
const OUTPUT_RATE = 48000;  // LiveKit's native rate — publishing at this and resampling
                            // the TTS up to it avoids the crude internal resample that
                            // reached the phone as muffled audio
const OUT_FRAME_SAMPLES = OUTPUT_RATE / 50; // 20 ms frames at 48 kHz
const TRANSCRIPT_BACKUP_INTERVAL_MS = 60000;

// Barge-in (flag BARGE_IN=on, PSTN only — separate tracks make it feasible). When the
// candidate speaks over the bot, stop the bot's queued audio and interrupt the brain so
// their words become the next turn. Energy VAD runs on the candidate track, which here
// contains no bot audio. Thresholds are env-tunable since they depend on the phone line.
const BARGE_IN = String(process.env.BARGE_IN || '').toLowerCase() === 'on';
const BARGE_VAD_RMS = parseInt(process.env.BARGE_VAD_RMS) || 800;     // per-frame RMS above this = voiced
const BARGE_MIN_FRAMES = parseInt(process.env.BARGE_MIN_FRAMES) || 4; // net voiced frames (leaky) to fire a barge-in
const BARGE_RESUME_MS = parseInt(process.env.BARGE_RESUME_MS) || 600; // drop bot audio this long after a barge-in
const BARGE_DEBUG = String(process.env.BARGE_DEBUG || 'on').toLowerCase() === 'on'; // log candidate RMS while bot speaks (tuning)

class PhoneAgentService {
  constructor() {
    // Active calls: roomName -> { room, session, audioSource, ... }
    this.activeCalls = new Map();

    // Connection lifecycle (inactivity 10 min, as in the Zoom bot — 2 min cut off
    // candidates who paused to think)
    const maxDurationMinutes = parseInt(process.env.VOICE_AGENT_MAX_DURATION_MINUTES) || 35;
    const inactivityMinutes = parseInt(process.env.VOICE_AGENT_INACTIVITY_TIMEOUT_MINUTES) || 10;
    this.maxCallDurationMs = maxDurationMinutes * 60 * 1000;
    this.inactivityTimeoutMs = inactivityMinutes * 60 * 1000;
  }

  /**
   * Check if we can accept a new call
   */
  canAcceptCall() {
    return this.activeCalls.size < MAX_CONCURRENT_CALLS;
  }

  /**
   * Get current active call count
   */
  getActiveCallCount() {
    return this.activeCalls.size;
  }

  /**
   * Join a LiveKit room and start the interview once the candidate answers
   *
   * @param {Object} params
   * @param {string} params.roomName - LiveKit room name
   * @param {string} params.token - LiveKit access token
   * @param {string} params.livekitUrl - LiveKit server URL
   * @param {string} params.interviewId - Interview row id (transcript backups, hang-up)
   * @param {Object} params.interviewConfig - Session config (interviewBrain.buildSessionConfig)
   * @param {Function} params.onCallComplete - Callback when call ends
   * @returns {Promise<Object>} Call handle
   */
  async joinCall(params) {
    const { roomName, token, livekitUrl, interviewId, interviewConfig, onCallComplete } = params;

    if (!this.canAcceptCall()) {
      throw new Error(`Max concurrent calls reached (${MAX_CONCURRENT_CALLS})`);
    }

    logger.info('Joining LiveKit room for phone call', { roomName });

    const room = new Room();
    const call = {
      room,
      interviewId,
      session: null,          // set once the call is answered
      audioSource: null,
      audioStream: null,
      resampler: null,        // 16 kHz TTS -> 48 kHz for LiveKit
      candidateTrack: null,   // the SIP audio track, held until the call is answered
      sipParticipant: null,
      ended: false,
      playout: Promise.resolve(), // serialises frames into the AudioSource
      timers: [],
      inactivityTimer: null,
      metadata: {
        startTime: Date.now(),
        interviewConfig,
        status: 'waiting_for_answer',
      },
      onCallComplete,
    };

    const resetInactivityTimer = () => {
      if (call.inactivityTimer) clearTimeout(call.inactivityTimer);
      call.inactivityTimer = setTimeout(() => {
        logger.warn('Call inactivity timeout', { roomName });
        this.endCall(roomName, 'inactivity_timeout');
      }, this.inactivityTimeoutMs);
    };

    // Greet only once the SIP call is actually answered. LiveKit makes the candidate's
    // audio track subscribable while the phone is still RINGING, so starting on
    // TrackSubscribed talked over dead air and the candidate missed the opening. The
    // answer signal is the participant attribute sip.callStatus === 'active'.
    const startInterview = (reason) => {
      if (call.session || call.ended || !call.candidateTrack) return;
      call.metadata.status = 'in_progress';
      logger.info('Call answered — starting interview', { roomName, reason });

      call.session = interviewBrain.createSession(
        {
          ...interviewConfig,
          onInterviewComplete: () => {
            logger.info('Interview complete, ending call', { roomName });
            this.endCall(roomName, 'completed');
          },
        },
        (audioBuffer) => this.publishAudio(call, audioBuffer)
      );

      call.timers.push(setInterval(() => {
        transcriptService.backup(interviewId, call.session?.getTranscript());
      }, TRANSCRIPT_BACKUP_INTERVAL_MS));

      // AudioStream resamples the incoming call audio to 16 kHz mono PCM16 for STT
      call.audioStream = new AudioStream(call.candidateTrack, INPUT_RATE, 1);
      (async () => {
        for await (const frame of call.audioStream) {
          if (!call.session) break;
          resetInactivityTimer();
          const buf = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
          // Barge-in: candidate talking over the bot -> silence the bot + interrupt the brain.
          if (BARGE_IN && call.session.isBotSpeaking && call.session.isBotSpeaking()) {
            const rms = this._frameRms(frame);
            // Leaky voiced counter — tolerant of brief dips between syllables (a strict
            // consecutive count often never reaches the threshold on real speech).
            if (rms >= BARGE_VAD_RMS) {
              call.bargeVoiced = Math.min((call.bargeVoiced || 0) + 1, BARGE_MIN_FRAMES * 3);
            } else {
              call.bargeVoiced = Math.max((call.bargeVoiced || 0) - 1, 0);
            }
            // Tuning: log candidate RMS while the bot speaks (throttled), so the threshold
            // can be calibrated to this phone line. Turn off with BARGE_DEBUG=off.
            if (BARGE_DEBUG && rms > 150) {
              const now = Date.now();
              if (!call.lastRmsLog || now - call.lastRmsLog > 400) {
                call.lastRmsLog = now;
                logger.info('barge VAD', { rms: Math.round(rms), thr: BARGE_VAD_RMS, voiced: call.bargeVoiced });
              }
            }
            if (call.bargeVoiced >= BARGE_MIN_FRAMES) {
              call.bargeVoiced = 0;
              logger.info('Barge-in detected — stopping bot', { roomName, rms: Math.round(rms) });
              this._stopBotAudio(call);
              if (call.session.interrupt) call.session.interrupt();
            }
          } else {
            call.bargeVoiced = 0;
          }
          call.session.sendAudio(buf);
        }
      })().catch(err => logger.error('Error reading candidate audio', { roomName, error: err.message }));
      resetInactivityTimer();
    };

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      if (!participant.identity.startsWith('sip_')) return;
      call.sipParticipant = participant;
      call.candidateTrack = track;
      const status = participant.attributes?.['sip.callStatus'];
      logger.info('SIP audio track subscribed', { roomName, sipCallStatus: status || '(none)' });

      if (status === 'active') {
        startInterview('active-on-subscribe');
      } else {
        // Insurance: if the answer attribute never arrives but the call is up, start
        // anyway rather than sit silent. A real answer fires 'active' well before this.
        const t = setTimeout(() => startInterview('answer-fallback'), 20000);
        call.timers.push(t);
      }
    });

    room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
      if (!participant.identity.startsWith('sip_')) return;
      call.sipParticipant = participant;
      const status = participant.attributes?.['sip.callStatus'];
      logger.info('SIP call status changed', { roomName, sipCallStatus: status });
      if (status === 'active') startInterview('active');
      else if (status === 'hangup') this.endCall(roomName, 'candidate_hangup');
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant === call.sipParticipant) {
        logger.info('SIP participant disconnected (candidate hung up)', { roomName });
        this.endCall(roomName, 'candidate_hangup');
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      logger.info('Room disconnected', { roomName });
      this.endCall(roomName, 'room_disconnected');
    });

    // Connect to the room
    try {
      await room.connect(livekitUrl, token, { autoSubscribe: true, dynacast: true });
      logger.info('Connected to LiveKit room', { roomName });

      // The bot's voice: one persistent 48 kHz track the brain's TTS is resampled into
      call.audioSource = new AudioSource(OUTPUT_RATE, 1);
      call.resampler = new AudioResampler(INPUT_RATE, OUTPUT_RATE, 1);
      const track = LocalAudioTrack.createAudioTrack('interviewer', call.audioSource);
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      await room.localParticipant.publishTrack(track, options);

      this.activeCalls.set(roomName, call);

      // Hard cap: the interview's own length plus slack, never less than the env cap
      const interviewMs = (interviewConfig?.durationMinutes || 30) * 60 * 1000;
      call.timers.push(setTimeout(() => {
        if (this.activeCalls.has(roomName)) {
          logger.warn('Call max duration reached', { roomName });
          this.endCall(roomName, 'max_duration');
        }
      }, Math.max(this.maxCallDurationMs, interviewMs + 10 * 60 * 1000)));

      return {
        roomName,
        room,
        getSession: () => this.activeCalls.get(roomName)?.session,
      };
    } catch (err) {
      logger.error('Failed to connect to LiveKit room', { roomName, error: err.message });
      throw err;
    }
  }

  /**
   * Resample the brain's 16 kHz TTS up to 48 kHz and queue it into the room's
   * AudioSource in 20 ms frames. captureFrame paces playout in real time, so frames are
   * chained. Chunks are copied (slice), since the resampler reuses its output buffer.
   */
  publishAudio(call, audioBuffer) {
    if (!call.audioSource || !call.resampler) return;
    if (call.bargeInStop) return; // barge-in: don't queue new bot audio while stopped
    // Drop a trailing odd byte rather than misalign 16-bit samples
    const usable = audioBuffer.length - (audioBuffer.length % 2);
    if (usable <= 0) return;
    const in16 = new Int16Array(usable / 2);
    Buffer.from(in16.buffer).set(audioBuffer.subarray(0, usable));

    const outFrames = call.resampler.push(new AudioFrame(in16, INPUT_RATE, 1, in16.length));
    for (const frame of outFrames) {
      const s = frame.data;
      for (let offset = 0; offset < s.length; offset += OUT_FRAME_SAMPLES) {
        const chunk = s.slice(offset, Math.min(offset + OUT_FRAME_SAMPLES, s.length));
        call.playout = call.playout
          .then(() => call.audioSource && !call.bargeInStop && call.audioSource.captureFrame(new AudioFrame(chunk, OUTPUT_RATE, 1, chunk.length)))
          .catch(err => logger.error('Error publishing audio', { error: err.message }));
      }
    }
  }

  /** RMS energy of a candidate audio frame (Int16) — the VAD signal for barge-in. */
  _frameRms(frame) {
    const d = frame.data;
    if (!d || !d.length) return 0;
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    return Math.sqrt(sum / d.length);
  }

  /** Barge-in: immediately silence the bot. Stops new frames and skips the frames already
   *  queued in the real-time playout chain (so playback halts within ~one frame); re-enables
   *  output after BARGE_RESUME_MS so the next turn plays — the aborted turn's trailing synth
   *  is dropped in between. */
  _stopBotAudio(call) {
    call.bargeInStop = true;
    let cleared = false;
    try { if (call.audioSource && call.audioSource.clearQueue) { call.audioSource.clearQueue(); cleared = true; } } catch (e) { /* not all SDK versions */ }
    logger.info('Barge-in: stopped bot audio', { clearQueue: cleared });
    if (call.bargeResetTimer) clearTimeout(call.bargeResetTimer);
    call.bargeResetTimer = setTimeout(() => { call.bargeInStop = false; }, BARGE_RESUME_MS);
  }

  /**
   * End a call
   */
  async endCall(roomName, reason = 'unknown') {
    const call = this.activeCalls.get(roomName);
    if (!call) return;
    // Remove first so the room's own Disconnected event doesn't end it twice
    this.activeCalls.delete(roomName);
    call.ended = true; // stops a pending answer-fallback from starting a session on a dead call

    logger.info('Ending call', { roomName, reason });

    // Clear timers
    if (call.inactivityTimer) clearTimeout(call.inactivityTimer);
    if (call.bargeResetTimer) clearTimeout(call.bargeResetTimer);
    call.timers.forEach(t => { clearTimeout(t); clearInterval(t); });

    // Get final data before the session is closed
    const transcript = call.session?.getTranscript() || [];
    const proctoringData = call.session?.getProctoringData() || {};
    const duration = Date.now() - call.metadata.startTime;
    transcriptService.backup(call.interviewId, transcript);

    // Close interview session
    if (call.session) {
      try {
        call.session.close();
      } catch (err) {
        logger.error('Error closing session', { roomName, error: err.message });
      }
      call.session = null;
    }
    try { call.audioStream?.close(); } catch (e) { /* ignore */ }
    call.audioSource = null;
    call.resampler = null;

    // Hang up the phone line if the candidate is still on it
    if (reason !== 'candidate_hangup' && call.interviewId) {
      await telephonyService.hangupCall(roomName, telephonyService.candidateIdentity(call.interviewId))
        .catch(() => { /* already gone */ });
    }

    // Disconnect from room
    try {
      await call.room.disconnect();
    } catch (err) {
      logger.error('Error disconnecting from room', { roomName, error: err.message });
    }

    // Callback
    if (call.onCallComplete) {
      call.onCallComplete({
        roomName,
        reason,
        duration,
        transcript,
        proctoringData,
      });
    }
  }

  /**
   * Get call status
   */
  getCallStatus(roomName) {
    const call = this.activeCalls.get(roomName);
    if (!call) return null;

    return {
      roomName,
      status: call.metadata.status,
      duration: Date.now() - call.metadata.startTime,
      hasSession: !!call.session,
    };
  }

  /**
   * End all active calls
   */
  async endAllCalls(reason = 'shutdown') {
    const roomNames = [...this.activeCalls.keys()];
    for (const roomName of roomNames) {
      await this.endCall(roomName, reason);
    }
  }
}

// Singleton
const phoneAgentService = new PhoneAgentService();

module.exports = phoneAgentService;
