# PSTN Interview Agent

Phone interview agent using LiveKit SIP for PSTN calls. Same interview brain as the Zoom bot (clikhireBotIntegration), different transport.

## Overview

This service enables automated phone interviews by calling candidates directly on their mobile numbers via PSTN (Public Switched Telephone Network). It uses:

- **LiveKit SIP** - Bridges PSTN calls to WebRTC rooms
- **Deepgram** - Speech-to-text (STT)
- **DeepSeek** - LLM for conversation
- **Google Cloud TTS** - Text-to-speech with 9 Indian language support

## Architecture

```
┌────────────────┐     ┌─────────────────┐     ┌──────────────────┐
│   Supabase     │────▶│   Cron Job      │────▶│  Telephony Svc   │
│  (interviews)  │     │ (poll scheduled)│     │ (CreateSIPPart.) │
└────────────────┘     └─────────────────┘     └────────┬─────────┘
                                                        │
                       ┌─────────────────┐              │
                       │  LiveKit Cloud  │◀─────────────┘
                       │   (SIP Bridge)  │
                       └────────┬────────┘
                                │
                       ┌────────┴────────┐
                       │   SIP Trunk     │
                       │ (Twilio/Exotel) │
                       └────────┬────────┘
                                │
                       ┌────────┴────────┐
                       │      PSTN       │
                       └────────┬────────┘
                                │
                       ┌────────┴────────┐
                       │  Candidate's    │
                       │     Phone       │
                       └─────────────────┘
```

## Key Differences from Zoom Bot

| Aspect | Zoom Bot | PSTN Agent |
|--------|----------|------------|
| Transport | Attendee WebSocket | LiveKit Room |
| Audio | Mixed (bot + candidate) | Separate tracks |
| Barge-in | Disabled (echo issues) | Possible (separate tracks) |
| Auto-greet | Conditional (fitment only) | Always (no waiting room) |
| Connection | Candidate joins meeting | Agent calls candidate |

## Services

| Service | Description |
|---------|-------------|
| `interviewBrain.service.js` | Transport-agnostic STT→LLM→TTS pipeline |
| `phoneAgent.service.js` | LiveKit Room transport adapter |
| `telephony.service.js` | SIP outbound calling via LiveKit |
| `database.service.js` | Supabase operations |
| `cron.job.js` | Polls for scheduled interviews |
| `callMonitor.job.js` | Monitors active calls |

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Set Up LiveKit Cloud

1. Create account at [livekit.io](https://livekit.io)
2. Create a SIP trunk (connect to Twilio, Telnyx, or regional provider)
3. Note your API key, secret, and SIP trunk ID

### 4. Set Up SIP Trunk Provider

For India, consider:
- [Exotel](https://exotel.com)
- [Knowlarity](https://knowlarity.com)
- [Ozonetel](https://ozonetel.com)

For international/testing:
- [Twilio](https://twilio.com) - Elastic SIP Trunking
- [Telnyx](https://telnyx.com)

### 5. Database Schema

Add these columns to your `interviews` table:

```sql
ALTER TABLE interviews ADD COLUMN candidate_phone_number text;
ALTER TABLE interviews ADD COLUMN call_status text DEFAULT NULL;
  -- values: 'dialing' | 'ringing' | 'in_progress' | 'completed' | 'no_answer' | 'busy' | 'failed' | 'voicemail'
ALTER TABLE interviews ADD COLUMN livekit_room_name text;
ALTER TABLE interviews ADD COLUMN call_metadata jsonb DEFAULT '{}'::jsonb;

CREATE INDEX idx_interviews_call_status ON interviews(call_status) WHERE mode = 'phone';
```

### 6. Start the Service

```bash
npm start
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check with cron/call status |
| GET | `/api/calls` | List active calls |
| POST | `/api/calls/test` | Place a test call |
| POST | `/api/calls/:roomName/end` | End a specific call |
| POST | `/api/calls/end-all` | Emergency: end all calls |
| POST | `/webhooks/livekit` | LiveKit event webhook |

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LIVEKIT_URL` | LiveKit server URL | - |
| `LIVEKIT_API_KEY` | LiveKit API key | - |
| `LIVEKIT_API_SECRET` | LiveKit API secret | - |
| `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` | SIP trunk ID | - |
| `MAX_CONCURRENT_CALLS` | Max simultaneous calls | 3 |
| `BUSINESS_HOURS_START` | Start hour (24h) | 9 |
| `BUSINESS_HOURS_END` | End hour (24h) | 21 |
| `BUSINESS_HOURS_TIMEZONE` | Timezone | Asia/Kolkata |

### Business Hours

Calls are only placed during configured business hours to:
1. Respect candidates' time
2. Comply with telecom regulations (India TRAI requires this)

## India Compliance Notes

⚠️ **Important**: Before placing calls to Indian numbers, ensure:

1. **DLT Registration** - Register as a Principal Entity on a TRAI DLT platform
2. **Script Registration** - Register voice templates/scripts
3. **Number Series** - Use correct number series (140 for promotional, 1600 for transactional)
4. **Consent** - Obtain candidate consent before calling

See the design doc in `clikhireBotIntegration/docs/PSTN_PHONE_MODULE_DESIGN.md` for details.

## Cost Estimate

Per 15-minute call to India:

| Component | Cost |
|-----------|------|
| PSTN (SIP trunk) | ₹9-27 (~$0.11-0.32) |
| LiveKit SIP bridging | $0.045-0.06 |
| Deepgram STT | $0.07-0.12 |
| Google TTS | ~$0.01 |
| DeepSeek LLM | ~$0.02 |
| **Total** | **~$0.25-0.55** |

## License

MIT
