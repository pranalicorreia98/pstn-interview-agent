/**
 * Telephony Service
 *
 * Handles outbound PSTN calls via LiveKit SIP with Vobiz as the SIP trunk provider.
 *
 * Vobiz provides:
 * - India-native SIP trunking with DLT/TRAI compliance built-in
 * - ₹0.45/min for India calls
 * - Sub-80ms latency
 * - Instant SIP trunks with Airtel, Jio, VIL
 *
 * Setup flow:
 * 1. Create Vobiz account and SIP trunk
 * 2. Configure trunk in LiveKit with Vobiz credentials
 * 3. Use trunk ID here for outbound calls
 */

const { AccessToken, SipClient, RoomServiceClient } = require('livekit-server-sdk');
const logger = require('../utils/logger');

// LiveKit reports an outbound SIP call's progress in this participant attribute
// (livekit-server-sdk 2.x has no getSipParticipant / deleteSipParticipant).
const SIP_CALL_STATUS = {
  dialing: 'dialing',
  ringing: 'ringing',
  active: 'in_progress',
  hangup: 'completed',
};

class TelephonyService {
  constructor() {
    // LiveKit configuration
    this.livekitUrl = process.env.LIVEKIT_URL;
    this.apiKey = process.env.LIVEKIT_API_KEY;
    this.apiSecret = process.env.LIVEKIT_API_SECRET;
    this.sipTrunkId = process.env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID;

    // Vobiz configuration (for reference/validation)
    this.vobizSipDomain = process.env.VOBIZ_SIP_DOMAIN; // e.g., your_domain.sip.vobiz.ai
    this.vobizCallerId = process.env.VOBIZ_CALLER_ID;   // Your Vobiz phone number

    // Business hours config (India timezone default)
    // TRAI compliance: Commercial calls only during business hours
    this.businessHoursStart = parseInt(process.env.BUSINESS_HOURS_START) || 9;
    this.businessHoursEnd = parseInt(process.env.BUSINESS_HOURS_END) || 21;
    this.timezone = process.env.BUSINESS_HOURS_TIMEZONE || 'Asia/Kolkata';

    // How long the candidate's phone rings before LiveKit gives up (seconds)
    this.ringingTimeoutSeconds = parseInt(process.env.CALL_RINGING_TIMEOUT_SECONDS) || 45;

    this.sipClient = null;
    this.roomService = null;
  }

  /**
   * Check if service is configured
   */
  isConfigured() {
    return !!(this.livekitUrl && this.apiKey && this.apiSecret && this.sipTrunkId);
  }

  /**
   * Check if Vobiz is configured
   */
  isVobizConfigured() {
    return !!(this.vobizSipDomain);
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
    this.roomService = new RoomServiceClient(this.livekitUrl, this.apiKey, this.apiSecret);

    logger.info('Telephony service initialized', {
      livekitUrl: this.livekitUrl,
      vobizConfigured: this.isVobizConfigured(),
      vobizDomain: this.vobizSipDomain ? `${this.vobizSipDomain.slice(0, 10)}...` : 'not set',
    });

    return true;
  }

  /**
   * Check if current time is within business hours
   * Required for TRAI compliance in India
   */
  isWithinBusinessHours() {
    const now = new Date();
    // Get current hour in target timezone
    const options = { timeZone: this.timezone, hour: 'numeric', hour12: false };
    const hour = parseInt(new Intl.DateTimeFormat('en-US', options).format(now));

    const withinHours = hour >= this.businessHoursStart && hour < this.businessHoursEnd;

    if (!withinHours) {
      logger.debug('Outside business hours', {
        currentHour: hour,
        timezone: this.timezone,
        allowedRange: `${this.businessHoursStart}:00 - ${this.businessHoursEnd}:00`,
      });
    }

    return withinHours;
  }

  /**
   * Generate a room name for an interview
   */
  generateRoomName(interviewId) {
    return `interview-${interviewId}`;
  }

  /**
   * Identity of the candidate's SIP participant in the room
   */
  candidateIdentity(interviewId) {
    return `sip_${interviewId}`;
  }

