/**
 * Phone Agent Service
 *
 * LiveKit Room transport adapter for PSTN calls.
 * Connects LiveKit SIP audio tracks to the interview brain.
 *
 * Key differences from Zoom/Attendee transport:
 * - Separate audio tracks (no mixed audio) - barge-in becomes possible
 * - Always auto-greet (no waiting room concept on phone)
 * - Direct PCM audio via LiveKit RTC SDK
 */

const { Room, RoomEvent, TrackSource, AudioFrame } = require('@livekit/rtc-node');
const logger = require('../utils/logger');
const interviewBrain = require('./interviewBrain.service');

// Maximum concurrent phone calls (cost control)
const MAX_CONCURRENT_CALLS = parseInt(process.env.MAX_CONCURRENT_CALLS) || 3;

class PhoneAgentService {
  constructor() {
    // Active calls: roomName -> { room, session, metadata }
    this.activeCalls = new Map();

    // Connection lifecycle
    const maxDurationMinutes = parseInt(process.env.VOICE_AGENT_MAX_DURATION_MINUTES) || 35;
    const inactivityMinutes = parseInt(process.env.VOICE_AGENT_INACTIVITY_TIMEOUT_MINUTES) || 2;
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
   * Join a LiveKit room and start the interview
   *
   * @param {Object} params
   * @param {string} params.roomName - LiveKit room name
   * @param {string} params.token - LiveKit access token
   * @param {string} params.livekitUrl - LiveKit server URL
   * @param {Object} params.interviewConfig - Interview configuration
   * @param {Function} params.onCallComplete - Callback when call ends
   * @returns {Promise<Object>} Call handle
   */
  async joinCall(params) {
    const { roomName, token, livekitUrl, interviewConfig, onCallComplete } = params;

    if (!this.canAcceptCall()) {
      throw new Error(`Max concurrent calls reached (${MAX_CONCURRENT_CALLS})`);
    }

    logger.info('Joining LiveKit room for phone call', { roomName });

    const room = new Room();
    let session = null;
    let sipParticipant = null;
    let inactivityTimer = null;

    const resetInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        logger.warn('Call inactivity timeout', { roomName });
        this.endCall(roomName, 'inactivity_timeout');
      }, this.inactivityTimeoutMs);
    };

    // Track participant audio
    room.on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
      // Only care about audio from the SIP participant (the candidate)
      if (track.source !== TrackSource.Microphone) return;
      if (!participant.identity.startsWith('sip_')) return;

      sipParticipant = participant;
      logger.info('Subscribed to SIP participant audio', {
        roomName,
        participantId: participant.identity,
      });

      // Create interview session when we get the candidate's audio
      session = interviewBrain.createSession(
        {
          sessionId: `phone-${roomName}`,
          autoGreet: true, // Always auto-greet on phone
          ...interviewConfig,
        },
        {
          onAudio: (audioBuffer) => {
            // Publish audio back to the room
            this.publishAudio(room, audioBuffer);
          },
          onTranscriptEntry: (entry) => {
            resetInactivityTimer();
            logger.debug('Transcript entry', { roomName, ...entry });
          },
          onInterviewComplete: () => {
            logger.info('Interview complete, ending call', { roomName });
            this.endCall(roomName, 'completed');
          },
        }
      );

      // Start processing audio from the track
      track.on('audio_frame', (frame) => {
        if (session) {
          resetInactivityTimer();
          // Convert AudioFrame to Buffer and push to session
          const audioBuffer = Buffer.from(frame.data.buffer);
          session.pushAudio(audioBuffer);
        }
      });
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant === sipParticipant) {
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
      await room.connect(livekitUrl, token);
      logger.info('Connected to LiveKit room', { roomName });

      // Store call metadata
      this.activeCalls.set(roomName, {
        room,
        session: null, // Will be set when SIP participant joins
        metadata: {
          startTime: Date.now(),
          interviewConfig,
          status: 'waiting_for_answer',
        },
        inactivityTimer,
        onCallComplete,
      });

      // Max duration timer
      setTimeout(() => {
        if (this.activeCalls.has(roomName)) {
          logger.warn('Call max duration reached', { roomName });
          this.endCall(roomName, 'max_duration');
        }
      }, this.maxCallDurationMs);

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
   * Publish audio to the LiveKit room
   */
  async publishAudio(room, audioBuffer) {
    try {
      // Create an audio frame from the buffer
      // The interview brain sends 16-bit PCM at 16kHz
      const frame = new AudioFrame(
        audioBuffer,
        16000, // sample rate
        1,     // channels (mono)
        audioBuffer.length / 2 // samples per channel (16-bit = 2 bytes per sample)
      );

      // Publish via local audio track
      // Note: In production, you'd maintain a persistent local audio track
      // and push frames to it. This is simplified for illustration.
      if (room.localParticipant) {
        const audioSource = room.localParticipant.audioTrackPublications.values().next().value;
        if (audioSource) {
          // Push audio frame to the track
          // Implementation depends on LiveKit SDK version
        }
      }
    } catch (err) {
      logger.error('Error publishing audio', { error: err.message });
    }
  }

  /**
   * End a call
   */
  async endCall(roomName, reason = 'unknown') {
    const call = this.activeCalls.get(roomName);
    if (!call) return;

    logger.info('Ending call', { roomName, reason });

    // Clear timers
    if (call.inactivityTimer) {
      clearTimeout(call.inactivityTimer);
    }

    // Close interview session
    if (call.session) {
      try {
        call.session.close();
      } catch (err) {
        logger.error('Error closing session', { roomName, error: err.message });
      }
    }

    // Disconnect from room
    try {
      await call.room.disconnect();
    } catch (err) {
      logger.error('Error disconnecting from room', { roomName, error: err.message });
    }

    // Get final data before cleanup
    const transcript = call.session?.getTranscript() || [];
    const proctoringData = call.session?.getProctoringData() || {};
    const duration = Date.now() - call.metadata.startTime;

    // Remove from active calls
    this.activeCalls.delete(roomName);

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
