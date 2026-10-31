/**
 * Database Service
 *
 * Supabase operations for phone interviews: scheduling, call status, and the
 * transcript hand-off that triggers the report (a `transcripts` row — the same
 * pipeline the Zoom bot feeds).
 *
 * Interview rows are shared with the Zoom bot and the main app, so this only uses
 * columns that exist on `interviews` (scheduled_for, bot_updated_at, ...) plus the
 * phone columns from the PSTN migration: candidate_phone_number, call_status,
 * livekit_room_name, call_metadata.
 */

const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

// interviews.status only accepts a fixed set (interviews_status_check) — the call
// outcome itself goes in call_status / call_metadata.
const FAILED_CALL_STATUS = {
  no_answer: 'missed',
  busy: 'missed',
  voicemail: 'missed',
};

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
   * - scheduled_for is within the fetch window (or already past)
   * - has a candidate_phone_number
   */
  async fetchScheduledPhoneInterviews() {
    if (!this.supabase) {
      throw new Error('Database service not initialized');
    }

    const windowEnd = new Date(Date.now() + this.fetchWindowMinutes * 60 * 1000);

    try {
      const { data, error } = await this.supabase
        .from(this.tableName)
        .select('*')
        .eq('mode', 'phone')
        .eq('status', 'scheduled')
        .not('candidate_phone_number', 'is', null)
        .lte('scheduled_for', windowEnd.toISOString())
        .order('scheduled_for', { ascending: true });

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
   * Claim an interview before dialing: scheduled -> in_progress, only if it is still
   * scheduled. Without this the next cron cycle (1 min later) found the same row and
   * dialed the candidate again. Returns true if this process won the claim.
   */
  async claimInterview(interviewId) {
    const { data, error } = await this.supabase
      .from(this.tableName)
      .update({ status: 'in_progress', bot_updated_at: new Date().toISOString() })
      .eq('id', interviewId)
      .eq('status', 'scheduled')
      .select('id');

    if (error) {
      logger.error('Error claiming interview', { interviewId, error: error.message });
      return false;
    }
    return (data || []).length > 0;
  }

  /**
   * Update interview call status. call_metadata is merged into the stored object —
   * replacing it dropped sip_participant_id, which the call monitor needs.
   */
  async updateCallStatus(interviewId, callStatus, additionalFields = {}) {
    if (!this.supabase) {
      throw new Error('Database service not initialized');
    }

    try {
      const { call_metadata: metadataPatch, ...fields } = additionalFields;
      const updateData = {
        call_status: callStatus,
        bot_updated_at: new Date().toISOString(),
        ...fields,
      };

      if (metadataPatch) {
        const { data: current } = await this.supabase
          .from(this.tableName)
          .select('call_metadata')
          .eq('id', interviewId)
          .maybeSingle();
        updateData.call_metadata = { ...(current?.call_metadata || {}), ...metadataPatch };
      }

      const { error } = await this.supabase
        .from(this.tableName)
        .update(updateData)
        .eq('id', interviewId);

      if (error) {
        logger.error('Error updating call status', { interviewId, callStatus, error: error.message });
        throw error;
      }

      logger.info('Updated call status', { interviewId, callStatus });
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
   * Mark call as completed. The transcript itself goes to the `transcripts` table via
   * transcript.service (that row is what triggers the report).
   */
  async markCallCompleted(interviewId, completionData = {}) {
    const { duration, reason } = completionData;

    return this.updateCallStatus(interviewId, 'completed', {
      status: 'completed',
      call_metadata: {
        completed_at: new Date().toISOString(),
        duration_ms: duration,
        completion_reason: reason,
      },
    });
  }

  /**
   * Mark call as failed (no answer, busy, voicemail, dial error)
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
      status: FAILED_CALL_STATUS[reason] || 'error',
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

  // --- Transcript hand-off (same tables and bucket as the Zoom bot) ---

  /**
   * Whether the interview already has a transcripts row: true, false, or null if the
   * check itself failed (callers must not insert on null — each insert triggers a report).
   */
  async hasTranscript(interviewId) {
    const { data, error } = await this.supabase
      .from('transcripts')
      .select('id')
      .eq('interview_id', interviewId)
      .limit(1);

    if (error) {
      logger.error('Error checking for existing transcript', { interviewId, error: error.message });
      return null;
    }
    return (data || []).length > 0;
  }

  /**
   * Insert a transcripts row. A database trigger then calls the main app's
   * analyze-transcript endpoint, which writes the report.
   */
  async insertTranscript(transcriptData) {
    const { data, error } = await this.supabase
      .from('transcripts')
      .insert(transcriptData)
      .select()
      .single();

    if (error) {
      logger.error('Error inserting transcript', { interviewId: transcriptData.interview_id, error: error.message });
      return null;
    }
    logger.info('Transcript record inserted', { id: data.id, interviewId: transcriptData.interview_id });
    return data;
  }

  async uploadToStorage(bucket, filePath, content, contentType = 'text/vtt', upsert = false) {
    const { error } = await this.supabase.storage
      .from(bucket)
      .upload(filePath, Buffer.from(content, 'utf8'), { contentType, upsert });

    if (error) {
      logger.error('Error uploading to storage', { bucket, filePath, error: error.message });
      return null;
    }
    return filePath;
  }

  async downloadFromStorage(bucket, filePath) {
    const { data, error } = await this.supabase.storage.from(bucket).download(filePath);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer()).toString('utf8');
  }

  async deleteFromStorage(bucket, filePath) {
    const { error } = await this.supabase.storage.from(bucket).remove([filePath]);
    if (error) {
      logger.warn('Error deleting from storage', { bucket, filePath, error: error.message });
    }
  }

  async updateProctoringFlags(interviewId, proctoringFlags) {
    const { error } = await this.supabase
      .from(this.tableName)
      .update({ proctoring_flags: proctoringFlags })
      .eq('id', interviewId);

    if (error) {
      logger.error('Error saving proctoring flags', { interviewId, error: error.message });
      return false;
    }
    return true;
  }

  /**
   * Completed phone interviews with no transcripts row (recovery sweep).
   */
  async fetchCompletedPhoneInterviewsWithoutTranscript(sinceHours) {
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
    const { data: interviews, error } = await this.supabase
      .from(this.tableName)
      .select('id')
      .eq('mode', 'phone')
      .eq('status', 'completed')
      .gte('bot_updated_at', since);

    if (error || !interviews || interviews.length === 0) {
      if (error) logger.error('Error fetching completed phone interviews', { error: error.message });
      return [];
    }

    const { data: transcripts, error: tErr } = await this.supabase
      .from('transcripts')
      .select('interview_id')
      .in('interview_id', interviews.map(i => i.id));

    if (tErr) {
      logger.error('Error fetching transcripts for completed phone interviews', { error: tErr.message });
      return [];
    }

    const withTranscript = new Set((transcripts || []).map(t => t.interview_id));
    return interviews.filter(i => !withTranscript.has(i.id));
  }
}

// Singleton
const databaseService = new DatabaseService();

module.exports = databaseService;
