/**
 * Database Service
 *
 * Supabase operations for phone interviews.
 * Fetches scheduled phone interviews, updates call status, stores transcripts.
 */

const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

class DatabaseService {
  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    this.tableName = process.env.DB_TABLE_NAME || 'interviews';
    this.schema = process.env.DB_SCHEMA || 'public';
    this.fetchWindowMinutes = parseInt(process.env.FETCH_WINDOW_MINUTES) || 5;

    this.supabase = null;
  }

  /**
   * Initialize Supabase client
   */
  initialize() {
    if (!this.supabaseUrl || !this.supabaseKey) {
      logger.warn('Database service not configured - missing Supabase credentials');
      return false;
    }

    this.supabase = createClient(this.supabaseUrl, this.supabaseKey, {
      db: { schema: this.schema },
    });

    logger.info('Database service initialized', { tableName: this.tableName });
    return true;
  }

  /**
   * Test database connection
   */
  async testConnection() {
    if (!this.supabase) {
      return false;
    }

    try {
      const { error } = await this.supabase
        .from(this.tableName)
        .select('id')
        .limit(1);

      if (error) {
        logger.error('Database connection test failed', { error: error.message });
        return false;
      }

      logger.info('Database connection test passed');
      return true;
    } catch (err) {
      logger.error('Database connection test error', { error: err.message });
      return false;
    }
  }

  /**
   * Fetch scheduled phone interviews ready to dial
   *
   * Returns interviews where:
   * - mode = 'phone'
   * - status = 'scheduled'
   * - scheduled_start_time is within the fetch window
   * - has a valid candidate_phone_number
   */
  async fetchScheduledPhoneInterviews() {
    if (!this.supabase) {
      throw new Error('Database service not initialized');
    }

    const now = new Date();
    const windowEnd = new Date(now.getTime() + this.fetchWindowMinutes * 60 * 1000);

    try {
      const { data, error } = await this.supabase
        .from(this.tableName)
        .select('*')
        .eq('mode', 'phone')
        .eq('status', 'scheduled')
        .not('candidate_phone_number', 'is', null)
        .lte('scheduled_start_time', windowEnd.toISOString())
        .order('scheduled_start_time', { ascending: true });

      if (error) {
        logger.error('Error fetching scheduled phone interviews', { error: error.message });
        throw error;
      }

      logger.info('Fetched scheduled phone interviews', { count: data?.length || 0 });
      return data || [];
    } catch (err) {
      logger.error('Failed to fetch scheduled phone interviews', { error: err.message });
      throw err;
    }
  }

  /**
   * Update interview call status
   */
  async updateCallStatus(interviewId, status, additionalFields = {}) {
    if (!this.supabase) {
      throw new Error('Database service not initialized');
    }

    try {
      const updateData = {
        call_status: status,
        updated_at: new Date().toISOString(),
        ...additionalFields,
      };

      const { error } = await this.supabase
        .from(this.tableName)
        .update(updateData)
        .eq('id', interviewId);

      if (error) {
        logger.error('Error updating call status', { interviewId, status, error: error.message });
        throw error;
      }

      logger.info('Updated call status', { interviewId, status });
    } catch (err) {
      logger.error('Failed to update call status', { interviewId, error: err.message });
      throw err;
    }
  }

  /**
   * Store LiveKit room info for an interview
   */
  async storeRoomInfo(interviewId, roomName, sipParticipantId) {
    return this.updateCallStatus(interviewId, 'dialing', {
      livekit_room_name: roomName,
      call_metadata: {
        sip_participant_id: sipParticipantId,
        dial_started_at: new Date().toISOString(),
      },
    });
  }

  /**
   * Mark call as connected (candidate answered)
   */
  async markCallConnected(interviewId, amdResult = null) {
    const callMetadata = {
      connected_at: new Date().toISOString(),
    };

    if (amdResult) {
      callMetadata.amd_result = amdResult;
    }

    return this.updateCallStatus(interviewId, 'in_progress', {
      call_metadata: callMetadata,
    });
  }

  /**
   * Mark call as completed and store final data
   */
  async markCallCompleted(interviewId, completionData = {}) {
    const { transcript, proctoringData, duration, reason } = completionData;

    const updateFields = {
      status: 'completed', // interview status
    };

    if (transcript) {
      updateFields.bot_transcript = transcript;
    }

    if (proctoringData) {
      updateFields.proctoring = proctoringData;
    }

    const callMetadata = {
      completed_at: new Date().toISOString(),
      duration_ms: duration,
      completion_reason: reason,
    };

    return this.updateCallStatus(interviewId, 'completed', {
      ...updateFields,
      call_metadata: callMetadata,
    });
  }

  /**
   * Mark call as failed
   */
  async markCallFailed(interviewId, reason, errorMessage = null) {
    const callMetadata = {
      failed_at: new Date().toISOString(),
      failure_reason: reason,
    };

    if (errorMessage) {
      callMetadata.error_message = errorMessage;
    }

    return this.updateCallStatus(interviewId, reason, {
      call_metadata: callMetadata,
    });
  }

  /**
   * Get interviews with active calls (for monitoring)
   */
  async getActiveCallInterviews() {
    if (!this.supabase) {
      throw new Error('Database service not initialized');
    }

    try {
      const { data, error } = await this.supabase
        .from(this.tableName)
        .select('*')
        .eq('mode', 'phone')
        .in('call_status', ['dialing', 'ringing', 'in_progress']);

      if (error) {
        throw error;
      }

      return data || [];
    } catch (err) {
      logger.error('Failed to get active call interviews', { error: err.message });
      throw err;
    }
  }

  /**
   * Get interview by ID
   */
  async getInterviewById(interviewId) {
    if (!this.supabase) {
      throw new Error('Database service not initialized');
    }

    try {
      const { data, error } = await this.supabase
        .from(this.tableName)
        .select('*')
        .eq('id', interviewId)
        .single();

      if (error) {
        throw error;
      }

      return data;
    } catch (err) {
      logger.error('Failed to get interview', { interviewId, error: err.message });
      throw err;
    }
  }

  /**
   * Get interview by room name
   */
  async getInterviewByRoomName(roomName) {
    if (!this.supabase) {
      throw new Error('Database service not initialized');
    }

    try {
      const { data, error } = await this.supabase
        .from(this.tableName)
        .select('*')
        .eq('livekit_room_name', roomName)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
        throw error;
      }

      return data || null;
    } catch (err) {
      logger.error('Failed to get interview by room name', { roomName, error: err.message });
      throw err;
    }
  }
}

// Singleton
const databaseService = new DatabaseService();

module.exports = databaseService;
