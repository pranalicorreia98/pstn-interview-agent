# PSTN Interview Agent

Phone interview agent using LiveKit SIP with Vobiz for PSTN calls. Same interview brain as the Zoom bot (clikhireBotIntegration), different transport.

## Overview

This service enables automated phone interviews by calling candidates directly on their mobile numbers via PSTN (Public Switched Telephone Network). It uses:

- **LiveKit SIP** - Bridges PSTN calls to WebRTC rooms
- **Vobiz** - India SIP trunk provider with built-in DLT/TRAI compliance
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
                       │     Vobiz       │
                       │   (SIP Trunk)   │
                       │  DLT Compliant  │
                       └────────┬────────┘
                                │
                       ┌────────┴────────┐
                       │  Airtel/Jio/VIL │
                       │     (PSTN)      │
                       └────────┬────────┘
                                │
                       ┌────────┴────────┐
                       │  Candidate's    │
                       │     Phone       │
                       └─────────────────┘
```

## Why Vobiz?

| Feature | Vobiz | Other Providers |
|---------|-------|-----------------|
| India pricing | ₹0.45/min | ₹0.60-1.50/min |
| DLT compliance | ✅ Built-in | ❌ You handle |
| TRAI compliance | ✅ Automatic | ❌ You handle |
| KYC | ✅ Hosted | ❌ Manual |
| Latency | Sub-80ms | Varies |
| Carriers | Airtel, Jio, VIL | Varies |

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
| `telephony.service.js` | SIP outbound calling via LiveKit + Vobiz |
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

### 3. Set Up Vobiz (SIP Trunk)

1. Create account at [vobiz.ai](https://www.vobiz.ai)
2. Complete KYC verification
3. Navigate to **SIP Trunk > Outbound Trunks > Trunks**
4. Click **Create Trunk** with name "LiveKit Integration"
5. Note your credentials:
   - SIP Domain: `<your_domain>.sip.vobiz.ai`
   - Username
   - Password
6. Purchase a phone number for caller ID

### 4. Set Up LiveKit Cloud

1. Create account at [livekit.io](https://livekit.io)
2. Get API credentials from **Settings > API Keys**
3. Go to **Telephony > Trunks** and create outbound trunk:
   ```
   Name: Vobiz India Trunk
   Address: <your_domain>.sip.vobiz.ai
   Auth Username: <vobiz_username>
   Auth Password: <vobiz_password>
   Numbers: <your_vobiz_phone_number>
   ```
4. Copy the Trunk ID to `LIVEKIT_SIP_OUTBOUND_TRUNK_ID`

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
| `VOBIZ_SIP_DOMAIN` | Vobiz SIP domain | - |
| `VOBIZ_CALLER_ID` | Caller ID number | - |
| `MAX_CONCURRENT_CALLS` | Max simultaneous calls | 3 |
| `BUSINESS_HOURS_START` | Start hour (24h) | 9 |
| `BUSINESS_HOURS_END` | End hour (24h) | 21 |
| `BUSINESS_HOURS_TIMEZONE` | Timezone | Asia/Kolkata |

### Business Hours

Calls are only placed during configured business hours to comply with TRAI regulations.

## India Compliance

**Handled by Vobiz:**
- ✅ DLT Registration
- ✅ TRAI Compliance
- ✅ Number series (140/1600)
- ✅ KYC

**Your responsibility:**
- Configure business hours correctly
- Disclose recording in greeting
- Ensure LLM responses are appropriate

## Cost Estimate

Per 15-minute call to India:

| Component | Cost |
|-----------|------|
| Vobiz SIP trunk | ₹6.75 (~$0.08) |
| LiveKit SIP bridging | $0.05 |
| Deepgram STT | $0.10 |
| Google TTS | $0.01 |
| DeepSeek LLM | $0.02 |
| **Total** | **~$0.26** |

Monthly (200 calls): **~$100/mo**

## References

- [Vobiz + LiveKit Integration Guide](https://vobiz.ai/docs/integrations/livekit)
- [LiveKit Telephony Docs](https://docs.livekit.io/telephony/)
- [Vobiz Documentation](https://vobiz.ai/docs)

## License

MIT
