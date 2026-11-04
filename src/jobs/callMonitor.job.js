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
const transcriptService = require('../services/transcript.service');

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

    // Before the no-active-calls return: missing transcripts matter most when nothing
    // is live (e.g. right after a restart)
    await transcriptService.recoverMissingTranscripts()
      .catch(err => logger.error('Transcript recovery sweep failed', { error: err.message }));

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
   * Orphan cleanup for one in-progress PSTN interview.
   *
   * The live lifecycle (answer, hang-up, no-answer, ring/max-duration timeouts) is driven
   * by the phone agent's own LiveKit events — so a call this process is actively running is
   * left alone. This sweep only catches rows left 'in_progress' with no live call (e.g. the
   * agent restarted mid-call): once such a row is clearly past when it should have finished,
   * it's marked failed so it doesn't sit stuck forever.
   */
  async checkCall(interview) {
    const interviewId = interview.id;
    let botConfig = interview.bot_config || {};
    if (typeof botConfig === 'string') { try { botConfig = JSON.parse(botConfig); } catch (e) { botConfig = {}; } }

    const roomName = telephonyService.generateRoomName(interviewId);
    if (phoneAgentService.getCallStatus(roomName)) return; // live here — the agent owns it

    const startedAt = botConfig._call?.dial_started_at || interview.bot_updated_at || interview.scheduled_for;
    const ageMs = Date.now() - new Date(startedAt).getTime();
    const maxMs = ((parseInt(interview.duration_minutes, 10) || 10) + 5) * 60 * 1000;
    if (ageMs > maxMs) {
      logger.warn('Orphaned in_progress PSTN interview — marking failed', {
        interviewId, ageMinutes: Math.round(ageMs / 60000),
      });
      await databaseService.markCallFailed(interviewId, 'failed', 'Call did not complete (agent restart or lost connection)');
      await phoneAgentService.endCall(roomName, 'orphan_cleanup').catch(() => {});
    }
  }
}

// Singleton
const callMonitorJob = new CallMonitorJob();

module.exports = callMonitorJob;
