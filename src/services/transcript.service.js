/**
 * Transcript Service
 *
 * Hands a finished call's transcript to the report pipeline: VTT upload to the
 * `transcripts` bucket + a `transcripts` row (a database trigger then calls the main
 * app's analyze-transcript endpoint, which writes the report). Same contract as the
 * Zoom bot's BotMonitor._processTranscript; source is 'other' because
 * transcripts_source_check only allows zoom / manual / other.
 *
 * Durability (ported from the Zoom bot, where transcripts were being lost):
 * - backup(): the live transcript is saved to storage every minute and at call end,
 *   so a restart mid-call or a failed upload doesn't lose it
 * - saveTranscript(): idempotent (each row triggers a paid LLM report), retried,
 *   falls back to the storage backup
 * - recoverMissingTranscripts(): sweep for completed phone interviews with no row
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const databaseService = require('./database.service');

const BUCKET = 'transcripts';
const backupPath = interviewId => `_pending/phone-${interviewId}.json`;
const RECOVERY_HOURS = parseInt(process.env.TRANSCRIPT_RECOVERY_HOURS) || 24;
const MAX_RECOVERY_ATTEMPTS = 10;

function formatVTTTime(totalSeconds) {
  const ms = Math.max(0, Math.round(totalSeconds * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, '0')}`;
}

/**
 * Session transcript entries ({ speaker, text, timestamp_ms }) -> WebVTT. Same cue
 * format as the Zoom bot ("Speaker: text"), which the report parser expects.
 */
function toVTT(entries) {
  const cues = entries.filter(e => e && typeof e.text === 'string' && e.text.trim());
  if (cues.length === 0) return 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:00.000\n[No transcript available]\n\n';

  let vtt = 'WEBVTT\n\n';
  cues.forEach((entry, i) => {
    const start = (entry.timestamp_ms || 0) / 1000;
    const end = i + 1 < cues.length
      ? (cues[i + 1].timestamp_ms || 0) / 1000
      : start + Math.max(2, entry.text.length * 0.08);
    vtt += `${i + 1}\n${formatVTTTime(start)} --> ${formatVTTTime(Math.max(end, start))}\n`;
    vtt += `${entry.speaker ? `${entry.speaker}: ` : ''}${entry.text.trim()}\n\n`;
  });
  return vtt;
}

class TranscriptService {
  constructor() {
    this.inFlight = new Set();         // interviewIds being saved
    this.recoveryAttempts = new Map(); // interviewId -> attempts by this process
    this.pendingBackups = new Set();
  }

  /** Save the live transcript to storage (fire-and-forget; awaited on shutdown via flush()) */
  backup(interviewId, entries) {
    if (!interviewId || !entries || entries.length === 0) return;
    const p = databaseService
      .uploadToStorage(BUCKET, backupPath(interviewId), JSON.stringify(entries), 'text/vtt', true)
      .catch(err => logger.warn('Transcript backup failed', { interviewId, error: err.message }))
      .finally(() => this.pendingBackups.delete(p));
    this.pendingBackups.add(p);
  }

  /** Wait for in-flight backups (graceful shutdown) */
  flush() {
    return Promise.allSettled([...this.pendingBackups]);
  }

  async loadBackup(interviewId) {
    const json = await databaseService.downloadFromStorage(BUCKET, backupPath(interviewId));
    if (!json) return null;
    try {
      const entries = JSON.parse(json);
      return Array.isArray(entries) && entries.length > 0 ? entries : null;
    } catch (e) {
      return null;
    }
  }

  async _retry(label, fn, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      const result = await fn();
      if (result) return result;
      if (i < attempts - 1) {
        logger.warn(`${label} failed, retrying`, { attempt: i + 1, attempts });
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
      }
    }
    return null;
  }

  /**
   * Upload the VTT and insert the transcripts row. Returns true when the interview has
   * a transcripts row afterwards (inserted now or already there).
   */
  async saveTranscript(interviewId, entries, proctoringData = null) {
    if (this.inFlight.has(interviewId)) return false;
    this.inFlight.add(interviewId);
    try {
      const already = await databaseService.hasTranscript(interviewId);
      if (already === null) return false; // can't tell — the recovery sweep retries
      if (already) {
        await databaseService.deleteFromStorage(BUCKET, backupPath(interviewId));
        return true;
      }

      if (!entries || entries.length === 0) entries = await this.loadBackup(interviewId);
      if (!entries || entries.length === 0) {
        logger.warn('No transcript for phone interview (live or backup)', { interviewId });
        return false;
      }

      const filePath = `${interviewId}/${Date.now()}_${crypto.randomUUID()}.vtt`;
      const uploaded = await this._retry('VTT upload', () =>
        databaseService.uploadToStorage(BUCKET, filePath, toVTT(entries), 'text/vtt', true));
      if (!uploaded) return false;

      const inserted = await this._retry('Transcript insert', async () =>
        (await databaseService.hasTranscript(interviewId)) ? { id: '(already inserted)' } : databaseService.insertTranscript({
          interview_id: interviewId,
          source: 'other',
          source_event: 'phone.call_completed',
          file_path: uploaded,
          status: 'created',
        }));
      if (!inserted) {
        logger.error('Failed to insert phone transcript — the recovery sweep will retry', { interviewId });
        return false;
      }

      logger.info('Phone transcript saved', { interviewId, entries: entries.length, filePath: uploaded });
      await databaseService.deleteFromStorage(BUCKET, backupPath(interviewId));
      if (proctoringData) await this.saveProctoring(interviewId, proctoringData);
      return true;
    } catch (err) {
      logger.error('Error saving phone transcript', { interviewId, error: err.message });
      return false;
    } finally {
      this.inFlight.delete(interviewId);
    }
  }

  /**
   * Proctoring flags in the shape the main app reads (multiple_speakers as in the Zoom
   * bot: flagged only on 2+ real second-voice events). No video or camera on a phone call.
   */
  async saveProctoring(interviewId, { secondarySpeakerEvents = [], participantEvents = [] }) {
    await databaseService.updateProctoringFlags(interviewId, {
      analyzed_at: new Date().toISOString(),
      channel: 'phone',
      multiple_speakers: {
        detected: secondarySpeakerEvents.length >= 2,
        events: secondarySpeakerEvents,
      },
      participant_events: participantEvents,
    });
  }

  /** Completed phone interviews with no transcripts row: save from the storage backup. */
  async recoverMissingTranscripts() {
    const missing = await databaseService.fetchCompletedPhoneInterviewsWithoutTranscript(RECOVERY_HOURS);
    for (const { id } of missing) {
      if (this.inFlight.has(id)) continue;
      const attempts = this.recoveryAttempts.get(id) || 0;
      if (attempts >= MAX_RECOVERY_ATTEMPTS) continue;
      this.recoveryAttempts.set(id, attempts + 1);
      logger.info('Recovering missing phone transcript', { interviewId: id, attempt: attempts + 1 });
      if (await this.saveTranscript(id, null)) this.recoveryAttempts.delete(id);
    }
  }
}

module.exports = new TranscriptService();
module.exports.toVTT = toVTT;
