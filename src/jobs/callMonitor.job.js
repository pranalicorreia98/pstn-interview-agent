/**
 * Call Monitor Job
 *
 * Monitors active phone calls and handles:
 * - Detecting when calls are answered (AMD result)
 * - Detecting hung-up/failed calls
 * - Syncing call state with database
 * - Cleanup of stale calls
 *
 * Similar to botMonitor.job.js in clikhireBotIntegration.
 */

const logger = require('../utils/logger');
const databaseService = require('../services/database.service');
const telephonyService = require('../services/telephony.service');
const phoneAgentService = require('../services/phoneAgent.service');

// Call states that indicate the call has ended
const TERMINAL_STATES = ['completed', 'no_answer', 'busy', 'failed', 'voicemail'];

class CallMonitorJob {
  constructor() {
    this.intervalMs = 60 * 1000; // Run every minute
    this.intervalId = null;
    this.lastRunTime = null;

    // Timeout for calls stuck in 'dialing' state
    this.dialingTimeoutMs = 2 * 60 * 1000; // 2 minutes

    // Timeout for calls stuck in 'ringing' state
    this.ringingTimeoutMs = 60 * 1000; // 1 minute
  }

  /**
   * Start the monitor job
   */
  start() {
    if (this.intervalId) {
      logger.warn('Call monitor job already running');
      return;
    }

    logger.info('Starting call monitor job');

    // Run on interval (don't run immediately - let cron start calls first)
    this.intervalId = setInterval(() => {
      this.runCycle();
    }, this.intervalMs);
  }

  /**
   * Stop the monitor job
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Call monitor job stopped');
    }
  }

  /**
   * Get job status
   */
  getStatus() {
    return {
      running: !!this.intervalId,
      lastRunTime: this.lastRunTime,
    };
  }

  /**
   * Run a single monitor cycle
   */
  async runCycle() {
    this.lastRunTime = new Date().toISOString();

    try {
      // Get all interviews with active calls from database
      const activeInterviews = await databaseService.getActiveCallInterviews();

      if (activeInterviews.length === 0) {
        logger.debug('No active calls to monitor');
        return;
      }

      logger.info('Monitoring active calls', { count: activeInterviews.length });

      for (const interview of activeInterviews) {
        try {
          await this.checkCall(interview);
        } catch (err) {
          logger.error('Error checking call', {
            interviewId: interview.id,
            error: err.message,
          });
        }
      }
    } catch (err) {
      logger.error('Call monitor cycle error', { error: err.message });
    }
  }

  /**
   * Check status of a single call
   */
  async checkCall(interview) {
    const { id: interviewId, call_status: currentStatus, call_metadata, livekit_room_name: roomName } = interview;
    const sipParticipantId = call_metadata?.sip_participant_id;

    if (!sipParticipantId) {
      logger.warn('Interview missing SIP participant ID', { interviewId });
      return;
    }

    // Check if phone agent has this call active
    const localStatus = phoneAgentService.getCallStatus(roomName);

    // Get status from LiveKit
    let livekitStatus = null;
    try {
      livekitStatus = await telephonyService.getCallStatus(roomName, sipParticipantId);
    } catch (err) {
      // If we can't get status, the call may have ended
      logger.warn('Could not get LiveKit call status', {
        interviewId,
        error: err.message,
      });
    }

    // Handle based on current state
    switch (currentStatus) {
      case 'dialing':
        await this.handleDialingState(interview, livekitStatus, localStatus);
        break;

      case 'ringing':
        await this.handleRingingState(interview, livekitStatus, localStatus);
        break;

      case 'in_progress':
        await this.handleInProgressState(interview, livekitStatus, localStatus);
        break;

      default:
        logger.warn('Unknown call status', { interviewId, currentStatus });
    }
  }

  /**
   * Handle call in 'dialing' state
   */
  async handleDialingState(interview, livekitStatus, localStatus) {
    const { id: interviewId, call_metadata } = interview;
    const dialStarted = call_metadata?.dial_started_at;

    // Check for timeout
    if (dialStarted) {
      const dialDuration = Date.now() - new Date(dialStarted).getTime();
      if (dialDuration > this.dialingTimeoutMs) {
        logger.warn('Call stuck in dialing state, marking as failed', { interviewId });
        await databaseService.markCallFailed(interviewId, 'failed', 'Dialing timeout');
        await phoneAgentService.endCall(interview.livekit_room_name, 'dialing_timeout');
        return;
      }
    }

    // Check LiveKit status
    if (livekitStatus) {
      if (livekitStatus.status === 'in_progress') {
        // Call was answered
        logger.info('Call answered (detected from LiveKit)', { interviewId });
        await databaseService.markCallConnected(interviewId, livekitStatus.amdResult);
      } else if (TERMINAL_STATES.includes(livekitStatus.status)) {
        // Call ended during dialing
        logger.info('Call ended during dialing', {
          interviewId,
          status: livekitStatus.status,
          reason: livekitStatus.disconnectReason,
        });
        await databaseService.markCallFailed(interviewId, livekitStatus.status);
      }
    }
  }

  /**
   * Handle call in 'ringing' state
   */
  async handleRingingState(interview, livekitStatus, localStatus) {
    const { id: interviewId, call_metadata } = interview;
    const ringingStarted = call_metadata?.ringing_started_at;

    // Check for timeout
    if (ringingStarted) {
      const ringDuration = Date.now() - new Date(ringingStarted).getTime();
      if (ringDuration > this.ringingTimeoutMs) {
        logger.info('Call not answered within timeout', { interviewId });
        await databaseService.markCallFailed(interviewId, 'no_answer');
        await phoneAgentService.endCall(interview.livekit_room_name, 'no_answer');
        return;
      }
    }

    // Check if answered
    if (livekitStatus?.status === 'in_progress') {
      logger.info('Call answered (detected from ringing)', { interviewId });
      await databaseService.markCallConnected(interviewId, livekitStatus.amdResult);
    } else if (livekitStatus && TERMINAL_STATES.includes(livekitStatus.status)) {
      await databaseService.markCallFailed(interviewId, livekitStatus.status);
    }
  }

  /**
   * Handle call in 'in_progress' state
   */
  async handleInProgressState(interview, livekitStatus, localStatus) {
    const { id: interviewId, livekit_room_name: roomName } = interview;

    // Check if call ended on LiveKit side but we don't know yet
    if (livekitStatus && TERMINAL_STATES.includes(livekitStatus.status)) {
      logger.info('Call ended (detected from LiveKit)', {
        interviewId,
        status: livekitStatus.status,
      });

      // End local session if still active
      if (localStatus) {
        await phoneAgentService.endCall(roomName, livekitStatus.status);
      }

      // Don't update DB here - let phoneAgent.onCallComplete handle it
      return;
    }

    // Check if local session ended but DB not updated
    if (!localStatus && livekitStatus?.status !== 'in_progress') {
      logger.warn('Local session ended but call still marked in_progress', { interviewId });
      // This shouldn't happen normally - onCallComplete should update DB
      // Just log it for debugging
    }
  }
}

// Singleton
const callMonitorJob = new CallMonitorJob();

module.exports = callMonitorJob;