  /**
   * Generate an access token for joining a room (toJwt() is async in server-sdk 2.x)
   */
  async generateAccessToken(roomName, participantIdentity = 'interview-bot') {
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
   * Place an outbound call to a candidate via Vobiz SIP trunk
   *
   * @param {Object} params
   * @param {string} params.interviewId - Interview record ID
   * @param {string} params.phoneNumber - Candidate's phone number (E.164 format)
   * @param {string} params.callerIdNumber - Optional caller ID (defaults to VOBIZ_CALLER_ID)
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

    // Validate India number format if calling India
    if (phoneNumber.startsWith('+91') && phoneNumber.length !== 13) {
      logger.warn('Invalid India phone number length', {
        phoneNumber: `${phoneNumber.slice(0, 6)}****`,
        length: phoneNumber.length,
        expected: 13,
      });
    }

    // Check business hours (TRAI compliance)
    if (!this.isWithinBusinessHours()) {
      throw new Error('Outside business hours - calls not allowed (TRAI compliance)');
    }

    const roomName = this.generateRoomName(interviewId);
    const callerId = callerIdNumber || this.vobizCallerId;

    logger.info('Placing outbound call via Vobiz', {
      interviewId,
      roomName,
      phoneNumber: `${phoneNumber.slice(0, 6)}****`, // Log partial number
      callerId: callerId ? `${callerId.slice(0, 6)}****` : 'default',
    });

    try {
      // Create SIP participant (places the outbound call via the Vobiz trunk). Returns
      // as soon as dialing starts; answer/hang-up arrive as the sip.callStatus attribute.
      const sipParticipant = await this.sipClient.createSipParticipant(
        this.sipTrunkId,
        phoneNumber,
        roomName,
        {
          participantIdentity: this.candidateIdentity(interviewId),
          participantName: 'Candidate',
          ...(callerId && { fromNumber: callerId }),
          ringingTimeout: this.ringingTimeoutSeconds,
          krispEnabled: true, // noise cancellation on the candidate's line
        }
      );

      logger.info('SIP participant created, call initiated via Vobiz', {
        roomName,
        sipParticipantId: sipParticipant.participantId,
        sipCallId: sipParticipant.sipCallId,
      });

      return {
        roomName,
        sipParticipantId: sipParticipant.participantId,
        participantIdentity: sipParticipant.participantIdentity,
        callStatus: 'dialing',
      };
    } catch (err) {
      logger.error('Failed to place call via Vobiz', {
        interviewId,
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * Get call status from LiveKit: the SIP participant's sip.callStatus attribute.
   * A participant that is no longer in the room has hung up (or never connected).
   *
   * @param {string} roomName - The room name
   * @param {string} participantIdentity - The SIP participant's identity (sip_<interviewId>)
   */
  async getCallStatus(roomName, participantIdentity) {
    if (!this.roomService) {
      throw new Error('Telephony service not initialized');
    }

    let participant;
    try {
      participant = await this.roomService.getParticipant(roomName, participantIdentity);
    } catch (err) {
      if (err.status === 404 || /not.?found|does not exist/i.test(err.message)) {
        return { roomName, participantIdentity, status: 'completed', disconnectReason: 'participant_gone' };
      }
      logger.error('Failed to get call status', { roomName, error: err.message });
      throw err;
    }

    const sipStatus = participant.attributes?.['sip.callStatus'];
    return {
      roomName,
      participantIdentity,
      status: SIP_CALL_STATUS[sipStatus] || 'unknown',
      sipStatus,
      disconnectReason: participant.disconnectReason,
    };
  }

  /**
   * Hang up a call (removing the SIP participant ends the phone call)
   */
  async hangupCall(roomName, participantIdentity) {
    if (!this.roomService) {
      throw new Error('Telephony service not initialized');
    }

    try {
      await this.roomService.removeParticipant(roomName, participantIdentity);
      logger.info('Call hung up', { roomName, participantIdentity });
    } catch (err) {
      logger.error('Failed to hang up call', { roomName, error: err.message });
      throw err;
    }
  }

  /**
   * List outbound SIP trunks (for debugging)
   */
  async listTrunks() {
    if (!this.sipClient) {
      throw new Error('Telephony service not initialized');
    }

    try {
      const trunks = await this.sipClient.listSipOutboundTrunk();
      return trunks;
    } catch (err) {
      logger.error('Failed to list SIP trunks', { error: err.message });
      throw err;
    }
  }

  /**
   * Create outbound trunk in LiveKit with Vobiz credentials
   *
   * This is typically done once during setup, not per-call.
   * You can also do this via the LiveKit dashboard.
   *
   * @param {Object} vobizCredentials
   * @param {string} vobizCredentials.sipDomain - e.g., your_domain.sip.vobiz.ai
   * @param {string} vobizCredentials.username - Vobiz username
   * @param {string} vobizCredentials.password - Vobiz password
   * @param {string} vobizCredentials.phoneNumber - Your Vobiz phone number
   */
  async createVobizTrunk(vobizCredentials) {
    if (!this.sipClient) {
      throw new Error('Telephony service not initialized');
    }

    const { sipDomain, username, password, phoneNumber } = vobizCredentials;

    try {
      const trunk = await this.sipClient.createSipOutboundTrunk(
        'Vobiz India Trunk',
        sipDomain,
        [phoneNumber],
        { authUsername: username, authPassword: password }
      );

      logger.info('Vobiz trunk created in LiveKit', {
        trunkId: trunk.sipTrunkId,
        name: trunk.name,
      });

      return trunk;
    } catch (err) {
      logger.error('Failed to create Vobiz trunk', { error: err.message });
      throw err;
    }
  }
}

// Singleton
const telephonyService = new TelephonyService();

module.exports = telephonyService;
