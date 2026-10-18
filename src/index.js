/**
 * PSTN Interview Agent
 *
 * Main entry point for the phone interview service.
 * Uses LiveKit SIP for PSTN calls, same interview brain as Zoom bot.
 */

require('dotenv').config();
const express = require('express');
const logger = require('./utils/logger');
const databaseService = require('./services/database.service');
const telephonyService = require('./services/telephony.service');
const phoneAgentService = require('./services/phoneAgent.service');
const cronJob = require('./jobs/cron.job');
const callMonitorJob = require('./jobs/callMonitor.job');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'pstn-interview-agent',
    timestamp: new Date().toISOString(),
    cronStatus: cronJob.getStatus(),
    callMonitorStatus: callMonitorJob.getStatus(),
    activeCalls: phoneAgentService.getActiveCallCount(),
  });
});

// Get active calls
app.get('/api/calls', (req, res) => {
  const activeCalls = [];
  for (const [roomName, call] of phoneAgentService.activeCalls) {
    activeCalls.push({
      roomName,
      status: call.metadata.status,
      duration: Date.now() - call.metadata.startTime,
      hasSession: !!call.session,
    });
  }
  res.json({ activeCalls });
});

// Manually trigger a call (for testing)
app.post('/api/calls/test', async (req, res) => {
  const { phoneNumber, interviewConfig } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ error: 'phoneNumber is required' });
  }

  try {
    // Generate test interview ID
    const testInterviewId = `test-${Date.now()}`;

    // Place the call
    const callInfo = await telephonyService.placeCall({
      interviewId: testInterviewId,
      phoneNumber,
    });

    // Generate token
    const token = telephonyService.generateAccessToken(
      callInfo.roomName,
      `bot-${testInterviewId}`
    );

    // Join the room
    await phoneAgentService.joinCall({
      roomName: callInfo.roomName,
      token,
      livekitUrl: process.env.LIVEKIT_URL,
      interviewConfig: interviewConfig || {
        language: 'en',
        durationMinutes: 5,
        greeting: 'Hello! This is a test call from the interview agent.',
      },
      onCallComplete: (result) => {
        logger.info('Test call completed', { result });
      },
    });

    res.json({
      success: true,
      interviewId: testInterviewId,
      ...callInfo,
    });
  } catch (err) {
    logger.error('Test call failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// End a specific call
app.post('/api/calls/:roomName/end', async (req, res) => {
  const { roomName } = req.params;
  const { reason } = req.body;

  try {
    await phoneAgentService.endCall(roomName, reason || 'api_request');
    res.json({ success: true, roomName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Emergency: end all calls
app.post('/api/calls/end-all', async (req, res) => {
  const count = phoneAgentService.getActiveCallCount();
  await phoneAgentService.endAllCalls('emergency_shutdown');
  res.json({ success: true, closedCalls: count });
});

// LiveKit webhook (for call events)
app.post('/webhooks/livekit', async (req, res) => {
  // TODO: Verify webhook signature
  const event = req.body;

  logger.info('LiveKit webhook received', { eventType: event.event });

  // Handle relevant events
  switch (event.event) {
    case 'participant_joined':
      if (event.participant?.identity?.startsWith('sip_')) {
        logger.info('SIP participant joined (call answered)', {
          roomName: event.room?.name,
          participantId: event.participant?.identity,
        });
        // Update database - call answered
        const interview = await databaseService.getInterviewByRoomName(event.room?.name);
        if (interview) {
          await databaseService.markCallConnected(interview.id);
        }
      }
      break;

    case 'participant_left':
      if (event.participant?.identity?.startsWith('sip_')) {
        logger.info('SIP participant left (call ended)', {
          roomName: event.room?.name,
          reason: event.participant?.disconnectReason,
        });
      }
      break;

    case 'room_finished':
      logger.info('Room finished', { roomName: event.room?.name });
      break;
  }

  res.sendStatus(200);
});

/**
 * Application startup
 */
async function startApplication() {
  logger.info('Starting PSTN Interview Agent');
  logger.info('Environment:', {
    nodeEnv: process.env.NODE_ENV || 'development',
    cronInterval: process.env.CRON_INTERVAL_MINUTES || '1',
    maxConcurrentCalls: process.env.MAX_CONCURRENT_CALLS || '3',
  });

  try {
    // Initialize database
    logger.info('Initializing database service...');
    if (!databaseService.initialize()) {
      logger.error('Database service not configured');
      process.exit(1);
    }

    const dbConnected = await databaseService.testConnection();
    if (!dbConnected) {
      logger.error('Failed to connect to database');
      process.exit(1);
    }
    logger.info('Database connection successful');

    // Initialize telephony
    logger.info('Initializing telephony service...');
    if (!telephonyService.initialize()) {
      logger.warn('Telephony service not configured - calls will not work');
    } else {
      logger.info('Telephony service initialized');
    }

    // Start HTTP server
    app.listen(PORT, () => {
      logger.info(`HTTP server started on port ${PORT}`);
      logger.info(`Health check: http://localhost:${PORT}/health`);
    });

    // Start cron job
    logger.info('Starting cron job scheduler...');
    cronJob.start();

    // Start call monitor
    logger.info('Starting call monitor...');
    callMonitorJob.start();

    logger.info('Application started successfully');

  } catch (error) {
    logger.error('Failed to start application', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

/**
 * Graceful shutdown
 */
function setupGracefulShutdown() {
  const shutdown = async (signal) => {
    logger.info(`Received ${signal} signal. Starting graceful shutdown...`);

    cronJob.stop();
    callMonitorJob.stop();

    // End all active calls gracefully
    logger.info('Ending all active calls...');
    await phoneAgentService.endAllCalls('shutdown');

    logger.info('Shutdown completed');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { reason, promise });
  });
}

// Setup handlers and start
setupGracefulShutdown();
startApplication();
