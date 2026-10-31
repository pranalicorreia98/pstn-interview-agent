# Pending — PSTN Interview Agent, end to end

Status (2026-10-31): the code is synced with the Zoom bot and passes a simulated end-to-end
call (fake LiveKit/Deepgram/LLM/TTS/Supabase). It has **never placed a real call**. What's
left is accounts, one database migration, the main app creating phone interviews, and
deployment.

How a call works: cron finds a `mode = 'phone'` interview → claims it → LiveKit dials the
candidate through the Vobiz SIP trunk → the bot joins the LiveKit room → on answer it greets
and interviews (Deepgram STT → DeepSeek → Google TTS, same brain and prompt as Zoom) →
when it ends, the transcript is written to `transcripts` → the existing report pipeline
scores it.

---

## 1. Accounts (blockers)

### Vobiz — India SIP trunk (the phone line)
- [ ] Create account at vobiz.ai and complete KYC
- [ ] SIP Trunk → Outbound Trunks → Create Trunk ("LiveKit Integration")
- [ ] Note: SIP domain (`<x>.sip.vobiz.ai`), username, password
- [ ] Buy a phone number for caller ID → `VOBIZ_CALLER_ID` (E.164, e.g. `+91…`)
- [ ] Confirm with Vobiz: outbound calls to Indian mobiles from this number, DLT/TRAI
      category for recruitment calls, and per-minute pricing

### LiveKit Cloud — media server + SIP bridge
- [ ] Create a project (pick the region nearest India) → `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
      `LIVEKIT_API_SECRET`
- [ ] Telephony → Trunks → Create **Outbound** trunk with the Vobiz domain, username,
      password and number → `LIVEKIT_SIP_OUTBOUND_TRUNK_ID`
      (or call `telephonyService.createVobizTrunk()` once)

### Reused from the Zoom bot (no new accounts)
Copy from the `clikhire-bot-secrets` Secret / bot `.env`:
`DEEPGRAM_API_KEY`, `DEEPSEEK_API_KEY` (+ `DEEPSEEK_MODEL=deepseek-chat`),
`GOOGLE_TTS_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

---

## 2. Database migration (Supabase — main app repo)

```sql
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS candidate_phone_number text;  -- E.164
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS call_status text;             -- dialing | in_progress | completed | no_answer | failed
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS livekit_room_name text;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS call_metadata jsonb DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_interviews_phone_scheduled
  ON interviews (scheduled_for) WHERE mode = 'phone' AND status = 'scheduled';
```

No other schema change: `interviews.status` uses existing values (scheduled → in_progress →
completed; missed / error for unanswered or failed calls), and transcripts are inserted with
`source = 'other'`, `source_event = 'phone.call_completed'` (allowed by
`transcripts_source_check`).

- [ ] Run the migration
- [ ] Check the Supabase database webhook on `transcripts` INSERT → `notify-analyze` has no
      filter on `source` (the edge function itself only needs `interview_id`)

---

## 3. Main app (clikhire) — creating phone interviews

Nothing creates `mode = 'phone'` interviews yet. Needed:
- [ ] A "phone screening" option when inviting / scheduling
- [ ] Interview row: `mode = 'phone'`, `status = 'scheduled'`, `scheduled_for`,
      `candidate_phone_number` (E.164), `interview_stage`, `duration_minutes`, and the same
      `bot_config` as a Zoom screening (`jd_title` = topic, `candidate.first_name`,
      `duration_minutes`; fitment: `questions`, `org_name`, `language`)
- [ ] Candidate's phone number + consent to an AI phone call (collect on the invite)
- [ ] Show call outcome (`call_status`: no answer / failed) in the candidate pipeline

---

## 4. Deployment

- [ ] Dockerfile — use a glibc image (e.g. `node:20-slim`), not Alpine:
      `@livekit/rtc-node` ships native glibc binaries
- [ ] Run as its own K3s Deployment next to `clikhire-bot` (same EC2), env from a ConfigMap +
      Secret. Only outbound network is needed (HTTPS + WebRTC/UDP to LiveKit Cloud) —
      no inbound ports except the optional `/webhooks/livekit`
- [ ] One instance only (cron + monitor run in-process; the claim prevents double-dialing,
      but don't run a stray copy — see the PM2 incident on the Zoom bot)

---

## 5. First live tests

- [ ] `POST /api/calls/test` with `{ "phoneNumber": "+91…", "topic": "AI ML Basics",
      "candidateName": "…", "durationMinutes": 3 }` to your own phone: greeting, audio
      quality/latency both ways, answer timing, closing, hang-up
- [ ] Not answered / rejected → interview `missed`, `call_status = no_answer`
- [ ] Hang up mid-interview → transcript + report still generated
- [ ] A real scheduled phone interview from the main app → report in the UI
- [ ] Calls are blocked outside 09:00–21:00 IST (`BUSINESS_HOURS_*`)

---

## Known gaps

- **Voicemail:** LiveKit has no answering-machine detection here. A voicemail greeting
  counts as the candidate speaking, so it gets a transcript and a (low) report.
- **Proctoring:** phone calls get `multiple_speakers` only (no video, no camera).
- **No retries:** an unanswered call is marked `missed`; re-dialing needs a new schedule.
- **Brain sync:** `interviewBrain.service.js` is copied verbatim from the Zoom bot's
  `voiceAgent.service.js` (see the header) — re-copy after Zoom bot changes.
