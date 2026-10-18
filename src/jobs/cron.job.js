/**
 * Cron Job
 *
 * Polls for scheduled phone interviews and initiates outbound calls.
 * Runs every N minutes (configurable via CRON_INTERVAL_MINUTES).
 */

const logger = require('../utils/logger');
const databaseService = require('../services/database.service');
const telephonyService = require('../services/telephony.service');
const phoneAgentService = require('../services/phoneAgent.service');

class CronJob {
  constructor() {
    this.intervalMinutes = parseInt(process.env.CRON_INTERVAL_MINUTES) || 1;
    this.intervalId = null;
    this.isRunning = false;
    this.lastRunTime = null;
  }

  /**
   * Start the cron job
   */
  start() {
    if (this.intervalId) {
      logger.warn('Cron job already running');
      return;
    }

    logger.info('Starting cron job', { intervalMinutes: this.intervalMinutes });

    // Run immediately on start
    this.runCycle();

    // Then run on interval
    this.intervalId = setInterval(() => {
      this.runCycle();
    }, this.intervalMinutes * 60 * 1000);
  }

  /**
   * Stop the cron job
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Cron job stopped');
    }
  }

  /**
   * Get job status
   */
  getStatus() {
    return {
      running: !!this.intervalId,
      intervalMinutes: this.intervalMinutes,
      lastRunTime: this.lastRunTime,
      activeCallCount: phoneAgentService.getActiveCallCount(),
    };
  }

  /**
   * Run a single cron cycle
   */
  async runCycle() {
    if (this.isRunning) {
      logger.debug('Skipping cron cycle - previous cycle still running');
      return;
    }

    this.isRunning = true;
    this.lastRunTime = new Date().toISOString();

    try {
      logger.debug('Running cron cycle');

      // Check if telephony is configured
      if (!telephonyService.isConfigured()) {
        logger.warn('Telephony service not configured - skipping cycle');
        return;
      }

      // Check business hours
      if (!telephonyService.isWithinBusinessHours()) {
        logger.debug('Outside business hours - skipping cycle');
        return;
      }

      // Check if we can accept more calls
      if (!phoneAgentService.canAcceptCall()) {
        logger.debug('Max concurrent calls reached - skipping cycle');
        return;
      }

      // Fetch scheduled phone interviews
      const interviews = await databaseService.fetchScheduledPhoneInterviews();

      if (interviews.length === 0) {
        logger.debug('No scheduled phone interviews found');
        return;
      }

      logger.info('Found scheduled phone interviews', { count: interviews.length });

      // Process interviews (respecting concurrent call limit)
      for (const interview of interviews) {
        if (!phoneAgentService.canAcceptCall()) {
          logger.info('Reached max concurrent calls - deferring remaining interviews');
          break;
        }

        try {
          await this.processInterview(interview);
          // Small delay between calls to avoid hitting rate limits
          await this.delay(1000);
        } catch (err) {
          logger.error('Error processing interview', {
            interviewId: interview.id,
            error: err.message,
          });
          // Mark as failed so we don't retry immediately
          await databaseService.markCallFailed(interview.id, 'failed', err.message);
        }
      }
    } catch (err) {
      logger.error('Cron cycle error', { error: err.message });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Process a single interview - place call and connect to phone agent
   */
  async processInterview(interview) {
    logger.info('Processing phone interview', {
      interviewId: interview.id,
      candidatePhone: `${interview.candidate_phone_number?.slice(0, 6)}****`,
    });

    // Place the outbound call via LiveKit SIP
    const callInfo = await telephonyService.placeCall({
      interviewId: interview.id,
      phoneNumber: interview.candidate_phone_number,
      callerIdNumber: interview.caller_id_number, // Optional
    });

    // Store room info in database
    await databaseService.storeRoomInfo(
      interview.id,
      callInfo.roomName,
      callInfo.sipParticipantId
    );

    // Generate access token for the bot to join the room
    const token = telephonyService.generateAccessToken(
      callInfo.roomName,
      `bot-${interview.id}`
    );

    // Build interview config from database record
    const interviewConfig = {
      language: interview.language || 'en',
      candidateName: interview.candidate_name,
      orgName: interview.org_name,
      jdTitle: interview.jd_title,
      skills: interview.skills,
      prompt: interview.system_prompt || interview.bot_config?.system_prompt,
      greeting: interview.greeting || interview.bot_config?.greeting,
      closing: interview.closing || interview.bot_config?.closing,
      durationMinutes: interview.duration_minutes || 30,
      questionCount: interview.question_count || 0, // 0 = screening
      sttUtteranceEndMs: interview.interview_stage === 'fitment' ? 2000 : 5000,
      sttEndpointing: interview.interview_stage === 'fitment' ? 400 : 800,
    };

    // Join the room and start the phone agent
    await phoneAgentService.joinCall({
      roomName: callInfo.roomName,
      token,
      livekitUrl: process.env.LIVEKIT_URL,
      interviewConfig,
      onCallComplete: async (result) => {
        await this.handleCallComplete(interview.id, result);
      },
    });

    logger.info('Phone agent joined room, waiting for candidate to answer', {
      interviewId: interview.id,
      roomName: callInfo.roomName,
    });
  }

  /**
   * Handle call completion
   */
  async handleCallComplete(interviewId, result) {
    const { reason, duration, transcript, proctoringData } = result;

    logger.info('Call completed', {
      interviewId,
      reason,
      durationMs: duration,
      transcriptEntries: transcript?.length || 0,
    });

    try {
      if (reason === 'completed' || reason === 'max_duration') {
        await databaseService.markCallCompleted(interviewId, {
          transcript,
          proctoringData,
          duration,
          reason,
        });
      } else if (reason === 'candidate_hangup') {
        await databaseService.markCallCompleted(interviewId, {
          transcript,
          proctoringData,
          duration,
          reason: 'candidate_hangup',
        });
      } else {
        // no_answer, busy, voicemail, failed, etc.
        await databaseService.markCallFailed(interviewId, reason);
      }
    } catch (err) {
      logger.error('Error handling call completion', {
        interviewId,
        error: err.message,
      });
    }
  }

  /**
   * Helper delay function
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton
const cronJob = new CronJob();

module.exports = cronJob;
