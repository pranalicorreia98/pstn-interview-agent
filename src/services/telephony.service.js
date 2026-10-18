/**
 * Telephony Service
 *
 * Handles outbound PSTN calls via LiveKit SIP.
 * Creates SIP participants in LiveKit rooms to dial candidates.
 */

const { AccessToken, SipClient } = require('livekit-server-sdk');
const logger = require('../utils/logger');

class TelephonyService {
  constructor() {
    this.livekitUrl = process.env.LIVEKIT_URL;
    this.apiKey = process.env.LIVEKIT_API_KEY;
    this.apiSecret = process.env.LIVEKIT_API_SECRET;
    this.sipTrunkId = process.env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID;

    // Business hours config (India timezone default)
    this.businessHoursStart = parseInt(process.env.BUSINESS_HOURS_START) || 9;
    this.businessHoursEnd = parseInt(process.env.BUSINESS_HOURS_END) || 21;
    this.timezone = process.env.BUSINESS_HOURS_TIMEZONE || 'Asia/Kolkata';

    this.sipClient = null;
  }

  /**
   * Check if service is configured
   */
  isConfigured() {
    return !!(this.livekitUrl && this.apiKey && this.apiSecret && this.sipTrunkId);
  }

  /**
   * Initialize SIP client
   */
  initialize() {
    if (!this.isConfigured()) {
      logger.warn('Telephony service not configured - missing LiveKit credentials');
      return false;
    }

    this.sipClient = new SipClient(this.livekitUrl, this.apiKey, this.apiSecret);
    logger.info('Telephony service initialized', { livekitUrl: this.livekitUrl });
    return true;
  }

  /**
   * Check if current time is within business hours
   */
  isWithinBusinessHours() {
    const now = new Date();
    // Get current hour in target timezone
    const options = { timeZone: this.timezone, hour: 'numeric', hour12: false };
    const hour = parseInt(new Intl.DateTimeFormat('en-US', options).format(now));

    return hour >= this.businessHoursStart && hour < this.businessHoursEnd;
  }

  /**
   * Generate a room name for an interview
   */
  generateRoomName(interviewId) {
    return `interview-${interviewId}`;
  }

  /**
   * Generate an access token for joining a room
   */
  generateAccessToken(roomName, participantIdentity = 'interview-bot') {
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: participantIdentity,
    });

    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    return token.toJwt();
  }

  /**
   * Place an outbound call to a candidate
   *
   * @param {Object} params
   * @param {string} params.interviewId - Interview record ID
   * @param {string} params.phoneNumber - Candidate's phone number (E.164 format)
   * @param {string} params.callerIdNumber - Optional caller ID to display
   * @returns {Promise<Object>} Call info { roomName, sipParticipantId }
   */
  async placeCall(params) {
    const { interviewId, phoneNumber, callerIdNumber } = params;

    if (!this.sipClient) {
      throw new Error('Telephony service not initialized');
    }

    // Validate phone number format (should be E.164)
    if (!phoneNumber.startsWith('+')) {
      throw new Error('Phone number must be in E.164 format (e.g., +919876543210)');
    }

    // Check business hours
    if (!this.isWithinBusinessHours()) {
      throw new Error('Outside business hours - calls not allowed');
    }

    const roomName = this.generateRoomName(interviewId);

    logger.info('Placing outbound call', {
      interviewId,
      roomName,
      phoneNumber: `${phoneNumber.slice(0, 6)}****`, // Log partial number
    });

    try {
      // Create SIP participant (places the outbound call)
      const sipParticipant = await this.sipClient.createSipParticipant({
        sipTrunkId: this.sipTrunkId,
        sipCallTo: phoneNumber,
        roomName: roomName,
        participantIdentity: `sip_${interviewId}`,
        participantName: 'Candidate',
        // Answering Machine Detection
        enableAnsweringMachineDetection: true,
        answeringMachineDetectionTimeout: 30, // seconds
        // Optional caller ID
        ...(callerIdNumber && {
          sipHeaders: {
            'P-Asserted-Identity': `<sip:${callerIdNumber}@trunk>`,
          },
        }),
      });

      logger.info('SIP participant created, call initiated', {
        roomName,
        sipParticipantId: sipParticipant.sipParticipantId,
      });

      return {
        roomName,
        sipParticipantId: sipParticipant.sipParticipantId,
        callStatus: 'dialing',
      };
    } catch (err) {
      logger.error('Failed to place call', {
        interviewId,
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * Get call status from LiveKit
   *
   * @param {string} roomName - The room name
   * @param {string} sipParticipantId - The SIP participant ID
   */
  async getCallStatus(roomName, sipParticipantId) {
    if (!this.sipClient) {
      throw new Error('Telephony service not initialized');
    }

    try {
      const participant = await this.sipClient.getSipParticipant(sipParticipantId);

      // Map LiveKit SIP status to our status values
      const statusMap = {
        'JOINING': 'dialing',
        'ACTIVE': 'in_progress',
        'DISCONNECTED': 'completed',
        'FAILED': 'failed',
      };

      return {
        roomName,
        sipParticipantId,
        status: statusMap[participant.state] || 'unknown',
        amdResult: participant.amdResult, // 'human', 'machine', or 'unknown'
        disconnectReason: participant.disconnectReason,
      };
    } catch (err) {
      logger.error('Failed to get call status', { roomName, error: err.message });
      throw err;
    }
  }

  /**
   * Hang up a call
   */
  async hangupCall(sipParticipantId) {
    if (!this.sipClient) {
      throw new Error('Telephony service not initialized');
    }

    try {
      await this.sipClient.deleteSipParticipant(sipParticipantId);
      logger.info('Call hung up', { sipParticipantId });
    } catch (err) {
      logger.error('Failed to hang up call', { sipParticipantId, error: err.message });
      throw err;
    }
  }

  /**
   * List active SIP trunks
   */
  async listTrunks() {
    if (!this.sipClient) {
      throw new Error('Telephony service not initialized');
    }

    try {
      const trunks = await this.sipClient.listSipTrunks();
      return trunks;
    } catch (err) {
      logger.error('Failed to list SIP trunks', { error: err.message });
      throw err;
    }
  }
}

// Singleton
const telephonyService = new TelephonyService();

module.exports = telephonyService;
